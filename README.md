# Banano Vibe Monitor — OpenClaw Plugin v1.5.1

Two-layer vibe moderation for Discord channels, running natively inside OpenClaw.

## Install

```bash
# 1. Clone and build
git clone https://github.com/jpbedoya/banano-bot
cd banano-bot/plugin
npm install && npm run build

# 2. Copy-install into OpenClaw
cp dist/index.js ~/.openclaw/extensions/banano-vibe/dist/index.js
```

> **Note:** `openclaw plugins install .` will fail if the plugin already exists. After first install, just copy the built `dist/index.js` directly and restart the gateway.

### First install (clean slate)

```bash
cd banano-bot/plugin
npm install && npm run build
openclaw plugins install .
openclaw gateway restart
```

### Updating to a new version

```bash
cd banano-bot/plugin
git pull
npm run build
cp dist/index.js ~/.openclaw/extensions/banano-vibe/dist/index.js
openclaw gateway restart
```

> **Important:** `openclaw plugins install` blocks if the plugin directory already exists. Always use the `cp` approach for updates — no need to uninstall first.

> **Do not** use `openclaw plugins install -l .` (the `-l` / link flag). That loads directly from your dev folder and any file change takes effect on next restart — not safe for production.

---

## Configure

Add to your OpenClaw config (`openclaw.json`) via `openclaw config edit` or the gateway `config.patch` API:

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
        sentimentThreshold: -2

        # Escalation policy
        # modEscalationMinSeverity controls which severity levels get posted to the mod channel:
        #   low    → all toxic messages go to mod channel (best for testing/visibility)
        #   medium → only medium + high severity go to mod channel
        #   high   → only high severity (direct threats, serious attacks) go to mod channel
        # In all cases, Banano still replies in-channel to flagged messages (if suggestedResponse set).
        modEscalationMinSeverity: low    # low | medium | high (default: high)
        highSeverityPublicReply: true    # false = silent mod-only escalation for high severity; true = Banano also replies publicly

        # AI model for vibe review (optional — see Model Selection below)
        vibeModel: "openrouter/google/gemma-3-27b-it:free"

        # Fallback models tried in order if primary returns 429/5xx/empty (optional)
        # Defaults to: llama-3.3-70b → nemotron-3-nano → claude-haiku-4-5
        vibeModelFallbacks:
          - "openrouter/meta-llama/llama-3.3-70b-instruct:free"
          - "openrouter/nvidia/nemotron-3-nano-30b-a3b:free"
          - "anthropic/claude-haiku-4-5"

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

---

## Model Selection

The `vibeModel` config controls which AI model runs the vibe review. The plugin auto-detects the provider from the model ID prefix and routes to the correct API with the correct key.

### Supported providers

| Prefix | API | Key source |
|--------|-----|------------|
| `openrouter/...` | `openrouter.ai/api/v1/chat/completions` | `openrouter` profile in `auth-profiles.json` |
| `anthropic/...` | `api.anthropic.com/v1/messages` | `anthropic` profile in `auth-profiles.json` |

### Examples

```yaml
# Recommended primary (fast, free, non-reasoning — no token budget surprises)
vibeModel: "openrouter/google/gemma-3-27b-it:free"

# Anthropic Haiku (fast, low cost, high quality — good paid fallback)
vibeModel: "anthropic/claude-haiku-4-5"

# OpenRouter auto-router (lets OpenRouter pick the best available)
vibeModel: "openrouter/openrouter/auto"
```

> **Critical:** The `openrouter/` prefix tells the plugin to call OpenRouter's API using the OpenRouter key. Without the prefix, an Anthropic model name is sent to the Anthropic API. If you set `vibeModel` to an OpenRouter model ID without the prefix, it will fail with a 404 from the Anthropic API. Always match the prefix to the provider.

