/**
 * Layer 0: Known slur/hate-phrase pre-filter — bypasses AFINN entirely.
 * Layer 1: Local sentiment scoring — free, instant, no API call.
 */

import * as fs from "fs";
import * as path from "path";

// ── External slur config ──────────────────────────────────────────────────────

type SlurConfig = {
  latinPatterns: RegExp[];
  nonLatinSlurs: string[];
};

let _slurConfig: SlurConfig | null = null;

function defaultSlurConfig(): SlurConfig {
  return { latinPatterns: [], nonLatinSlurs: [] };
}

/**
 * Initialize the slur config from a JSON file in the given plugin directory.
 * Called from index.ts with api.resolvePath('.') near the top of register().
 */
export function initSlurConfig(pluginDir: string): void {
  const configPath = path.join(pluginDir, "slur-config.json");
  _slurConfig = loadSlurConfigFromPath(configPath);
}

/**
 * Reload the slur config from disk (hot-reload support).
 */
export function reloadSlurConfig(pluginDir: string): void {
  initSlurConfig(pluginDir);
}

function loadSlurConfigFromPath(configPath: string): SlurConfig {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const data = JSON.parse(raw) as { latinPatterns?: string[]; nonLatinSlurs?: string[] };
    const latinPatterns = (data.latinPatterns ?? []).map((p: string) => new RegExp(p, "i"));
    const nonLatinSlurs = data.nonLatinSlurs ?? [];
    return { latinPatterns, nonLatinSlurs };
  } catch (err) {
    // If the file can't be loaded, return an empty config — don't crash the plugin
    // eslint-disable-next-line no-console
    console.warn(`[banano-vibe] Could not load slur-config.json from ${configPath}: ${err}`);
    return defaultSlurConfig();
  }
}

function getSlurConfig(): SlurConfig {
  if (!_slurConfig) {
    // Fallback: try to load from __dirname (works if JSON was copied to dist/)
    const fallbackPath = path.join(__dirname, "..", "slur-config.json");
    const altPath = path.join(__dirname, "slur-config.json");
    if (fs.existsSync(fallbackPath)) {
      _slurConfig = loadSlurConfigFromPath(fallbackPath);
    } else if (fs.existsSync(altPath)) {
      _slurConfig = loadSlurConfigFromPath(altPath);
    } else {
      _slurConfig = defaultSlurConfig();
    }
  }
  return _slurConfig;
}

/**
 * Returns true if the text contains a known slur or hate phrase.
 * Latin-script slurs use word-boundary matching; non-Latin uses substring match.
 * When this returns true, the message bypasses AFINN and goes straight to AI review.
 */
export function containsKnownSlur(text: string): boolean {
  const config = getSlurConfig();
  for (const pattern of config.latinPatterns) {
    if (pattern.test(text)) return true;
  }
  const lower = text.toLowerCase();
  for (const slur of config.nonLatinSlurs) {
    if (lower.includes(slur.toLowerCase())) return true;
  }
  return false;
}



// @ts-ignore — sentiment has no types
import Sentiment from "sentiment";

const analyzer = new Sentiment();

/**
 * Returns true if the message should be escalated to AI review.
 * Only messages with sentiment score <= threshold get escalated.
 */
export function shouldEscalate(text: string, threshold: number): boolean {
  const result = analyzer.analyze(text);
  return result.score <= threshold;
}

/**
 * Get the raw sentiment score for debugging/logging.
 */
export function getSentimentScore(text: string): number {
  return analyzer.analyze(text).score;
}

/**
 * Returns true if the text is likely non-English based on the proportion of
 * non-ASCII characters (Cyrillic, Chinese, Japanese, Korean, Arabic, Hebrew, etc.).
 * Heuristic: if more than 20% of characters have codepoint > 127, treat as non-English.
 */
export function isLikelyNonEnglish(text: string): boolean {
  if (!text || text.length === 0) return false;
  let nonAsciiCount = 0;
  for (const char of text) {
    if (char.codePointAt(0)! > 127) nonAsciiCount++;
  }
  return nonAsciiCount / text.length > 0.2;
}
