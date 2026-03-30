/**
 * Banano Vibe Monitor — Standalone Bot
 *
 * Runs independently of OpenClaw. Opens its own Discord Gateway WebSocket
 * and monitors watched channels for vibe violations.
 *
 * Config via environment variables (or .env file in project root):
 *   DISCORD_BOT_TOKEN        - Discord bot token (required)
 *   BANANO_OPENROUTER_KEY    - OpenRouter API key (required for AI review)
 *   WATCHED_CHANNEL_IDS      - Comma-separated Discord channel IDs to monitor
 *   MOD_CHANNEL_ID           - Channel ID to send mod alerts to
 *   SENTIMENT_THRESHOLD      - Sentiment score cutoff (default: -2)
 *   MOD_ESCALATION_MIN_SEVERITY - low | medium | high (default: high)
 *   HIGH_SEVERITY_PUBLIC_REPLY  - true | false (default: true)
 *   COOLDOWN_MS              - Per-channel cooldown in ms (default: 30000)
 *   DEDUPE_WINDOW_MS         - Dedupe window in ms (default: 60000)
 *   MAX_RECENT_MESSAGES      - Context window size (default: 10)
 *   VIBE_MODEL               - Primary AI model (default: openrouter/google/gemma-3-27b-it:free)
 *   VIBE_REVIEW_TIMEOUT_MS   - AI review timeout in ms (default: 30000)
 *   LOG_DIR                  - Path for JSONL logs (default: ./logs)
 *   DATA_DIR                 - Path for violations ledger (default: ./moderation)
 *
 * Usage:
 *   npm run build && node dist/standalone.js
 *   # or via PM2:
 *   pm2 start ecosystem.config.js
 */

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";
import { getSentimentScore, containsKnownSlur, isLikelyNonEnglish } from "./sentiment.js";
import { buildVibeCheckPrompt, parseVibeResult, type RecentMessage } from "./vibe-check.js";
import { initViolations, recordViolation } from "./violations.js";

// ── Env loading ───────────────────────────────────────────────────────────────

function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  try {
    const lines = fs.readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key && val && !process.env[key]) process.env[key] = val;
    }
  } catch { /* best-effort */ }
}

loadDotEnv();

// ── Config ────────────────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(`[banano-standalone] ERROR: Missing required env var: ${key}`);
    process.exit(1);
  }
  return val;
}

