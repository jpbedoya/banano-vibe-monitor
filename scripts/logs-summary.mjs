#!/usr/bin/env node
/**
 * Banano Vibe Monitor — Log Summary
 *
 * Usage:
 *   node scripts/logs-summary.mjs              # today (UTC)
 *   node scripts/logs-summary.mjs 2026-03-17   # specific date
 *   node scripts/logs-summary.mjs --all        # all available dates
 *   node scripts/logs-summary.mjs --recent 5   # last 5 recent events
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Default to the installed extension logs dir; fall back to local dev logs
const INSTALLED_LOGS = path.join(
  process.env.HOME || "~",
  ".openclaw/extensions/banano-vibe/logs"
);
const LOCAL_LOGS = path.join(__dirname, "../logs");
const LOGS_DIR = process.env.LOGS_DIR ||
  (fs.existsSync(INSTALLED_LOGS) ? INSTALLED_LOGS : LOCAL_LOGS);

const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgRed: "\x1b[41m",
  bgYellow: "\x1b[43m",
};

const DECISION_COLOR = {
  SENTIMENT_FLAG: COLORS.yellow,
  VIBE_CHECK_ENQUEUED: COLORS.cyan,
  FALSE_ALARM: COLORS.green,
  MILD_RESPONSE: COLORS.cyan,
  HIGH_ESCALATION: COLORS.red,
  MOD_SILENCED: COLORS.yellow,
  MOD_UNSILENCED: COLORS.green,
  MOD_DENIED: COLORS.red,
  COOLDOWN: COLORS.dim,
  DEDUPE: COLORS.dim,
};

function c(color, text) {
  return `${color}${text}${COLORS.reset}`;
}

function loadLines(date) {
  const file = path.join(LOGS_DIR, `banano-vibe-${date}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function getAvailableDates() {
  if (!fs.existsSync(LOGS_DIR)) return [];
  return fs
    .readdirSync(LOGS_DIR)
    .filter((f) => f.match(/^banano-vibe-\d{4}-\d{2}-\d{2}\.jsonl$/))
    .map((f) => f.replace("banano-vibe-", "").replace(".jsonl", ""))
    .sort();
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function summarize(events, label) {
  const total = events.length;
  if (total === 0) {
    console.log(`\n${c(COLORS.bold, label)}: ${c(COLORS.dim, "no events")}`);
    return;
  }

  const counts = {};
  const channelCounts = {};
  for (const e of events) {
    counts[e.decision] = (counts[e.decision] || 0) + 1;
    if (e.channel) channelCounts[e.channel] = (channelCounts[e.channel] || 0) + 1;
  }

  const flags = counts["SENTIMENT_FLAG"] || 0;
  const enqueued = counts["VIBE_CHECK_ENQUEUED"] || 0;
  const falseAlarms = counts["FALSE_ALARM"] || 0;
  const mild = counts["MILD_RESPONSE"] || 0;
  const escalations = counts["HIGH_ESCALATION"] || 0;
  const cooldowns = counts["COOLDOWN"] || 0;
  const dedupes = counts["DEDUPE"] || 0;

  const falseAlarmRate = enqueued > 0 ? Math.round((falseAlarms / enqueued) * 100) : 0;
  const rateColor = falseAlarmRate > 60 ? COLORS.red : falseAlarmRate > 30 ? COLORS.yellow : COLORS.green;

  console.log(`\n${c(COLORS.bold, "━━━ " + label + " ━━━")}`);
  console.log();
  console.log(`  ${c(COLORS.bold, "Sentiment flags:")}    ${c(COLORS.yellow, flags)}`);
  console.log(`  ${c(COLORS.bold, "AI reviews sent:")}    ${enqueued}`);
  console.log(`  ${c(COLORS.bold, "False alarms:")}       ${c(COLORS.green, falseAlarms)}  ${c(rateColor, `(${falseAlarmRate}% false alarm rate)`)}`);
  console.log(`  ${c(COLORS.bold, "Mild responses:")}     ${c(COLORS.cyan, mild)}`);
  console.log(`  ${c(COLORS.bold, "Escalations:")}        ${c(escalations > 0 ? COLORS.red : COLORS.dim, escalations)}`);
  console.log(`  ${c(COLORS.bold, "Cooldowns:")}          ${c(COLORS.dim, cooldowns)}`);
  console.log(`  ${c(COLORS.bold, "Deduped:")}            ${c(COLORS.dim, dedupes)}`);

  // Top channels
  const topChannels = Object.entries(channelCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  if (topChannels.length > 0) {
    console.log();
    console.log(`  ${c(COLORS.bold, "Top channels:")}`);
    for (const [channel, count] of topChannels) {
      console.log(`    ${c(COLORS.dim, channel)}  ${count} events`);
    }
  }
}

function printRecent(events, n = 10) {
  const recent = events.slice(-n).reverse();
  if (recent.length === 0) {
    console.log(c(COLORS.dim, "  no recent events"));
    return;
  }
  console.log(`\n${c(COLORS.bold, `━━━ Last ${recent.length} events ━━━`)}`);
  console.log();
  for (const e of recent) {
    const time = e.ts ? new Date(e.ts).toLocaleTimeString() : "?";
    const color = DECISION_COLOR[e.decision] || COLORS.white;
    const decision = c(color, e.decision.padEnd(22));
    const channel = e.channel ? c(COLORS.dim, `#${e.channel.slice(-6)}`) : "";
    const detail = e.preview
      ? `"${e.preview.slice(0, 50)}"`
      : e.reason
      ? e.reason.slice(0, 60)
      : e.severity
      ? `severity:${e.severity}`
      : "";
    console.log(`  ${c(COLORS.dim, time)}  ${decision}  ${channel}  ${c(COLORS.dim, detail)}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (!fs.existsSync(LOGS_DIR)) {
  console.log(c(COLORS.yellow, `No logs directory found at: ${LOGS_DIR}`));
  console.log(c(COLORS.dim, "Logs are written once the plugin is active and events occur."));
  process.exit(0);
}

if (args.includes("--all")) {
  const dates = getAvailableDates();
  if (dates.length === 0) {
    console.log(c(COLORS.dim, "No log files found."));
    process.exit(0);
  }
  let allEvents = [];
  for (const date of dates) {
    const events = loadLines(date);
    summarize(events, date);
    allEvents = allEvents.concat(events);
  }
  if (dates.length > 1) {
    summarize(allEvents, `All time (${dates.length} days)`);
  }
  printRecent(allEvents, 10);
} else {
  const recentIdx = args.indexOf("--recent");
  const recentN = recentIdx >= 0 ? parseInt(args[recentIdx + 1]) || 10 : 10;
  const date = args.find((a) => a.match(/^\d{4}-\d{2}-\d{2}$/)) || todayUTC();
  const events = loadLines(date);

  summarize(events, `${date}${date === todayUTC() ? " (today)" : ""}`);
  printRecent(events, recentN);
}

console.log();
