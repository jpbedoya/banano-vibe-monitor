# Banano Vibe Monitor — Standalone Bot

Self-contained Discord vibe moderation bot. No OpenClaw required. Runs anywhere Node.js 18+ is available.

---

## What It Does

Two-layer message moderation for Discord channels:

1. **Slur pre-filter** — instant block on known slurs (skips sentiment scoring)
2. **Sentiment scoring** — local AFINN-based check, free and fast
3. **AI vibe review** — only runs when sentiment flags a message; uses OpenRouter (free models available) with Anthropic as fallback

When a violation is confirmed:
- Optionally replies in the flagged channel as Banano
- Sends a mod alert to a private mod channel with a jump link and strike count
- Tracks per-user strike history in `data/moderation/violations.json`

---

## Requirements

- Node.js 18+
- npm
- A Discord bot token with the **Message Content** intent enabled

---

## Quick Setup

### 1. Clone / get the code

```bash
cd banano-bot/standalone
npm install
npm run build
```

### 2. Create a Discord bot

1. Go to https://discord.com/developers/applications
2. Create a new application → Bot
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**
4. Copy the bot token
5. Invite the bot to your server with these permissions: `Send Messages`, `Read Message History`, `View Channels`

Invite URL format:
```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=68608&scope=bot
```

### 3. Configure environment

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

```env
# Required
DISCORD_TOKEN=your_bot_token_here

# AI provider (at least one required)
BANANO_OPENROUTER_KEY=your_openrouter_key   # Free models available at openrouter.ai
ANTHROPIC_API_KEY=your_anthropic_key         # Fallback / optional

# Channels
WATCHED_CHANNEL_IDS=874638621368533015,886669323681275905   # Comma-separated IDs to monitor
MOD_CHANNEL_ID=your_mod_channel_id                          # Where alerts get sent

# Tuning (optional — defaults shown)
SENTIMENT_THRESHOLD=-2          # Lower = less sensitive (default: -2)
MAX_RECENT_MESSAGES=10          # Context messages sent to AI for review
COOLDOWN_MS=30000               # Per-channel cooldown between responses (ms)
DEDUPE_WINDOW_MS=60000          # Deduplication window (ms)
MOD_ESCALATION_MIN_SEVERITY=high   # low | medium | high
HIGH_SEVERITY_PUBLIC_REPLY=true    # Reply publicly for high-severity violations
VIBE_REVIEW_TIMEOUT_MS=30000       # AI review timeout per call (ms)
VIBE_MODEL=                        # Override primary model (default: openrouter/google/gemma-3-27b-it:free)
```

### 4. Run the bot

```bash
npm start
```

Or for development (auto-recompile on changes):
```bash
npm run dev
# in another terminal:
npm start
```

---

## Running as a Service (Production)

Using PM2:
```bash
npm install -g pm2
pm2 start dist/bot.js --name banano-vibe
pm2 save
pm2 startup   # follow the printed command to auto-start on reboot
```

Using systemd (Linux):
```ini
[Unit]
Description=Banano Vibe Monitor
After=network.target

[Service]
WorkingDirectory=/path/to/banano-bot/standalone
ExecStart=/usr/bin/node dist/bot.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

---

## Data Files

All runtime data is written to `standalone/data/`:

| Path | Contents |
|------|----------|
| `data/stats.json` | Message counts, flag counts, escalations |
| `data/moderation/violations.json` | Per-user strike history |
| `data/logs/banano-vibe-YYYY-MM-DD.jsonl` | Daily decision log (JSONL) |

---

## AI Model Config

The bot uses a fallback chain. If the primary model fails, it automatically tries the next:

1. `VIBE_MODEL` (or default: `openrouter/google/gemma-3-27b-it:free`)
2. `openrouter/meta-llama/llama-3.3-70b-instruct:free`
3. `openrouter/nvidia/nemotron-3-nano-30b-a3b:free`
4. `anthropic/claude-haiku-4-5` (requires `ANTHROPIC_API_KEY`)

Free OpenRouter models are sufficient for most use cases. Get a key at https://openrouter.ai.

---

## Troubleshooting

**Bot connects but never triggers**
- Check `WATCHED_CHANNEL_IDS` — must match the channel IDs exactly (no spaces)
- Verify the bot has `View Channels` + `Read Message History` in those channels
- Check that **Message Content Intent** is enabled in the Discord developer portal

**Fatal close code 4014**
- Message Content Intent not enabled. Go to Discord Developer Portal → Bot → Privileged Gateway Intents → enable Message Content Intent.

**Vibe reviews always fail**
- Check `BANANO_OPENROUTER_KEY` is set and valid
- Test the key at https://openrouter.ai

**Bot replies but no mod alerts**
- Check `MOD_CHANNEL_ID` is set and the bot has `Send Messages` in that channel
