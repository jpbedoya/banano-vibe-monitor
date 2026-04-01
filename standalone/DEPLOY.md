# DEPLOY.md — MonkeDAO Production Deployment

> How the standalone vibe bot is deployed and running on the MonkeDAO server.
> For general setup from scratch, see [README.md](./README.md).

---

## Architecture Overview

```
┌─────────────────────┐     ┌─────────────────────────┐
│   OpenClaw Gateway   │     │  Standalone Vibe Bot     │
│                      │     │  (systemd service)       │
│  - Telegram bot      │     │                          │
│  - Discord bot       │     │  - Own Discord gateway   │
│  - Banano AI agent   │     │  - Watches #bot-patrol   │
│                      │     │  - Posts to #banano-admin │
│  Same Discord token  │     │  Same Discord token      │
└──────────┬───────────┘     └──────────┬───────────────┘
           │                            │
           └────────────────────────────┘
                        │
              Discord API (shared bot)
```

**Why standalone?** The OpenClaw plugin version routed all messages through OpenClaw's gateway, causing double-replies, rate limits, and coupling to gateway restarts. The standalone bot connects directly to Discord's gateway — independent, faster, no middleman.

**Shared token:** Both OpenClaw and the standalone bot use the same Discord bot token. Discord allows multiple gateway connections (sharding). To prevent double-replies, `#bot-patrol` is set to `requireMention: true` in OpenClaw's config so only the standalone bot handles passive monitoring there.

---

## Server Details

| Item | Value |
|---|---|
| **Server** | `bonano-openclaw` |
| **Bot path** | `/root/.openclaw/workspace/code/banano-vibe-monitor/standalone/` |
| **Config** | `/root/.openclaw/workspace/code/banano-vibe-monitor/standalone/.env` |
| **Prompt** | `/root/.openclaw/workspace/code/banano-vibe-monitor/standalone/prompt.txt` |
| **Systemd service** | `banano-vibe` (`/etc/systemd/system/banano-vibe.service`) |

---

## Discord Channel IDs

| Channel | ID | Purpose |
|---|---|---|
| `#bot-patrol-test` | `1485792688677589144` | Watched channel (messages monitored) |
| `#banano-admin` | `1485808518719213738` | Mod escalation alerts posted here |
| MonkeDAO guild | `874638621368533012` | — |

---

## Moderators

| Name | Discord ID |
|---|---|
| JP | `428063738931839006` |
| Jemmy | `707771840960921996` |
| Bibsee | `972865157271277589` |
| Solus | `474671428285759518` |
| KingCON | `929146714936463391` |

---

## Current .env Configuration

```env
DISCORD_TOKEN=<same as OpenClaw — see openclaw.json>
BANANO_OPENROUTER_KEY=<OpenRouter API key>
WATCHED_CHANNEL_IDS=1485792688677589144
MOD_CHANNEL_ID=1485808518719213738
MODERATOR_IDS=428063738931839006,707771840960921996,972865157271277589,474671428285759518,929146714936463391
SENTIMENT_THRESHOLD=-2
MOD_ESCALATION_MIN_SEVERITY=low
HIGH_SEVERITY_PUBLIC_REPLY=true
VIBE_MODEL=openrouter/google/gemma-3-27b-it:free
```

> **Note:** `.env` is gitignored. If the server dies, recreate it from the template above. The Discord token and OpenRouter key are in OpenClaw's config (`/root/.openclaw/openclaw.json` and `/root/.openclaw/agents/main/agent/auth-profiles.json`).

---

## Common Operations

### Check status
```bash
systemctl status banano-vibe
```

### View logs
```bash
journalctl -u banano-vibe -f           # live tail
journalctl -u banano-vibe -n 50        # last 50 lines
journalctl -u banano-vibe --since "1 hour ago"
```

### Restart the bot
```bash
systemctl restart banano-vibe
```

### Pull updates and deploy
```bash
cd /root/.openclaw/workspace/code/banano-vibe-monitor
git pull origin main
cd standalone && npm install && npm run build
systemctl restart banano-vibe
```

### Edit the AI prompt
```bash
nano /root/.openclaw/workspace/code/banano-vibe-monitor/standalone/prompt.txt
systemctl restart banano-vibe
```

### If the bot is down
```bash
systemctl status banano-vibe           # check what's wrong
systemctl start banano-vibe            # start it
systemctl enable banano-vibe           # ensure it starts on reboot
```

---

## OpenClaw Config (must stay in sync)

The standalone bot and OpenClaw share a Discord token. To prevent double-replies in `#bot-patrol`:

```jsonc
// In openclaw.json → channels.discord.guilds['874638621368533012'].channels
"1485792688677589144": {
  "requireMention": true   // ← must be true while standalone bot is active
}
```

If `requireMention` is set to `false`, both OpenClaw and the standalone bot will respond to every message in that channel.

---

## Known Issues & Gotchas

### Free models get rate-limited (429)
**Problem:** `google/gemma-3-27b-it:free` and `meta-llama/llama-3.3-70b-instruct:free` frequently return 429 errors from OpenRouter.

**Effect:** Bot falls back to `nvidia/nemotron-3-nano-30b-a3b:free` which is more lenient on severity ratings (tends to rate things as "medium" instead of "high").

**Mitigation options:**
- Use a paid model (set `VIBE_MODEL` in `.env`)
- Accept the fallback behavior — bot still catches and responds, just classifies less aggressively

### .env is not in the repo
The `.env` file is gitignored. If the server is rebuilt from scratch, recreate it using the template above.

### Bot doesn't see messages in new channels
The bot only watches channels listed in `WATCHED_CHANNEL_IDS`. To add a channel:
1. Add the channel ID to `WATCHED_CHANNEL_IDS` in `.env` (comma-separated)
2. Ensure the bot has `View Channels` + `Read Message History` in that channel
3. `systemctl restart banano-vibe`

---

## Adding to Production (new channels)

When ready to move beyond `#bot-patrol-test` to real MonkeDAO channels:

1. Get the channel IDs to monitor
2. Add them to `WATCHED_CHANNEL_IDS` in `.env`
3. Consider setting `MOD_ESCALATION_MIN_SEVERITY=high` for production (currently `low` for testing)
4. Verify the bot has permissions in those channels
5. `systemctl restart banano-vibe`
6. Update OpenClaw config to set `requireMention: true` for any channels the standalone bot watches

---

*Last updated: March 31, 2026*
