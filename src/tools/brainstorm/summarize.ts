// src/tools/brainstorm/summarize.ts
import type { BrainstormAnswer } from "./types";
import { BrainstormError } from "./types";

/**
 * System prompt for the summary LLM
 */
export const SUMMARY_SYSTEM_PROMPT = `<purpose>
Synthesize the brainstorming session into a structured design document.
Extract key decisions, requirements, and constraints from the Q&A.
</purpose>

<output-format>
Generate a markdown design document with these sections:

## Problem Statement
What problem are we solving? What's the user's goal?

## Requirements
- Functional requirements (what it must do)
- Non-functional requirements (performance, scale, etc.)

## Constraints
- Technical constraints
- Business constraints
- Timeline constraints

## Proposed Approach
High-level solution approach based on user's choices.

## Architecture Overview
Key components and how they interact.

## Key Decisions
Decisions made during brainstorming with rationale.

## Open Questions
Any remaining uncertainties or areas needing more exploration.
</output-format>

<principles>
- Be concise but comprehensive
- Focus on decisions made, not questions asked
- Include rationale from user's answers
- Highlight tradeoffs that were discussed
- Flag any inconsistencies or gaps
</principles>`;

/**
 * Format an answer for the summary context
 */
function formatAnswerForSummary(answer: BrainstormAnswer): string {
  const { type, answer: response } = answer;

  if (response === null || response === undefined) {
    return "No response";
  }

  switch (type) {
    case "pick_one": {
      const r = response as { selected?: string; other?: string };
      return r.other ? `"${r.other}" (custom)` : `"${r.selected}"`;
    }
    case "pick_many": {
      const r = response as { selected?: string[]; other?: string[] };
      const items = [...(r.selected || []), ...(r.other || [])];
      return items.map((s) => `"${s}"`).join(", ");
    }
    case "confirm": {
      const r = response as { choice?: "yes" | "no" | "cancel" };
      return r.choice === "yes" ? "Yes" : r.choice === "no" ? "No" : "Cancelled";
    }
    case "ask_text": {
      const r = response as { text?: string };
      return `"${r.text}"`;
    }
    case "show_options": {
      const r = response as { selected?: string; feedback?: string };
      return r.feedback ? `"${r.selected}" - ${r.feedback}` : `"${r.selected}"`;
    }
    case "thumbs": {
      const r = response as { choice?: "up" | "down" };
      return r.choice === "up" ? "Positive" : "Negative";
    }
    case "slider": {
      const r = response as { value?: number };
      return String(r.value);
    }
    default:
      return JSON.stringify(response);
  }
}

/**
 * Build the context string for the summary LLM
 */
export function buildSummaryContext(request: string, context: string, answers: BrainstormAnswer[]): string {
  let result = `USER REQUEST:\n${request}\n\n`;

  if (context) {
    result += `CONTEXT:\n${context}\n\n`;
  }

  result += "BRAINSTORMING SESSION:\n";
  for (const a of answers) {
    result += `Q: ${a.question}\n`;
    result += `A: ${formatAnswerForSummary(a)}\n\n`;
  }

  return result;
}

/**
 * Call the summary LLM to generate a design document
 *
 * @param client - OpenCode SDK client
 * @param sessionId - OpenCode session ID for the LLM call
 * @param request - Original user request
 * @param context - Background context
 * @param answers - All answers from the session
 * @param model - Model to use (default: anthropic/claude-sonnet-4)
 */
export async function callSummarize(
  client: import("@opencode-ai/sdk").OpencodeClient,
  sessionId: string,
  request: string,
  context: string,
  answers: BrainstormAnswer[],
  model?: string,
): Promise<string> {
  const summaryContext = buildSummaryContext(request, context, answers);

  // Parse model string into provider/model
  const modelParts = (model || "anthropic/claude-sonnet-4").split("/");
  const providerID = modelParts[0];
  const modelID = modelParts.slice(1).join("/");

  try {
    const response = await client.session.prompt({
      path: { id: sessionId },
      body: {
        model: { providerID, modelID },
        system: SUMMARY_SYSTEM_PROMPT,
        tools: {}, // No tools for summary
        parts: [{ type: "text", text: summaryContext }],
      },
    });

    if (!response.data) {
      throw new BrainstormError("llm_error", "No response from summary LLM");
    }

    // Extract text from response parts
    const textParts = response.data.parts.filter((p): p is import("@opencode-ai/sdk").TextPart => p.type === "text");
    const text = textParts.map((p) => p.text).join("");

    if (!text) {
      throw new BrainstormError("llm_error", "Empty response from summary LLM");
    }

    return text;
  } catch (e) {
    if (e instanceof BrainstormError) throw e;
    throw new BrainstormError("llm_error", `Summary LLM call failed: ${e}`, e);
  }
}
