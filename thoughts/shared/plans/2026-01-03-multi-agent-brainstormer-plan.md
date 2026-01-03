# Multi-Agent Brainstormer Implementation Plan

**Goal:** Split the single brainstormer agent into three specialized agents (brainstormer orchestrator, bootstrapper, probe) to improve perceived startup time and make behavior more deterministic.

**Architecture:** The brainstormer becomes an orchestrator that spawns two subagents: bootstrapper (fast initial questions) and probe (thoughtful follow-ups). All agents use `anthropic/claude-opus-4-5`. The orchestrator manages session lifecycle and context accumulation, while subagents return structured JSON.

**Design:** [thoughts/shared/designs/2026-01-03-multi-agent-brainstormer-design.md](../designs/2026-01-03-multi-agent-brainstormer-design.md)

---

## Task 1: Create Bootstrapper Agent

**Files:**
- Create: `src/agents/bootstrapper.ts`
- Modify: `src/agents/index.ts`

**Step 1: Write the bootstrapper agent**

```typescript
// src/agents/bootstrapper.ts
import type { AgentConfig } from "@opencode-ai/sdk";

export const bootstrapperAgent: AgentConfig = {
  description: "Generates 2-3 fast initial questions to start a brainstorming session",
  mode: "subagent",
  model: "anthropic/claude-opus-4-5",
  temperature: 0.5,
  prompt: `<purpose>
Generate 2-3 initial questions to start a brainstorming session.
Speed over perfection - these are conversation starters.
</purpose>

<output-format>
Return ONLY a JSON array of question objects. No markdown, no explanation.

Each question object has:
- type: "pick_one" | "pick_many" | "confirm" | "ask_text" | "show_options" | "thumbs" | "slider"
- config: object with question-specific fields

Example output:
[
  {
    "type": "pick_one",
    "config": {
      "question": "What's the primary goal?",
      "options": [
        {"id": "speed", "label": "Fast performance"},
        {"id": "simple", "label": "Simplicity"},
        {"id": "flexible", "label": "Flexibility"}
      ]
    }
  },
  {
    "type": "ask_text",
    "config": {
      "question": "Any specific constraints or requirements?",
      "placeholder": "e.g., must work offline, budget limits..."
    }
  }
]
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
    config: { question: string, options: [{id, label, pros?: string[], cons?: string[]}], recommended?: string }
  </type>
  <type name="thumbs">
    config: { question: string, context?: string }
  </type>
  <type name="slider">
    config: { question: string, min: number, max: number, defaultValue?: number }
  </type>
</question-types>

<principles>
  <principle>Generate exactly 2-3 questions</principle>
  <principle>Use simple types: pick_one, ask_text, confirm</principle>
  <principle>Generic questions are fine - just conversation starters</principle>
  <principle>Focus on understanding scope, goals, and constraints</principle>
  <principle>Return ONLY valid JSON - no markdown code blocks</principle>
</principles>

<never-do>
  <forbidden>Never return more than 3 questions</forbidden>
  <forbidden>Never wrap output in markdown code blocks</forbidden>
  <forbidden>Never include explanatory text outside the JSON</forbidden>
  <forbidden>Never use complex question types like show_plan or review_section</forbidden>
</never-do>`,
};
```

**Step 2: Update agents index to export bootstrapper**

```typescript
// src/agents/index.ts
import type { AgentConfig } from "@opencode-ai/sdk";
import { brainstormerAgent } from "./brainstormer";
import { bootstrapperAgent } from "./bootstrapper";

export const agents: Record<string, AgentConfig> = {
  brainstormer: brainstormerAgent,
  bootstrapper: bootstrapperAgent,
};

export { brainstormerAgent, bootstrapperAgent };
```

**Step 3: Verify TypeScript compiles**

Run: `bun run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add src/agents/bootstrapper.ts src/agents/index.ts
git commit -m "feat(agents): add bootstrapper subagent for fast initial questions"
```

---

## Task 2: Create Probe Agent

**Files:**
- Create: `src/agents/probe.ts`
- Modify: `src/agents/index.ts`

**Step 1: Write the probe agent**

