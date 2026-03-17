/**
 * Banano Vibe Monitor — OpenClaw Plugin v1.0.0
 *
 * Two-layer vibe moderation for Discord channels:
 *   Layer 1: Local sentiment scoring (free, instant)
 *   Layer 2: AI vibe review (only for flagged messages)
 *
 * Hooks:
 *   message_received → sentiment gate → AI review → response / escalation
 *   message_sending  → intercept correlation-matched vibe check responses
 *
 * Install:
 *   openclaw plugins install ./plugin
 */

import { shouldEscalate, getSentimentScore } from "./sentiment.js";
import { buildVibeCheckPrompt, parseVibeResult } from "./vibe-check.js";
import type { RecentMessage } from "./vibe-check.js";
import { initState, isSilenced, silence, unsilence } from "./state.js";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

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
    enqueueSystemEvent: (text: string, opts: { sessionKey: string }) => boolean;
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
  pendingCheckTimeoutMs: number;
  maxPendingChecks: number;
  contextFilterBots: boolean;
  modEscalationMinSeverity: "low" | "medium" | "high";
  highSeverityPublicReply: boolean;
};

function resolveConfig(pluginConfig?: Record<string, unknown>): VibeConfig {
  const cfg = pluginConfig || {};
  return {
    enabled: cfg.enabled !== false,
    watchedChannelIds: Array.isArray(cfg.watchedChannelIds) ? (cfg.watchedChannelIds as string[]) : [],
    modChannelId: typeof cfg.modChannelId === "string" ? cfg.modChannelId : null,
    modRoleIds: Array.isArray(cfg.modRoleIds) ? (cfg.modRoleIds as string[]) : [],
    modUserIds: Array.isArray(cfg.modUserIds) ? (cfg.modUserIds as string[]) : [],
    sentimentThreshold: typeof cfg.sentimentThreshold === "number" ? cfg.sentimentThreshold : -2,
    maxRecentMessages: typeof cfg.maxRecentMessages === "number" ? cfg.maxRecentMessages : 10,
    cooldownMs: typeof cfg.cooldownMs === "number" ? cfg.cooldownMs : 30_000,
    dedupeWindowMs: typeof cfg.dedupeWindowMs === "number" ? cfg.dedupeWindowMs : 60_000,
    pendingCheckTimeoutMs: typeof cfg.pendingCheckTimeoutMs === "number" ? cfg.pendingCheckTimeoutMs : 60_000,
    maxPendingChecks: typeof cfg.maxPendingChecks === "number" ? cfg.maxPendingChecks : 20,
    contextFilterBots: cfg.contextFilterBots !== false,
    modEscalationMinSeverity:
      cfg.modEscalationMinSeverity === "low" || cfg.modEscalationMinSeverity === "medium"
        ? (cfg.modEscalationMinSeverity as "low" | "medium")
        : "high",
    // If true, high-severity issues still get an in-channel reply even if also escalated to mods.
    // If false, high-severity is mod-only (silent escalation).
    highSeverityPublicReply: cfg.highSeverityPublicReply !== false,
  };
}

// ── Discord token from config ─────────────────────────────────────────────────

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

// ── Discord REST helpers ──────────────────────────────────────────────────────

const DISCORD_API = "https://discord.com/api/v10";

async function fetchRecentMessages(
  token: string,
  channelId: string,
  beforeMessageId: string | undefined,
  limit: number,
  filterBots: boolean,
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
      id: string;
      author: { username: string; bot?: boolean };
      content: string;
    }>;
    return messages
      .reverse()
      .filter((m) => {
        if (!m.content?.trim()) return false; // skip empty
        if (filterBots && m.author.bot) return false; // skip bots
        return true;
      })
      .map((m) => ({ author: m.author.username, content: m.content }));
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
    const res = await fetch(`${DISCORD_API}/guilds/${guildId}/members/${userId}`, {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { roles: [], permissions: "0" };
    const member = (await res.json()) as { roles: string[]; permissions?: string };
    return { roles: member.roles || [], permissions: member.permissions || "0" };
  } catch {
    return { roles: [], permissions: "0" };
  }
}