> **Reasoning models (e.g. Nemotron, o1):** These models spend tokens on internal reasoning before generating output. With a low `max_tokens` budget they can return empty content. The plugin sets `max_tokens: 1024` to handle this, but non-reasoning models like Gemma are faster and more predictable for simple classification tasks.

### Fallback chain

Set `vibeModelFallbacks` to try alternative models automatically when the primary returns a 429, 5xx, or empty response:

```yaml
vibeModel: "openrouter/google/gemma-3-27b-it:free"
vibeModelFallbacks:
  - "openrouter/meta-llama/llama-3.3-70b-instruct:free"
  - "openrouter/nvidia/nemotron-3-nano-30b-a3b:free"
  - "anthropic/claude-haiku-4-5"   # paid safety net — always works
```

The plugin tries each model in order and returns the first successful result. Only if all models fail does it post an error to the mod channel.

### Key storage

The plugin resolves the OpenRouter key in this priority order:

1. **`BANANO_OPENROUTER_KEY` env var** — set via the plugin's own `.env` file (recommended, isolated from OpenClaw config)
2. **OpenClaw `auth-profiles.json`** — fallback if env var is not set

**Recommended: use the `.env` file** so the key is fully decoupled from OpenClaw's auth setup:

```bash
# Create/edit the plugin's .env file
echo "BANANO_OPENROUTER_KEY=sk-or-v1-..." > ~/.openclaw/extensions/banano-vibe/.env
```

The plugin loads this file on startup automatically. To rotate the key, just update the `.env` and restart the gateway.

To verify your keys are present:
```bash
cat ~/.openclaw/agents/main/agent/auth-profiles.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
for k, v in data.get('profiles', {}).items():
    print(k, '->', v.get('provider'), '| has key:', 'key' in v or 'token' in v)
"
```

---

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
                                            └── review failure → mod-only failure alert
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

- **Mod auth:** `!banano stop/start` verifies Discord permissions (ModerateMembers or Administrator). Configure `modRoleIds`/`modUserIds` for explicit control.
- **Claimed turns:** once a watched-channel message trips moderation, Banano claims that turn and suppresses normal assistant replies in that channel for the moderation window.
- **No raw provider errors in watched chat:** if the review fails, Banano logs the failure and alerts the mod channel only.
- **Context-aware:** AI review includes last ~10 messages, preventing false flags on sarcasm/banter.
- **Fails closed:** if permission check fails, mod commands are denied.

### Mod controls

- `!banano stop` — silence in current channel (persists across restarts)
- `!banano start` — resume in current channel
- Mods/admins only (verified via Discord API)

### Commands

- `/vibe_status` — show current config, model, thresholds
- `/vibe_stats` — show counters since last restart (flags, false alarms, escalations, cooldowns)
- `/vibe_violations [user]` — show violation history for a user or recent violations (last 30 days)

---

## Violation Ledger

The plugin tracks formal moderation warnings in a persistent ledger at:
```
~/.openclaw/extensions/banano-vibe/moderation/violations.json
```

Violations are recorded automatically when the AI review escalates a message. You can also record manual warnings by issuing them through the Banano agent.

The three-strike policy applies:
- Strike 1: 1-hour timeout
- Strike 2: 24-hour timeout
- Strike 3: 7-day timeout

> **Note:** Banano records violations but cannot apply Discord timeouts directly (requires `MODERATE_MEMBERS` Discord permission on the bot token). Timeouts must be applied manually in Discord. This is a known limitation to close in a future release.

Use `/vibe_violations` to query the ledger, or `/vibe_violations @user` for a specific user.

---

## Observability

### Main OpenClaw log

All decisions flow to the main OpenClaw gateway log:
```bash
grep "banano-vibe" /tmp/openclaw/openclaw-$(date -u +%Y-%m-%d).log | jq .
```

