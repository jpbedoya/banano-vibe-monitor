/**
 * Banano Vibe Monitor — Standalone Bot v1.0.0
 *
 * Self-contained Discord bot that runs the full vibe check pipeline
 * WITHOUT OpenClaw. Reads config from env vars, connects directly
 * to the Discord gateway, and sends messages via Discord REST.
 *
 * Two-layer vibe moderation:
 *   Layer 0: Known slur pre-filter (bypasses AFINN)
 *   Layer 1: Local sentiment scoring (free, instant)
 *   Layer 2: AI vibe review via OpenRouter/Anthropic with fallback chain
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";

// ── Inline sentiment module ─────────────────────────────────────────────────
// Duplicated from src/sentiment.ts (plugin uses CJS, standalone is ESM)

// @ts-ignore — sentiment has no types
import Sentiment from "sentiment";
const analyzer = new Sentiment();

const LATIN_SLUR_PATTERNS = [
  /\bfaggots?\b/i, /\bfags?\b/i, /\bdykes?\b/i, /\btrann(?:y|ie?)s?\b/i,
  /\bniggers?\b/i, /\bniggas?\b/i, /\bkikes?\b/i, /\bchinks?\b/i,
  /\bspicks?\b/i, /\bspics?\b/i, /\bwetbacks?\b/i, /\bboongas?\b/i,
  /\bboongy?\b/i, /\bcoons?\b/i, /\bgooks?\b/i, /\btowelheads?\b/i,
  /\bragheads?\b/i, /\bsandniggers?\b/i, /\bzipperheads?\b/i,
  /\bretards?\b/i, /\bspaz(?:zes)?\b/i, /\bmongoloids?\b/i,
  /\bcunts?\b/i, /\btwats?\b/i,
  /\bmaric[oó]n(?:es)?\b/i, /\bpendejos?\b/i,
];

const NON_LATIN_SLURS = [
  'сука', 'блять', 'блядь', 'пиздец', 'ёбаный', 'хуй',
  '操你', '傻逼', '妈的', '他妈', '操蛋',
  '𨳒', '仆街', '屌你老母',
  'चूतिया', 'मादरचोद', 'बहनचोद', 'रांड',
  'puta',
  'كس', 'شرموطة',
  '碌柒', '笨杘', '戇鳩',
  'bangsat', 'goblok', 'banci', 'bacod', 'tolol', 'kontol',
  'ngentot', 'jancok', 'bangang', 'jabur', 'pukimak',
  // Japanese threats/slurs
  'しばくぞ', 'ぶっ殺す', '殺すぞ', 'ぶっ飛ばす', 'バカ', 'アホ', 'クソ', 'うざい', 'きもい', '死ね', 'うせろ',
  // Korean
  '씨발', '개새끼', '좆', '병신', '미친놈', '닥쳐',
];

function containsKnownSlur(text: string): boolean {
  for (const pattern of LATIN_SLUR_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  const lower = text.toLowerCase();
  for (const slur of NON_LATIN_SLURS) {
    if (lower.includes(slur.toLowerCase())) return true;
  }
  return false;
}

function shouldEscalate(text: string, threshold: number): boolean {
  return analyzer.analyze(text).score <= threshold;
}

function getSentimentScore(text: string): number {
  return analyzer.analyze(text).score;
}

function isLikelyNonEnglish(text: string): boolean {
  if (!text || text.length === 0) return false;
  let nonAsciiCount = 0;
  for (const char of text) {
    if (char.codePointAt(0)! > 127) nonAsciiCount++;
  }
  return nonAsciiCount / text.length > 0.2;
}

// ── Inline persona ──────────────────────────────────────────────────────────

const VIBE_CHECK_PROMPT = `You are Banano, MonkeDAO's resident degen ape. You're reviewing a flagged message for community vibe violations.

## Your task
Determine if a flagged message is genuinely toxic, negative, or harmful to community vibes.

## Rules
- Jokes, sarcasm, and light trash talk are FINE — don't over-police
- Context matters — "this project is trash" during banter is different from actual hostility
- Only flag real issues: sustained negativity, personal attacks, FUD spreading, drama-baiting, direct threats
- **Non-English messages:** Take them seriously. Phrases like しばくぞ (Japanese: "I'll beat you up") or similar threats in any language ARE violations
- Keep suggested responses short, chill, and in-character (not preachy)

## Response format
Answer in JSON only:
{
  "isToxic": boolean,
  "severity": "low" | "medium" | "high",
  "reason": "brief reason",
  "suggestedResponse": "what Banano should say in-channel, or null if no response needed"
}`;

// ── Inline vibe-check ───────────────────────────────────────────────────────

type VibeResult = {
  isToxic: boolean;
  severity: "low" | "medium" | "high";
  reason: string;
  suggestedResponse: string | null;
};

type RecentMessage = {
  author: string;
  content: string;
};

function buildVibeCheckPrompt(
  flaggedText: string,
  authorName: string,
  recentMessages: RecentMessage[],
): string {
  const context = recentMessages.length
    ? recentMessages.map((m) => `${m.author}: ${m.content}`).join("\n")
    : "(no prior context)";

  return `${VIBE_CHECK_PROMPT}

Recent conversation:
${context}

Flagged message from ${authorName}: "${flaggedText}"`;
}

function parseVibeResult(text: string): VibeResult | null {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed.isToxic === "boolean") {
        return {
          isToxic: parsed.isToxic,
          severity: parsed.severity || "low",
          reason: parsed.reason || "unknown",
          suggestedResponse: parsed.suggestedResponse || null,
        };
      }
    }
  } catch { /* parse failure */ }
  return null;
}

