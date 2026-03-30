/**
 * Violation ledger — JSON-backed per-user strike tracking.
 * Stored at: <pluginDir>/moderation/violations.json
 *
 * Writes are async and debounced to avoid blocking the event loop.
 */

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";

export type ViolationEntry = {
  strike: number;
  date: string; // ISO date YYYY-MM-DD
  reason: string;
  severity: "low" | "medium" | "high";
  channelId: string;
  messageId?: string;
  guildId?: string;
  issuedBy: "auto" | string;
};

export type MemberRecord = {
  userId: string;
  username: string;
  strikes: number;
  history: ViolationEntry[];
};

export type ViolationsLedger = {
  version: 1;
  members: Record<string, MemberRecord>;
};

let ledgerPath: string;
let ledger: ViolationsLedger;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function initViolations(pluginDir: string): void {
  const dir = path.join(pluginDir, "moderation");
  ledgerPath = path.join(dir, "violations.json");
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(ledgerPath)) {
      ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    } else {
      ledger = { version: 1, members: {} };
      scheduleSave();
    }
  } catch {
    ledger = { version: 1, members: {} };
  }
}

function scheduleSave(debounceMs = 500): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fsp.writeFile(ledgerPath, JSON.stringify(ledger, null, 2), "utf8").catch(() => {
      // Best-effort — loss of a single write is acceptable
    });
  }, debounceMs);
}

export function recordViolation(params: {
  userId: string;
  username: string;
  reason: string;
  severity: "low" | "medium" | "high";
  channelId: string;
  messageId?: string;
  guildId?: string;
  issuedBy?: string;
}): MemberRecord {
  const { userId, username, reason, severity, channelId, messageId, guildId, issuedBy } = params;

  if (!ledger.members[userId]) {
    ledger.members[userId] = { userId, username, strikes: 0, history: [] };
  }

  const member = ledger.members[userId];
  member.username = username;
  member.strikes += 1;

  const entry: ViolationEntry = {
    strike: member.strikes,
    date: new Date().toISOString().slice(0, 10),
    reason,
    severity,
    channelId,
    ...(messageId ? { messageId } : {}),
    ...(guildId ? { guildId } : {}),
    issuedBy: issuedBy || "auto",
  };

  member.history.push(entry);
  scheduleSave();
  return member;
}

export function getMember(userId: string): MemberRecord | null {
  return ledger.members[userId] ?? null;
}

export function getRecentViolations(limitDays = 30): Array<MemberRecord & { latestViolation: ViolationEntry }> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - limitDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  return Object.values(ledger.members)
    .filter((m) => m.history.some((h) => h.date >= cutoffStr))
    .map((m) => {
      const recent = [...m.history].reverse().find((h) => h.date >= cutoffStr)!;
      return { ...m, latestViolation: recent };
    })
    .sort((a, b) => b.strikes - a.strikes);
}

export function formatMemberViolations(member: MemberRecord): string {
  const lines = [
    `**${member.username}** (<@${member.userId}>) — ${member.strikes} strike${member.strikes !== 1 ? "s" : ""}`,
  ];
  for (const v of member.history) {
    const jumpLink =
      v.guildId && v.messageId
        ? ` — [jump](https://discord.com/channels/${v.guildId}/${v.channelId}/${v.messageId})`
        : "";
    lines.push(`  • Strike ${v.strike} | ${v.date} | ${v.severity} | ${v.reason}${jumpLink}`);
  }
  return lines.join("\n");
}
