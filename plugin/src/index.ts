/**
 * Banano Vibe Monitor — OpenClaw Plugin
 *
 * Two-layer vibe moderation for Discord channels:
 *   Layer 1: Local sentiment scoring (free, instant)
 *   Layer 2: AI vibe review (only for flagged messages)
 *
 * Hooks:
 *   message_received → sentiment gate → AI review → response / escalation
 *   gateway_start    → initialize state
 *
 * Install:
 *   openclaw plugins install -l ./plugin
 */

import { shouldEscalate, getSentimentScore } from "./sentiment.js";
import { buildVibeCheckPrompt, parseVibeResult } from "./vibe-check.js";
import type { RecentMessage } from "./vibe-check.js";
import { initState, isSilenced, silence, unsilence } from "./state.js";

// ── Minimal types ────────────────────────────────────────────────────────────

type PluginLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

type PluginRuntime = {
  channel: {
    discord: {
      sendMessageDiscord: (params: {
        token: string;
        channelId: string;
        content: string;
        replyToMessageId?: string;
      }) => Promise<unknown>;
    };
  };
  system: {
    enqueueSystemEvent: (
      text: string,
      opts: { sessionKey: string },
    ) => boolean;
  };
};

type OpenClawConfig = Record<string, unknown>;

type PluginApi = {
  id: string;
  name: string;
  config: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
  runtime: PluginRuntime;
  logger: PluginLogger;
  registerCommand: (def: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler: (ctx: { args?: string }) => { text: string };
  }) => void;
  on: (hookName: string, handler: (...args: unknown[]) => unknown, opts?: unknown) => void;
  resolvePath: (input: string) => string;
};

type MessageReceivedEvent = {
  from: string;
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
};

type MessageContext = {
  channelId: string;
  accountId?: string;
  conversationId?: string;
};

// ── Config ───────────────────────────────────────────────────────────────────

type VibeConfig = {
  enabled: boolean;
  watchedChannelIds: string[];
  modChannelId: string | null;
  modRoleIds: string[];
  modUserIds: string[];
  sentimentThreshold: number;
  maxRecentMessages: number;
  cooldownMs: number;
  dedupeWindowMs: number;
};

function resolveConfig(pluginConfig?: Record<string, unknown>): VibeConfig {
  const cfg = pluginConfig || {};
  return {
    enabled: cfg.enabled !== false,
    watchedChannelIds: Array.isArray(cfg.watchedChannelIds) ? cfg.watchedChannelIds : [],
    modChannelId: typeof cfg.modChannelId === "string" ? cfg.modChannelId : null,
    modRoleIds: Array.isArray(cfg.modRoleIds) ? cfg.modRoleIds : [],
    modUserIds: Array.isArray(cfg.modUserIds) ? cfg.modUserIds : [],
    sentimentThreshold: typeof cfg.sentimentThreshold === "number" ? cfg.sentimentThreshold : -2,
    maxRecentMessages: typeof cfg.maxRecentMessages === "number" ? cfg.maxRecentMessages : 10,
    cooldownMs: typeof cfg.cooldownMs === "number" ? cfg.cooldownMs : 30_000,
    dedupeWindowMs: typeof cfg.dedupeWindowMs === "number" ? cfg.dedupeWindowMs : 60_000,
  };
}

// ── Discord token from config ────────────────────────────────────────────────

function resolveDiscordToken(config: OpenClawConfig): string | null {
  try {
    const channels = config.channels as Record<string, unknown> | undefined;
    if (!channels) return null;
    const discord = channels.discord as Record<string, unknown> | undefined;
    if (!discord) return null;
    if (typeof discord.token === "string") return discord.token;
    const accounts = discord.accounts as Record<string, Record<string, unknown>> | undefined;
    if (accounts) {
      for (const acc of Object.values(accounts)) {
        if (typeof acc.token === "string") return acc.token;
      }
    }
  } catch { /* */ }
  return null;
}

// ── Discord REST helpers ─────────────────────────────────────────────────────

const DISCORD_API = "https://discord.com/api/v10";

