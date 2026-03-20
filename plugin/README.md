# Banano Vibe Monitor — OpenClaw Plugin v1.3.0

Two-layer vibe moderation for Discord channels, running natively inside OpenClaw.

## Install

```bash
# 1. Clone and build
git clone https://github.com/jpbedoya/banano-bot
cd banano-bot/plugin
npm install && npm run build

# 2. Copy-install into OpenClaw (isolated from dev code)
openclaw plugins install .
```

This copies the plugin into OpenClaw's extensions directory (`~/.openclaw/extensions/banano-vibe/`). Logs, state, and config are all stored there — separate from your dev folder.

### Updating to a new version

```bash
cd banano-bot/plugin
git pull
npm run build
openclaw plugins install .   # re-copies, overwrites the installed version
openclaw gateway restart
```

Prod only updates when you explicitly run these steps. A `git pull` in your dev folder has no effect until you reinstall.

> **Note:** Do not use `openclaw plugins install -l .` (the `-l` / link flag). That loads directly from your dev folder and any file change takes effect on next restart — not safe for production.

## Configure

Add to your OpenClaw config (`openclaw.json`):

```yaml
plugins:
  entries:
    banano-vibe:
      enabled: true
      config:
        # Required: channels to monitor
        watchedChannelIds:
          - "CHANNEL_ID_HERE"

        # Required: where to send mod escalations
        modChannelId: "MOD_CHANNEL_ID_HERE"

        # Required: lock mod commands to specific roles/users.
        # Falls back to Discord permission bits (ModerateMembers/Admin) if empty,
        # but explicit IDs are more predictable and easier to audit.
        modRoleIds:
          - "MOD_ROLE_ID_HERE"
        modUserIds:
          - "TRUSTED_USER_ID_HERE"   # optional, always-allowed individuals

        # Sentiment gate threshold (default: -2).
        # Lower = less sensitive. Start here, tune after a few days of real traffic.
        # Watch logs for false alarms and missed flags; -1 is more responsive.
        sentimentThreshold: -2

        # Escalation policy
        modEscalationMinSeverity: high   # low | medium | high (default: high)
        highSeverityPublicReply: true    # false = silent mod-only escalation for high severity

        # Tuning knobs (defaults are fine for launch)
        cooldownMs: 30000          # min time between actions per channel
        dedupeWindowMs: 60000      # ignore duplicate message events
        maxRecentMessages: 10      # AI context window size
        contextFilterBots: true    # filter bot messages from AI context
        vibeReviewTimeoutMs: 30000 # isolated AI review timeout
```

Also set `requireMention: false` on watched channels so Banano sees every message:

```yaml
channels:
  discord:
    guilds:
      YOUR_GUILD_ID:
        channels:
          "CHANNEL_ID_HERE":
            requireMention: false
```

Then restart OpenClaw.

## How it works

```
All messages in watched channels
  │
  ▼
Layer 1: Sentiment score (free, local)
  │
  ├── score > threshold → ignore (90%+ of messages)
  │
  └── score <= threshold ──→ dedupe check ──→ cooldown check
                                                    │
                                            claim the turn (suppress normal Banano reply)
                                                    │
                                            Layer 2: AI vibe review
                                            (with last ~10 messages for context)
                                                    │
                                            ├── false alarm → ignore publicly
                                            ├── mild → in-channel redirect
                                            ├── high → mod escalation
                                            │            + public reply (if highSeverityPublicReply)
                                            └── review failure → retry once silently,
                                                         then mod-only failure alert
```

### Escalation policy

| Severity | In-channel reply? | Mod alert? |
|----------|------------------|------------|
| low      | yes (if above threshold) | only if modEscalationMinSeverity=low |
| medium   | yes              | only if modEscalationMinSeverity=low/medium |
| high     | only if highSeverityPublicReply=true | always (if above threshold) |

**Recommended starting config:**
- `modEscalationMinSeverity: high` — mods only see serious stuff
- `highSeverityPublicReply: true` — Banano still redirects publicly

For a stricter moderation community, set `highSeverityPublicReply: false` to escalate silently.

### Security / safety behavior

- **Mod auth:** `!banano stop/start` verifies Discord permissions (ModerateMembers or Administrator). Configure `modRoleIds`/`modUserIds` for explicit control — don't rely on permission fallback alone in production.
- **Claimed turns:** once a watched-channel message trips moderation, Banano claims that turn and suppresses normal assistant replies in that channel for the moderation window.
- **No raw provider errors in watched chat:** if the review fails, Banano logs the failure and alerts the mod channel only — never exposes errors in the watched channel.
- **Context-aware:** AI review includes last ~10 messages, preventing false flags on sarcasm/banter.
- **Fails closed:** if permission check fails, mod commands are denied.

