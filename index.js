require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const Sentiment = require('sentiment');
const fs = require('fs');
const path = require('path');
const { SYSTEM_PROMPT } = require('./persona');

// ── Config ──────────────────────────────────────────────────────────────────

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MOD_CHANNEL_ID = process.env.MOD_CHANNEL_ID; // optional: where to send serious flags
const WATCHED_CHANNEL_IDS = (process.env.WATCHED_CHANNEL_IDS || '').split(',').filter(Boolean);
const SENTIMENT_THRESHOLD = parseInt(process.env.SENTIMENT_THRESHOLD || '-2');

// ── Persistent silence state ─────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'state.json');

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      return new Set(data.silencedChannels || []);
    }
  } catch (e) {
    console.error('Failed to load state:', e);
  }
  return new Set();
}

function saveState(silencedChannels) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ silencedChannels: [...silencedChannels] }, null, 2));
  } catch (e) {
    console.error('Failed to save state:', e);
  }
}

// Channels Banano is silenced in (by !banano stop) — persists across restarts
const silencedChannels = loadState();

// Conversation history per channel (simple in-memory, last 20 messages)
const channelHistory = new Map();

// ── Clients ──────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const sentiment = new Sentiment();

// ── Helpers ──────────────────────────────────────────────────────────────────

function getHistory(channelId) {
  if (!channelHistory.has(channelId)) channelHistory.set(channelId, []);
  return channelHistory.get(channelId);
}

function addToHistory(channelId, role, content) {
  const history = getHistory(channelId);
  history.push({ role, content });
  // Keep last 20 messages for context
  if (history.length > 20) history.splice(0, history.length - 20);
}

async function askBanano(channelId, userMessage, extraContext = '') {
  const history = getHistory(channelId);
  const messages = [
    ...history,
    { role: 'user', content: extraContext ? `[context: ${extraContext}]\n${userMessage}` : userMessage },
  ];

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages,
  });

  const reply = response.content[0].text;
  addToHistory(channelId, 'user', userMessage);
  addToHistory(channelId, 'assistant', reply);
  return reply;
}

async function checkVibes(message, recentMessages) {
  const context = recentMessages.map(m => `${m.author.username}: ${m.content}`).join('\n');
  const prompt = `[VIBE CHECK - do not respond as if chatting normally]
Recent conversation in the channel:
${context}

Flagged message from ${message.author.username}: "${message.content}"

Is this genuinely toxic, negative, or harmful to community vibes? Answer in JSON:
{
  "isToxic": boolean,
  "severity": "low" | "medium" | "high",
  "reason": "brief reason",
  "suggestedResponse": "what Banano should say in the channel (null if no response needed)"
}
Only flag real issues. Jokes, sarcasm, and light trash talk are fine.`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 200,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });

  try {
    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('Failed to parse vibe check response:', e);
  }
  return null;
}

// ── Event Handlers ───────────────────────────────────────────────────────────

client.on('ready', () => {
  console.log(`🦍 Banano is online as ${client.user.tag}`);
  console.log(`Watching channels: ${WATCHED_CHANNEL_IDS.length ? WATCHED_CHANNEL_IDS.join(', ') : 'none (mention-only mode)'}`);
});

client.on('messageCreate', async (message) => {
  // Ignore bots
  if (message.author.bot) return;

  const channelId = message.channel.id;
  const content = message.content.trim();
  const isMentioned = message.mentions.has(client.user);
  const isWatchedChannel = WATCHED_CHANNEL_IDS.includes(channelId);

  // Mod commands
  if (content === '!banano stop') {
    if (message.member?.permissions.has('ModerateMembers')) {
      silencedChannels.add(channelId);
      saveState(silencedChannels);
      await message.reply('aight aight, going quiet 🤫');
    }
    return;
  }
  if (content === '!banano start') {
    if (message.member?.permissions.has('ModerateMembers')) {
      silencedChannels.delete(channelId);
      saveState(silencedChannels);
      await message.reply('ape is back 🦍');
    }
    return;
  }

  // Silenced?
  if (silencedChannels.has(channelId)) return;

  // ── Mention handler ──────────────────────────────────────────────────────
  if (isMentioned) {
    const userText = content.replace(/<@!?\d+>/g, '').trim() || 'gm';
    try {
      await message.channel.sendTyping();
      const reply = await askBanano(channelId, `${message.author.username}: ${userText}`);
      await message.reply(reply);
    } catch (err) {
      console.error('Error responding to mention:', err);
    }
    return;
  }

  // ── Vibe monitoring in watched channels ──────────────────────────────────
  if (isWatchedChannel) {
    const score = sentiment.analyze(content).score;
    if (score <= SENTIMENT_THRESHOLD) {
      console.log(`[vibe-check] Flagged message (score: ${score}): "${content}"`);

      try {
        // Fetch recent context
        const recent = await message.channel.messages.fetch({ limit: 10, before: message.id });
        const recentArr = [...recent.values()].reverse();

        const vibeResult = await checkVibes(message, recentArr);
        if (!vibeResult) return;

        console.log('[vibe-check] Result:', vibeResult);

        if (vibeResult.isToxic && vibeResult.suggestedResponse) {
          await message.channel.send(vibeResult.suggestedResponse);
        }

        // Flag to mod channel if high severity
        if (vibeResult.isToxic && vibeResult.severity === 'high' && MOD_CHANNEL_ID) {
          const modChannel = await client.channels.fetch(MOD_CHANNEL_ID).catch(() => null);
          if (modChannel) {
            await modChannel.send(
              `🚨 **Vibe alert** in <#${channelId}>\n` +
              `User: ${message.author.tag}\n` +
              `Message: "${content}"\n` +
              `Reason: ${vibeResult.reason}\n` +
              `[Jump to message](${message.url})`
            );
          }
        }
      } catch (err) {
        console.error('Error during vibe check:', err);
      }
    }
  }
});

// ── Launch ───────────────────────────────────────────────────────────────────

if (!DISCORD_TOKEN || !ANTHROPIC_API_KEY) {
  console.error('❌ Missing DISCORD_TOKEN or ANTHROPIC_API_KEY in .env');
  process.exit(1);
}

client.login(DISCORD_TOKEN);