```typescript
// src/agents/probe.ts
import type { AgentConfig } from "@opencode-ai/sdk";

export const probeAgent: AgentConfig = {
  description: "Generates thoughtful follow-up questions based on conversation context",
  mode: "subagent",
  model: "anthropic/claude-opus-4-5",
  temperature: 0.6,
  prompt: `<purpose>
Analyze the conversation so far and decide:
1. Is the design sufficiently explored? (done: true)
2. If not, what's the ONE most important question to ask next?
</purpose>

<input-format>
You receive context in this format:

ORIGINAL REQUEST:
{user's idea/request}

CONVERSATION:
Q1 [pick_one]: What's the primary goal?
A1: User selected "simplicity"

Q2 [ask_text]: Any constraints?
A2: User wrote: "Must work on macOS and Linux"
</input-format>

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
  <type name="rank">
    config: { question: string, options: [{id, label}] }
  </type>
  <type name="rate">
    config: { question: string, options: [{id, label}], min?: number, max?: number }
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
  <forbidden>Never continue past 15 questions - set done: true</forbidden>
</never-do>`,
};
```

**Step 2: Update agents index to export probe**

```typescript
// src/agents/index.ts
import type { AgentConfig } from "@opencode-ai/sdk";
import { brainstormerAgent } from "./brainstormer";
import { bootstrapperAgent } from "./bootstrapper";
import { probeAgent } from "./probe";

export const agents: Record<string, AgentConfig> = {
  brainstormer: brainstormerAgent,
  bootstrapper: bootstrapperAgent,
  probe: probeAgent,
};

export { brainstormerAgent, bootstrapperAgent, probeAgent };
```

**Step 3: Verify TypeScript compiles**

Run: `bun run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add src/agents/probe.ts src/agents/index.ts
git commit -m "feat(agents): add probe subagent for thoughtful follow-up questions"
```

---

## Task 3: Create Context Builder Utility

**Files:**
- Create: `src/agents/context.ts`

This utility formats Q&A history for the probe agent.

**Step 1: Write the context builder**

```typescript
// src/agents/context.ts

import type { QuestionType } from "../session/types";

export interface QAPair {
  questionNumber: number;
  questionType: QuestionType;
  questionText: string;
  answer: unknown;
  config: unknown;
}

/**
 * Formats a single answer based on question type.
 * Maps response objects to human-readable summaries.
 */
export function formatAnswer(questionType: QuestionType, answer: unknown, config: unknown): string {
  if (!answer || typeof answer !== "object") {
    return "User did not respond";
  }

  const ans = answer as Record<string, unknown>;
  const cfg = config as Record<string, unknown>;

  switch (questionType) {
    case "pick_one": {
      const selected = ans.selected as string | undefined;
      if (!selected) return "User did not select";
      const options = (cfg.options as Array<{ id: string; label: string }>) || [];
      const option = options.find((o) => o.id === selected);
      return `User selected "${option?.label || selected}"`;
    }

    case "pick_many": {
      const selected = ans.selected as string[] | undefined;
      if (!selected || selected.length === 0) return "User selected nothing";
      const options = (cfg.options as Array<{ id: string; label: string }>) || [];
      const labels = selected.map((id) => {
        const opt = options.find((o) => o.id === id);
        return opt?.label || id;
      });
      return `User selected: ${labels.map((l) => `"${l}"`).join(", ")}`;
    }

    case "confirm": {
      const choice = ans.choice as string | undefined;
      if (choice === "yes") return "User said yes";
      if (choice === "no") return "User said no";
      if (choice === "cancel") return "User cancelled";
      return "User did not respond";
    }

    case "ask_text": {
      const text = ans.text as string | undefined;
      if (!text) return "User provided no text";
      return `User wrote: "${text}"`;
    }

    case "show_options": {
      const selected = ans.selected as string | undefined;
      const feedback = ans.feedback as string | undefined;
      if (!selected) return "User did not select";
      const options = (cfg.options as Array<{ id: string; label: string }>) || [];
      const option = options.find((o) => o.id === selected);
      let result = `User chose "${option?.label || selected}"`;
      if (feedback) result += ` with feedback: "${feedback}"`;
      return result;
    }

    case "thumbs": {
      const choice = ans.choice as string | undefined;
      if (choice === "up") return "User gave thumbs up";
      if (choice === "down") return "User gave thumbs down";
      return "User did not respond";
    }

    case "slider": {
      const value = ans.value as number | undefined;
      if (value === undefined) return "User did not set value";
      return `User set value to ${value}`;
    }

    case "rank": {
      const ranking = ans.ranking as string[] | undefined;
      if (!ranking || ranking.length === 0) return "User did not rank";
      const options = (cfg.options as Array<{ id: string; label: string }>) || [];
      const ranked = ranking.map((id, i) => {
        const opt = options.find((o) => o.id === id);
        return `${i + 1}. ${opt?.label || id}`;
      });
      return `User ranked: ${ranked.join(", ")}`;
    }

    case "rate": {
      const ratings = ans.ratings as Record<string, number> | undefined;
      if (!ratings) return "User did not rate";
      const options = (cfg.options as Array<{ id: string; label: string }>) || [];
      const rated = Object.entries(ratings).map(([id, rating]) => {
        const opt = options.find((o) => o.id === id);
        return `${opt?.label || id}: ${rating}`;
      });
      return `User rated: ${rated.join(", ")}`;
    }

    default:
      return `User responded: ${JSON.stringify(answer)}`;
  }
}

/**
 * Builds the full context string for the probe agent.
 */
export function buildProbeContext(originalRequest: string, qaPairs: QAPair[]): string {
  let context = `ORIGINAL REQUEST:\n${originalRequest}\n\n`;

  if (qaPairs.length === 0) {
    context += "CONVERSATION:\n(No questions answered yet)";
    return context;
  }

  context += "CONVERSATION:\n";
  for (const qa of qaPairs) {
    const formattedAnswer = formatAnswer(qa.questionType, qa.answer, qa.config);
    context += `Q${qa.questionNumber} [${qa.questionType}]: ${qa.questionText}\n`;
    context += `A${qa.questionNumber}: ${formattedAnswer}\n\n`;
  }

  return context.trim();
}
```

**Step 2: Verify TypeScript compiles**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/agents/context.ts
git commit -m "feat(agents): add context builder utility for probe agent"
```

---

## Task 4: Write Context Builder Tests

**Files:**
- Create: `tests/agents/context.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/agents/context.test.ts
import { describe, it, expect } from "bun:test";
import { formatAnswer, buildProbeContext, type QAPair } from "../../src/agents/context";

describe("formatAnswer", () => {
  it("should format pick_one answer", () => {
    const answer = { selected: "opt1" };
    const config = { options: [{ id: "opt1", label: "Option One" }] };

    const result = formatAnswer("pick_one", answer, config);

    expect(result).toBe('User selected "Option One"');
  });

  it("should format pick_many answer", () => {
    const answer = { selected: ["a", "c"] };
    const config = {
      options: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta" },
        { id: "c", label: "Charlie" },
      ],
    };

    const result = formatAnswer("pick_many", answer, config);

    expect(result).toBe('User selected: "Alpha", "Charlie"');
  });

  it("should format confirm yes", () => {
    const result = formatAnswer("confirm", { choice: "yes" }, {});
    expect(result).toBe("User said yes");
  });

  it("should format confirm no", () => {
    const result = formatAnswer("confirm", { choice: "no" }, {});
    expect(result).toBe("User said no");
  });

  it("should format ask_text answer", () => {
    const result = formatAnswer("ask_text", { text: "Must work offline" }, {});
    expect(result).toBe('User wrote: "Must work offline"');
  });

  it("should format show_options with feedback", () => {
    const answer = { selected: "opt2", feedback: "I prefer this approach" };
    const config = { options: [{ id: "opt2", label: "Option Two" }] };

    const result = formatAnswer("show_options", answer, config);

    expect(result).toBe('User chose "Option Two" with feedback: "I prefer this approach"');
  });

  it("should format thumbs up", () => {
    const result = formatAnswer("thumbs", { choice: "up" }, {});
    expect(result).toBe("User gave thumbs up");
  });

  it("should format slider value", () => {
    const result = formatAnswer("slider", { value: 7 }, {});
    expect(result).toBe("User set value to 7");
  });

  it("should format rank answer", () => {
    const answer = { ranking: ["c", "a", "b"] };
    const config = {
      options: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta" },
        { id: "c", label: "Charlie" },
      ],
    };

    const result = formatAnswer("rank", answer, config);

    expect(result).toBe("User ranked: 1. Charlie, 2. Alpha, 3. Beta");
  });

  it("should format rate answer", () => {
    const answer = { ratings: { a: 5, b: 3 } };
    const config = {
      options: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta" },
      ],
    };

    const result = formatAnswer("rate", answer, config);

    expect(result).toContain("Alpha: 5");
    expect(result).toContain("Beta: 3");
  });
});

