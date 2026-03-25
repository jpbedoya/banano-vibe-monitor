/**
 * Layer 1: Local sentiment scoring — free, instant, no API call.
 */

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