async function fetchRecentMessages(
  token: string,
  channelId: string,
  beforeMessageId: string | undefined,
  limit: number,
): Promise<RecentMessage[]> {
  try {
    let url = `${DISCORD_API}/channels/${channelId}/messages?limit=${limit}`;
    if (beforeMessageId) url += `&before=${beforeMessageId}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const messages = (await res.json()) as Array<{
      author: { username: string };
      content: string;
    }>;
    return messages.reverse().map((m) => ({
      author: m.author.username,
      content: m.content,
    }));
  } catch {
    return [];
  }
}

async function fetchMemberPermissions(
  token: string,
  guildId: string,
  userId: string,
): Promise<{ roles: string[]; permissions: string }> {
  try {
    const res = await fetch(
      `${DISCORD_API}/guilds/${guildId}/members/${userId}`,
      {
        headers: { Authorization: `Bot ${token}` },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return { roles: [], permissions: "0" };
    const member = (await res.json()) as { roles: string[]; permissions?: string };
    return { roles: member.roles || [], permissions: member.permissions || "0" };
  } catch {
    return { roles: [], permissions: "0" };
  }
}

// ── Vibe check marker ────────────────────────────────────────────────────────
// Internal tag prepended to system events so we can reliably intercept responses.
const VIBE_TAG = "[BANANO_VIBE_CHECK_INTERNAL]";

// ── Dedupe / cooldown state ──────────────────────────────────────────────────

const handledMessages = new Map<string, number>(); // messageId → timestamp
const channelCooldowns = new Map<string, number>(); // channelId → last action timestamp

function isDuplicate(messageId: string, windowMs: number): boolean {
  const now = Date.now();
  // Clean old entries
  for (const [id, ts] of handledMessages) {
    if (now - ts > windowMs * 2) handledMessages.delete(id);
  }
  if (handledMessages.has(messageId)) return true;
  handledMessages.set(messageId, now);
  return false;
}

function isOnCooldown(channelId: string, cooldownMs: number): boolean {
  const last = channelCooldowns.get(channelId);
  if (!last) return false;
  return Date.now() - last < cooldownMs;
}

function markAction(channelId: string): void {
  channelCooldowns.set(channelId, Date.now());
}

// ── Plugin ────────────────────────────────────────────────────────────────────

const plugin = {
  id: "banano-vibe",
  name: "Banano Vibe Monitor",
  description: "Two-layer vibe moderation for Discord: local sentiment gate + AI review.",
  version: "1.1.0",

  register(api: PluginApi) {
    const config = resolveConfig(api.pluginConfig);
    const logger = api.logger;

    if (!config.enabled) {
      logger.info("[banano-vibe] Plugin disabled via config");
      return;
    }

    if (config.watchedChannelIds.length === 0) {
      logger.warn("[banano-vibe] No watched channels configured — mention-only mode");
    }

    const discordToken = resolveDiscordToken(api.config);
    if (!discordToken) {
      logger.error("[banano-vibe] No Discord token in OpenClaw config — cannot operate");
      return;
    }

    const stateDir = api.resolvePath(".");
    initState(stateDir);

    logger.info(
      `[banano-vibe] Active | watching: ${config.watchedChannelIds.join(", ") || "none"} | ` +
        `mod: ${config.modChannelId || "none"} | threshold: ${config.sentimentThreshold}`,
    );

    // ── /vibe_status command ──────────────────────────────────────────────
    api.registerCommand({
      name: "vibe_status",
      description: "Show Banano vibe monitor status",
      handler: () => ({
        text: [
          "🦍 **Banano Vibe Monitor**",
          `Enabled: ${config.enabled}`,
          `Watching: ${config.watchedChannelIds.join(", ") || "none"}`,
          `Mod channel: ${config.modChannelId || "none"}`,
          `Threshold: ${config.sentimentThreshold}`,
          `Cooldown: ${config.cooldownMs}ms`,
          `Mod roles: ${config.modRoleIds.join(", ") || "any with ModerateMembers"}`,
        ].join("\n"),
      }),
    });

    // ── Send to Discord ───────────────────────────────────────────────────
    async function sendDiscord(channelId: string, content: string): Promise<void> {
      try {
        await api.runtime.channel.discord.sendMessageDiscord({
          token: discordToken!,
          channelId,
          content,
        });
      } catch (err) {
        logger.error(`[banano-vibe] Send failed (${channelId}): ${err}`);
      }
    }

    // ── Check if user is a mod ────────────────────────────────────────────
    // P0 #1: Real mod auth — checks Discord roles + permissions, not blind trust.
    async function isModerator(
      metadata: Record<string, unknown> | undefined,
    ): Promise<boolean> {
      // Check metadata for sender info
      const senderId = metadata?.senderId as string | undefined;
      const guildId = metadata?.guildId as string | undefined;
      const senderRoles = metadata?.senderRoles as string[] | undefined;

      // If modUserIds configured, check against sender
      if (config.modUserIds.length > 0 && senderId) {
        if (config.modUserIds.includes(senderId)) return true;
      }

      // If senderRoles available in metadata, check against modRoleIds
      if (senderRoles && config.modRoleIds.length > 0) {
        for (const role of senderRoles) {
          if (config.modRoleIds.includes(role)) return true;
        }
      }

      // Fallback: fetch from Discord API if we have guild + sender
      if (guildId && senderId) {
        const member = await fetchMemberPermissions(discordToken!, guildId, senderId);

        // Check modRoleIds
        if (config.modRoleIds.length > 0) {
          for (const role of member.roles) {
            if (config.modRoleIds.includes(role)) return true;
          }
        }

        // Check MODERATE_MEMBERS permission bit (1 << 40)
        const perms = BigInt(member.permissions || "0");
        const MODERATE_MEMBERS = BigInt(1) << BigInt(40);
        const ADMINISTRATOR = BigInt(1) << BigInt(3);
        if ((perms & MODERATE_MEMBERS) !== BigInt(0)) return true;
        if ((perms & ADMINISTRATOR) !== BigInt(0)) return true;
      }

      // Fail closed: if we can't verify, deny
      if (config.modRoleIds.length > 0 || config.modUserIds.length > 0) {
        return false;
      }

      // No mod restrictions configured — log warning
      logger.warn(
        "[banano-vibe] No modRoleIds/modUserIds configured. " +
          "Mod commands require Discord API permission check.",
      );
      return false;
    }

    // ── Pending vibe checks (for response interception) ───────────────────
    // Maps channelId → { flaggedContent, authorName, messageUrl, timestamp }
    const pendingVibeChecks = new Map<
      string,
      {
        flaggedContent: string;
        authorName: string;
        messageId?: string;
        channelId: string;
        timestamp: number;
      }
    >();

    // ── message_received hook ─────────────────────────────────────────────
    api.on("message_received", async (event: unknown, ctx: unknown) => {
      const msg = event as MessageReceivedEvent;
      const msgCtx = ctx as MessageContext;

      // Only Discord
      if (msgCtx.channelId !== "discord") return;

      const content = msg.content?.trim();
      if (!content) return;

      const conversationId = msgCtx.conversationId || "";
      const discordChannelId = conversationId.replace(/^discord:/, "");
      if (!discordChannelId) return;

      const metadata = msg.metadata || {};
      const messageId = metadata.messageId as string | undefined;

      // ── Mod controls (P0 #1: real auth) ──────────────────────────────
      if (content === "!banano stop" || content === "!banano start") {
        const authorized = await isModerator(metadata);
        if (!authorized) {
          logger.info(
            `[banano-vibe] Mod command denied for ${msg.from} — not a mod`,
          );
          return;
        }

        if (content === "!banano stop") {
          silence(discordChannelId);
          await sendDiscord(discordChannelId, "aight aight, going quiet 🤫");
          logger.info(`[banano-vibe] Silenced ${discordChannelId} by ${msg.from}`);
        } else {
          unsilence(discordChannelId);
          await sendDiscord(discordChannelId, "ape is back 🦍");
          logger.info(`[banano-vibe] Unsilenced ${discordChannelId} by ${msg.from}`);
        }
        return;
      }

      // Skip silenced channels
      if (isSilenced(discordChannelId)) return;

      // Skip non-watched channels
      if (!config.watchedChannelIds.includes(discordChannelId)) return;

      // P1 #7: Dedupe check
      if (messageId && isDuplicate(messageId, config.dedupeWindowMs)) {
        return;
      }

      // P1 #7: Cooldown check
      if (isOnCooldown(discordChannelId, config.cooldownMs)) {
        return;
      }

      // ── Layer 1: Sentiment gate ──────────────────────────────────────
      const score = getSentimentScore(content);
      if (!shouldEscalate(content, config.sentimentThreshold)) {
        return;
      }

      logger.info(
        `[banano-vibe] Flagged (score: ${score}): "${content.slice(0, 80)}" from ${msg.from}`,
      );

      // ── Layer 2: AI vibe review (P0 #2: with context) ────────────────
      const recentMessages = await fetchRecentMessages(
        discordToken!,
        discordChannelId,
        messageId,
        config.maxRecentMessages,
      );

      const vibePrompt = buildVibeCheckPrompt(content, msg.from || "unknown", recentMessages);

      // P0 #5: Use internal marker tag for reliable interception
      // P0 #3: Uses system event (v1) — tagged for safe interception
      // Store pending check metadata for response routing
      pendingVibeChecks.set(discordChannelId, {
        flaggedContent: content,
        authorName: msg.from || "unknown",
        messageId,
        channelId: discordChannelId,
        timestamp: Date.now(),
      });

      // Clean stale pending checks (>60s old)
      for (const [ch, check] of pendingVibeChecks) {
        if (Date.now() - check.timestamp > 60_000) pendingVibeChecks.delete(ch);
      }

      // P0 #4: Use conversationId as session key base (matches OpenClaw routing)
      const sessionKey = `agent:main:discord:channel:${discordChannelId}`;

      const injected = api.runtime.system.enqueueSystemEvent(
        `${VIBE_TAG}\n${vibePrompt}\n\nRespond ONLY with the JSON object. Do not post anything else.`,
        { sessionKey },
      );

      if (injected) {
        logger.info(`[banano-vibe] Vibe check enqueued for ${discordChannelId}`);
      } else {
        logger.warn(`[banano-vibe] Failed to enqueue vibe check for ${discordChannelId}`);
        pendingVibeChecks.delete(discordChannelId);
      }
    });

    // ── message_sending hook (P0 #5: intercept tagged responses) ──────────
    api.on("message_sending", (event: unknown, _ctx: unknown) => {
      const msg = event as { to: string; content: string; metadata?: Record<string, unknown> };
      const content = msg.content?.trim();
      if (!content) return;

      // Only intercept if it looks like a vibe check JSON response
      const result = parseVibeResult(content);
      if (!result) return;

      // Check for a pending vibe check that matches
      // Find by looking at all pending checks (the response might route anywhere)
      let matchedCheck: {
        flaggedContent: string;
        authorName: string;
        messageId?: string;
        channelId: string;
      } | null = null;

      for (const [ch, check] of pendingVibeChecks) {
        if (Date.now() - check.timestamp < 60_000) {
          matchedCheck = check;
          pendingVibeChecks.delete(ch);
          break;
        }
      }

      if (!matchedCheck) {
        // No pending check — this might be a normal message that happens to contain JSON.
        // Let it through to avoid blocking legitimate messages.
        return;
      }

      // We have a confirmed vibe check response — handle it
      const targetChannel = matchedCheck.channelId;

      if (result.isToxic) {
        markAction(targetChannel);

        // In-channel response for any severity with a suggestion
        if (result.suggestedResponse) {
          sendDiscord(targetChannel, result.suggestedResponse);
        }

        // P1 #6: Rich mod escalation payload
        if (result.severity === "high" && config.modChannelId) {
          const alert = [
            `🚨 **Vibe alert** in <#${targetChannel}>`,
            `**User:** ${matchedCheck.authorName}`,
            `**Message:** "${matchedCheck.flaggedContent.slice(0, 200)}"`,
            `**Severity:** ${result.severity}`,
            `**Reason:** ${result.reason}`,
          ];
          if (matchedCheck.messageId) {
            alert.push(
              `[Jump to message](https://discord.com/channels/@me/${targetChannel}/${matchedCheck.messageId})`,
            );
          }
          sendDiscord(config.modChannelId, alert.join("\n"));
        }

        logger.info(
          `[banano-vibe] ${result.severity}: ${result.reason} → ` +
            `${result.suggestedResponse ? "responded" : "silent"}` +
            `${result.severity === "high" ? " + mod escalation" : ""}`,
        );
      } else {
        logger.info(`[banano-vibe] False alarm: ${result.reason}`);
      }

      // Block the raw JSON from reaching chat
      return { cancel: true };
    });
  },
};

export default plugin;