function envList(key: string): string[] {
  return (process.env[key] || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function envNum(key: string, fallback: number): number {
  const val = process.env[key];
  const n = val ? parseInt(val, 10) : NaN;
  return isNaN(n) ? fallback : n;
}

function envBool(key: string, fallback: boolean): boolean {
  const val = process.env[key];
  if (!val) return fallback;
  return val.toLowerCase() !== "false" && val !== "0";
}

const DISCORD_TOKEN = requireEnv("DISCORD_BOT_TOKEN");
const OPENROUTER_KEY = process.env.BANANO_OPENROUTER_KEY || null;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || null;

if (!OPENROUTER_KEY && !ANTHROPIC_KEY) {
  console.error("[banano-standalone] ERROR: At least one of BANANO_OPENROUTER_KEY or ANTHROPIC_API_KEY must be set");
  process.exit(1);
}

const CONFIG = {
  watchedChannelIds: envList("WATCHED_CHANNEL_IDS"),
  modChannelId: process.env.MOD_CHANNEL_ID || null,
  sentimentThreshold: envNum("SENTIMENT_THRESHOLD", -2),
  maxRecentMessages: envNum("MAX_RECENT_MESSAGES", 10),
  cooldownMs: envNum("COOLDOWN_MS", 30_000),
  dedupeWindowMs: envNum("DEDUPE_WINDOW_MS", 60_000),
  contextFilterBots: envBool("CONTEXT_FILTER_BOTS", true),
  modEscalationMinSeverity: (process.env.MOD_ESCALATION_MIN_SEVERITY || "high") as "low" | "medium" | "high",
  highSeverityPublicReply: envBool("HIGH_SEVERITY_PUBLIC_REPLY", true),
  vibeReviewTimeoutMs: envNum("VIBE_REVIEW_TIMEOUT_MS", 30_000),
  vibeModel: process.env.VIBE_MODEL || "openrouter/google/gemma-3-27b-it:free",
  vibeFallbacks: [
    "openrouter/meta-llama/llama-3.3-70b-instruct:free",
    "openrouter/nvidia/nemotron-3-nano-30b-a3b:free",
    "anthropic/claude-haiku-4-5",
  ],
  logDir: path.resolve(process.env.LOG_DIR || "./logs"),
  dataDir: path.resolve(process.env.DATA_DIR || "./data"),
};

if (CONFIG.watchedChannelIds.length === 0) {
  console.warn("[banano-standalone] WARNING: No WATCHED_CHANNEL_IDS configured — bot will not trigger on any channel");
}

// ── Logging ───────────────────────────────────────────────────────────────────

if (!fs.existsSync(CONFIG.logDir)) fs.mkdirSync(CONFIG.logDir, { recursive: true });
if (!fs.existsSync(CONFIG.dataDir)) fs.mkdirSync(CONFIG.dataDir, { recursive: true });

function log(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const ts = new Date().toISOString();
  console[level === "ERROR" ? "error" : level === "WARN" ? "warn" : "log"](`${ts} [${level}] ${msg}`);
}

function writeJsonlLog(decision: string, meta: Record<string, unknown>): void {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const logPath = path.join(CONFIG.logDir, `banano-vibe-${date}.jsonl`);
    const entry = JSON.stringify({ ts: new Date().toISOString(), decision, ...meta }) + "\n";
    fs.appendFileSync(logPath, entry);
  } catch { /* best-effort */ }
}

// ── Discord REST ──────────────────────────────────────────────────────────────

const DISCORD_API = "https://discord.com/api/v10";

async function discordGet<T>(apiPath: string): Promise<T | null> {
  try {
    const res = await fetch(`${DISCORD_API}${apiPath}`, {
      headers: { Authorization: `Bot ${DISCORD_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch { return null; }
}

async function discordPost(channelId: string, content: string, replyToMessageId?: string): Promise<void> {
  try {
    const body: Record<string, unknown> = { content };
    if (replyToMessageId) {
      body.message_reference = { message_id: replyToMessageId };
    }
    const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bot ${DISCORD_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      log("ERROR", `Discord send failed (${channelId}) ${res.status}: ${err.slice(0, 200)}`);
    }
  } catch (err) {
    log("ERROR", `Discord send exception (${channelId}): ${err}`);
  }
}

async function fetchRecentMessages(
  channelId: string,
  beforeMessageId: string | undefined,
  limit: number,
  filterBots: boolean,
): Promise<RecentMessage[]> {
  try {
    let url = `/channels/${channelId}/messages?limit=${limit}`;
    if (beforeMessageId) url += `&before=${beforeMessageId}`;
    const messages = await discordGet<Array<{
      id: string;
      author: { username: string; bot?: boolean };
      content: string;
    }>>(url);
    if (!messages) return [];
    return messages
      .reverse()
      .filter((m) => m.content?.trim() && !(filterBots && m.author.bot))
      .map((m) => ({ author: m.author.username, content: m.content }));
  } catch { return []; }
}

// ── Sanitization ──────────────────────────────────────────────────────────────

function sanitizeForPrompt(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, "'").slice(0, 500);
}

function escapeDiscordMarkdown(text: string): string {
  return text.replace(/([*_`~|>\\])/g, "\\$1");
}

// ── Deduplication & cooldown ──────────────────────────────────────────────────

const handledMessages = new Map<string, number>();
const channelCooldowns = new Map<string, number>();

function isDuplicate(messageId: string): boolean {
  const now = Date.now();
  for (const [id, ts] of handledMessages) {
    if (now - ts > CONFIG.dedupeWindowMs * 2) handledMessages.delete(id);
  }
  if (handledMessages.has(messageId)) return true;
  handledMessages.set(messageId, now);
  return false;
}

function isOnCooldown(channelId: string): boolean {
  const last = channelCooldowns.get(channelId);
  return !!last && Date.now() - last < CONFIG.cooldownMs;
}

function markCooldown(channelId: string): void {
  channelCooldowns.set(channelId, Date.now());
}

// ── AI vibe review ────────────────────────────────────────────────────────────

async function runVibeReviewSingle(
  prompt: string,
  model: string,
): Promise<{ raw: string | null; error?: string; retryable?: boolean }> {
  try {
    if (model.startsWith("openrouter/")) {
      if (!OPENROUTER_KEY) return { raw: null, error: "No OpenRouter key configured", retryable: false };
      const orModel = model.replace(/^openrouter\//, "");
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENROUTER_KEY}`,
          "HTTP-Referer": "https://monkedao.io",
          "X-Title": "Banano Vibe Monitor",
        },
        body: JSON.stringify({ model: orModel, max_tokens: 1024, messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(CONFIG.vibeReviewTimeoutMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { raw: null, error: `OpenRouter ${res.status}: ${body.slice(0, 200)}`, retryable: res.status === 429 || res.status >= 500 };
      }
      const data = await res.json() as { choices?: Array<{ message?: { content?: string | null } }> };
      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text) return { raw: null, error: "empty response", retryable: true };
      return { raw: text };
    } else {
      // Anthropic
      if (!ANTHROPIC_KEY) return { raw: null, error: "No Anthropic key configured", retryable: false };
      const anModel = model.replace(/^anthropic\//, "");
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model: anModel, max_tokens: 1024, messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(CONFIG.vibeReviewTimeoutMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { raw: null, error: `Anthropic ${res.status}: ${body.slice(0, 200)}`, retryable: res.status === 429 || res.status >= 500 };
      }
      const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
      const text = data.content?.find((b) => b.type === "text")?.text?.trim();
      if (!text) return { raw: null, error: "empty response", retryable: true };
      return { raw: text };
    }
  } catch (err) {
    return { raw: null, error: String(err), retryable: true };
  }
}

async function runVibeReview(prompt: string): Promise<{ raw: string | null; error?: string; modelUsed?: string }> {
  const chain = [CONFIG.vibeModel, ...CONFIG.vibeFallbacks.filter((m) => m !== CONFIG.vibeModel)];
  let lastError = "unknown";
  for (const model of chain) {
    const result = await runVibeReviewSingle(prompt, model);
    if (result.raw !== null) {
      if (model !== CONFIG.vibeModel) log("INFO", `Vibe review via fallback: ${model}`);
      return { raw: result.raw, modelUsed: model };
    }
    lastError = result.error ?? "unknown";
    if (!result.retryable) return { raw: null, error: lastError };
    log("WARN", `Model ${model} failed (${lastError}), trying fallback...`);
  }
  return { raw: null, error: `All models failed. Last: ${lastError}` };
}

// ── Persistent stats ─────────────────────────────────────────────────────────

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

let stats: VibeStats;
let statsPath: string;
let statsTimer: ReturnType<typeof setTimeout> | null = null;

function initStats(): void {
  statsPath = path.join(CONFIG.dataDir, "stats.json");
  try {
    if (fs.existsSync(statsPath)) {
      stats = JSON.parse(fs.readFileSync(statsPath, "utf8")) as VibeStats;
      return;
    }
  } catch { /* */ }
  stats = {
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
    fsp.writeFile(statsPath, JSON.stringify(stats, null, 2), "utf8").catch(() => {});
  }, 2000);
}

// ── Core message handler ──────────────────────────────────────────────────────

async function handleMessage(msg: {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  author: { id: string; username: string };
}): Promise<void> {
  const { id: messageId, channel_id: channelId, guild_id: guildId, content, author } = msg;

  if (!CONFIG.watchedChannelIds.includes(channelId)) return;
  if (!content.trim()) return;

  // Dedupe
  if (isDuplicate(messageId)) {
    writeJsonlLog("DEDUPE", { messageId, channel: channelId });
    stats.dedupeSuppressed++; scheduleStatsSave();
    return;
  }

  // Cooldown
  if (isOnCooldown(channelId)) {
    writeJsonlLog("COOLDOWN", { channel: channelId });
    stats.cooldownSuppressed++; scheduleStatsSave();
    return;
  }

  // Layer 0: known slur pre-filter — bypasses AFINN
  const hasSlur = containsKnownSlur(content);

  // Layer 1: sentiment gate (skip for non-English or known slurs)
  const nonEnglish = isLikelyNonEnglish(content);
  if (!nonEnglish && !hasSlur) {
    const score = getSentimentScore(content);
    if (score > CONFIG.sentimentThreshold) {
      writeJsonlLog("SENTIMENT_PASS", { score, channel: channelId });
      return;
    }
    log("INFO", `SENTIMENT_FLAG score=${score} author=${author.username} channel=${channelId} preview="${content.slice(0, 60)}"`);
    writeJsonlLog("SENTIMENT_FLAG", { score, channel: channelId, author: author.username, authorId: author.id, preview: content.slice(0, 60) });
  } else {
    log("INFO", `SENTIMENT_FLAG score=${hasSlur ? "slur-bypass" : "non-english-bypass"} author=${author.username} channel=${channelId} preview="${content.slice(0, 60)}"`);
    writeJsonlLog("SENTIMENT_FLAG", { score: hasSlur ? "slur-bypass" : "non-english-bypass", channel: channelId, author: author.username, authorId: author.id, preview: content.slice(0, 60) });
  }
  stats.flagged++; scheduleStatsSave();

  // Layer 2: AI review
  const recentMessages = await fetchRecentMessages(channelId, messageId, CONFIG.maxRecentMessages, CONFIG.contextFilterBots);
  const correlationId = crypto.randomUUID();

  const prompt = buildVibeCheckPrompt(
    sanitizeForPrompt(content),
    sanitizeForPrompt(author.username),
    recentMessages.map((m) => ({ author: sanitizeForPrompt(m.author), content: sanitizeForPrompt(m.content) })),
  );

  log("INFO", `VIBE_CHECK_START correlationId=${correlationId} channel=${channelId} author=${author.username}`);
  writeJsonlLog("VIBE_CHECK_START", { correlationId, channel: channelId, author: author.username, authorId: author.id });

  const review = await runVibeReview(prompt);

  if (!review.raw) {
    stats.reviewErrors++; scheduleStatsSave();
    log("WARN", `VIBE_CHECK_ERROR correlationId=${correlationId} error=${review.error}`);
    writeJsonlLog("VIBE_CHECK_ERROR", { correlationId, channel: channelId, error: review.error });
    if (CONFIG.modChannelId) {
      const jumpLink = guildId ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}` : null;
      const lines = [
        `⚠️ **Vibe review failed** in <#${channelId}>`,
        `**User:** ${escapeDiscordMarkdown(author.username)} (<@${author.id}>)`,
        `**Message:** \`${escapeDiscordMarkdown(content.slice(0, 200))}\``,
        `**Error:** ${escapeDiscordMarkdown(review.error || "unknown")}`,
      ];
      if (jumpLink) lines.push(`[Jump to message](${jumpLink})`);
      await discordPost(CONFIG.modChannelId, lines.join("\n"));
    }
    return;
  }

  const result = parseVibeResult(review.raw);

  if (!result) {
    stats.reviewErrors++; scheduleStatsSave();
    log("WARN", `VIBE_CHECK_ERROR correlationId=${correlationId} reason=parse_failure`);
    writeJsonlLog("VIBE_CHECK_ERROR", { correlationId, channel: channelId, reason: "parse_failure", raw: review.raw.slice(0, 200) });
    return;
  }

  if (!result.isToxic) {
    stats.falseAlarms++; scheduleStatsSave();
    writeJsonlLog("FALSE_ALARM", { correlationId, reason: result.reason, channel: channelId });
    return;
  }

  markCooldown(channelId);

  const severityOrder = { low: 0, medium: 1, high: 2 };
  const minOrder = severityOrder[CONFIG.modEscalationMinSeverity];
  const resultOrder = severityOrder[result.severity] ?? 2;
  const isHighSeverity = result.severity === "high";
  const escalateToMod = resultOrder >= minOrder && !!CONFIG.modChannelId;
  const shouldReplyPublicly = result.suggestedResponse && (!isHighSeverity || CONFIG.highSeverityPublicReply);

  // Public in-channel response
  if (shouldReplyPublicly) {
    await discordPost(channelId, result.suggestedResponse!, messageId);
    stats.mildResponses++; scheduleStatsSave();
    log("INFO", `MILD_RESPONSE correlationId=${correlationId} severity=${result.severity} channel=${channelId}`);
    writeJsonlLog("MILD_RESPONSE", { correlationId, severity: result.severity, channel: channelId, reason: result.reason });
  }

  // Mod channel escalation
  if (escalateToMod) {
    const jumpLink = guildId ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}` : null;

    const memberRecord = recordViolation({
      userId: author.id,
      username: author.username,
      reason: result.reason,
      severity: result.severity,
      channelId,
      messageId,
      guildId,
    });

    const alert = [
      `🚨 **Vibe alert** in <#${channelId}> (Strike #${memberRecord.strikes})`,
      `**User:** ${escapeDiscordMarkdown(author.username)} (<@${author.id}>)`,
      `**User ID:** ${author.id}`,
      `**Message:** \`${escapeDiscordMarkdown(content.slice(0, 200))}\``,
      `**Severity:** ${result.severity}`,
      `**Reason:** ${escapeDiscordMarkdown(result.reason)}`,
      `**Model:** ${review.modelUsed ?? "unknown"}`,
    ];
    if (jumpLink) alert.push(`[Jump to message](${jumpLink})`);
    if (isHighSeverity && !CONFIG.highSeverityPublicReply) {
      alert.push(`_(silent escalation — no public reply sent)_`);
    }

    await discordPost(CONFIG.modChannelId!, alert.join("\n"));
    stats.escalations++; scheduleStatsSave();
    log("INFO", `HIGH_ESCALATION correlationId=${correlationId} severity=${result.severity} author=${author.username}`);
    writeJsonlLog("HIGH_ESCALATION", { correlationId, severity: result.severity, channel: channelId, author: author.username, authorId: author.id, reason: result.reason });
  }
}

