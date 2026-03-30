# Banano Vibe Monitor

AI-powered vibe moderation for MonkeDAO Discord channels. Two deployment options:

---

## `openclaw-plugin/`

Runs **inside OpenClaw** as a plugin, hooking into its existing Discord connection. No separate bot process needed.

Best for: teams already running OpenClaw who want vibe moderation with zero extra infrastructure.

See [`openclaw-plugin/README.md`](openclaw-plugin/README.md) for setup.

---

## `standalone/`

Self-contained Discord bot that runs independently. No OpenClaw required — just Node.js 18+ and a Discord bot token.

Best for: deploying on a VPS or anywhere OpenClaw isn't running.

See [`standalone/README.md`](standalone/README.md) for setup.

---

## How vibe checking works (both modes)

```
Discord message
      │
      ▼
Layer 0: Known slur pre-filter (instant block)
      │
      ▼
Layer 1: Local sentiment score (free, no API)
      │
      ├── passes threshold → ignore
      │
      └── fails threshold → Layer 2: AI vibe review
                                      │
                              ├── false alarm → no action
                              ├── mild → in-channel reply
                              └── escalation → mod channel alert + strike recorded
```
