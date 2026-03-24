# Banano Vibe Monitor — OpenClaw Plugin v2.0.0

Two-layer vibe moderation for Discord channels, running natively inside OpenClaw.

## How it works

The plugin hooks into **OpenClaw's existing Discord connection** via the `message_received` event — no separate WebSocket, no extra bot connections, no Discord rate limit risk.

```
Discord message
        │
        ▼
OpenClaw Discord plugin (existing WS connection)
        │
        ▼
message_received hook → banano-vibe
        │
        ▼
Layer 1: Sentiment score (free, local, instant)
        │
        ├── score > threshold → ignore (~99% of messages)
        │
        └── score ≤ threshold → Layer 2: AI vibe review
                                (with last ~10 messages for context)
                                        │
                                ├── false alarm → no action
                                ├── mild → in-channel redirect
                                └── escalation → mod channel alert + jump link
```

> **Prerequisites:** Set `groupPolicy: open` on your Discord guild in `openclaw.json` so all messages reach the hook, not just those from allowlisted users. Keep `requireMention: true` to control main agent costs.

---

## Install

### First install

```bash
git clone https://github.com/jpbedoya/banano-vibe-monitor
cd banano-vibe-monitor
npm install && npm run build
openclaw plugins install .
```

Then restart the gateway:

```bash
kill -SIGTERM $(pgrep -f openclaw-gateway | head -1) && sleep 3 && openclaw gateway start
```

> Use a full process restart (not SIGUSR1) to load new plugin code — SIGUSR1 reuses the module cache.

### Updating

```bash
git pull
npm install && npm run build
rm -rf ~/.openclaw/extensions/banano-vibe
openclaw plugins install .
```

Then full gateway restart as above.

---

## Configure

Add to `openclaw.json` under `plugins.entries`:

```json
{
  "plugins": {
    "entries": {
      "banano-vibe": {
        "enabled": true,
        "config": {
          "watchedChannelIds": ["CHANNEL_ID"],
          "modChannelId": "MOD_CHANNEL_ID",
          "sentimentThreshold": -2,
          "modEscalationMinSeverity": "low",
          "highSeverityPublicReply": true,
          "vibeModel": "openrouter/google/gemma-3-27b-it:free",
          "vibeModelFallbacks": [
            "openrouter/meta-llama/llama-3.3-70b-instruct:free",
            "openrouter/nvidia/nemotron-3-nano-30b-a3b:free",
            "anthropic/claude-haiku-4-5"
          ]
        }
      }
    }
  }
}
```

Also ensure your Discord guild has `groupPolicy: open`:

```json
{
  "channels": {
    "discord": {
      "guilds": {
        "YOUR_GUILD_ID": {
          "groupPolicy": "open",
          "requireMention": true
        }
      }
    }
  }
}
```

### Config reference

| Key | Default | Description |
|-----|---------|-------------|
| `watchedChannelIds` | `[]` | Discord channel IDs to monitor |
| `modChannelId` | `null` | Channel to send escalation alerts |
| `sentimentThreshold` | `-2` | Sentiment score cutoff for AI review. Lower = less sensitive |
| `modEscalationMinSeverity` | `"high"` | Minimum severity to post to mod channel (`low`/`medium`/`high`) |
| `highSeverityPublicReply` | `true` | Whether high-severity flags get an in-channel reply |
| `vibeModel` | `openrouter/google/gemma-3-27b-it:free` | Primary AI model for vibe review |
| `vibeModelFallbacks` | see defaults | Ordered fallbacks on 429/5xx/empty response |
| `cooldownMs` | `30000` | Min time between actions per channel |
| `dedupeWindowMs` | `60000` | Window to ignore duplicate message events |
| `maxRecentMessages` | `10` | Messages of context sent to AI |
| `vibeReviewTimeoutMs` | `30000` | AI review timeout |

---

## API keys

The plugin resolves the OpenRouter key in this order:

1. `BANANO_OPENROUTER_KEY` env var (recommended)
2. OpenClaw `auth-profiles.json` fallback

Set via the plugin's `.env` file to keep it isolated from OpenClaw's auth config:

```bash
echo "BANANO_OPENROUTER_KEY=sk-or-v1-..." > ~/.openclaw/extensions/banano-vibe/.env
```

The plugin loads this file on startup automatically.

---

## Escalation policy

| Severity | In-channel reply | Mod alert |
|----------|-----------------|-----------|
| low | yes | only if `modEscalationMinSeverity=low` |
| medium | yes | only if `modEscalationMinSeverity=low/medium` |
| high | only if `highSeverityPublicReply=true` | always |

---

## Commands

- `/vibe_status` — show current config and model
- `/vibe_stats` — counters since last restart
- `/vibe_violations [userId]` — violation history for a user or last 30 days

---

## Violation ledger

Violations are recorded automatically on escalation at:
```
~/.openclaw/extensions/banano-vibe/moderation/violations.json
```

Three-strike policy: Strike 1 → 1h timeout · Strike 2 → 24h · Strike 3 → 7 days.

> Banano records violations but cannot apply Discord timeouts directly — those must be applied manually by a moderator.

---

## Observability

```bash
# All vibe decisions
grep "banano-vibe" /tmp/openclaw/openclaw-$(date -u +%Y-%m-%d).log

# Only escalations
grep "HIGH_ESCALATION" /tmp/openclaw/openclaw-$(date -u +%Y-%m-%d).log | jq .
```

Daily JSONL logs also written to `~/.openclaw/extensions/banano-vibe/logs/`.

---

## Tuning

After a few days of real traffic:

- High false alarm rate → raise threshold (e.g. `-1`)
- Too many mod alerts → raise `modEscalationMinSeverity` to `medium` or `high`
- Missing obvious bad messages → lower threshold (e.g. `-3`)

---

## Architecture notes

- **No extra Discord WS:** Uses OpenClaw's `message_received` hook. Zero additional bot connections.
- **Singleton guard:** Plugin state stored on `globalThis` to survive OpenClaw's jiti module reloads — ensures exactly one hook registration regardless of how many times `register()` is called.
- **In-process deduplication:** Message IDs tracked in a `globalThis` Set — first caller wins, duplicates skipped immediately.
- **Sentiment gate:** AFINN-based local scoring. Only messages crossing the threshold hit the AI model — keeps quota usage minimal.
- **AI fallbacks:** Primary model → ordered fallbacks on 429/error. Includes both free OpenRouter models and a paid Anthropic fallback.