// ── Discord Gateway WebSocket ─────────────────────────────────────────────────

const DISCORD_GATEWAY = "https://discord.com/api/v10/gateway/bot";
const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_MESSAGE_CONTENT = 1 << 15;
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

type GatewayPayload = { op: number; d?: unknown; t?: string; s?: number };

async function getGatewayUrl(): Promise<string> {
  try {
    const res = await fetch(DISCORD_GATEWAY, {
      headers: { Authorization: `Bot ${DISCORD_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json() as { url?: string };
      if (data.url) return `${data.url}/?v=10&encoding=json`;
    }
  } catch { /* */ }
  return "wss://gateway.discord.gg/?v=10&encoding=json";
}

function startGateway(): void {
  let ws: WebSocket | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let sequence: number | null = null;
  let sessionId: string | null = null;
  let resumeUrl: string | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let messageCount = 0;
  let awaitingAck = false;

  function scheduleReconnect(delayMs = 5000): void {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delayMs);
  }

  function sendHeartbeat(): void {
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (awaitingAck) {
      log("WARN", "No heartbeat ACK received — zombie connection detected, reconnecting");
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      ws?.close(4000, "Zombie: no heartbeat ACK");
      return;
    }
    awaitingAck = true;
    ws.send(JSON.stringify({ op: 1, d: sequence }));
  }

  function startHeartbeat(intervalMs: number): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    awaitingAck = false;
    const jitter = Math.random() * intervalMs;
    setTimeout(() => {
      sendHeartbeat();
      heartbeatTimer = setInterval(sendHeartbeat, intervalMs);
    }, jitter);
  }

  async function connect(): Promise<void> {
    const url = resumeUrl ?? await getGatewayUrl();
    log("INFO", `Connecting to Discord Gateway: ${url.slice(0, 50)}...`);

    try {
      ws = new WebSocket(url);
    } catch (err) {
      log("ERROR", `WebSocket constructor failed: ${err}`);
      scheduleReconnect();
      return;
    }

    ws.addEventListener("open", () => log("INFO", "Gateway connected"));

    ws.addEventListener("message", async (event: MessageEvent) => {
      let payload: GatewayPayload;
      try {
        payload = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
      } catch { return; }

      if (payload.s != null) sequence = payload.s;

      // op 1: heartbeat request from server
      if (payload.op === 1) {
        awaitingAck = false;
        ws?.send(JSON.stringify({ op: 1, d: sequence }));
        awaitingAck = true;
      }

      // op 11: heartbeat ACK
      if (payload.op === 11) { awaitingAck = false; }

      // op 10: hello
      if (payload.op === 10) {
        const interval = (payload.d as { heartbeat_interval: number }).heartbeat_interval;
        startHeartbeat(interval);

        if (sessionId && resumeUrl) {
          ws?.send(JSON.stringify({ op: 6, d: { token: DISCORD_TOKEN, session_id: sessionId, seq: sequence } }));
        } else {
          ws?.send(JSON.stringify({
            op: 2,
            d: {
              token: DISCORD_TOKEN,
              intents: INTENT_GUILD_MESSAGES | INTENT_MESSAGE_CONTENT,
              properties: { os: "linux", browser: "banano-vibe", device: "banano-vibe" },
            },
          }));
        }
      }

      // op 0: dispatch
      if (payload.op === 0 && payload.t) {
        if (payload.t === "READY") {
          const d = payload.d as { session_id: string; resume_gateway_url: string };
          sessionId = d.session_id;
          resumeUrl = `${d.resume_gateway_url}/?v=10&encoding=json`;
          log("INFO", `Gateway ready — session ${sessionId.slice(0, 8)}`);
        }
        if (payload.t === "RESUMED") log("INFO", "Gateway resumed");
        if (payload.t === "MESSAGE_CREATE") {
          const msg = payload.d as { id: string; channel_id: string; guild_id?: string; content: string; author: { id: string; username: string; bot?: boolean } };
          if (msg.author?.bot) return;
          if (!CONFIG.watchedChannelIds.includes(msg.channel_id)) return;
          messageCount++;
          log("INFO", `MESSAGE_RECEIVED msgId=${msg.id} author=${msg.author.username} channel=${msg.channel_id} count=${messageCount}`);
          handleMessage(msg).catch((err) => log("ERROR", `handleMessage error: ${err}`));
        }
      }

      // op 7: reconnect
      if (payload.op === 7) { log("INFO", "Gateway reconnect requested"); ws?.close(); }

      // op 9: invalid session
      if (payload.op === 9) {
        if (!payload.d) { sessionId = null; resumeUrl = null; sequence = null; }
        ws?.close();
      }
    });

    ws.addEventListener("close", (event: CloseEvent) => {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      awaitingAck = false;
      if (FATAL_CLOSE_CODES.has(event.code)) {
        log("ERROR", `Gateway closed with fatal code ${event.code} — not reconnecting. Check MESSAGE_CONTENT intent in Discord developer portal.`);
        process.exit(1);
      }
      log("WARN", `Gateway closed (code ${event.code}), reconnecting in 5s...`);
      scheduleReconnect();
    });

    ws.addEventListener("error", (event: Event) => log("ERROR", `Gateway error: ${event}`));
  }

  connect().catch((err) => log("ERROR", `Initial connect failed: ${err}`));
}

// ── Startup ───────────────────────────────────────────────────────────────────

initViolations(CONFIG.dataDir);
initStats();

log("INFO", "Banano Vibe Monitor (standalone) starting");
log("INFO", `Watching channels: ${CONFIG.watchedChannelIds.join(", ") || "NONE"}`);
log("INFO", `Mod channel: ${CONFIG.modChannelId || "none"}`);
log("INFO", `Sentiment threshold: ${CONFIG.sentimentThreshold}`);
log("INFO", `Vibe model: ${CONFIG.vibeModel}`);

startGateway();

// Graceful shutdown
process.on("SIGINT", () => { log("INFO", "Shutting down (SIGINT)"); process.exit(0); });
process.on("SIGTERM", () => { log("INFO", "Shutting down (SIGTERM)"); process.exit(0); });