// ── Internal vibe check envelope ─────────────────────────────────────────────
// Each vibe check gets a unique correlation ID.
// The agent is asked to include it in the response JSON.
// Interception only matches if the ID matches exactly.

const VIBE_ENVELOPE_PREFIX = "BANANO_VIBE";

function buildVibeEnvelope(correlationId: string, prompt: string): string {
  return (
    `[${VIBE_ENVELOPE_PREFIX}:${correlationId}]\n` +
    `${prompt}\n\n` +
    `IMPORTANT: Respond ONLY with this exact JSON structure. ` +
    `Include the correlationId field. Do not post anything else.\n` +
    `{ "correlationId": "${correlationId}", "isToxic": ..., "severity": ..., "reason": ..., "suggestedResponse": ... }`
  );
}

function extractCorrelationId(content: string): string | null {
  try {
    const match = content.match(/"correlationId"\s*:\s*"([^"]+)"/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

// ── Pending vibe check map (keyed by correlationId) ───────────────────────────

type PendingCheck = {
  correlationId: string;
  flaggedContent: string;
  authorName: string;
  messageId: string | undefined;
  channelId: string;
  guildId: string | undefined;
  timestamp: number;
};

// ── Dedupe / cooldown state ───────────────────────────────────────────────────

const handledMessages = new Map<string, number>();
const channelCooldowns = new Map<string, number>();

function isDuplicate(messageId: string, windowMs: number): boolean {
  const now = Date.now();
  for (const [id, ts] of handledMessages) {
    if (now - ts > windowMs * 2) handledMessages.delete(id);
  }
  if (handledMessages.has(messageId)) return true;
  handledMessages.set(messageId, now);
  return false;
}

function isOnCooldown(channelId: string, cooldownMs: number): boolean {
  const last = channelCooldowns.get(channelId);
  return !!last && Date.now() - last < cooldownMs;
}

function markAction(channelId: string): void {
  channelCooldowns.set(channelId, Date.now());
}

// ── Structured log helper ─────────────────────────────────────────────────────

type Decision =
  | "SILENCED"
  | "NOT_WATCHED"
  | "DEDUPE"
  | "COOLDOWN"
  | "SENTIMENT_PASS"
  | "SENTIMENT_FLAG"
  | "VIBE_CHECK_ENQUEUED"
  | "FALSE_ALARM"
  | "MILD_RESPONSE"
  | "HIGH_ESCALATION"
  | "MOD_DENIED"
  | "MOD_SILENCED"
  | "MOD_UNSILENCED";

// Decisions worth persisting to the JSONL log (skip noisy pass-throughs)
const LOGGED_DECISIONS = new Set<Decision>([
  "SENTIMENT_FLAG",
  "VIBE_CHECK_ENQUEUED",
  "FALSE_ALARM",
  "MILD_RESPONSE",
  "HIGH_ESCALATION",
  "MOD_DENIED",
  "MOD_SILENCED",
  "MOD_UNSILENCED",
  "COOLDOWN",
  "DEDUPE",
]);

let vibeLogDir: string | null = null;

function initVibeLog(pluginDir: string): void {
  vibeLogDir = path.join(pluginDir, "logs");
  try {
    if (!fs.existsSync(vibeLogDir)) fs.mkdirSync(vibeLogDir, { recursive: true });
  } catch {
    vibeLogDir = null;
  }
}

function writeVibeLog(decision: Decision, meta: Record<string, unknown>): void {
  if (!vibeLogDir) return;
  try {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
    const logPath = path.join(vibeLogDir, `banano-vibe-${date}.jsonl`);
    const entry = JSON.stringify({ ts: new Date().toISOString(), decision, ...meta }) + "\n";
    fs.appendFileSync(logPath, entry);
  } catch {
    // Best-effort — don't crash the plugin if logging fails
  }
}

function logDecision(
  logger: PluginLogger,
  decision: Decision,
  meta: Record<string, unknown>,
): void {
  logger.info(`[banano-vibe] ${decision} ${JSON.stringify(meta)}`);
  if (LOGGED_DECISIONS.has(decision)) {
    writeVibeLog(decision, meta);
  }
}

// ── Plugin ────────────────────────────────────────────────────────────────────

const plugin = {
  id: "banano-vibe",
  name: "Banano Vibe Monitor",
  description: "Two-layer vibe moderation for Discord: local sentiment gate + AI review.",
  version: "1.0.0",

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
    // Narrowed non-null token for use in closures
    const token: string = discordToken;

    const stateDir = api.resolvePath(".");
    initState(stateDir);
    initVibeLog(stateDir);

    // Correlation ID keyed pending checks
    const pendingChecks = new Map<string, PendingCheck>();

    logger.info(
      `[banano-vibe] Active v1.0.0 | watching: ${config.watchedChannelIds.join(", ") || "none"} | ` +
        `mod: ${config.modChannelId || "none"} | threshold: ${config.sentimentThreshold}`,
    );

    // ── Counters for /vibe_stats ─────────────────────────────────────────
    const stats = {
      flagged: 0,
      falseAlarms: 0,
      mildResponses: 0,
      escalations: 0,
      cooldownSuppressed: 0,
      dedupeSuppressed: 0,
      startedAt: Date.now(),
    };

    // ── /vibe_status command ─────────────────────────────────────────────
    api.registerCommand({
      name: "vibe_status",
      description: "Show Banano vibe monitor status and pending checks",
      handler: () => ({
        text: [
          "🦍 **Banano Vibe Monitor v1.0.0**",
          `Enabled: ${config.enabled}`,
          `Watching: ${config.watchedChannelIds.join(", ") || "none"}`,
          `Mod channel: ${config.modChannelId || "none"}`,
          `Threshold: ${config.sentimentThreshold}`,
          `Cooldown: ${config.cooldownMs}ms`,
          `Escalation min severity: ${config.modEscalationMinSeverity}`,
          `High severity public reply: ${config.highSeverityPublicReply}`,
          `Mod roles: ${config.modRoleIds.join(", ") || "Discord permissions"}`,
          `Pending checks: ${pendingChecks.size}`,
        ].join("\n"),
      }),
    });

    // ── /vibe_stats command ──────────────────────────────────────────────
    api.registerCommand({
      name: "vibe_stats",
      description: "Show Banano vibe monitor counters since last restart",
      handler: () => {
        const uptimeMin = Math.floor((Date.now() - stats.startedAt) / 60_000);
        return {
          text: [
            "🦍 **Banano Vibe Stats**",
            `Uptime: ${uptimeMin}m`,
            `Flagged by sentiment: ${stats.flagged}`,
            `False alarms (AI cleared): ${stats.falseAlarms}`,
            `Mild in-channel responses: ${stats.mildResponses}`,
            `Mod escalations: ${stats.escalations}`,
            `Cooldown suppressed: ${stats.cooldownSuppressed}`,
            `Dedupe suppressed: ${stats.dedupeSuppressed}`,
            `Pending checks now: ${pendingChecks.size}`,
          ].join("\n"),
        };
      },
    });

    // ── Send to Discord ──────────────────────────────────────────────────
    async function sendDiscord(channelId: string, content: string): Promise<void> {
      try {
        await api.runtime.channel.discord.sendMessageDiscord({
          token: token,
          channelId,
          content,
        });
      } catch (err) {
        logger.error(`[banano-vibe] Send failed (${channelId}): ${err}`);
      }
    }

    // ── Mod auth ─────────────────────────────────────────────────────────
    async function isModerator(metadata: Record<string, unknown> | undefined): Promise<boolean> {
      const senderId = metadata?.senderId as string | undefined;
      const guildId = metadata?.guildId as string | undefined;
      const senderRoles = metadata?.senderRoles as string[] | undefined;

      if (config.modUserIds.length > 0 && senderId) {
        if (config.modUserIds.includes(senderId)) return true;
      }

      if (senderRoles && config.modRoleIds.length > 0) {
        for (const role of senderRoles) {
          if (config.modRoleIds.includes(role)) return true;
        }
      }

      if (guildId && senderId) {
        const member = await fetchMemberPermissions(token, guildId, senderId);
        if (config.modRoleIds.length > 0) {
          for (const role of member.roles) {
            if (config.modRoleIds.includes(role)) return true;
          }
        }
        const perms = BigInt(member.permissions || "0");
        const MODERATE_MEMBERS = BigInt(1) << BigInt(40);
        const ADMINISTRATOR = BigInt(1) << BigInt(3);
        if ((perms & MODERATE_MEMBERS) !== BigInt(0)) return true;
        if ((perms & ADMINISTRATOR) !== BigInt(0)) return true;
      }

      return false;
    }

    // ── Clean stale pending checks ───────────────────────────────────────
    function cleanPendingChecks(): void {
      const now = Date.now();
      for (const [id, check] of pendingChecks) {
        if (now - check.timestamp > config.pendingCheckTimeoutMs) {
          pendingChecks.delete(id);
        }
      }
      // Cap at maxPendingChecks — drop oldest
      if (pendingChecks.size > config.maxPendingChecks) {
        const sorted = [...pendingChecks.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
        for (const [id] of sorted.slice(0, pendingChecks.size - config.maxPendingChecks)) {
          pendingChecks.delete(id);
        }
      }
    }

    // ── message_received hook ────────────────────────────────────────────
    api.on("message_received", async (event: unknown, ctx: unknown) => {
      const msg = event as MessageReceivedEvent;
      const msgCtx = ctx as MessageContext;

      if (msgCtx.channelId !== "discord") return;

      const content = msg.content?.trim();
      if (!content) return;

      const conversationId = msgCtx.conversationId || "";
      const discordChannelId = conversationId.replace(/^discord:/, "");
      if (!discordChannelId) return;

      const metadata = msg.metadata || {};
      const messageId = metadata.messageId as string | undefined;
      const guildId = metadata.guildId as string | undefined;

      // ── Mod controls ─────────────────────────────────────────────────
      if (content === "!banano stop" || content === "!banano start") {
        const authorized = await isModerator(metadata);
        if (!authorized) {
          logDecision(logger, "MOD_DENIED", { user: msg.from, channel: discordChannelId });
          return;
        }
        if (content === "!banano stop") {
          silence(discordChannelId);
          await sendDiscord(discordChannelId, "aight aight, going quiet 🤫");
          logDecision(logger, "MOD_SILENCED", { user: msg.from, channel: discordChannelId });
        } else {
          unsilence(discordChannelId);
          await sendDiscord(discordChannelId, "ape is back 🦍");
          logDecision(logger, "MOD_UNSILENCED", { user: msg.from, channel: discordChannelId });
        }
        return;
      }

      // Skip silenced
      if (isSilenced(discordChannelId)) {
        logDecision(logger, "SILENCED", { channel: discordChannelId });
        return;
      }

      // Skip non-watched
      if (!config.watchedChannelIds.includes(discordChannelId)) {
        logDecision(logger, "NOT_WATCHED", { channel: discordChannelId });
        return;
      }

      // Dedupe
      if (messageId && isDuplicate(messageId, config.dedupeWindowMs)) {
        stats.dedupeSuppressed++;
        logDecision(logger, "DEDUPE", { messageId, channel: discordChannelId });
        return;
      }

      // Cooldown
      if (isOnCooldown(discordChannelId, config.cooldownMs)) {
        stats.cooldownSuppressed++;
        logDecision(logger, "COOLDOWN", { channel: discordChannelId });
        return;
      }

      // ── Layer 1: Sentiment gate ──────────────────────────────────────
      const score = getSentimentScore(content);
      if (!shouldEscalate(content, config.sentimentThreshold)) {
        logDecision(logger, "SENTIMENT_PASS", {
          score,
          threshold: config.sentimentThreshold,
          channel: discordChannelId,
        });
        return;
      }

      stats.flagged++;
      logDecision(logger, "SENTIMENT_FLAG", {
        score,
        threshold: config.sentimentThreshold,
        channel: discordChannelId,
        preview: content.slice(0, 60),
        author: msg.from,
      });

      // ── Layer 2: AI vibe review ──────────────────────────────────────
      // P0 #2: Fetch recent context, filter bots/empty
      const recentMessages = await fetchRecentMessages(
        token,
        discordChannelId,
        messageId,
        config.maxRecentMessages,
        config.contextFilterBots,
      );

      // P0 #1: Unique correlation ID per check
      const correlationId = crypto.randomUUID();
      const vibePrompt = buildVibeCheckPrompt(content, msg.from || "unknown", recentMessages);
      const envelope = buildVibeEnvelope(correlationId, vibePrompt);

      // Store with correlation ID as key
      cleanPendingChecks();
      pendingChecks.set(correlationId, {
        correlationId,
        flaggedContent: content,
        authorName: msg.from || "unknown",
        messageId,
        channelId: discordChannelId,
        guildId,
        timestamp: Date.now(),
      });

      const sessionKey = `agent:main:discord:channel:${discordChannelId}`;
      const injected = api.runtime.system.enqueueSystemEvent(envelope, { sessionKey });

      if (injected) {
        logDecision(logger, "VIBE_CHECK_ENQUEUED", {
          correlationId,
          channel: discordChannelId,
          pendingCount: pendingChecks.size,
        });
      } else {
        logger.warn(`[banano-vibe] Failed to enqueue vibe check for ${discordChannelId}`);
        pendingChecks.delete(correlationId);
      }
    });

    // ── message_sending hook (intercept correlation-matched responses) ───
    api.on("message_sending", (event: unknown, _ctx: unknown) => {
      const msg = event as { to: string; content: string; metadata?: Record<string, unknown> };
      const content = msg.content?.trim();
      if (!content) return;

      // P0 #1+#3: Match by correlation ID — no ambiguity, no cross-talk
      const correlationId = extractCorrelationId(content);
      if (!correlationId) return;

      const check = pendingChecks.get(correlationId);
      if (!check) return; // Not our check — let it through

      // Matched — remove from pending
      pendingChecks.delete(correlationId);

      const result = parseVibeResult(content);
      if (!result) {
        logger.warn(`[banano-vibe] Could not parse vibe result for correlation ${correlationId}`);
        return { cancel: true }; // Still block — has our ID, don't leak
      }

      if (!result.isToxic) {
        stats.falseAlarms++;
        logDecision(logger, "FALSE_ALARM", {
          correlationId,
          reason: result.reason,
          channel: check.channelId,
        });
        return { cancel: true };
      }

      markAction(check.channelId);

      const severityOrder = { low: 0, medium: 1, high: 2 };
      const minOrder = severityOrder[config.modEscalationMinSeverity];
      const resultOrder = severityOrder[result.severity] ?? 2;
      const isHighSeverity = result.severity === "high";
      const escalateToMod = resultOrder >= minOrder && !!config.modChannelId;

      // In-channel response — skip if high severity and highSeverityPublicReply is false
      const shouldReplyPublicly = result.suggestedResponse &&
        (!isHighSeverity || config.highSeverityPublicReply);

      if (shouldReplyPublicly) {
        sendDiscord(check.channelId, result.suggestedResponse!);
        stats.mildResponses++;
        logDecision(logger, "MILD_RESPONSE", {
          correlationId,
          severity: result.severity,
          channel: check.channelId,
          reason: result.reason,
        });
      }

      // Mod escalation — with guild-based jump link
      if (escalateToMod) {
        const jumpLink = check.guildId && check.messageId
          ? `https://discord.com/channels/${check.guildId}/${check.channelId}/${check.messageId}`
          : check.messageId
          ? `https://discord.com/channels/@me/${check.channelId}/${check.messageId}`
          : null;

        const alert = [
          `🚨 **Vibe alert** in <#${check.channelId}>`,
          `**User:** ${check.authorName}`,
          `**Message:** "${check.flaggedContent.slice(0, 200)}"`,
          `**Severity:** ${result.severity}`,
          `**Reason:** ${result.reason}`,
        ];
        if (jumpLink) alert.push(`[Jump to message](${jumpLink})`);
        if (isHighSeverity && !config.highSeverityPublicReply) {
          alert.push(`_(silent escalation — no public reply sent)_`);
        }

        sendDiscord(config.modChannelId!, alert.join("\n"));
        stats.escalations++;
        logDecision(logger, "HIGH_ESCALATION", {
          correlationId,
          severity: result.severity,
          channel: check.channelId,
          reason: result.reason,
          hasJumpLink: !!jumpLink,
          silentEscalation: isHighSeverity && !config.highSeverityPublicReply,
        });
      }

      return { cancel: true };
    });
  },
};

export default plugin;
