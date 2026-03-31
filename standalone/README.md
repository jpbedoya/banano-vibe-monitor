# Banano Vibe Monitor — Standalone Bot

Self-contained Discord vibe moderation bot. No OpenClaw required.

---

## Setup

### 1. Clone and build

```bash
git clone https://github.com/jpbedoya/banano-vibe-monitor
cd banano-vibe-monitor/standalone
npm install
npm run build
```

### 2. Create a Discord bot

1. Go to https://discord.com/developers/applications → **New Application** → **Bot**
2. Under **Privileged Gateway Intents**, enable **Message Content Intent**
3. Copy the **bot token** — you'll need it in the next step
4. Invite the bot to your server:
   ```
   https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=68608&scope=bot
   ```
   Required permissions: `Send Messages`, `Read Message History`, `View Channels`

### 3. Configure

```bash
cp .env.example .env
nano .env
```

Minimum required:

```env
DISCORD_TOKEN=your_bot_token_here
BANANO_OPENROUTER_KEY=your_openrouter_key   # free key at openrouter.ai
WATCHED_CHANNEL_IDS=123456789,987654321     # comma-separated channel IDs to monitor
MOD_CHANNEL_ID=111222333                    # channel where alerts get posted
```

### 4. Run it

```bash
npm start
```

You should see:
```
[banano-vibe] Gateway connected
[banano-vibe] Gateway ready
[banano-vibe] Active v1.0.0 | watching: 123456789,987654321 | mod: 111222333
```

---

## Keep it running (production)

Install PM2 once:
```bash
npm install -g pm2
```

Start the bot:
```bash
pm2 start dist/bot.js --name banano-vibe
pm2 save        # persist across reboots
pm2 startup     # prints a command — run it to enable auto-start on reboot
```

Useful commands:
```bash
pm2 logs banano-vibe      # live logs
pm2 status                # check it's running
pm2 restart banano-vibe   # after config changes
```

---

## Update

```bash
cd banano-vibe-monitor
git pull
cd standalone && npm install && npm run build
pm2 restart banano-vibe
```

---

## Customizing the AI prompt

The bot ships with a default prompt that defines Banano's persona and moderation rules. You can override it without touching the code by editing `prompt.txt` in the `standalone/` directory.

```bash
nano prompt.txt
pm2 restart banano-vibe   # restart to pick up changes
```

The file is loaded at startup. If it's missing or empty, the bot falls back to the built-in default.

**What to put in the prompt:**
- Banano's persona and tone
- What counts as a violation (and what doesn't)
- Language-specific guidance (e.g. non-English threats)
- Response style for in-channel replies

The response format block at the bottom (`## Response format`) must stay intact — the bot parses that JSON to decide what to do.

---

## Full config reference

All settings go in `.env`. Only `DISCORD_TOKEN` is strictly required — everything else has a default.

| Variable | Default | Description |
|---|---|---|
| `DISCORD_TOKEN` | — | Bot token (required) |
| `BANANO_OPENROUTER_KEY` | — | OpenRouter API key (primary AI provider) |
| `ANTHROPIC_API_KEY` | — | Anthropic key (fallback AI provider) |
| `WATCHED_CHANNEL_IDS` | — | Comma-separated channel IDs to monitor |
| `MOD_CHANNEL_ID` | — | Channel for escalation alerts |
| `SENTIMENT_THRESHOLD` | `-2` | AFINN score cutoff — lower = less sensitive |
| `MOD_ESCALATION_MIN_SEVERITY` | `high` | Minimum severity to post to mod channel (`low`/`medium`/`high`) |
| `HIGH_SEVERITY_PUBLIC_REPLY` | `true` | Reply in-channel for high severity violations |
| `VIBE_MODEL` | `openrouter/google/gemma-3-27b-it:free` | Primary AI model |
| `MAX_RECENT_MESSAGES` | `10` | Message context sent to AI |
| `COOLDOWN_MS` | `30000` | Per-channel cooldown between responses (ms) |
| `DEDUPE_WINDOW_MS` | `60000` | Deduplication window (ms) |
| `VIBE_REVIEW_TIMEOUT_MS` | `30000` | AI review timeout (ms) |

---

## Troubleshooting

**Bot connects but never triggers**
- Double-check `WATCHED_CHANNEL_IDS` — exact IDs, no spaces
- Confirm the bot has `View Channels` + `Read Message History` in those channels

**Fatal error: close code 4014**
- Message Content Intent isn't enabled. Discord Developer Portal → your app → Bot → Privileged Gateway Intents → turn on Message Content Intent

**Vibe reviews fail**
- Make sure `BANANO_OPENROUTER_KEY` is set. Get a free key at https://openrouter.ai

**No mod alerts**
- Check `MOD_CHANNEL_ID` is set and the bot has `Send Messages` in that channel
