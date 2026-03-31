/**
 * Banano Vibe Monitor — OpenClaw Plugin v2.4.0
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

import { getSentimentScore, isLikelyNonEnglish, containsKnownSlur, initSlurConfig } from "./sentiment.js";
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
import * as fsp from "fs/promises";
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

// ── In-process message deduplication ─────────────────────────────────────────
// Uses a globalThis Set to deduplicate message IDs across all code paths and
// all jiti module reloads within the same Node.js process. Since OpenClaw calls
// register() multiple times during startup (reload cycles), multiple gateway
// instances can briefly coexist. The shared Set ensures only the first caller
// processes any given message ID — the rest skip immediately.

function tryClaimMessage(messageId: string): boolean {
  // Check in-memory set first — fastest, covers all code paths in this process
  const ids = claimedIds();
  if (ids.has(messageId)) return false;
  ids.add(messageId);

  // Periodically prune old IDs to avoid unbounded growth (keep last 1000)
  if (ids.size > 1000) {
    const toDelete = [...ids].slice(0, ids.size - 1000);
    for (const id of toDelete) ids.delete(id);
  }

  return true;
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

// ── Discord markdown escaping ─────────────────────────────────────────────────
// Escape user-controlled content before inserting into Discord messages
// to prevent markdown injection in mod alerts.

function escapeDiscordMarkdown(text: string): string {
  return text.replace(/([*_`~|>\\])/g, "\\$1");
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

// Counter for gateway instances — increments each time startDirectGateway is called.
// Used in diagnostic logs to confirm only one instance is active at a time.
let _gatewayInstanceCount = 0;

function startDirectGateway(
  token: string,
  watchedChannelIds: string[],
  onMessage: (msg: DiscordMessageEvent) => Promise<void>,
  logger: PluginLogger,
): { stop: () => void } {
  const instanceId = ++_gatewayInstanceCount;
  let ws: WebSocket | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatJitterTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatIntervalMs = 0;
  let lastHeartbeatAckAt = 0;
  let awaitingAck = false;
  let sequence: number | null = null;
  let sessionId: string | null = null;
  let resumeGatewayUrl: string | null = null;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let messageCount = 0;

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

  function clearHeartbeatTimers(): void {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (heartbeatJitterTimer) { clearTimeout(heartbeatJitterTimer); heartbeatJitterTimer = null; }
  }

  function sendHeartbeat(): void {
    if (ws?.readyState !== WS.OPEN) return;

    // If we sent a heartbeat and never got an ACK back, the connection is zombie.
    // Close it and let the reconnect logic handle recovery.
    if (awaitingAck) {
      logger.warn(`[banano-vibe] No heartbeat ACK received — zombie connection detected [instance=${instanceId}]`);
      clearHeartbeatTimers();
      ws?.close(4000, "Zombie connection: no heartbeat ACK");
      return;
    }

    awaitingAck = true;
    ws.send(JSON.stringify({ op: 1, d: sequence }));
  }

  function startHeartbeat(intervalMs: number): void {
    clearHeartbeatTimers();
    heartbeatIntervalMs = intervalMs;
    lastHeartbeatAckAt = Date.now();
    awaitingAck = false;

    // Send first heartbeat after a random jitter (per Discord docs)
    const jitter = Math.random() * intervalMs;
    heartbeatJitterTimer = setTimeout(() => {
      heartbeatJitterTimer = null;
      sendHeartbeat();
      heartbeatTimer = setInterval(sendHeartbeat, intervalMs);
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
      logger.info(`[banano-vibe] Direct gateway connected [instance=${instanceId}]`);
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
        awaitingAck = false; // server-initiated heartbeat resets the ACK expectation
        if (ws?.readyState === WS.OPEN) {
          ws.send(JSON.stringify({ op: 1, d: sequence }));
          awaitingAck = true;
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
          logger.info(`[banano-vibe] Direct gateway ready [instance=${instanceId} discordSession=${sessionId.slice(0, 8)}]`);
        }

        if (payload.t === "RESUMED") {
          logger.info("[banano-vibe] Direct gateway resumed");
        }

        if (payload.t === "MESSAGE_CREATE") {
          const msg = payload.d as DiscordMessageEvent;
          if (msg.author?.bot) return;
          if (!watchedChannelIds.includes(msg.channel_id)) return;
          messageCount++;
          logger.info(`[banano-vibe] DIAG_MESSAGE_RECEIVED instance=${instanceId} discordSession=${sessionId?.slice(0,8)} seq=${sequence} msgId=${msg.id} author=${msg.author.username} msgCount=${messageCount}`);
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

      // op 11 = Heartbeat ACK — mark connection as healthy
      if (payload.op === 11) {
        awaitingAck = false;
        lastHeartbeatAckAt = Date.now();
      }
    });

    ws.addEventListener("close", (event: CloseEvent) => {
      clearHeartbeatTimers();
      awaitingAck = false;
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
      logger.info(`[banano-vibe] Direct gateway stopping [instance=${instanceId}]`);
      stopped = true;
      clearHeartbeatTimers();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}

// ── Singleton guard ───────────────────────────────────────────────────────────
// OpenClaw may call register() multiple times per lifecycle (config reload via
// SIGUSR1 reuses the Node module cache, so module-level state persists).
// We track the running gateway instance and stop it before starting a new one,
// ensuring there is always exactly one active WS connection regardless of how
// many times register() is called.

// Use globalThis to persist state across jiti module reloads within the same
// Node.js process. Module-level variables are reset on every jiti reimport,
// but globalThis survives, making it the correct singleton store.
const _global = globalThis as typeof globalThis & {
  __bananoVibeRegistered?: boolean;
  __bananoVibeGateway?: { stop: () => void } | null;
  __bananoVibeClaimedIds?: Set<string>;
};
if (_global.__bananoVibeRegistered === undefined) _global.__bananoVibeRegistered = false;
if (_global.__bananoVibeGateway === undefined) _global.__bananoVibeGateway = null;
if (_global.__bananoVibeClaimedIds === undefined) _global.__bananoVibeClaimedIds = new Set();

// Convenience accessors
function isRegistered(): boolean { return !!_global.__bananoVibeRegistered; }
function setRegistered(v: boolean): void { _global.__bananoVibeRegistered = v; }
function getActiveGateway(): { stop: () => void } | null { return _global.__bananoVibeGateway ?? null; }
function setActiveGateway(gw: { stop: () => void } | null): void { _global.__bananoVibeGateway = gw; }
function claimedIds(): Set<string> { return _global.__bananoVibeClaimedIds!; }

const plugin = {
  id: "banano-vibe",
  name: "Banano Vibe Monitor",
  description: "Two-layer vibe moderation for Discord: local sentiment gate + isolated AI review.",
  version: "2.4.0",

  register(api: PluginApi) {
    // Load .env first (needed for enabled check to work with env-driven config)
    loadDotEnv(api.resolvePath("."));
    // Load external slur config (slur-config.json) from plugin directory
    initSlurConfig(api.resolvePath("."));
    api.logger.info(`[banano-vibe] DIAG_REGISTER_CALLED _registered=${isRegistered()} _activeGateway=${getActiveGateway() !== null}`);

    const config = resolveConfig(api.pluginConfig);
    const logger = api.logger;

    if (!config.enabled) {
      logger.info("[banano-vibe] Plugin disabled via config");
      return;
    }

    // Singleton guard — ensure exactly one active gateway at all times.
    // SIGUSR1 config reloads reuse the Node module cache and call register()
    // multiple times concurrently. We set _registered = true immediately to
    // block concurrent calls, then stop the old gateway if one exists.
    if (isRegistered()) {
      const existing = getActiveGateway();
      if (existing) {
        logger.info("[banano-vibe] Reloading — stopping existing gateway");
        existing.stop();
        setActiveGateway(null);
      }
      // If registered but no active gateway, fall through and re-register the hook
    }
    setRegistered(true);

    if (config.watchedChannelIds.length === 0) {
      logger.warn("[banano-vibe] No watched channels configured — plugin will not trigger");
    }

    // Token still needed for REST API calls (fetchRecentMessages context window)
    const discordToken = resolveDiscordToken(api.config);
    if (!discordToken) {
      logger.error("[banano-vibe] No Discord token in OpenClaw config — cannot fetch message context");
      return;
    }
    const token: string = discordToken;

    const stateDir = api.resolvePath(".");
    initState(stateDir);
    initVibeLog(stateDir);
    initViolations(stateDir);

    logger.info(
      `[banano-vibe] Active v2.4.0 | watching: ${config.watchedChannelIds.join(", ") || "none"} | ` +
        `mod: ${config.modChannelId || "none"} | threshold: ${config.sentimentThreshold}`,
    );

    // ── Persistent stats ─────────────────────────────────────────────────
    const statsPath = path.join(stateDir, "stats.json");
    let statsTimer: ReturnType<typeof setTimeout> | null = null;

    type VibeStats = {
      flagged: number;
      falseAlarms: number;
      mildResponses: number;
      escalations: number;
      cooldownSuppressed: number;
      dedupeSuppressed: number;
      reviewErrors: number;
      startedAt: number;
      lastSaved: string;
    };

    function loadStats(): VibeStats {
      try {
        if (fs.existsSync(statsPath)) {
          return JSON.parse(fs.readFileSync(statsPath, "utf8")) as VibeStats;
        }
      } catch { /* */ }
      return {
        flagged: 0, falseAlarms: 0, mildResponses: 0, escalations: 0,
        cooldownSuppressed: 0, dedupeSuppressed: 0, reviewErrors: 0,
        startedAt: Date.now(), lastSaved: new Date().toISOString(),
      };
    }

    function scheduleStatsSave(): void {
      if (statsTimer) clearTimeout(statsTimer);
      statsTimer = setTimeout(() => {
        statsTimer = null;
        stats.lastSaved = new Date().toISOString();
        fsp.writeFile(statsPath, JSON.stringify(stats, null, 2), "utf8").catch(() => { /* best-effort */ });
      }, 2000);
    }

    const stats = loadStats();

    // ── /vibe_status command ─────────────────────────────────────────────
    api.registerCommand({
      name: "vibe_status",
      description: "Show Banano vibe monitor status",
      handler: () => ({
        text: [
          "🦍 **Banano Vibe Monitor v2.4.0**",
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
            `Last saved: ${stats.lastSaved ? new Date(stats.lastSaved).toUTCString() : "not yet"}`,
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

      // Cross-process deduplication — atomically claim this messageId before
      // doing anything. If another code path already claimed it, skip entirely.
      if (messageId) {
        if (!tryClaimMessage(messageId)) {
          logger.info(`[banano-vibe] CROSS_PROCESS_DEDUPE msgId=${messageId} author=${authorName}`);
          return;
        }
      }

      // Skip non-watched channels
      if (!config.watchedChannelIds.includes(discordChannelId)) {
        logDecision(logger, "NOT_WATCHED", { channel: discordChannelId });
        return;
      }

      // Dedupe — messageId is always present from the direct gateway path
      if (messageId && isDuplicate(messageId, config.dedupeWindowMs)) {
        stats.dedupeSuppressed++;
        scheduleStatsSave();
        logDecision(logger, "DEDUPE", { messageId, channel: discordChannelId });
        return;
      }

      // Cooldown
      if (isOnCooldown(discordChannelId, config.cooldownMs)) {
        stats.cooldownSuppressed++;
        scheduleStatsSave();
        logDecision(logger, "COOLDOWN", { channel: discordChannelId });
        return;
      }

      // ── Layer 0: Known slur pre-filter — bypasses AFINN entirely ────
      const hasSlur = containsKnownSlur(content);

      // ── Layer 1: Sentiment gate ──────────────────────────────────────
      // Bypass AFINN for non-English text or known slurs — route directly to AI review
      const nonEnglish = isLikelyNonEnglish(content);
      if (!nonEnglish && !hasSlur) {
        const score = getSentimentScore(content);
        if (score > config.sentimentThreshold) {
          logDecision(logger, "SENTIMENT_PASS", { score, threshold: config.sentimentThreshold, channel: discordChannelId });
          return;
        }
        stats.flagged++;
        scheduleStatsSave();
        logDecision(logger, "SENTIMENT_FLAG", { score, threshold: config.sentimentThreshold, channel: discordChannelId, preview: content.slice(0, 60), author: authorName, authorId });
      } else {
        // Non-English OR known slur: bypass AFINN, always proceed to AI review
        stats.flagged++;
        scheduleStatsSave();
        logDecision(logger, "SENTIMENT_FLAG", { score: hasSlur ? "slur-bypass" : "non-english-bypass", threshold: config.sentimentThreshold, channel: discordChannelId, preview: content.slice(0, 60), author: authorName, authorId });
      }

      claimChannelReply(discordChannelId, config.vibeReviewTimeoutMs * 2 + 15_000);
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
        scheduleStatsSave();
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
            `**User:** ${escapeDiscordMarkdown(authorName)}${authorId ? ` (<@${authorId}>)` : ""}`,
            `**User ID:** ${authorId ?? "unknown"}`,
            `**Message:** \`${escapeDiscordMarkdown(content.slice(0, 200))}\``,
            `**Error:** ${escapeDiscordMarkdown(errorSummary)}`,
          ];
          if (jumpLink) alert.push(`[Jump to message](${jumpLink})`);
          await sendDiscord(config.modChannelId, alert.join("\n"));
        }
        return;
      }

      const result = parseVibeResult(review.raw);
      if (!result) {
        stats.reviewErrors++;
        scheduleStatsSave();
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
        scheduleStatsSave();
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
        scheduleStatsSave();
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
          `**User:** ${escapeDiscordMarkdown(authorName)}${authorId ? ` (<@${authorId}>)` : ""}`,
          `**User ID:** ${authorId ?? "unknown"}`,
          `**Message:** \`${escapeDiscordMarkdown(content.slice(0, 200))}\``,
          `**Severity:** ${result.severity}`,
          `**Reason:** ${escapeDiscordMarkdown(result.reason)}`,
          `**Model:** ${review.modelUsed ?? "unknown"}`,
        ];
        if (jumpLink) alert.push(`[Jump to message](${jumpLink})`);
        if (isHighSeverity && !config.highSeverityPublicReply) {
          alert.push(`_(silent escalation — no public reply sent)_`);
        }

        await sendDiscord(config.modChannelId!, alert.join("\n"));
        stats.escalations++;
        scheduleStatsSave();
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

    // ── message_received hook (OpenClaw's inbound pipeline) ─────────────────
    // Uses OpenClaw's built-in Discord connection — no separate WebSocket.
    // groupPolicy: open on the MonkeDAO guild ensures all messages reach here,
    // not just from allowlisted users.
    api.on("message_received", async (event: unknown) => {
      const msg = event as {
        from?: string;
        content?: string;
        metadata?: {
          provider?: string;
          to?: string;
          messageId?: string;
          senderId?: string;
          senderName?: string;
          guildId?: string;
        };
      };

      // Only Discord
      if (msg.metadata?.provider !== "discord") return;

      const content = typeof msg.content === "string" ? msg.content.trim() : "";
      if (!content) return;

      // OpenClaw Discord `to` formats observed: "discord:channel:<id>", "channel:<id>", or bare "<id>"
      const rawTo = typeof msg.metadata?.to === "string" ? msg.metadata.to : "";
      const channelId = rawTo.startsWith("discord:channel:")
        ? rawTo.slice("discord:channel:".length)
        : rawTo.startsWith("channel:")
          ? rawTo.slice("channel:".length)
          : rawTo.startsWith("discord:")
            ? rawTo.slice("discord:".length)
            : rawTo;

      logger.info(`[banano-vibe] DIAG_MESSAGE_RECEIVED rawTo=${rawTo} channelId=${channelId} author=${msg.metadata?.senderName ?? msg.from}`);

      await processVibeMessage(
        channelId,
        content,
        msg.metadata?.senderId,
        msg.metadata?.senderName ?? msg.from ?? "unknown",
        msg.metadata?.messageId,
        msg.metadata?.guildId,
      );
    });

    logger.info("[banano-vibe] message_received hook registered — watching all messages in watched channels");

    // ── Direct Discord Gateway — primary inbound path ────────────────────
    // Bypasses OpenClaw's requireMention filter so ALL messages in watched
    // channels are processed, regardless of who sent them.
    // The message_received hook above remains as a secondary path for
    // messages that do reach OpenClaw's pipeline; tryClaimMessage()
    // deduplication prevents double-processing.
    const gateway = startDirectGateway(
      token,
      config.watchedChannelIds,
      async (msg: DiscordMessageEvent) => {
        await processVibeMessage(
          msg.channel_id,
          msg.content,
          msg.author.id,
          msg.author.username,
          msg.id,
          msg.guild_id,
        );
      },
      logger,
    );
    setActiveGateway(gateway);

    // Clean up on plugin unload
    if (typeof (api as Record<string, unknown>).onUnload === "function") {
      ((api as Record<string, unknown>).onUnload as (fn: () => void) => void)(() => {
        setActiveGateway(null);
        if (statsTimer) clearTimeout(statsTimer);
        setRegistered(false);
      });
    }
  },
};

export default plugin;
