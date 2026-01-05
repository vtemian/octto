// src/tools/brainstorm/probe.ts
import type { BrainstormAnswer, ProbeResponse } from "./types";
import { BrainstormError } from "./types";
import { DEFAULT_PROBE_MODEL } from "../../constants";

/**
 * System prompt for the probe LLM
 */
export const PROBE_SYSTEM_PROMPT = `<purpose>
Analyze the conversation so far and decide:
1. Is the design sufficiently explored? (done: true)
2. If not, what's the ONE most important question to ask next?
</purpose>

<output-format>
Return ONLY a JSON object. No markdown, no explanation.

If design is complete:
{
  "done": true,
  "reason": "Brief explanation of why design is complete"
}

If more questions needed:
{
  "done": false,
  "reason": "Brief explanation of what we need to learn",
  "question": {
    "type": "pick_one",
    "config": {
      "question": "...",
      "options": [...]
    }
  }
}
</output-format>

<question-types>
  <type name="pick_one">
    config: { question: string, options: [{id, label, description?}], recommended?: string }
  </type>
  <type name="pick_many">
    config: { question: string, options: [{id, label, description?}], recommended?: string[], min?: number, max?: number }
  </type>
  <type name="confirm">
    config: { question: string, context?: string }
  </type>
  <type name="ask_text">
    config: { question: string, placeholder?: string, multiline?: boolean }
  </type>
  <type name="show_options">
    config: { question: string, options: [{id, label, pros?: string[], cons?: string[]}], recommended?: string, allowFeedback?: boolean }
  </type>
  <type name="thumbs">
    config: { question: string, context?: string }
  </type>
  <type name="slider">
    config: { question: string, min: number, max: number, defaultValue?: number }
  </type>
</question-types>

<principles>
  <principle>Each question builds on previous answers - go deeper, not wider</principle>
  <principle>Don't repeat questions already asked</principle>
  <principle>Set done: true after 8-12 questions typically</principle>
  <principle>Use show_options when presenting architectural choices with tradeoffs</principle>
  <principle>Return ONLY valid JSON - no markdown code blocks</principle>
</principles>

<completion-criteria>
Set done: true when:
- Core problem is well understood
- Key constraints are identified
- Main architectural decisions are made
- User has validated the approach
- ~8-12 questions have been asked
</completion-criteria>

<never-do>
  <forbidden>Never return more than 1 question at a time</forbidden>
  <forbidden>Never wrap output in markdown code blocks</forbidden>
  <forbidden>Never include explanatory text outside the JSON</forbidden>
  <forbidden>Never ask the same question twice</forbidden>
</never-do>`;

/**
 * Format an answer for display in the probe context
 */
export function formatAnswer(answer: BrainstormAnswer): string {
  const { type, answer: response } = answer;

  if (response === null || response === undefined) {
    return "No response";
  }

  switch (type) {
    case "pick_one": {
      const r = response as { selected?: string; other?: string };
      if (r.other) return `User selected "other": "${r.other}"`;
      return `User selected "${r.selected}"`;
    }
    case "pick_many": {
      const r = response as { selected?: string[]; other?: string[] };
      const selections = r.selected?.join('", "') || "";
      const others = r.other?.length ? ` (other: "${r.other.join('", "')}")` : "";
      return `User selected: "${selections}"${others}`;
    }
    case "confirm": {
      const r = response as { choice?: "yes" | "no" | "cancel" };
      return `User said ${r.choice}`;
    }
    case "ask_text": {
      const r = response as { text?: string };
      return `User wrote: "${r.text}"`;
    }
    case "show_options": {
      const r = response as { selected?: string; feedback?: string };
      const feedback = r.feedback ? ` (feedback: "${r.feedback}")` : "";
      return `User chose "${r.selected}"${feedback}`;
    }
    case "thumbs": {
      const r = response as { choice?: "up" | "down" };
      return `User gave thumbs ${r.choice}`;
    }
    case "slider": {
      const r = response as { value?: number };
      return `User set value to ${r.value}`;
    }
    case "rank": {
      const r = response as { ranking?: string[] };
      return `User ranked: ${r.ranking?.join(" > ")}`;
    }
    case "rate": {
      const r = response as { ratings?: Record<string, number> };
      const ratings = Object.entries(r.ratings || {})
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      return `User rated: ${ratings}`;
    }
    default:
      return `Response: ${JSON.stringify(response)}`;
  }
}