describe("buildProbeContext", () => {
  it("should build context with no questions", () => {
    const result = buildProbeContext("Build a CLI tool", []);

    expect(result).toContain("ORIGINAL REQUEST:");
    expect(result).toContain("Build a CLI tool");
    expect(result).toContain("(No questions answered yet)");
  });

  it("should build context with Q&A pairs", () => {
    const qaPairs: QAPair[] = [
      {
        questionNumber: 1,
        questionType: "pick_one",
        questionText: "What's the primary goal?",
        answer: { selected: "speed" },
        config: { options: [{ id: "speed", label: "Fast performance" }] },
      },
      {
        questionNumber: 2,
        questionType: "ask_text",
        questionText: "Any constraints?",
        answer: { text: "Must work on macOS" },
        config: {},
      },
    ];

    const result = buildProbeContext("Build a CLI tool", qaPairs);

    expect(result).toContain("ORIGINAL REQUEST:");
    expect(result).toContain("Build a CLI tool");
    expect(result).toContain("CONVERSATION:");
    expect(result).toContain("Q1 [pick_one]: What's the primary goal?");
    expect(result).toContain('A1: User selected "Fast performance"');
    expect(result).toContain("Q2 [ask_text]: Any constraints?");
    expect(result).toContain('A2: User wrote: "Must work on macOS"');
  });
});
```

**Step 2: Run test to verify it passes**

Run: `bun test tests/agents/context.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/agents/context.test.ts
git commit -m "test(agents): add context builder tests"
```

---

## Task 5: Refactor Brainstormer to Orchestrator

**Files:**
- Modify: `src/agents/brainstormer.ts`

The brainstormer becomes an orchestrator that:
1. Spawns bootstrapper immediately on user request
2. Parses JSON responses from subagents
3. Manages session lifecycle
4. Accumulates context and passes to probe
5. Writes design document at the end

**Step 1: Rewrite brainstormer as orchestrator**

```typescript
// src/agents/brainstormer.ts
import type { AgentConfig } from "@opencode-ai/sdk";