### Mod controls

- `!banano stop` — silence in current channel (persists across restarts)
- `!banano start` — resume in current channel
- Mods/admins only (verified via Discord API)

### Commands

- `/vibe_status` — show current config and pending check count
- `/vibe_stats` — show counters since last restart (flags, false alarms, escalations, cooldowns)

## Observability

### Dedicated JSONL log

After a copied install (`npm run deploy`), logs live at:
```
~/.openclaw/extensions/banano-vibe/logs/banano-vibe-YYYY-MM-DD.jsonl
```

One JSON object per line, daily rotation by UTC date. Only actionable decisions are written — noisy pass-throughs (`SENTIMENT_PASS`, `NOT_WATCHED`) are skipped.

Example entries:
```jsonl
{"ts":"2026-03-17T18:34:00.000Z","decision":"SENTIMENT_FLAG","channel":"123...","score":-3,"preview":"this project is trash","author":"user123","authorId":"4280..."}
{"ts":"2026-03-17T18:34:00.100Z","decision":"TURN_CLAIMED","channel":"123...","messageId":"1483...","author":"user123","authorId":"4280..."}
{"ts":"2026-03-17T18:34:02.000Z","decision":"FALSE_ALARM","channel":"123...","reason":"sarcastic banter","correlationId":"..."}
{"ts":"2026-03-17T18:35:10.000Z","decision":"HIGH_ESCALATION","channel":"123...","severity":"high","reason":"personal attack","author":"user123","authorId":"4280...","hasJumpLink":true}
```

**Tail live:**
```bash
LOGDIR=~/.openclaw/extensions/banano-vibe/logs
tail -f $LOGDIR/banano-vibe-$(date -u +%Y-%m-%d).jsonl | jq .
```

### CLI summary script

Run from the dev folder (`~/banano-bot/plugin`):

```bash
# Today's summary (reads from installed extension logs)
LOGS_DIR=~/.openclaw/extensions/banano-vibe/logs npm run logs

# Specific date
node scripts/logs-summary.mjs 2026-03-17

# All dates
npm run logs:all

# Last N recent events
node scripts/logs-summary.mjs --recent 20
```

Output includes:
- Total flags, false alarms, escalations, mild responses
- False alarm rate (%)
- Top channels by event count
- Recent events timeline

### Static HTML viewer

Open `scripts/logs-viewer.html` in any browser — no server needed.

Drop a `banano-vibe-YYYY-MM-DD.jsonl` file from `~/.openclaw/extensions/banano-vibe/logs/` onto it to get:
- Summary cards (flags / false alarms / mild / escalations)
- Top channels bar chart
- Filterable, searchable event table

### jq queries

```bash
LOGDIR=~/.openclaw/extensions/banano-vibe/logs
DATE=$(date -u +%Y-%m-%d)

# All escalations
jq 'select(.decision=="HIGH_ESCALATION")' $LOGDIR/banano-vibe-$DATE.jsonl

# Count by decision type
jq -r '.decision' $LOGDIR/banano-vibe-$DATE.jsonl | sort | uniq -c | sort -rn
```

Decisions in the file: `SENTIMENT_FLAG`, `TURN_CLAIMED`, `NORMAL_REPLY_SUPPRESSED`, `VIBE_CHECK_START`, `VIBE_CHECK_ERROR`, `FALSE_ALARM`, `MILD_RESPONSE`, `HIGH_ESCALATION`, `MOD_DENIED`, `MOD_SILENCED`, `MOD_UNSILENCED`, `COOLDOWN`, `DEDUPE`

All decisions (including pass-throughs) are also in the main OpenClaw gateway log:
```bash
grep "banano-vibe" ~/.openclaw/logs/gateway.log
```

Use `/vibe_stats` for a quick in-chat summary without touching the filesystem.

## Tuning guide

**After a few days of real traffic:**

1. Check `SENTIMENT_FLAG` vs `FALSE_ALARM` ratio. High false alarm rate → lower threshold (e.g. -1).
2. Check `COOLDOWN` count. High suppression → channel is noisy or threshold too sensitive.
3. Check `HIGH_ESCALATION` logs. Too many mod alerts → raise `modEscalationMinSeverity` to `high`.
4. Check `SENTIMENT_PASS` entries for messages that should have been caught → raise threshold.

## What's not in scope yet

These are known limitations to revisit after launch with real traffic:

- **Per-user cooldown** — repeated offender tracking, anti-pile-on behavior
- **Context quality** — trim repetitive spam, skip very short noise
- **Suppression scope** — turn-claim suppression is channel-scoped and time-window based; if you want even tighter ownership, move moderation to a dedicated bot/session surface

## Changelog