// ── Inline violations ledger ────────────────────────────────────────────────

type ViolationEntry = {
  strike: number;
  date: string;
  reason: string;
  severity: "low" | "medium" | "high";
  channelId: string;
  messageId?: string;
  guildId?: string;
  issuedBy: "auto" | string;
};

type MemberRecord = {
  userId: string;
  username: string;
  strikes: number;
  history: ViolationEntry[];
};

type ViolationsLedger = {
  version: 1;
  members: Record<string, MemberRecord>;
};

let ledgerPath: string;
let ledger: ViolationsLedger;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function initViolations(dataDir: string): void {
  const dir = path.join(dataDir, "moderation");
  ledgerPath = path.join(dir, "violations.json");
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(ledgerPath)) {
      ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    } else {
      ledger = { version: 1, members: {} };
      scheduleLedgerSave();
    }
  } catch {
    ledger = { version: 1, members: {} };
  }
}

function scheduleLedgerSave(debounceMs = 500): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fsp.writeFile(ledgerPath, JSON.stringify(ledger, null, 2), "utf8").catch(() => {});
  }, debounceMs);
}

function recordViolation(params: {
  userId: string;
  username: string;
  reason: string;
  severity: "low" | "medium" | "high";
  channelId: string;
  messageId?: string;
  guildId?: string;
}): MemberRecord {
  const { userId, username, reason, severity, channelId, messageId, guildId } = params;
  if (!ledger.members[userId]) {
    ledger.members[userId] = { userId, username, strikes: 0, history: [] };
  }
  const member = ledger.members[userId];
  member.username = username;
  member.strikes += 1;
  member.history.push({
    strike: member.strikes,
    date: new Date().toISOString().slice(0, 10),
    reason,
    severity,
    channelId,
    ...(messageId ? { messageId } : {}),
    ...(guildId ? { guildId } : {}),
    issuedBy: "auto",
  });
  scheduleLedgerSave();
  return member;
}

// ── Logger ──────────────────────────────────────────────────────────────────

const logger = {
  info: (msg: string) => console.log(`[banano-vibe] ${msg}`),
  warn: (msg: string) => console.warn(`[banano-vibe] ${msg}`),
  error: (msg: string) => console.error(`[banano-vibe] ${msg}`),
};

// ── .env loader ─────────────────────────────────────────────────────────────

