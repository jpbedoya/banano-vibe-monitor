# Banano Vibe Monitor — OpenClaw Plugin

Two-layer vibe moderation for Discord channels, running natively inside OpenClaw.

## Install

```bash
cd banano-bot/plugin
npm install && npm run build
openclaw plugins install -l .
```

## Configure

Add to your OpenClaw `config.yml`:

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
        pendingCheckTimeoutMs: 60000
        maxPendingChecks: 20
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
                                            Layer 2: AI vibe review
                                            (with last ~10 messages for context)
                                                    │
                                            ├── false alarm → ignore
                                            ├── mild → in-channel redirect
                                            └── high → mod escalation
                                                         + public reply (if highSeverityPublicReply)
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

### Security

- **Mod auth:** `!banano stop/start` verifies Discord permissions (ModerateMembers or Administrator). Configure `modRoleIds`/`modUserIds` for explicit control — don't rely on permission fallback alone in production.
- **Correlation IDs:** every vibe check gets a UUID; interception only fires on exact match, no cross-talk between concurrent checks.
- **Response interception:** vibe check responses are tagged and consumed before reaching chat. Raw JSON never leaks to users.
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

All decisions are logged as structured entries:

```
[banano-vibe] DECISION {"key":"value",...}
```

Decisions: `SILENCED`, `NOT_WATCHED`, `DEDUPE`, `COOLDOWN`, `SENTIMENT_PASS`, `SENTIMENT_FLAG`, `VIBE_CHECK_ENQUEUED`, `FALSE_ALARM`, `MILD_RESPONSE`, `HIGH_ESCALATION`, `MOD_DENIED`, `MOD_SILENCED`, `MOD_UNSILENCED`

**Useful log queries:**
```bash
# False alarm rate
grep 'FALSE_ALARM\|SENTIMENT_FLAG' openclaw.log | wc -l

# All escalations
grep 'HIGH_ESCALATION' openclaw.log

# Cooldown suppression (may indicate noisy channel or threshold too aggressive)
grep 'COOLDOWN' openclaw.log | wc -l
```

Use `/vibe_stats` for a quick summary without log access.

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
- **Cleaner AI path** — long-term: dedicated moderation runtime instead of system-event injection/interception

## Changelog

### v1.3.0
- `/vibe_stats` command — flag, false alarm, escalation, cooldown counters
- `highSeverityPublicReply` config — explicit control over whether high-severity also replies publicly
- Stats counters wired to all decision paths
- Silent escalation note in mod alert when `highSeverityPublicReply: false`

### v1.2.0
- Correlation IDs — UUID per check, exact-match interception
- Jump links — correct `discord.com/channels/{guildId}/{channelId}/{msgId}` format
- Hardened pending-check map — timeout eviction + max cap
- `logDecision()` structured logging helper
- Context hygiene — bot filter + empty message strip
- New config: `pendingCheckTimeoutMs`, `maxPendingChecks`, `contextFilterBots`, `modEscalationMinSeverity`

### v1.1.0
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
- [ ] Raw JSON never appears in any channel
- [ ] `/vibe_stats` shows correct counts