export const brainstormerAgent: AgentConfig = {
  description: "Orchestrates brainstorming sessions by coordinating bootstrapper and probe subagents",
  mode: "primary",
  model: "anthropic/claude-opus-4-5",
  temperature: 0.7,
  prompt: `<purpose>
Orchestrate brainstorming sessions. You coordinate subagents and manage the session.
You do NOT generate questions yourself - subagents do that.
</purpose>

<critical-rules>
  <rule priority="HIGHEST">IMMEDIATELY spawn bootstrapper on user request - no thinking first</rule>
  <rule priority="HIGH">Parse JSON from subagents - they return structured data</rule>
  <rule priority="HIGH">Build context string after each answer for probe</rule>
  <rule>Call end_session when probe returns done: true</rule>
</critical-rules>

<workflow>
1. User gives request
2. IMMEDIATELY spawn bootstrapper with the request
3. Parse bootstrapper's JSON array of questions
4. Call start_session with those questions
5. Enter answer loop:
   a. get_next_answer(block=true)
   b. Add Q&A to context
   c. Spawn probe with full context
   d. Parse probe's JSON response
   e. If done: false, push probe's question
   f. If done: true, exit loop
6. Call end_session
7. Write design document
</workflow>

<spawning-subagents>
Use background_task to spawn subagents:

Bootstrapper (for initial questions):
background_task(
  agent="bootstrapper",
  description="Generate initial questions",
  prompt="Generate 2-3 initial questions for: {user's request}"
)

Probe (for follow-ups):
background_task(
  agent="probe", 
  description="Generate follow-up question",
  prompt="{full context string}"
)

Then use background_output(task_id, block=true) to get the result.
</spawning-subagents>

<context-format>
Build this context string for probe:

ORIGINAL REQUEST:
{user's original request}

CONVERSATION:
Q1 [pick_one]: What's the primary goal?
A1: User selected "simplicity"

Q2 [ask_text]: Any constraints?
A2: User wrote: "Must work on macOS and Linux"

Q3 [pick_many]: Which features are essential?
A3: User selected: "sync", "backup"
</context-format>

<answer-formatting>
Format answers based on question type:
- pick_one: User selected "{label}"
- pick_many: User selected: "{label1}", "{label2}"
- confirm: User said yes/no
- ask_text: User wrote: "{text}"
- show_options: User chose "{label}" [+ feedback if any]
- thumbs: User gave thumbs up/down
- slider: User set value to {value}
- rank: User ranked: 1. {first}, 2. {second}, ...
- rate: User rated: {item}: {rating}, ...
</answer-formatting>

<parsing-subagent-responses>
Bootstrapper returns JSON array:
[
  {"type": "pick_one", "config": {...}},
  {"type": "ask_text", "config": {...}}
]

Probe returns JSON object:
{"done": false, "reason": "...", "question": {"type": "...", "config": {...}}}
or
{"done": true, "reason": "..."}

Parse these with JSON.parse(). If parsing fails, retry once.
</parsing-subagent-responses>

<error-handling>
- If bootstrapper returns invalid JSON: retry once, then use 2 generic questions
- If probe returns invalid JSON: retry once with same context
- If probe keeps returning questions past 15: force done
- If user closes browser: end session, report incomplete
</error-handling>

<fallback-questions>
If bootstrapper fails, use these:
[
  {
    "type": "ask_text",
    "config": {
      "question": "What are you trying to build or accomplish?",
      "placeholder": "Describe your idea..."
    }
  },
  {
    "type": "pick_one",
    "config": {
      "question": "What's most important to you?",
      "options": [
        {"id": "speed", "label": "Fast to build"},
        {"id": "quality", "label": "High quality"},
        {"id": "simple", "label": "Keep it simple"}
      ]
    }
  }
]
</fallback-questions>

<session-tools>
  <tool name="start_session">Opens browser with initial questions array</tool>
  <tool name="end_session">Closes browser when done</tool>
  <tool name="get_next_answer">Gets next answered question (block=true)</tool>
  <tool name="pick_one">Push single-select question</tool>
  <tool name="pick_many">Push multi-select question</tool>
  <tool name="confirm">Push yes/no question</tool>
  <tool name="ask_text">Push text input question</tool>
  <tool name="show_options">Push options with pros/cons</tool>
  <tool name="thumbs">Push thumbs up/down</tool>
  <tool name="slider">Push numeric slider</tool>
</session-tools>

<background-tools>
  <tool name="background_task">Spawn subagent task</tool>
  <tool name="background_output">Get subagent result (use block=true)</tool>
  <tool name="background_list">List running tasks</tool>
</background-tools>

<principles>
  <principle>You are an ORCHESTRATOR - you coordinate, not create</principle>
  <principle>Spawn bootstrapper IMMEDIATELY - no delay</principle>
  <principle>Parse JSON carefully - subagents return structured data</principle>
  <principle>Build context incrementally after each answer</principle>
  <principle>Let probe decide when design is complete</principle>
</principles>

<never-do>
  <forbidden>NEVER generate questions yourself - use subagents</forbidden>
  <forbidden>NEVER think before spawning bootstrapper - do it immediately</forbidden>
  <forbidden>NEVER decide when design is complete - probe decides</forbidden>
  <forbidden>NEVER skip building context - probe needs full history</forbidden>
  <forbidden>NEVER leave session open after probe returns done: true</forbidden>
</never-do>

<output-format path="thoughts/shared/designs/YYYY-MM-DD-{topic}-design.md">
After session ends, write design document with:
- Problem Statement
- Constraints
- Approach
- Architecture
- Components
- Data Flow
- Error Handling
- Testing Strategy
- Open Questions
</output-format>`,
};
```

**Step 2: Verify TypeScript compiles**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/agents/brainstormer.ts
git commit -m "refactor(agents): convert brainstormer to orchestrator pattern"
```