**Decisions logged:** `SENTIMENT_FLAG`, `SENTIMENT_PASS`, `TURN_CLAIMED`, `VIBE_CHECK_START`, `VIBE_CHECK_ERROR`, `FALSE_ALARM`, `MILD_RESPONSE`, `HIGH_ESCALATION`, `MOD_DENIED`, `MOD_SILENCED`, `MOD_UNSILENCED`, `COOLDOWN`, `DEDUPE`, `NOT_WATCHED`

### jq queries

```bash
LOG=/tmp/openclaw/openclaw-$(date -u +%Y-%m-%d).log

# All vibe decisions
grep "banano-vibe" $LOG | jq '."1"' | grep -v null

# Only escalations
grep "HIGH_ESCALATION" $LOG | jq .

# Count by decision type
grep "banano-vibe" $LOG | jq -r '."1" | split(" ")[1]' | sort | uniq -c | sort -rn
```

Use `/vibe_stats` for a quick in-chat summary without touching the filesystem.

---

## Tuning guide

**After a few days of real traffic:**

1. Check `SENTIMENT_FLAG` vs `FALSE_ALARM` ratio. High false alarm rate → lower threshold (e.g. -1).
2. Check `COOLDOWN` count. High suppression → channel is noisy or threshold too sensitive.
3. Check `HIGH_ESCALATION` logs. Too many mod alerts → raise `modEscalationMinSeverity` to `high`.
4. Check `SENTIMENT_PASS` entries for messages that should have been caught → raise threshold.

---

## Troubleshooting

### `Anthropic API 404: model not found`
You set `vibeModel` to an OpenRouter model ID but it's being sent to the Anthropic API. Make sure the model ID starts with `openrouter/`. Example: `openrouter/nvidia/nemotron-3-nano-30b-a3b:free`.

### `/vibe_violations` shows 0 violations
The violation ledger only records violations that were escalated automatically by the AI review, or manually via the agent. Warnings you send as plain Discord messages are not auto-detected. To record a manual warning, ask the Banano agent to issue a formal warning — it will write to the ledger.

### Plugin update not taking effect after restart
SIGUSR1 (gateway tool restart) does a config reload but reuses the cached Node module. If you updated `dist/index.js`, you need a full process restart to bust the module cache:
```bash
openclaw gateway restart
```
Or kill and restart the gateway process directly via your process manager.

### Plugin won't reinstall (`plugin already exists`)
`openclaw plugins install` blocks if `~/.openclaw/extensions/banano-vibe/` already exists. For updates, just copy the built file directly:
```bash
cp dist/index.js ~/.openclaw/extensions/banano-vibe/dist/index.js
openclaw gateway restart
```

---

## What's not in scope yet

- **Applying Discord timeouts automatically** — requires `MODERATE_MEMBERS` permission on bot token; currently manual
- **Per-user cooldown** — repeated offender auto-escalation
- **Violation ledger auto-populated from manual warnings** — currently only auto-escalations are recorded

---

## Changelog

### v1.5.1
- **Singleton guard** — `register()` now exits early if already called. Prevents OpenClaw from spawning multiple Discord gateway connections and duplicate `message_sending` hooks per restart cycle, which was causing the plugin to cancel outgoing Telegram replies and hammer Discord with reconnects.

### v1.5.0
- **`BANANO_OPENROUTER_KEY` env var** — plugin now checks this env var first before falling back to OpenClaw's `auth-profiles.json`. Load it from a `.env` file in the plugin install directory (`~/.openclaw/extensions/banano-vibe/.env`) to keep the key fully isolated from OpenClaw's auth config.
- **`.env` auto-load** — plugin reads `.env` from its install directory on startup. No manual env export needed.

