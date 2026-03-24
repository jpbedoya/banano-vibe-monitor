/**
 * Banano Vibe Monitor — OpenClaw Plugin v1.6.0
 *
 * Two-layer vibe moderation for Discord channels:
 *   Layer 1: Local sentiment scoring (free, instant)
 *   Layer 2: AI vibe review via direct OpenRouter/Anthropic API call
 *
 * Hooks:
 *   message_received → sentiment gate → AI review → respond / escalate
 *
 * Install:
 *   openclaw plugins install ./plugin
 */

import { getSentimentScore } from "./sentiment.js";
import { buildVibeCheckPrompt, parseVibeResult } from "./vibe-check.js";
import type { RecentMessage } from "./vibe-check.js";
import { initState } from "./state.js";
import {
  initViolations,
  recordViolation,
  getMember,
  getRecentViolations,
  formatMemberViolations,
} from "./violations.js";
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
      sendMessageDiscord: (
        target: string,
        text: string,
        opts?: {
          cfg?: OpenClawConfig;
          replyTo?: string;
          accountId?: string;
          silent?: boolean;
          verbose?: boolean;
        },
      ) => Promise<unknown>;
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
  sentimentThreshold: number;
  maxRecentMessages: number;
  cooldownMs: number;
  dedupeWindowMs: number;
  contextFilterBots: boolean;
  modEscalationMinSeverity: "low" | "medium" | "high";
  highSeverityPublicReply: boolean;
  vibeReviewTimeoutMs: number;
  vibeModel: string | null;
  vibeModelFallbacks: string[];
};

function resolveConfig(pluginConfig?: Record<string, unknown>): VibeConfig {
  const cfg = pluginConfig || {};
  return {
    enabled: cfg.enabled !== false,
    watchedChannelIds: Array.isArray(cfg.watchedChannelIds) ? (cfg.watchedChannelIds as string[]) : [],
    modChannelId: typeof cfg.modChannelId === "string" ? cfg.modChannelId : null,
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
    vibeModel: typeof cfg.vibeModel === "string" ? cfg.vibeModel : null,
    vibeModelFallbacks: Array.isArray(cfg.vibeModelFallbacks) ? (cfg.vibeModelFallbacks as string[]) : [],
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

// ── API key resolution ───────────────────────────────────────────────────────

function resolveAuthProfiles(): Record<string, Record<string, unknown>> {
  try {
    const home = process.env.HOME || "/root";
    const authPath = path.join(home, ".openclaw", "agents", "main", "agent", "auth-profiles.json");
    if (fs.existsSync(authPath)) {
      const data = JSON.parse(fs.readFileSync(authPath, "utf8"));
      return (data?.profiles as Record<string, Record<string, unknown>>) ?? {};
    }
  } catch { /* */ }
  return {};
}

function resolveAnthropicKey(config: OpenClawConfig): string | null {
  try {
    const auth = config.auth as Record<string, unknown> | undefined;
    const profiles = auth?.profiles as Record<string, Record<string, unknown>> | undefined;
    if (profiles) {
      for (const profile of Object.values(profiles)) {
        if (profile.provider === "anthropic" && typeof profile.token === "string") {
          return profile.token;
        }
      }
    }
  } catch { /* */ }

  for (const profile of Object.values(resolveAuthProfiles())) {
    if (profile.provider === "anthropic") {
      if (typeof profile.token === "string") return profile.token;
      if (typeof profile.key === "string") return profile.key;
    }
  }
  return null;
}

function loadDotEnv(pluginDir: string): void {
  try {
    const envPath = path.join(pluginDir, ".env");
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key && val && !process.env[key]) {
        process.env[key] = val;
      }
    }
  } catch { /* best-effort */ }
}

function resolveOpenRouterKey(_config: OpenClawConfig): string | null {
  // 1. Dedicated env var — set via plugin .env or system env
  if (process.env.BANANO_OPENROUTER_KEY) return process.env.BANANO_OPENROUTER_KEY;

  // 2. Fall back to OpenClaw auth-profiles store
  for (const profile of Object.values(resolveAuthProfiles())) {
    if (profile.provider === "openrouter") {
      if (typeof profile.key === "string") return profile.key;
      if (typeof profile.token === "string") return profile.token;
    }
  }
  return null;
}