---

## Task 6: Update Plugin to Register All Agents

**Files:**
- Modify: `src/index.ts`

**Step 1: Verify agents are already registered**

The current `src/index.ts` already imports and registers agents via the `agents` record from `src/agents/index.ts`. Since we updated that file in Tasks 1 and 2, all three agents should be registered automatically.

**Step 2: Verify by reading current state**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Run build to verify everything works**

Run: `bun run build`
Expected: Build succeeds

**Step 4: Commit (if any changes needed)**

```bash
git status
# If no changes, skip commit
```

---

## Task 7: Integration Test - Multi-Agent Flow

**Files:**
- Create: `tests/integration/multi-agent.test.ts`

This test verifies the context building and JSON parsing work correctly.

**Step 1: Write the integration test**

```typescript
// tests/integration/multi-agent.test.ts
import { describe, it, expect } from "bun:test";
import { buildProbeContext, formatAnswer, type QAPair } from "../../src/agents/context";

describe("Multi-Agent Integration", () => {
  describe("Bootstrapper JSON parsing", () => {
    it("should parse valid bootstrapper response", () => {
      const bootstrapperResponse = `[
        {
          "type": "pick_one",
          "config": {
            "question": "What's the primary goal?",
            "options": [
              {"id": "speed", "label": "Fast performance"},
              {"id": "simple", "label": "Simplicity"}
            ]
          }
        },
        {
          "type": "ask_text",
          "config": {
            "question": "Any constraints?",
            "placeholder": "e.g., must work offline..."
          }
        }
      ]`;

      const questions = JSON.parse(bootstrapperResponse);

      expect(questions).toHaveLength(2);
      expect(questions[0].type).toBe("pick_one");
      expect(questions[0].config.question).toBe("What's the primary goal?");
      expect(questions[1].type).toBe("ask_text");
    });

    it("should handle bootstrapper response with extra whitespace", () => {
      const bootstrapperResponse = `
      
      [{"type": "confirm", "config": {"question": "Ready?"}}]
      
      `;

      const questions = JSON.parse(bootstrapperResponse.trim());

      expect(questions).toHaveLength(1);
      expect(questions[0].type).toBe("confirm");
    });
  });

  describe("Probe JSON parsing", () => {
    it("should parse probe response with question", () => {
      const probeResponse = `{
        "done": false,
        "reason": "Need to understand scale requirements",
        "question": {
          "type": "slider",
          "config": {
            "question": "Expected number of users?",
            "min": 1,
            "max": 1000000,
            "defaultValue": 1000
          }
        }
      }`;

      const result = JSON.parse(probeResponse);

      expect(result.done).toBe(false);
      expect(result.reason).toBe("Need to understand scale requirements");
      expect(result.question.type).toBe("slider");
      expect(result.question.config.min).toBe(1);
    });

    it("should parse probe done response", () => {
      const probeResponse = `{
        "done": true,
        "reason": "All key decisions have been made"
      }`;

      const result = JSON.parse(probeResponse);

      expect(result.done).toBe(true);
      expect(result.reason).toBe("All key decisions have been made");
      expect(result.question).toBeUndefined();
    });
  });

  describe("Full context building flow", () => {
    it("should build context through multiple Q&A rounds", () => {
      const originalRequest = "Build a task management CLI";
      const qaPairs: QAPair[] = [];

      // Round 1: pick_one
      qaPairs.push({
        questionNumber: 1,
        questionType: "pick_one",
        questionText: "What's the primary goal?",
        answer: { selected: "simple" },
        config: {
          options: [
            { id: "speed", label: "Fast performance" },
            { id: "simple", label: "Simplicity" },
          ],
        },
      });

      let context = buildProbeContext(originalRequest, qaPairs);
      expect(context).toContain("Build a task management CLI");
      expect(context).toContain('A1: User selected "Simplicity"');

      // Round 2: ask_text
      qaPairs.push({
        questionNumber: 2,
        questionType: "ask_text",
        questionText: "Any specific constraints?",
        answer: { text: "Must work offline, no cloud sync" },
        config: {},
      });

      context = buildProbeContext(originalRequest, qaPairs);
      expect(context).toContain('A2: User wrote: "Must work offline, no cloud sync"');

      // Round 3: pick_many
      qaPairs.push({
        questionNumber: 3,
        questionType: "pick_many",
        questionText: "Which features are essential?",
        answer: { selected: ["tags", "due"] },
        config: {
          options: [
            { id: "tags", label: "Tags/Labels" },
            { id: "due", label: "Due dates" },
            { id: "priority", label: "Priority levels" },
          ],
        },
      });

      context = buildProbeContext(originalRequest, qaPairs);
      expect(context).toContain('A3: User selected: "Tags/Labels", "Due dates"');

      // Verify full context structure
      expect(context).toContain("ORIGINAL REQUEST:");
      expect(context).toContain("CONVERSATION:");
      expect(context).toContain("Q1 [pick_one]:");
      expect(context).toContain("Q2 [ask_text]:");
      expect(context).toContain("Q3 [pick_many]:");
    });
  });
});
```