function loadDotEnv(dir: string): void {
  try {
    const envPath = path.join(dir, ".env");
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

// ── Config from env vars ────────────────────────────────────────────────────

type VibeConfig = {
  discordToken: string;
  openRouterKey: string | null;
  anthropicKey: string | null;
  watchedChannelIds: string[];
  modChannelId: string | null;
  sentimentThreshold: number;
  maxRecentMessages: number;
  cooldownMs: number;
  dedupeWindowMs: number;
  modEscalationMinSeverity: "low" | "medium" | "high";
  highSeverityPublicReply: boolean;
  vibeReviewTimeoutMs: number;
  vibeModel: string | null;
};

function resolveConfig(): VibeConfig {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    logger.error("DISCORD_TOKEN env var is required");
    process.exit(1);
  }

  const minSev = process.env.MOD_ESCALATION_MIN_SEVERITY;
  const validSev = minSev === "low" || minSev === "medium" || minSev === "high" ? minSev : "high";

  return {
    discordToken: token,
    openRouterKey: process.env.BANANO_OPENROUTER_KEY || null,
    anthropicKey: process.env.ANTHROPIC_API_KEY || null,
    watchedChannelIds: (process.env.WATCHED_CHANNEL_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    modChannelId: process.env.MOD_CHANNEL_ID || null,
    sentimentThreshold: Number(process.env.SENTIMENT_THRESHOLD) || -2,
    maxRecentMessages: Number(process.env.MAX_RECENT_MESSAGES) || 10,
    cooldownMs: Number(process.env.COOLDOWN_MS) || 30_000,
    dedupeWindowMs: Number(process.env.DEDUPE_WINDOW_MS) || 60_000,
    modEscalationMinSeverity: validSev,
    highSeverityPublicReply: process.env.HIGH_SEVERITY_PUBLIC_REPLY !== "false",
    vibeReviewTimeoutMs: Number(process.env.VIBE_REVIEW_TIMEOUT_MS) || 30_000,
    vibeModel: process.env.VIBE_MODEL || null,
  };
}

// ── Prompt sanitization ─────────────────────────────────────────────────────

function sanitizeForPrompt(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/`/g, "'")
    .slice(0, 500);
}

// ── Discord markdown escaping ───────────────────────────────────────────────

function escapeDiscordMarkdown(text: string): string {
  return text.replace(/([*_`~|>\\])/g, "\\$1");
}

// ── Discord REST ────────────────────────────────────────────────────────────

const DISCORD_API = "https://discord.com/api/v10";

async function sendDiscord(
  token: string,
  channelId: string,
  content: string,
  replyToMessageId?: string,
): Promise<void> {
  try {
    const body: Record<string, unknown> = { content };
    if (replyToMessageId) {
      body.message_reference = { message_id: replyToMessageId };
      body.allowed_mentions = { replied_user: false };
    }
    const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bot ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.error(`Send failed (${channelId}): ${res.status} ${text.slice(0, 200)}`);
    }
  } catch (err) {
    logger.error(`Send failed (${channelId}): ${err}`);
  }
}

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

// ── Dedupe / cooldown state ─────────────────────────────────────────────────

const claimedIds = new Set<string>();
const handledMessages = new Map<string, number>();
const channelCooldowns = new Map<string, number>();

function tryClaimMessage(messageId: string): boolean {
  if (claimedIds.has(messageId)) return false;
  claimedIds.add(messageId);
  if (claimedIds.size > 1000) {
    const toDelete = [...claimedIds].slice(0, claimedIds.size - 1000);
    for (const id of toDelete) claimedIds.delete(id);
  }
  return true;
}

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

// ── Structured log helper ───────────────────────────────────────────────────

type Decision =
  | "NOT_WATCHED" | "DEDUPE" | "COOLDOWN" | "SENTIMENT_PASS" | "SENTIMENT_FLAG"
  | "VIBE_CHECK_START" | "VIBE_CHECK_ERROR" | "FALSE_ALARM"
  | "MILD_RESPONSE" | "HIGH_ESCALATION";

const LOGGED_DECISIONS = new Set<Decision>([
  "SENTIMENT_FLAG", "VIBE_CHECK_START", "VIBE_CHECK_ERROR",
  "FALSE_ALARM", "MILD_RESPONSE", "HIGH_ESCALATION", "COOLDOWN", "DEDUPE",
]);

let vibeLogDir: string | null = null;

function initVibeLog(dataDir: string): void {
  vibeLogDir = path.join(dataDir, "logs");
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
  } catch { /* best-effort */ }
}