### v1.4.1
- **Fallback model chain** — `vibeModelFallbacks` config (array) lets you specify ordered fallbacks tried automatically on 429/5xx/empty response. Default chain: `llama-3.3-70b:free` → `nemotron-3-nano:free` → `claude-haiku-4-5`
- **`max_tokens` bumped to 1024** — fixes empty responses from reasoning models (e.g. Nemotron) that burn tokens on internal thinking before generating output
- **Default `vibeModel` changed** to `openrouter/google/gemma-3-27b-it:free` — non-reasoning model, faster and more predictable for classification tasks
- **Retryable error detection** — 429/5xx trigger fallback; auth errors (4xx non-429) fail fast without wasting fallback budget

### v1.4.0
- **Multi-provider vibe review** — plugin now routes to the correct API based on the `vibeModel` prefix:
  - `openrouter/*` → OpenRouter API (`openrouter.ai/api/v1/chat/completions`) with OpenRouter key
  - `anthropic/*` → Anthropic API (`api.anthropic.com/v1/messages`) with Anthropic key
  - Previously hard-coded to Anthropic only — any OpenRouter model would 404
- **New `resolveOpenRouterKey()`** — reads OpenRouter key from `auth-profiles.json` automatically
- **Violation ledger** — `/vibe_violations` command + persistent `violations.json` tracking strikes, reasons, dates
- Default `vibeModel` changed to `openrouter/nvidia/nemotron-3-nano-30b-a3b:free` (fast, free, sufficient for moderation)

### v1.3.0
- **Direct Anthropic API for vibe review** — replaced subagent session approach with a direct `fetch` to the Anthropic messages API. Eliminates the `Plugin runtime subagent methods are only available during a gateway request` crash entirely.
- `vibeModel` config strips the `anthropic/` prefix automatically for the API call (default: `claude-haiku-4-5`)

### v1.2.0
- **Persistent reviewer session** — vibe checks reuse a single long-lived session instead of spawning a new one per message
- **Removed retry loop** — the previous retry-on-timeout logic caused errors after the gateway request context expired; removed

### v1.1.3
- Added `vibeModel` config option
- Hardened Discord suppression fallback
- Fixed subagent session cleanup
- Fixed `!banano stop/start` to claim channel reply properly

### v1.1.2
- Fixed claim window release on false alarm
- Fixed jump link guarding against missing `guildId`/`messageId`
- Tightened dedupe to prevent double-counting

### v1.1.1
- Fixed isolated review runtime call
- Fixed Discord send path signature
- Fixed Discord author attribution
- Added `authorId` to logs and escalations
- Claimed-turn suppression implemented
- Retry-once failure handling with mod-channel-only alert on second failure

### v1.0.0
- CLI summary script: `npm run logs`
- Static HTML viewer: `scripts/logs-viewer.html`

### v0.4.0
- Dedicated JSONL log with daily rotation

### v0.3.0
- `/vibe_stats` command
- `highSeverityPublicReply` config

### v0.2.0
- Correlation IDs, jump links, structured logging, context hygiene

### v0.1.0
- Initial release: sentiment gate, AI review, mod auth, escalation

---

## Test checklist

- [ ] `@Banano gm` → normal reply (bypasses plugin)
- [ ] Positive message in watched channel → `SENTIMENT_PASS` in logs, no action
- [ ] Negative message → sentiment gate trips → AI review fires
- [ ] Mild issue → gentle in-channel redirect
- [ ] Serious issue → mod channel escalation with jump link
- [ ] `highSeverityPublicReply: false` → high severity escalates silently
- [ ] `!banano stop` by mod → silences channel
- [ ] `!banano stop` by non-mod → `MOD_DENIED` in logs, no action
- [ ] `!banano start` by mod → resumes channel
- [ ] Rapid negative messages → cooldown suppresses spam
- [ ] Same message event twice → dedupe prevents double-processing
- [ ] Raw JSON / provider errors never appear in watched chat
- [ ] `/vibe_stats` shows correct counts
- [ ] `/vibe_violations` returns ledger results after a violation is recorded
- [ ] OpenRouter model → routed to OpenRouter API (not Anthropic)
- [ ] Anthropic model → routed to Anthropic API