**Step 2: Run test to verify it passes**

Run: `bun test tests/integration/multi-agent.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/integration/multi-agent.test.ts
git commit -m "test(integration): add multi-agent flow tests"
```

---

## Task 8: Run All Tests and Final Verification

**Step 1: Run all tests**

Run: `bun test`
Expected: All tests PASS

**Step 2: Run type check**

Run: `bun run typecheck`
Expected: No errors

**Step 3: Run build**

Run: `bun run build`
Expected: Build succeeds

**Step 4: Verify dist output**

Run: `ls -la dist/`
Expected: Contains `index.js` and `index.d.ts`

**Step 5: Final commit**

```bash
git add -A
git status
# Verify only expected files are staged
git commit -m "feat(brainstormer): implement multi-agent architecture

- Add bootstrapper subagent for fast initial questions (temp 0.5)
- Add probe subagent for thoughtful follow-ups (temp 0.6)
- Refactor brainstormer to orchestrator pattern (temp 0.7)
- Add context builder utility for Q&A history formatting
- Add comprehensive tests for context building and JSON parsing

The brainstormer now:
1. Immediately spawns bootstrapper on user request
2. Opens browser with 2-3 initial questions
3. Spawns probe after each answer with full context
4. Continues until probe returns done: true
5. Writes design document at the end"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Create bootstrapper agent | `src/agents/bootstrapper.ts`, `src/agents/index.ts` |
| 2 | Create probe agent | `src/agents/probe.ts`, `src/agents/index.ts` |
| 3 | Create context builder utility | `src/agents/context.ts` |
| 4 | Write context builder tests | `tests/agents/context.test.ts` |
| 5 | Refactor brainstormer to orchestrator | `src/agents/brainstormer.ts` |
| 6 | Verify plugin registers all agents | `src/index.ts` (verify only) |
| 7 | Integration test for multi-agent flow | `tests/integration/multi-agent.test.ts` |
| 8 | Final verification and commit | All files |

## Agent Configuration Summary

| Agent | Mode | Temperature | Responsibility |
|-------|------|-------------|----------------|
| brainstormer | primary | 0.7 | Orchestrator - coordinates flow, no creative decisions |
| bootstrapper | subagent | 0.5 | Fast initial questions (2-3), returns JSON array |
| probe | subagent | 0.6 | Thoughtful follow-ups, returns JSON with done/question |

## Data Flow

```
User Request
     |
     v
brainstormer (orchestrator)
     |
     +---> background_task(agent="bootstrapper", prompt=request)
     |          |
     |          v
     |     [q1, q2, q3] (JSON array)
     |          |
     |     start_session(questions)
     |
     +---> LOOP:
              get_next_answer
                   |
                   v
              background_task(agent="probe", prompt=context)
                   |
                   v
              {done?, question} (JSON object)
                   |
              if !done: push question
              if done: exit loop
                   |
              end_session
                   |
              write design doc
```