/**
 * Build the context string for the probe LLM
 */
export function buildProbeContext(request: string, answers: BrainstormAnswer[]): string {
  let context = `ORIGINAL REQUEST:\n${request}\n\nCONVERSATION:\n`;

  if (answers.length === 0) {
    context += "(No answers yet)\n";
  } else {
    for (let i = 0; i < answers.length; i++) {
      const a = answers[i];
      context += `Q${i + 1} [${a.type}]: ${a.question}\n`;
      context += `A${i + 1}: ${formatAnswer(a)}\n\n`;
    }
  }

  return context;
}

/**
 * Parse and validate the probe LLM response
 */
export function parseProbeResponse(text: string): ProbeResponse {
  // Strip markdown code blocks if present
  let cleaned = text.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, -3);
  }
  cleaned = cleaned.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new BrainstormError("invalid_response", `Failed to parse probe response as JSON: ${text}`, e);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new BrainstormError("invalid_response", "Probe response is not an object");
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.done !== "boolean") {
    throw new BrainstormError("invalid_response", "Probe response missing 'done' boolean field");
  }

  if (obj.done === true) {
    return {
      done: true,
      reason: typeof obj.reason === "string" ? obj.reason : "Design complete",
    };
  }

  // done === false, need question
  if (!obj.question || typeof obj.question !== "object") {
    throw new BrainstormError("invalid_response", "Probe response with done=false must include 'question' object");
  }

  const question = obj.question as Record<string, unknown>;
  if (typeof question.type !== "string" || typeof question.config !== "object") {
    throw new BrainstormError("invalid_response", "Probe question must have 'type' string and 'config' object");
  }

  return {
    done: false,
    reason: typeof obj.reason === "string" ? obj.reason : "",
    question: {
      type: question.type as import("../../session/types").QuestionType,
      config: question.config as import("../../session/types").QuestionConfig,
    },
  };
}

/**
 * Call the probe LLM to decide next action
 *
 * @param client - OpenCode SDK client
 * @param sessionId - OpenCode session ID for the LLM call
 * @param request - Original user request
 * @param answers - Answers collected so far
 * @param model - Model to use (default: anthropic/claude-sonnet-4)
 */
export async function callProbe(
  client: import("@opencode-ai/sdk").OpencodeClient,
  sessionId: string,
  request: string,
  answers: BrainstormAnswer[],
  model?: string,
): Promise<ProbeResponse> {
  const context = buildProbeContext(request, answers);

  // Parse model string into provider/model
  const modelParts = (model || DEFAULT_PROBE_MODEL).split("/");
  const providerID = modelParts[0];
  const modelID = modelParts.slice(1).join("/");

  try {
    const response = await client.session.prompt({
      path: { id: sessionId },
      body: {
        model: { providerID, modelID },
        system: PROBE_SYSTEM_PROMPT,
        tools: {}, // No tools for probe
        parts: [{ type: "text", text: context }],
      },
    });

    if (!response.data) {
      throw new BrainstormError("llm_error", "No response from probe LLM");
    }

    // Extract text from response parts
    const textParts = response.data.parts.filter((p): p is import("@opencode-ai/sdk").TextPart => p.type === "text");
    const text = textParts.map((p) => p.text).join("");

    if (!text) {
      throw new BrainstormError("llm_error", "Empty response from probe LLM");
    }

    return parseProbeResponse(text);
  } catch (e) {
    if (e instanceof BrainstormError) throw e;
    throw new BrainstormError("llm_error", `Probe LLM call failed: ${e}`, e);
  }
}