### v1.3.0
- **Direct Anthropic API for vibe review** — replaced subagent session approach with a direct `fetch` to the Anthropic messages API. Eliminates the `Plugin runtime subagent methods are only available during a gateway request` crash entirely. No session lifecycle, no context expiry, no retry needed.
- Removed all subagent runtime types and the persistent reviewer session key
- `vibeModel` config now strips the `anthropic/` prefix automatically for the API call (default: `claude-haiku-4-5`)

### v1.2.0
- **Persistent reviewer session** — vibe checks now reuse a single long-lived session (`banano-vibe:reviewer`) instead of spawning a new one per message. Eliminates session sprawl and cleans up orphaned subagents.
- **Removed retry loop** — the previous retry-on-timeout logic would attempt a second subagent run after the gateway request context had already expired, causing `Plugin runtime subagent methods are only available during a gateway request` errors. Removed the retry; a single well-scoped run is reliable; failures are still alerted to the mod channel.
- Mod channel failure alert now says "Vibe review failed" (singular) instead of "failed twice"

### v1.1.3
- Added `vibeModel` config option — override the AI model used for vibe review (defaults to OpenClaw primary)
- Hardened Discord suppression fallback for edge cases in message routing
- Fixed subagent session cleanup to avoid leaking sessions on timeout
- Fixed `!banano stop/start` to claim channel reply and suppress main agent leakthrough

### v1.1.2
- Fixed claim window behavior: window now releases cleanly on false alarm
- Fixed false alarm path: channel reply claim is freed so normal replies can resume
- Fixed jump link: guarded against missing `guildId`/`messageId` to prevent broken links
- Tightened dedupe: sentiment check now happens after dedupe to avoid double-counting

### v1.1.1
- Fixed isolated review runtime call to include `idempotencyKey`
- Fixed Discord send path to use OpenClaw's native `sendMessageDiscord(target, text, opts)` signature
- Fixed Discord author attribution using `senderName` / `senderUsername`
- Added `authorId` to logs and mod escalations for reliable later moderation actions
- Claimed-turn suppression: when moderation triggers, Banano suppresses normal watched-channel replies for that turn
- Retry-once moderation review failure handling, with second failure logged and sent to mod channel only
- Removed stale config docs for `pendingCheckTimeoutMs` / `maxPendingChecks`

### v1.0.0
- CLI summary script: `npm run logs` — flags, false alarms, escalations, top channels, recent events
- Static HTML viewer: `scripts/logs-viewer.html` — drag-and-drop JSONL, filter/search, charts

### v0.4.0
- Dedicated JSONL log: `plugin/logs/banano-vibe-YYYY-MM-DD.jsonl` (daily rotation, UTC)
- Only actionable decisions written (not noisy pass-throughs)
- Best-effort write — plugin won't crash if log dir is unwritable

### v0.3.0
- `/vibe_stats` command — flag, false alarm, escalation, cooldown counters
- `highSeverityPublicReply` config — explicit control over whether high-severity also replies publicly
- Stats counters wired to all decision paths
- Silent escalation note in mod alert when `highSeverityPublicReply: false`

### v0.2.0
- Correlation IDs — UUID per check, exact-match interception
- Jump links — correct `discord.com/channels/{guildId}/{channelId}/{msgId}` format
- `logDecision()` structured logging helper
- Context hygiene — bot filter + empty message strip
- New config: `contextFilterBots`, `modEscalationMinSeverity`

### v0.1.0
- Real mod auth via Discord API (ModerateMembers/Admin + configurable role/user IDs)
- Recent message context fetch for AI review
- Tagged vibe check responses (VIBE_TAG) — JSON never leaks to chat
- Session routing via conversation-based key
- Dedupe by message ID + per-channel cooldown
- Rich mod escalation (user, message, severity, reason)

## Test checklist

- [ ] `@Banano gm` → normal reply (bypasses plugin)
- [ ] Positive message in watched channel → `SENTIMENT_PASS` in logs
- [ ] Negative message → sentiment gate trips → AI review fires
- [ ] Mild issue → gentle in-channel redirect
- [ ] Serious issue → mod channel escalation with jump link
- [ ] `highSeverityPublicReply: false` → high severity escalates silently
- [ ] `!banano stop` by mod → silences channel, persists on restart
- [ ] `!banano stop` by non-mod → `MOD_DENIED` in logs, no action
- [ ] `!banano start` by mod → resumes channel
- [ ] Rapid negative messages → cooldown suppresses spam
- [ ] Same message event twice → dedupe prevents double-processing
- [ ] Raw JSON / provider errors never appear in watched chat
- [ ] Flagged message suppresses normal Banano reply in watched channel
- [ ] Review failure alerts mod channel only (no error in watched channel)
- [ ] `/vibe_stats` shows correct counts