function logDecision(decision: Decision, meta: Record<string, unknown>): void {
  logger.info(`${decision} ${JSON.stringify(meta)}`);
  if (LOGGED_DECISIONS.has(decision)) {
    writeVibeLog(decision, meta);
  }
}

// ── Discord Gateway ─────────────────────────────────────────────────────────

const DISCORD_GATEWAY_URL = "https://discord.com/api/v10/gateway";
const DISCORD_INTENT_GUILD_MESSAGES = 1 << 9;
const DISCORD_INTENT_MESSAGE_CONTENT = 1 << 15;

const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

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
): { stop: () => void } {
  const WS = (globalThis as Record<string, unknown>).WebSocket as typeof globalThis.WebSocket;

  let ws: WebSocket | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatJitterTimer: ReturnType<typeof setTimeout> | null = null;
  let awaitingAck = false;
  let sequence: number | null = null;
  let sessionId: string | null = null;
  let resumeGatewayUrl: string | null = null;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let messageCount = 0;

  async function getGatewayUrl(): Promise<string> {
    try {
      const res = await fetch(`${DISCORD_GATEWAY_URL}/bot`, {
        headers: { Authorization: `Bot ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = (await res.json()) as { url?: string };
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
    if (awaitingAck) {
      logger.warn("No heartbeat ACK received — zombie connection detected");
      clearHeartbeatTimers();
      ws?.close(4000, "Zombie connection: no heartbeat ACK");
      return;
    }
    awaitingAck = true;
    ws.send(JSON.stringify({ op: 1, d: sequence }));
  }

  function startHeartbeat(intervalMs: number): void {
    clearHeartbeatTimers();
    awaitingAck = false;
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
      logger.error(`Gateway WS constructor error: ${err}`);
      scheduleReconnect();
      return;
    }

    ws.addEventListener("open", () => {
      logger.info("Gateway connected");
    });

    ws.addEventListener("message", async (event: MessageEvent) => {
      let payload: GatewayMessage;
      try {
        payload = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString()) as GatewayMessage;
      } catch { return; }

      if (payload.s !== undefined && payload.s !== null) {
        sequence = payload.s;
      }

      // op 1 = Heartbeat request from server
      if (payload.op === 1) {
        awaitingAck = false;
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
          logger.info(`Gateway ready [session=${sessionId.slice(0, 8)}]`);
        }

        if (payload.t === "RESUMED") {
          logger.info("Gateway resumed");
        }

        if (payload.t === "MESSAGE_CREATE") {
          const msg = payload.d as DiscordMessageEvent;
          if (msg.author?.bot) return;
          if (!watchedChannelIds.includes(msg.channel_id)) return;
          messageCount++;
          logger.info(`MESSAGE_RECEIVED msgId=${msg.id} author=${msg.author.username} msgCount=${messageCount}`);
          try {
            await onMessage(msg);
          } catch (err) {
            logger.error(`Gateway message handler error: ${err}`);
          }
        }
      }

      // op 7 = Reconnect requested
      if (payload.op === 7) {
        logger.info("Gateway reconnect requested");
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

      // op 11 = Heartbeat ACK
      if (payload.op === 11) {
        awaitingAck = false;
      }
    });

    ws.addEventListener("close", (event: CloseEvent) => {
      clearHeartbeatTimers();
      awaitingAck = false;
      if (stopped) return;

      if (FATAL_CLOSE_CODES.has(event.code)) {
        logger.error(
          `Gateway closed with fatal code ${event.code} — not reconnecting. ` +
          `Check that MESSAGE_CONTENT intent is enabled in the Discord developer portal.`,
        );
        process.exit(1);
      }

      logger.info(`Gateway closed (code ${event.code}), reconnecting...`);
      scheduleReconnect();
    });

    ws.addEventListener("error", (event: Event) => {
      logger.error(`Gateway error: ${event}`);
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
      logger.info("Gateway stopping");
      stopped = true;
      clearHeartbeatTimers();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}

// ── AI vibe review — multi-provider with fallback ───────────────────────────

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
  config: VibeConfig,
  prompt: string,
  vibeModel: string,
): Promise<{ raw: string | null; error?: string; retryable?: boolean }> {
  try {
    if (isOpenRouterModel(vibeModel)) {
      const orKey = config.openRouterKey;
      if (!orKey) return { raw: null, error: "No OpenRouter API key configured" };

      const model = vibeModel.replace(/^openrouter\//, "");
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${orKey}`,
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

      const data = (await res.json()) as {
        choices?: Array<{
          message?: { content?: string | null; reasoning_content?: string | null };
          finish_reason?: string;
        }>;
      };

      const choice = data.choices?.[0];
      const msg = choice?.message;
      const text = (msg?.content?.trim() || msg?.reasoning_content?.trim()) ?? "";

      if (!text) {
        logger.warn(`OpenRouter empty response — finish_reason: ${choice?.finish_reason ?? "unknown"}`);
        return { raw: null, error: "empty response from OpenRouter", retryable: true };
      }
      return { raw: text };

    } else {
      const anthropicKey = config.anthropicKey;
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

      const data = (await res.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };

      const text = data.content?.find((b) => b.type === "text")?.text?.trim();
      if (!text) return { raw: null, error: "empty response from Anthropic", retryable: true };
      return { raw: text };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Vibe review error (${vibeModel}): ${msg}`);
    return { raw: null, error: msg, retryable: true };
  }
}

async function runVibeReview(
  config: VibeConfig,
  prompt: string,
): Promise<{ raw: string | null; error?: string; modelUsed?: string }> {
  const primary = config.vibeModel || DEFAULT_VIBE_MODEL;
  const chain = [primary, ...DEFAULT_VIBE_FALLBACKS.filter((m) => m !== primary)];

  let lastError = "unknown error";
  for (const model of chain) {
    const result = await runVibeReviewSingle(config, prompt, model);
    if (result.raw !== null) {
      if (model !== primary) {
        logger.info(`Vibe review succeeded via fallback: ${model}`);
      }
      return { raw: result.raw, modelUsed: model };
    }
    lastError = result.error ?? "unknown error";
    if (!result.retryable) {
      return { raw: null, error: lastError };
    }
    logger.warn(`Model ${model} failed (${lastError}), trying next fallback...`);
  }

  return { raw: null, error: `All models failed. Last error: ${lastError}` };
}

// ── Stats ───────────────────────────────────────────────────────────────────

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

function initStats(dataDir: string): void {
  statsPath = path.join(dataDir, "stats.json");
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

// ── Core message processing ─────────────────────────────────────────────────

async function processVibeMessage(
  config: VibeConfig,
  discordChannelId: string,
  content: string,
  authorId: string | undefined,
  authorName: string,
  messageId: string | undefined,
  guildId: string | undefined,
): Promise<void> {
  // Cross-process deduplication
  if (messageId) {
    if (!tryClaimMessage(messageId)) {
      logger.info(`CROSS_PROCESS_DEDUPE msgId=${messageId} author=${authorName}`);
      return;
    }
  }

  // Skip non-watched channels
  if (!config.watchedChannelIds.includes(discordChannelId)) {
    logDecision("NOT_WATCHED", { channel: discordChannelId });
    return;
  }

  // Dedupe
  if (messageId && isDuplicate(messageId, config.dedupeWindowMs)) {
    stats.dedupeSuppressed++;
    scheduleStatsSave();
    logDecision("DEDUPE", { messageId, channel: discordChannelId });
    return;
  }

  // Cooldown
  if (isOnCooldown(discordChannelId, config.cooldownMs)) {
    stats.cooldownSuppressed++;
    scheduleStatsSave();
    logDecision("COOLDOWN", { channel: discordChannelId });
    return;
  }

  // ── Layer 0: Known slur pre-filter
  const hasSlur = containsKnownSlur(content);

  // ── Layer 1: Sentiment gate
  const nonEnglish = isLikelyNonEnglish(content);
  if (!nonEnglish && !hasSlur) {
    const score = getSentimentScore(content);
    if (score > config.sentimentThreshold) {
      logDecision("SENTIMENT_PASS", { score, threshold: config.sentimentThreshold, channel: discordChannelId });
      return;
    }
    stats.flagged++;
    scheduleStatsSave();
    logDecision("SENTIMENT_FLAG", { score, threshold: config.sentimentThreshold, channel: discordChannelId, preview: content.slice(0, 60), author: authorName, authorId });
  } else {
    stats.flagged++;
    scheduleStatsSave();
    logDecision("SENTIMENT_FLAG", { score: hasSlur ? "slur-bypass" : "non-english-bypass", threshold: config.sentimentThreshold, channel: discordChannelId, preview: content.slice(0, 60), author: authorName, authorId });
  }

  // ── Layer 2: AI vibe review
  const recentMessages = await fetchRecentMessages(
    config.discordToken,
    discordChannelId,
    messageId,
    config.maxRecentMessages,
    true, // filter bots
  );

  const correlationId = crypto.randomUUID();
  const safeContent = sanitizeForPrompt(content);
  const safeAuthor = sanitizeForPrompt(authorName);
  const safeRecentMessages = recentMessages.map((m) => ({
    author: sanitizeForPrompt(m.author),
    content: sanitizeForPrompt(m.content),
  }));
  const vibePrompt = buildVibeCheckPrompt(safeContent, safeAuthor, safeRecentMessages);

  logDecision("VIBE_CHECK_START", {
    correlationId,
    channel: discordChannelId,
    author: authorName,
    authorId,
  });

  const review = await runVibeReview(config, vibePrompt);

  if (!review.raw) {
    stats.reviewErrors++;
    scheduleStatsSave();
    const errorSummary = review.error || "unknown review failure";
    logDecision("VIBE_CHECK_ERROR", {
      correlationId,
      channel: discordChannelId,
      author: authorName,
      authorId,
      error: errorSummary,
    });
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
      await sendDiscord(config.discordToken, config.modChannelId, alert.join("\n"));
    }
    return;
  }

  const result = parseVibeResult(review.raw);
  if (!result) {
    stats.reviewErrors++;
    scheduleStatsSave();
    logDecision("VIBE_CHECK_ERROR", {
      correlationId,
      channel: discordChannelId,
      author: authorName,
      authorId,
      reason: "parse failure",
      raw: review.raw.slice(0, 200),
    });
    if (config.modChannelId) {
      await sendDiscord(
        config.discordToken,
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
    logDecision("FALSE_ALARM", {
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

  if (shouldReplyPublicly) {
    await sendDiscord(config.discordToken, discordChannelId, result.suggestedResponse!, messageId);
    stats.mildResponses++;
    scheduleStatsSave();
    logDecision("MILD_RESPONSE", {
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

    await sendDiscord(config.discordToken, config.modChannelId!, alert.join("\n"));
    stats.escalations++;
    scheduleStatsSave();
    logDecision("HIGH_ESCALATION", {
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

// ── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  const dataDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // Load .env from standalone/ directory
  loadDotEnv(process.cwd());

  const config = resolveConfig();

  if (!config.openRouterKey && !config.anthropicKey) {
    logger.warn("No AI provider key configured — vibe reviews will fail. Set BANANO_OPENROUTER_KEY or ANTHROPIC_API_KEY.");
  }

  if (config.watchedChannelIds.length === 0) {
    logger.warn("No watched channels configured — bot will not trigger. Set WATCHED_CHANNEL_IDS.");
  }

  // Initialize subsystems
  initVibeLog(dataDir);
  initViolations(dataDir);
  initStats(dataDir);

  logger.info(
    `Active v1.0.0 | watching: ${config.watchedChannelIds.join(", ") || "none"} | ` +
    `mod: ${config.modChannelId || "none"} | threshold: ${config.sentimentThreshold}`,
  );

  // Start Discord gateway
  const gateway = startDirectGateway(
    config.discordToken,
    config.watchedChannelIds,
    async (msg: DiscordMessageEvent) => {
      await processVibeMessage(
        config,
        msg.channel_id,
        msg.content,
        msg.author.id,
        msg.author.username,
        msg.id,
        msg.guild_id,
      );
    },
  );

  // Graceful shutdown
  const shutdown = () => {
    logger.info("Shutting down...");
    gateway.stop();
    // Flush pending saves
    if (statsTimer) clearTimeout(statsTimer);
    if (saveTimer) clearTimeout(saveTimer);
    stats.lastSaved = new Date().toISOString();
    fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2), "utf8");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
