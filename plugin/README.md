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
        watchedChannelIds:
          - "1483389953089077359"
        modChannelId: "1483389841835167866"
        sentimentThreshold: -2
        modRoleIds:
          - "YOUR_MOD_ROLE_ID"    # optional: lock stop/start to specific roles
        modUserIds:
          - "YOUR_USER_ID"        # optional: always-allowed mod users
        cooldownMs: 30000          # min time between actions per channel
        dedupeWindowMs: 60000      # ignore duplicate message events
        maxRecentMessages: 10      # context window for AI review
```

Also set `requireMention: false` on watched channels:

```yaml
channels:
  discord:
    guilds:
      YOUR_GUILD_ID:
        channels:
          "1483389953089077359":
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
                                            (with ~10 recent messages for context)
                                                    │
                                            ├── false alarm → ignore
                                            ├── mild → Banano redirects in-channel
                                            └── high → in-channel + mod escalation
```

### Security
- **Mod auth (P0):** `!banano stop/start` verifies Discord permissions via API (ModerateMembers or Administrator). Optionally lock to specific roles/users via `modRoleIds`/`modUserIds`. Fails closed if can't verify.
- **Response interception (P0):** Vibe check responses are tagged internally and intercepted before reaching chat. Raw JSON never leaks to users.
- **Context-aware (P0):** AI review gets the last ~10 messages for context, preventing false flags on sarcasm/banter.

### Mod controls
- `!banano stop` — silence in current channel (persists across restarts)
- `!banano start` — resume in current channel
- Mods/admins only (verified via Discord API)

### Commands
- `/vibe_status` — show current plugin config

## P0 fixes (v1.1.0)

1. ✅ **Real mod auth** — Discord API permission check, configurable role/user IDs, fail closed
2. ✅ **Recent message context** — fetches last ~10 messages via Discord REST API
3. ✅ **Tagged vibe check responses** — internal marker prevents JSON leaks, pending-check map for reliable interception
4. ✅ **Session routing** — uses OpenClaw's conversation-based session key
5. ✅ **Dedupe + cooldown** — per-message dedup, per-channel cooldown, auto-cleanup
6. ✅ **Rich mod escalation** — includes user, message, severity, reason, jump link

## Test checklist

- [ ] `@Banano gm` → normal reply (bypasses plugin)
- [ ] Positive message in watched channel → ignored
- [ ] Negative message → sentiment gate trips → AI review with context
- [ ] Mild issue → gentle in-channel redirect
- [ ] Serious issue → mod channel escalation with full details
- [ ] `!banano stop` by mod → silences channel
- [ ] `!banano stop` by non-mod → denied
- [ ] `!banano start` by mod → resumes channel
- [ ] Rapid negative messages → cooldown prevents spam
- [ ] Same message event twice → dedupe prevents double-processing
- [ ] Raw JSON never appears in any channel