// ── Prompt sanitization ───────────────────────────────────────────────────────
// Prevent prompt injection: strip characters that could be used to smuggle
// fake JSON objects or break out of the prompt structure.

function sanitizeForPrompt(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/`/g, "'")
    .slice(0, 500); // hard cap on user content length in prompt
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

  // Require an explicit discord signal — don't match on bare "channel:" prefix
  // which could be used by other providers (Slack, etc.)
  const isDiscord =
    [provider, channel, surface, ctxChannelId].includes("discord") ||
    chatId.startsWith("discord:") ||
    conversationId.startsWith("discord:");

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

function resolveAuthorName(msg: MessageReceivedEvent, metadata: Record<string, unknown> | undefined): string {
  const md = metadata || {};
  const candidates = [
    typeof md.senderName === "string" ? md.senderName : null,
    typeof md.senderUsername === "string" ? md.senderUsername : null,
    typeof md.username === "string" ? md.username : null,
    typeof md.tag === "string" ? md.tag : null,
    typeof md.name === "string" ? md.name : null,
    typeof md.sender === "string" ? md.sender : null,
    typeof md.label === "string" ? md.label : null,
    typeof msg.from === "string" ? msg.from : null,
  ];

  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    if (/^(?:discord:|channel:)\d+$/.test(trimmed)) continue;
    return trimmed;
  }

  const senderId = typeof md.senderId === "string" ? md.senderId.trim() : "";
  if (senderId) return `user:${senderId}`;
  return "unknown";
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

// ── Dedupe / cooldown state ───────────────────────────────────────────────────

const handledMessages = new Map<string, number>();
const channelCooldowns = new Map<string, number>();
const claimedChannelReplies = new Map<string, number>();
const allowedPluginMessages = new Map<string, number>();

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

function cleanupExpiringMap(map: Map<string, number>, now = Date.now()): void {
  for (const [key, expiresAt] of map) {
    if (expiresAt <= now) map.delete(key);
  }
}

function claimChannelReply(channelId: string, windowMs: number): void {
  cleanupExpiringMap(claimedChannelReplies);
  claimedChannelReplies.set(channelId, Date.now() + windowMs);
}

function releaseChannelReply(channelId: string): void {
  claimedChannelReplies.delete(channelId);
}

function isClaimedChannelReply(channelId: string): boolean {
  cleanupExpiringMap(claimedChannelReplies);
  const expiresAt = claimedChannelReplies.get(channelId);
  return !!expiresAt && expiresAt > Date.now();
}

function hasAnyClaimedWatchedChannel(watchedChannelIds: string[]): boolean {
  cleanupExpiringMap(claimedChannelReplies);
  return watchedChannelIds.some((channelId) => {
    const expiresAt = claimedChannelReplies.get(channelId);
    return !!expiresAt && expiresAt > Date.now();
  });
}

function allowPluginMessage(channelId: string, content: string, windowMs = 15_000): void {
  cleanupExpiringMap(allowedPluginMessages);
  // Truncate content key to avoid unbounded map keys from very long messages
  allowedPluginMessages.set(`${channelId}::${content.slice(0, 200)}`, Date.now() + windowMs);
}

function consumeAllowedPluginMessage(channelId: string, content: string): boolean {
  cleanupExpiringMap(allowedPluginMessages);
  const key = `${channelId}::${content.slice(0, 200)}`;
  const expiresAt = allowedPluginMessages.get(key);
  if (!expiresAt || expiresAt <= Date.now()) return false;
  allowedPluginMessages.delete(key);
  return true;
}

// ── Structured log helper ─────────────────────────────────────────────────────

type Decision =
  | "NOT_WATCHED"
  | "DEDUPE"
  | "COOLDOWN"
  | "SENTIMENT_PASS"
  | "SENTIMENT_FLAG"
  | "TURN_CLAIMED"
  | "NORMAL_REPLY_SUPPRESSED"
  | "VIBE_CHECK_START"
  | "VIBE_CHECK_ERROR"
  | "FALSE_ALARM"
  | "MILD_RESPONSE"
  | "HIGH_ESCALATION";

const LOGGED_DECISIONS = new Set<Decision>([
  "SENTIMENT_FLAG",
  "TURN_CLAIMED",
  "NORMAL_REPLY_SUPPRESSED",
  "VIBE_CHECK_START",
  "VIBE_CHECK_ERROR",
  "FALSE_ALARM",
  "MILD_RESPONSE",
  "HIGH_ESCALATION",
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

// ── Direct Discord Gateway WebSocket listener ────────────────────────────────
// Bypasses OpenClaw's message routing so ALL messages in watched channels
// are processed regardless of allowlists. Runs independently alongside
// OpenClaw's own Discord connection (same token, separate WS connection —
// Discord supports multiple gateway connections per bot token).

const DISCORD_GATEWAY_URL = "https://discord.com/api/v10/gateway";
const DISCORD_INTENT_GUILD_MESSAGES = 1 << 9;  // GUILD_MESSAGES
const DISCORD_INTENT_MESSAGE_CONTENT = 1 << 15; // MESSAGE_CONTENT

// Discord close codes that are non-recoverable — do not reconnect on these.
const FATAL_CLOSE_CODES = new Set([
  4004, // Authentication failed
  4010, // Invalid shard
  4011, // Sharding required
  4012, // Invalid API version
  4013, // Invalid intent(s)
  4014, // Disallowed intent(s) — MESSAGE_CONTENT not enabled in developer portal
]);

type GatewayMessage = {
  op: number;
  d?: unknown;
  t?: string;
  s?: number;
};

type DiscordMessageEvent = {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  author: {
    id: string;
    username: string;
    bot?: boolean;
  };
};

function startDirectGateway(
  token: string,
  watchedChannelIds: string[],
  onMessage: (msg: DiscordMessageEvent) => Promise<void>,
  logger: PluginLogger,
): { stop: () => void } {
  let ws: WebSocket | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let sequence: number | null = null;
  let sessionId: string | null = null;
  let resumeGatewayUrl: string | null = null;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const WS = (globalThis as any).WebSocket as typeof globalThis.WebSocket;

  async function getGatewayUrl(): Promise<string> {
    try {
      const res = await fetch(`${DISCORD_GATEWAY_URL}/bot`, {
        headers: { Authorization: `Bot ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json() as { url?: string };
        return data.url ? `${data.url}/?v=10&encoding=json` : "wss://gateway.discord.gg/?v=10&encoding=json";
      }
    } catch { /* */ }
    return "wss://gateway.discord.gg/?v=10&encoding=json";
  }

  function startHeartbeat(intervalMs: number): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    // Send first heartbeat after a random jitter (per Discord docs)
    const jitter = Math.random() * intervalMs;
    setTimeout(() => {
      if (ws?.readyState === WS.OPEN) {
        ws.send(JSON.stringify({ op: 1, d: sequence }));
      }
      heartbeatTimer = setInterval(() => {
        if (ws?.readyState === WS.OPEN) {
          ws.send(JSON.stringify({ op: 1, d: sequence }));
        }
      }, intervalMs);
    }, jitter);
  }

  function connect(url?: string): void {
    if (stopped) return;

    const connectUrl = url || resumeGatewayUrl || "wss://gateway.discord.gg/?v=10&encoding=json";

    try {
      ws = new WS(connectUrl);
    } catch (err) {
      logger.error(`[banano-vibe] Direct gateway WS constructor error: ${err}`);
      scheduleReconnect();
      return;
    }

    ws.addEventListener("open", () => {
      logger.info("[banano-vibe] Direct gateway connected");
    });

    ws.addEventListener("message", async (event: MessageEvent) => {
      let payload: GatewayMessage;
      try {
        payload = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString()) as GatewayMessage;
      } catch {
        return;
      }

      if (payload.s !== undefined && payload.s !== null) {
        sequence = payload.s;
      }

      // op 1 = Heartbeat request from server — respond immediately
      if (payload.op === 1) {
        if (ws?.readyState === WS.OPEN) {
          ws.send(JSON.stringify({ op: 1, d: sequence }));
        }
      }

      // op 10 = Hello
      if (payload.op === 10) {
        const heartbeatInterval = (payload.d as { heartbeat_interval: number }).heartbeat_interval;
        startHeartbeat(heartbeatInterval);

        if (sessionId && resumeGatewayUrl) {
          ws?.send(JSON.stringify({
            op: 6,
            d: { token, session_id: sessionId, seq: sequence },
          }));
        } else {
          ws?.send(JSON.stringify({
            op: 2,
            d: {
              token,
              intents: DISCORD_INTENT_GUILD_MESSAGES | DISCORD_INTENT_MESSAGE_CONTENT,
              properties: { os: "linux", browser: "banano-vibe", device: "banano-vibe" },
            },
          }));
        }
      }

      // op 0 = Dispatch
      if (payload.op === 0 && payload.t) {
        if (payload.t === "READY") {
          const d = payload.d as { session_id: string; resume_gateway_url: string };
          sessionId = d.session_id;
          resumeGatewayUrl = `${d.resume_gateway_url}/?v=10&encoding=json`;
          logger.info("[banano-vibe] Direct gateway ready");
        }

        if (payload.t === "RESUMED") {
          logger.info("[banano-vibe] Direct gateway resumed");
        }

        if (payload.t === "MESSAGE_CREATE") {
          const msg = payload.d as DiscordMessageEvent;
          if (msg.author?.bot) return;
          if (!watchedChannelIds.includes(msg.channel_id)) return;
          try {
            await onMessage(msg);
          } catch (err) {
            logger.error(`[banano-vibe] Direct gateway message handler error: ${err}`);
          }
        }
      }

      // op 7 = Reconnect requested
      if (payload.op === 7) {
        logger.info("[banano-vibe] Direct gateway reconnect requested");
        ws?.close();
      }

      // op 9 = Invalid session
      if (payload.op === 9) {
        const resumable = payload.d as boolean;
        if (!resumable) {
          sessionId = null;
          resumeGatewayUrl = null;
          sequence = null;
        }
        ws?.close();
      }

      // op 11 = Heartbeat ACK — no action needed
    });

    ws.addEventListener("close", (event: CloseEvent) => {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      if (stopped) return;

      if (FATAL_CLOSE_CODES.has(event.code)) {
        logger.error(
          `[banano-vibe] Direct gateway closed with fatal code ${event.code} — not reconnecting. ` +
          `Check that MESSAGE_CONTENT intent is enabled in the Discord developer portal.`
        );
        return; // Do not reconnect on fatal errors
      }

      logger.info(`[banano-vibe] Direct gateway closed (code ${event.code}), reconnecting...`);
      scheduleReconnect();
    });

    ws.addEventListener("error", (event: Event) => {
      logger.error(`[banano-vibe] Direct gateway error: ${event}`);
    });
  }

  function scheduleReconnect(delayMs = 5000): void {
    if (stopped) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (!stopped) connect();
    }, delayMs);
  }

  getGatewayUrl().then((url) => {
    if (!stopped) connect(url);
  }).catch(() => {
    if (!stopped) connect();
  });

  return {
    stop() {
      stopped = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}

// ── Singleton guard ───────────────────────────────────────────────────────────
// OpenClaw may call register() multiple times per lifecycle. Without this guard,
// each call spawns a new Discord gateway connection and a duplicate message_sending hook.

let _registered = false;

const plugin = {
  id: "banano-vibe",
  name: "Banano Vibe Monitor",
  description: "Two-layer vibe moderation for Discord: local sentiment gate + isolated AI review.",
  version: "1.6.0",

  register(api: PluginApi) {
    // Load .env first (needed for enabled check to work with env-driven config)
    loadDotEnv(api.resolvePath("."));

    const config = resolveConfig(api.pluginConfig);
    const logger = api.logger;

    if (!config.enabled) {
      logger.info("[banano-vibe] Plugin disabled via config");
      return;
    }

    // Singleton guard — after enabled check so disabling/re-enabling works correctly
    if (_registered) {
      logger.info("[banano-vibe] Already registered — skipping duplicate register()");
      return;
    }
    _registered = true;

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
    initViolations(stateDir);

    logger.info(
      `[banano-vibe] Active v1.6.0 | watching: ${config.watchedChannelIds.join(", ") || "none"} | ` +
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
          "🦍 **Banano Vibe Monitor v1.6.0**",
          `Enabled: ${config.enabled}`,
          `Watching: ${config.watchedChannelIds.join(", ") || "none"}`,
          `Mod channel: ${config.modChannelId || "none"}`,
          `Threshold: ${config.sentimentThreshold}`,
          `Cooldown: ${config.cooldownMs}ms`,
          `Escalation min severity: ${config.modEscalationMinSeverity}`,
          `High severity public reply: ${config.highSeverityPublicReply}`,
          `Review timeout: ${config.vibeReviewTimeoutMs}ms`,
          `Review model: ${config.vibeModel || "default"}`,
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

    // ── /vibe_violations command ─────────────────────────────────────────
    api.registerCommand({
      name: "vibe_violations",
      description: "Show violation history. Usage: /vibe_violations [userId]",
      acceptsArgs: true,
      handler: ({ args }) => {
        const userId = args?.trim().replace(/^<@!?/, "").replace(/>$/, "");
        if (userId) {
          const member = getMember(userId);
          if (!member) return { text: `No violations on record for <@${userId}>.` };
          return { text: formatMemberViolations(member) };
        }
        const recent = getRecentViolations(30);
        if (recent.length === 0) return { text: "No violations in the last 30 days." };
        const lines = ["**Recent violations (last 30 days):**"];
        for (const m of recent.slice(0, 10)) {
          lines.push(`• **${m.username}** — ${m.strikes} strike${m.strikes !== 1 ? "s" : ""} | last: ${m.latestViolation.date} | ${m.latestViolation.severity}`);
        }
        return { text: lines.join("\n") };
      },
    });

    // ── Send to Discord ──────────────────────────────────────────────────
    async function sendDiscord(channelId: string, content: string, replyToMessageId?: string): Promise<void> {
      try {
        const text = typeof content === "string" ? content : String(content ?? "");
        allowPluginMessage(channelId, text);
        await api.runtime.channel.discord.sendMessageDiscord(`channel:${channelId}`, text, {
          cfg: api.config,
          replyTo: replyToMessageId,
          verbose: false,
        });
      } catch (err) {
        logger.error(`[banano-vibe] Send failed (${channelId}): ${err}`);
      }
    }

    // ── Vibe review — multi-provider with fallback ───────────────────────
    const DEFAULT_VIBE_MODEL = "openrouter/google/gemma-3-27b-it:free";
    const DEFAULT_VIBE_FALLBACKS = [
      "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      "openrouter/nvidia/nemotron-3-nano-30b-a3b:free",
      "anthropic/claude-haiku-4-5",
    ];

    function isOpenRouterModel(m: string): boolean {
      return m.startsWith("openrouter/");
    }

    async function runVibeReviewSingle(
      prompt: string,
      vibeModel: string,
    ): Promise<{ raw: string | null; error?: string; retryable?: boolean }> {
      try {
        if (isOpenRouterModel(vibeModel)) {
          const orKey = resolveOpenRouterKey(api.config);
          if (!orKey) return { raw: null, error: "No OpenRouter API key configured" };

          const model = vibeModel.replace(/^openrouter\//, "");

          const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${orKey}`,
              "HTTP-Referer": "https://monkedao.io",
              "X-Title": "Banano Vibe Monitor",
            },
            body: JSON.stringify({
              model,
              max_tokens: 1024,
              messages: [{ role: "user", content: prompt }],
            }),
            signal: AbortSignal.timeout(config.vibeReviewTimeoutMs),
          });

          if (!res.ok) {
            const body = await res.text().catch(() => "");
            const retryable = res.status === 429 || res.status >= 500;
            return { raw: null, error: `OpenRouter API ${res.status}: ${body.slice(0, 200)}`, retryable };
          }

          const data = await res.json() as {
            choices?: Array<{
              message?: {
                content?: string | null;
                reasoning_content?: string | null;
              };
              finish_reason?: string;
            }>;
          };

          const choice = data.choices?.[0];
          const msg = choice?.message;
          const text = (msg?.content?.trim() || msg?.reasoning_content?.trim()) ?? "";

          if (!text) {
            logger.warn(`[banano-vibe] OpenRouter empty response — finish_reason: ${choice?.finish_reason ?? "unknown"}`);
            return { raw: null, error: "empty response from OpenRouter", retryable: true };
          }
          return { raw: text };

        } else {
          const anthropicKey = resolveAnthropicKey(api.config);
          if (!anthropicKey) return { raw: null, error: "No Anthropic API key configured" };

          const model = vibeModel.replace(/^anthropic\//, "");

          const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": anthropicKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model,
              max_tokens: 1024,
              messages: [{ role: "user", content: prompt }],
            }),
            signal: AbortSignal.timeout(config.vibeReviewTimeoutMs),
          });

          if (!res.ok) {
            const body = await res.text().catch(() => "");
            const retryable = res.status === 429 || res.status >= 500;
            return { raw: null, error: `Anthropic API ${res.status}: ${body.slice(0, 200)}`, retryable };
          }

          const data = await res.json() as {
            content?: Array<{ type: string; text?: string }>;
          };

          const text = data.content?.find((b) => b.type === "text")?.text?.trim();
          if (!text) return { raw: null, error: "empty response from Anthropic", retryable: true };
          return { raw: text };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[banano-vibe] Vibe review error (${vibeModel}): ${msg}`);
        return { raw: null, error: msg, retryable: true };
      }
    }

    async function runVibeReview(
      prompt: string,
    ): Promise<{ raw: string | null; error?: string; modelUsed?: string }> {
      const primary = config.vibeModel || DEFAULT_VIBE_MODEL;
      const fallbacks = config.vibeModelFallbacks.length > 0
        ? config.vibeModelFallbacks
        : DEFAULT_VIBE_FALLBACKS;

      const chain = [primary, ...fallbacks.filter((m) => m !== primary)];

      let lastError = "unknown error";
      for (const model of chain) {
        const result = await runVibeReviewSingle(prompt, model);
        if (result.raw !== null) {
          if (model !== primary) {
            logger.info(`[banano-vibe] Vibe review succeeded via fallback: ${model}`);
          }
          return { raw: result.raw, modelUsed: model };
        }
        lastError = result.error ?? "unknown error";
        if (!result.retryable) {
          return { raw: null, error: lastError };
        }
        logger.warn(`[banano-vibe] Model ${model} failed (${lastError}), trying next fallback...`);
      }

      return { raw: null, error: `All models failed. Last error: ${lastError}` };
    }

    // ── message_sending hook ────────────────────────────────────────────
    // Suppresses normal OpenClaw replies in watched Discord channels when
    // the plugin has claimed the turn for moderation. Only fires for Discord.
    api.on("message_sending", async (event: unknown, ctx: unknown) => {
      const outgoing = event as { to?: string; content?: string; metadata?: Record<string, unknown> };
      const msgCtx = ctx as MessageContext;

      // Only suppress Discord outgoing messages — never Telegram, Signal, etc.
      const eventChannel = typeof outgoing.metadata?.channel === "string" ? outgoing.metadata.channel : "";
      const ctxChannel = typeof msgCtx.channelId === "string" ? msgCtx.channelId : "";
      const isDiscordOutgoing = eventChannel === "discord" || ctxChannel === "discord";
      if (!isDiscordOutgoing) return {};

      const content = typeof outgoing.content === "string" ? outgoing.content.trim() : "";
      const target = typeof outgoing.to === "string" ? outgoing.to : "";

      const directChannelId =
        extractTrailingId(target) ||
        extractTrailingId(msgCtx.conversationId) ||
        extractTrailingId(msgCtx.channelId);

      const suppressionChannelId =
        directChannelId && config.watchedChannelIds.includes(directChannelId)
          ? directChannelId
          : null;

      if (!suppressionChannelId) return {};
      if (consumeAllowedPluginMessage(suppressionChannelId, content)) return {};
      if (!isClaimedChannelReply(suppressionChannelId)) return {};

      logDecision(logger, "NORMAL_REPLY_SUPPRESSED", {
        channel: suppressionChannelId,
        preview: content.slice(0, 100),
        target,
        eventChannel,
      });
      return { cancel: true };
    });

    // ── Core message processing ──────────────────────────────────────────
    async function processVibeMessage(
      discordChannelId: string,
      content: string,
      authorId: string | undefined,
      authorName: string,
      messageId: string | undefined,
      guildId: string | undefined,
    ): Promise<void> {

      // Skip non-watched channels
      if (!config.watchedChannelIds.includes(discordChannelId)) {
        logDecision(logger, "NOT_WATCHED", { channel: discordChannelId });
        return;
      }

      // Dedupe — messageId is always present from the direct gateway path
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
      if (score > config.sentimentThreshold) {
        logDecision(logger, "SENTIMENT_PASS", {
          score,
          threshold: config.sentimentThreshold,
          channel: discordChannelId,
        });
        return;
      }

      stats.flagged++;
      claimChannelReply(discordChannelId, config.vibeReviewTimeoutMs * 2 + 15_000);
      logDecision(logger, "SENTIMENT_FLAG", {
        score,
        threshold: config.sentimentThreshold,
        channel: discordChannelId,
        preview: content.slice(0, 60),
        author: authorName,
        authorId,
      });
      logDecision(logger, "TURN_CLAIMED", {
        channel: discordChannelId,
        messageId,
        author: authorName,
        authorId,
      });

      // ── Layer 2: AI vibe review ──────────────────────────────────────
      const recentMessages = await fetchRecentMessages(
        token,
        discordChannelId,
        messageId,
        config.maxRecentMessages,
        config.contextFilterBots,
      );

      const correlationId = crypto.randomUUID();
      // Sanitize user content before inserting into the prompt
      const safeContent = sanitizeForPrompt(content);
      const safeAuthor = sanitizeForPrompt(authorName);
      const safeRecentMessages = recentMessages.map((m) => ({
        author: sanitizeForPrompt(m.author),
        content: sanitizeForPrompt(m.content),
      }));
      const vibePrompt = buildVibeCheckPrompt(safeContent, safeAuthor, safeRecentMessages);

      logDecision(logger, "VIBE_CHECK_START", {
        correlationId,
        channel: discordChannelId,
        author: authorName,
        authorId,
      });

      const review = await runVibeReview(vibePrompt);

      if (!review.raw) {
        stats.reviewErrors++;
        const errorSummary = review.error || "unknown review failure";
        logDecision(logger, "VIBE_CHECK_ERROR", {
          correlationId,
          channel: discordChannelId,
          author: authorName,
          authorId,
          error: errorSummary,
        });
        releaseChannelReply(discordChannelId);
        if (config.modChannelId) {
          const jumpLink =
            guildId && messageId
              ? `https://discord.com/channels/${guildId}/${discordChannelId}/${messageId}`
              : null;
          const alert = [
            `⚠️ **Vibe review failed** in <#${discordChannelId}>`,
            `**User:** ${authorName}${authorId ? ` (<@${authorId}>)` : ""}`,
            `**User ID:** ${authorId ?? "unknown"}`,
            `**Message:** "${content.slice(0, 200)}"`,
            `**Error:** ${errorSummary}`,
          ];
          if (jumpLink) alert.push(`[Jump to message](${jumpLink})`);
          await sendDiscord(config.modChannelId, alert.join("\n"));
        }
        return;
      }

      const result = parseVibeResult(review.raw);
      if (!result) {
        stats.reviewErrors++;
        logDecision(logger, "VIBE_CHECK_ERROR", {
          correlationId,
          channel: discordChannelId,
          author: authorName,
          authorId,
          reason: "parse failure",
          raw: review.raw.slice(0, 200),
        });
        releaseChannelReply(discordChannelId);
        if (config.modChannelId) {
          await sendDiscord(
            config.modChannelId,
            [
              `⚠️ **Vibe review parse failure** in <#${discordChannelId}>`,
              `**User:** ${authorName}${authorId ? ` (<@${authorId}>)` : ""}`,
              `**User ID:** ${authorId ?? "unknown"}`,
              `**Message:** "${content.slice(0, 200)}"`,
              `**Model:** ${review.modelUsed ?? "unknown"}`,
              `**Raw:** \`${review.raw.slice(0, 180)}\``,
            ].join("\n"),
          );
        }
        return;
      }

      if (!result.isToxic) {
        stats.falseAlarms++;
        releaseChannelReply(discordChannelId);
        logDecision(logger, "FALSE_ALARM", {
          correlationId,
          reason: result.reason,
          channel: discordChannelId,
        });
        return;
      }

      markAction(discordChannelId);
      // Release claim immediately after processing — don't hold it for the full timeout
      releaseChannelReply(discordChannelId);

      const severityOrder = { low: 0, medium: 1, high: 2 };
      const minOrder = severityOrder[config.modEscalationMinSeverity];
      const resultOrder = severityOrder[result.severity] ?? 2;
      const isHighSeverity = result.severity === "high";
      const escalateToMod = resultOrder >= minOrder && !!config.modChannelId;
      const shouldReplyPublicly =
        result.suggestedResponse && (!isHighSeverity || config.highSeverityPublicReply);

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

      if (escalateToMod) {
        const jumpLink =
          guildId && messageId
            ? `https://discord.com/channels/${guildId}/${discordChannelId}/${messageId}`
            : null;

        let memberRecord = null;
        if (authorId) {
          memberRecord = recordViolation({
            userId: authorId,
            username: authorName,
            reason: result.reason,
            severity: result.severity,
            channelId: discordChannelId,
            messageId,
            guildId,
          });
        }

        const strikeText = memberRecord ? ` (Strike #${memberRecord.strikes})` : "";

        const alert = [
          `🚨 **Vibe alert** in <#${discordChannelId}>${strikeText}`,
          `**User:** ${authorName}${authorId ? ` (<@${authorId}>)` : ""}`,
          `**User ID:** ${authorId ?? "unknown"}`,
          `**Message:** "${content.slice(0, 200)}"`,
          `**Severity:** ${result.severity}`,
          `**Reason:** ${result.reason}`,
          `**Model:** ${review.modelUsed ?? "unknown"}`,
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
          author: authorName,
          authorId,
          reason: result.reason,
          hasJumpLink: !!jumpLink,
          silentEscalation: isHighSeverity && !config.highSeverityPublicReply,
        });
      }
    }

    // ── message_received hook (OpenClaw-routed messages) ─────────────────
    api.on("message_received", async (event: unknown, ctx: unknown) => {
      const msg = event as MessageReceivedEvent;
      const msgCtx = ctx as MessageContext;
      const metadata = msg.metadata || {};

      const resolved = resolveDiscordContext(msgCtx, metadata);
      if (!resolved.isDiscord) return;

      const content = msg.content?.trim();
      if (!content) return;

      const discordChannelId = resolved.discordChannelId;
      if (!discordChannelId) return;

      const messageId = (metadata.messageId ?? metadata.message_id ?? metadata.id) as string | undefined;
      const guildId = (metadata.guildId ?? metadata.guild_id) as string | undefined;
      const authorId = (metadata.senderId ?? metadata.userId ?? metadata.sender_id ?? metadata.user_id) as string | undefined;
      const authorName = resolveAuthorName(msg, metadata);

      await processVibeMessage(discordChannelId, content, authorId, authorName, messageId, guildId);
    });

    // ── Direct Discord gateway (sees ALL messages, bypasses OpenClaw routing) ──
    const directGateway = startDirectGateway(
      token,
      config.watchedChannelIds,
      async (msg: DiscordMessageEvent) => {
        const content = msg.content?.trim();
        if (!content) return;
        await processVibeMessage(
          msg.channel_id,
          content,
          msg.author.id,
          msg.author.username,
          msg.id,
          msg.guild_id,
        );
      },
      logger,
    );

    logger.info("[banano-vibe] Direct gateway listener started — watching all messages in watched channels");

    // Clean up on plugin unload
    if (typeof (api as Record<string, unknown>).onUnload === "function") {
      ((api as Record<string, unknown>).onUnload as (fn: () => void) => void)(() => {
        directGateway.stop();
        _registered = false; // Reset so plugin can be re-registered after unload
      });
    }
  },
};

export default plugin;
