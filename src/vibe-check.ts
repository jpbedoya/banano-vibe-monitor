/**
 * Layer 2: AI vibe review — only called for messages that pass the sentiment gate.
 *
 * Uses OpenClaw's system event injection to trigger an agent turn
 * with the vibe check prompt. The agent's response is parsed for the result.
 */

import { VIBE_CHECK_PROMPT } from "./persona.js";

export type VibeResult = {
  isToxic: boolean;
  severity: "low" | "medium" | "high";
  reason: string;
  suggestedResponse: string | null;
};

export type RecentMessage = {
  author: string;
  content: string;
};

/**
 * Build the vibe check prompt for a flagged message.
 */
export function buildVibeCheckPrompt(
  flaggedText: string,
  authorName: string,
  recentMessages: RecentMessage[],
): string {
  const context = recentMessages.length
    ? recentMessages.map((m) => `${m.author}: ${m.content}`).join("\n")
    : "(no prior context)";

  return `${VIBE_CHECK_PROMPT}

Recent conversation:
${context}

Flagged message from ${authorName}: "${flaggedText}"`;
}

/**
 * Parse the AI response to extract a VibeResult.
 */
export function parseVibeResult(text: string): VibeResult | null {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed.isToxic === "boolean") {
        return {
          isToxic: parsed.isToxic,
          severity: parsed.severity || "low",
          reason: parsed.reason || "unknown",
          suggestedResponse: parsed.suggestedResponse || null,
        };
      }
    }
  } catch {
    // Parse failure — return null
  }
  return null;
}
