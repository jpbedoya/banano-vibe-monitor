# Banano Vibe Monitor — OpenClaw Plugin v1.6.0

Two-layer vibe moderation for Discord channels, running natively inside OpenClaw.

## How it works

```
All messages in watched channels
        │
        ▼
Layer 1: Sentiment score (free, local, instant)
        │
        ├── score > threshold → ignore (90%+ of messages)
        │
        └── score ≤ threshold → Layer 2: AI vibe review
                                (with last ~10 messages for context)
                                        │
                                ├── false alarm → no action
                                ├── mild → in-channel redirect
                                └── escalation → mod channel alert + jump link
```

The plugin opens its own Discord WebSocket connection, bypassing OpenClaw's allowlists — it sees **all** messages in watched channels regardless of routing configuration.

---

## Install

### First install

```bash
git clone https://github.com/jpbedoya/banano-vibe-monitor
cd banano-vibe-monitor
npm install && npm run build
openclaw plugins install .
openclaw gateway restart
```

### Updating

```bash
git pull
npm run build
cp -r dist/* ~/.openclaw/extensions/banano-vibe/dist/
openclaw gateway restart
```

> `openclaw plugins install` blocks if the plugin directory already exists. Use the `cp` approach for updates.

---

## Configure

Add to `openclaw.json`:

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

Also set `requireMention: false` on watched channels in the Discord guild config.

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

> Banano records violations but cannot apply Discord timeouts directly — those must be applied manually.

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
