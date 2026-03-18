/**
 * Banano Vibe Monitor — OpenClaw Plugin v1.1.0
 *
 * Two-layer vibe moderation for Discord channels:
 *   Layer 1: Local sentiment scoring (free, instant)
 *   Layer 2: AI vibe review via isolated subagent session
 *
 * Hooks:
 *   message_received → sentiment gate → isolated AI review → respond / escalate
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
  subagent: {
    run: (params: {
      sessionKey: string;
      message: string;
      extraSystemPrompt?: string;
      deliver?: boolean;
    }) => Promise<{ runId: string }>;
    waitForRun: (params: {
      runId: string;
      timeoutMs?: number;
    }) => Promise<{ status: "ok" | "error" | "timeout"; error?: string }>;
    getSessionMessages: (params: {
      sessionKey: string;
      limit?: number;
    }) => Promise<{ messages: unknown[] }>;
    deleteSession: (params: {
      sessionKey: string;
      deleteTranscript?: boolean;
    }) => Promise<void>;
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

type ResolvedDiscordContext = {
  isDiscord: boolean;
  discordChannelId: string | null;
  source: string;
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
  contextFilterBots: boolean;
  modEscalationMinSeverity: "low" | "medium" | "high";
  highSeverityPublicReply: boolean;
  vibeReviewTimeoutMs: number;
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
    contextFilterBots: cfg.contextFilterBots !== false,
    modEscalationMinSeverity:
      cfg.modEscalationMinSeverity === "low" || cfg.modEscalationMinSeverity === "medium"
        ? (cfg.modEscalationMinSeverity as "low" | "medium")
        : "high",
    highSeverityPublicReply: cfg.highSeverityPublicReply !== false,
    vibeReviewTimeoutMs: typeof cfg.vibeReviewTimeoutMs === "number" ? cfg.vibeReviewTimeoutMs : 30_000,
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

// ── Discord context resolution ────────────────────────────────────────────────

function extractTrailingId(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return trimmed;
  const match = trimmed.match(/(?:discord:|channel:|conversation:|chat:)?(\d{6,})$/);
  return match?.[1] ?? null;
}

function resolveDiscordContext(
  msgCtx: MessageContext,
  metadata: Record<string, unknown> | undefined,
): ResolvedDiscordContext {
  const md = metadata || {};
  const provider = typeof md.provider === "string" ? md.provider : "";
  const channel = typeof md.channel === "string" ? md.channel : "";
  const surface = typeof md.surface === "string" ? md.surface : "";
  const chatId = typeof md.chat_id === "string" ? md.chat_id : "";
  const metadataChannelId = typeof md.channelId === "string" ? md.channelId : "";
  const conversationId = typeof msgCtx.conversationId === "string" ? msgCtx.conversationId : "";
  const ctxChannelId = typeof msgCtx.channelId === "string" ? msgCtx.channelId : "";

  const isDiscord =
    [provider, channel, surface, ctxChannelId].includes("discord") ||
    chatId.startsWith("channel:") ||
    conversationId.startsWith("discord:") ||
    conversationId.startsWith("channel:");

  const discordChannelId =
    extractTrailingId(metadataChannelId) ||
    extractTrailingId(chatId) ||
    extractTrailingId(conversationId) ||
    extractTrailingId(ctxChannelId);

  let source = "unknown";
  if (extractTrailingId(metadataChannelId)) source = "metadata.channelId";
  else if (extractTrailingId(chatId)) source = "metadata.chat_id";
  else if (extractTrailingId(conversationId)) source = "ctx.conversationId";
  else if (extractTrailingId(ctxChannelId)) source = "ctx.channelId";

  return { isDiscord, discordChannelId, source };
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
        if (!m.content?.trim()) return false;
        if (filterBots && m.author.bot) return false;
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
  | "VIBE_CHECK_START"
  | "VIBE_CHECK_TIMEOUT"
  | "VIBE_CHECK_ERROR"
  | "FALSE_ALARM"
  | "MILD_RESPONSE"
  | "HIGH_ESCALATION"
  | "MOD_DENIED"
  | "MOD_SILENCED"
  | "MOD_UNSILENCED";

const LOGGED_DECISIONS = new Set<Decision>([
  "SENTIMENT_FLAG",
  "VIBE_CHECK_START",
  "VIBE_CHECK_TIMEOUT",
  "VIBE_CHECK_ERROR",
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
    const date = new Date().toISOString().slice(0, 10);
    const logPath = path.join(vibeLogDir, `banano-vibe-${date}.jsonl`);
    const entry = JSON.stringify({ ts: new Date().toISOString(), decision, ...meta }) + "\n";
    fs.appendFileSync(logPath, entry);
  } catch {
    // Best-effort
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
  description: "Two-layer vibe moderation for Discord: local sentiment gate + isolated AI review.",
  version: "1.1.0",

  register(api: PluginApi) {
    const config = resolveConfig(api.pluginConfig);
    const logger = api.logger;

    if (!config.enabled) {
      logger.info("[banano-vibe] Plugin disabled via config");
      return;
    }

    if (config.watchedChannelIds.length === 0) {
      logger.warn("[banano-vibe] No watched channels configured — plugin will not trigger");
    }

    const discordToken = resolveDiscordToken(api.config);
    if (!discordToken) {
      logger.error("[banano-vibe] No Discord token in OpenClaw config — cannot operate");
      return;
    }
    const token: string = discordToken;

    const stateDir = api.resolvePath(".");
    initState(stateDir);
    initVibeLog(stateDir);

    logger.info(
      `[banano-vibe] Active v1.1.0 | watching: ${config.watchedChannelIds.join(", ") || "none"} | ` +
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
      reviewErrors: 0,
      startedAt: Date.now(),
    };

    // ── /vibe_status command ─────────────────────────────────────────────
    api.registerCommand({
      name: "vibe_status",
      description: "Show Banano vibe monitor status",
      handler: () => ({
        text: [
          "🦍 **Banano Vibe Monitor v1.1.0**",
          `Enabled: ${config.enabled}`,
          `Watching: ${config.watchedChannelIds.join(", ") || "none"}`,
          `Mod channel: ${config.modChannelId || "none"}`,
          `Threshold: ${config.sentimentThreshold}`,
          `Cooldown: ${config.cooldownMs}ms`,
          `Escalation min severity: ${config.modEscalationMinSeverity}`,
          `High severity public reply: ${config.highSeverityPublicReply}`,
          `Mod roles: ${config.modRoleIds.join(", ") || "Discord permissions"}`,
          `Review timeout: ${config.vibeReviewTimeoutMs}ms`,
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
            `Review errors/timeouts: ${stats.reviewErrors}`,
            `Cooldown suppressed: ${stats.cooldownSuppressed}`,
            `Dedupe suppressed: ${stats.dedupeSuppressed}`,
          ].join("\n"),
        };
      },
    });

    // ── Send to Discord ──────────────────────────────────────────────────
    async function sendDiscord(channelId: string, content: string): Promise<void> {
      try {
        await api.runtime.channel.discord.sendMessageDiscord({
          token,
          channelId,
          content,
        });
      } catch (err) {
        logger.error(`[banano-vibe] Send failed (${channelId}): ${err}`);
      }
    }

    // ── Mod auth ─────────────────────────────────────────────────────────
    async function isModerator(metadata: Record<string, unknown> | undefined): Promise<boolean> {
      const senderId = (metadata?.senderId ?? metadata?.userId) as string | undefined;
      const guildId = (metadata?.guildId ?? metadata?.guild_id) as string | undefined;
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

    // ── Isolated AI vibe review ───────────────────────────────────────────
    // Runs the vibe check in a dedicated isolated session — no re-entrancy,
    // no message_sending interception. The result comes back directly.
    async function runVibeReview(
      prompt: string,
      correlationId: string,
    ): Promise<string | null> {
      const sessionKey = `banano-vibe:check:${correlationId}`;
      try {
        const { runId } = await api.runtime.subagent.run({
          sessionKey,
          message: prompt,
          deliver: false, // don't send to any channel
        });

        const waited = await api.runtime.subagent.waitForRun({
          runId,
          timeoutMs: config.vibeReviewTimeoutMs,
        });

        if (waited.status !== "ok") {
          logger.warn(`[banano-vibe] Vibe review ${waited.status}: ${waited.error ?? ""}`);
          return null;
        }

        const { messages } = await api.runtime.subagent.getSessionMessages({
          sessionKey,
          limit: 5,
        });

        // Find last assistant text message
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i] as { role?: string; content?: unknown };
          if (m.role !== "assistant") continue;
          const content = m.content;
          if (typeof content === "string" && content.trim()) return content;
          if (Array.isArray(content)) {
            for (const block of content) {
              const b = block as { type?: string; text?: string };
              if (b.type === "text" && b.text?.trim()) return b.text;
            }
          }
        }
        return null;
      } finally {
        // Clean up the isolated session
        api.runtime.subagent.deleteSession({ sessionKey, deleteTranscript: true }).catch(() => {});
      }
    }

    // ── message_received hook ────────────────────────────────────────────
    api.on("message_received", async (event: unknown, ctx: unknown) => {
      const msg = event as MessageReceivedEvent;
      const msgCtx = ctx as MessageContext;
      const metadata = msg.metadata || {};

      const resolved = resolveDiscordContext(msgCtx, metadata);
      if (!resolved.isDiscord) return;

      const content = msg.content?.trim();
      if (!content) return;

      const discordChannelId = resolved.discordChannelId;
      if (!discordChannelId) {
        logger.warn(
          `[banano-vibe] Unable to resolve Discord channel id: ` +
            JSON.stringify({ ctxChannelId: msgCtx.channelId, conversationId: msgCtx.conversationId }),
        );
        return;
      }

      const messageId = (metadata.messageId ?? metadata.message_id ?? metadata.id) as string | undefined;
      const guildId = (metadata.guildId ?? metadata.guild_id) as string | undefined;
      // Prefer sender_id from inbound_meta, fall back to metadata fields
      const authorName = msg.from || (metadata.sender as string) || "unknown";

      // ── Mod controls ─────────────────────────────────────────────────
      if (content === "!banano stop" || content === "!banano start") {
        const authorized = await isModerator(metadata);
        if (!authorized) {
          logDecision(logger, "MOD_DENIED", { user: authorName, channel: discordChannelId });
          return;
        }
        if (content === "!banano stop") {
          silence(discordChannelId);
          await sendDiscord(discordChannelId, "aight aight, going quiet 🤫");
          logDecision(logger, "MOD_SILENCED", { user: authorName, channel: discordChannelId });
        } else {
          unsilence(discordChannelId);
          await sendDiscord(discordChannelId, "ape is back 🦍");
          logDecision(logger, "MOD_UNSILENCED", { user: authorName, channel: discordChannelId });
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
        logDecision(logger, "NOT_WATCHED", { channel: discordChannelId, source: resolved.source });
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
        author: authorName,
      });

      // ── Layer 2: Isolated AI vibe review ─────────────────────────────
      const recentMessages = await fetchRecentMessages(
        token,
        discordChannelId,
        messageId,
        config.maxRecentMessages,
        config.contextFilterBots,
      );

      const correlationId = crypto.randomUUID();
      const vibePrompt = buildVibeCheckPrompt(content, authorName, recentMessages);

      logDecision(logger, "VIBE_CHECK_START", {
        correlationId,
        channel: discordChannelId,
        author: authorName,
      });

      const rawResult = await runVibeReview(vibePrompt, correlationId);

      if (!rawResult) {
        stats.reviewErrors++;
        logDecision(logger, "VIBE_CHECK_ERROR", { correlationId, channel: discordChannelId });
        return;
      }

      const result = parseVibeResult(rawResult);
      if (!result) {
        stats.reviewErrors++;
        logDecision(logger, "VIBE_CHECK_ERROR", {
          correlationId,
          channel: discordChannelId,
          reason: "parse failure",
          raw: rawResult.slice(0, 200),
        });
        return;
      }

      if (!result.isToxic) {
        stats.falseAlarms++;
        logDecision(logger, "FALSE_ALARM", {
          correlationId,
          reason: result.reason,
          channel: discordChannelId,
        });
        return;
      }

      markAction(discordChannelId);

      const severityOrder = { low: 0, medium: 1, high: 2 };
      const minOrder = severityOrder[config.modEscalationMinSeverity];
      const resultOrder = severityOrder[result.severity] ?? 2;
      const isHighSeverity = result.severity === "high";
      const escalateToMod = resultOrder >= minOrder && !!config.modChannelId;
      const shouldReplyPublicly =
        result.suggestedResponse && (!isHighSeverity || config.highSeverityPublicReply);

      // In-channel response
      if (shouldReplyPublicly) {
        await sendDiscord(discordChannelId, result.suggestedResponse!);
        stats.mildResponses++;
        logDecision(logger, "MILD_RESPONSE", {
          correlationId,
          severity: result.severity,
          channel: discordChannelId,
          reason: result.reason,
        });
      }

      // Mod escalation
      if (escalateToMod) {
        const jumpLink =
          guildId && messageId
            ? `https://discord.com/channels/${guildId}/${discordChannelId}/${messageId}`
            : messageId
            ? `https://discord.com/channels/@me/${discordChannelId}/${messageId}`
            : null;

        const alert = [
          `🚨 **Vibe alert** in <#${discordChannelId}>`,
          `**User:** ${authorName}`,
          `**Message:** "${content.slice(0, 200)}"`,
          `**Severity:** ${result.severity}`,
          `**Reason:** ${result.reason}`,
        ];
        if (jumpLink) alert.push(`[Jump to message](${jumpLink})`);
        if (isHighSeverity && !config.highSeverityPublicReply) {
          alert.push(`_(silent escalation — no public reply sent)_`);
        }

        await sendDiscord(config.modChannelId!, alert.join("\n"));
        stats.escalations++;
        logDecision(logger, "HIGH_ESCALATION", {
          correlationId,
          severity: result.severity,
          channel: discordChannelId,
          reason: result.reason,
          hasJumpLink: !!jumpLink,
          silentEscalation: isHighSeverity && !config.highSeverityPublicReply,
        });
      }
    });
  },
};

export default plugin;
