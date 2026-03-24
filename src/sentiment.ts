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
