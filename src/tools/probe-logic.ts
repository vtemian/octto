// src/tools/probe-logic.ts
// Inline probe logic - evaluates branch context and decides next action

import type { Branch } from "../state/types";
import type { QuestionConfig } from "../session/types";

export interface ProbeResult {
  done: boolean;
  reason: string;
  finding?: string;
  question?: {
    type: string;
    config: QuestionConfig;
  };
}

/**
 * Evaluates a branch's Q&A history and decides:
 * - If done: returns finding
 * - If not: returns next question
 *
 * Rules-based probe logic with scope awareness.
 */
export function evaluateBranch(branch: Branch): ProbeResult {
  const answeredQuestions = branch.questions.filter((q) => q.answer !== undefined);
  const answeredCount = answeredQuestions.length;
  const pendingCount = branch.questions.length - answeredCount;

  // Rule 1: If we have pending questions, wait for them
  if (pendingCount > 0) {
    return {
      done: false,
      reason: `Waiting for ${pendingCount} pending question(s)`,
    };
  }

  // Rule 2: If 3+ questions answered, we have enough depth
  if (answeredCount >= 3) {
    return {
      done: true,
      reason: `Explored ${answeredCount} questions - sufficient depth for ${branch.scope}`,
      finding: synthesizeFinding(branch),
    };
  }

  // Rule 3: Check if user explicitly confirmed/declined to continue
  const lastAnswer = answeredQuestions[answeredQuestions.length - 1];
  if (lastAnswer) {
    const ans = lastAnswer.answer as Record<string, unknown>;

    // If user confirmed "ready to proceed", mark done
    if (ans.choice === "yes" && lastAnswer.type === "confirm") {
      return {
        done: true,
        reason: "User confirmed direction is clear",
        finding: synthesizeFinding(branch),
      };
    }

    // If user said "no" to confirm, ask what's unclear
    if (ans.choice === "no" && lastAnswer.type === "confirm") {
      return {
        done: false,
        reason: "User wants to clarify something",
        question: {
          type: "ask_text",
          config: {
            question: `What aspect of "${branch.scope}" needs more discussion?`,
            placeholder: "What's unclear or needs more thought?",
            multiline: true,
          } as QuestionConfig,
        },
      };
    }
  }

  // Rule 4: Generate contextual follow-up based on scope and answers
  const nextQuestion = generateContextualFollowUp(branch, answeredQuestions);
  if (nextQuestion) {
    return {
      done: false,
      reason: `Exploring ${branch.scope} further`,
      question: nextQuestion,
    };
  }

  // Fallback: mark done
  return {
    done: true,
    reason: "Sufficient information gathered",
    finding: synthesizeFinding(branch),
  };
}

/**
 * Synthesizes a meaningful finding from the branch's Q&A history
 */
function synthesizeFinding(branch: Branch): string {
  const answers = branch.questions
    .filter((q) => q.answer !== undefined)
    .map((q) => {
      const ans = q.answer as Record<string, unknown>;
      return extractAnswerSummary(q.text, ans);
    });

  if (answers.length === 0) {
    return `${branch.scope}: No specific direction determined`;
  }

  // Build a coherent finding
  const mainChoice = answers[0]; // First answer is usually the main decision
  const qualifiers = answers.slice(1).filter((a) => a && !a.includes("ready to proceed"));

  if (qualifiers.length > 0) {
    return `${branch.scope}: ${mainChoice}. Additional considerations: ${qualifiers.join(", ")}`;
  }
  return `${branch.scope}: ${mainChoice}`;
}

/**
 * Extracts a readable summary from an answer
 */
function extractAnswerSummary(questionText: string, answer: Record<string, unknown>): string {
  // Handle different answer formats
  if (answer.selected) {
    const selected = answer.selected;
    if (Array.isArray(selected)) {
      return selected.join(", ");
    }
    return String(selected);
  }
  if (answer.choice) {
    return String(answer.choice);
  }
  if (answer.text) {
    const text = String(answer.text);
    // Truncate long text answers
    return text.length > 100 ? `${text.substring(0, 100)}...` : text;
  }
  if (answer.value !== undefined) {
    return String(answer.value);
  }

  // Fallback: try to extract any meaningful value
  const values = Object.values(answer).filter((v) => v !== undefined && v !== null);
  if (values.length > 0) {
    return String(values[0]);
  }
  return "unspecified";
}

/**
 * Generates a contextual follow-up question based on scope and previous answers
 */
function generateContextualFollowUp(
  branch: Branch,
  answeredQuestions: Branch["questions"],
): ProbeResult["question"] | null {
  const answeredCount = answeredQuestions.length;
  const scope = branch.scope.toLowerCase();

  // After first answer: ask about constraints/requirements
  if (answeredCount === 1) {
    const firstAnswer = answeredQuestions[0].answer as Record<string, unknown>;
    const chosenOption = extractAnswerSummary("", firstAnswer);

    // Contextual follow-up based on what they chose
    return {
      type: "pick_one",
      config: {
        question: `What's most important for "${chosenOption}"?`,
        options: generatePriorityOptions(scope),
      } as QuestionConfig,
    };
  }

  // After second answer: confirm direction
  if (answeredCount === 2) {
    return {
      type: "confirm",
      config: {
        question: `Is the direction clear for "${branch.scope}"?`,
        context: "Yes = we have enough info. No = let's discuss more.",
      } as QuestionConfig,
    };
  }

  return null;
}

/**
 * Generates priority options based on scope keywords
 */
function generatePriorityOptions(scope: string): Array<{ id: string; label: string }> {
  // Default options that work for most contexts
  const defaultOptions = [
    { id: "simplicity", label: "Keep it simple" },
    { id: "performance", label: "Performance matters most" },
    { id: "flexibility", label: "Flexibility for future changes" },
    { id: "reliability", label: "Reliability and stability" },
  ];

  // Contextual options based on scope keywords
  if (scope.includes("database") || scope.includes("data")) {
    return [
      { id: "consistency", label: "Data consistency" },
      { id: "performance", label: "Query performance" },
      { id: "scalability", label: "Scalability" },
      { id: "simplicity", label: "Keep it simple" },
    ];
  }

  if (scope.includes("api") || scope.includes("endpoint")) {
    return [
      { id: "simplicity", label: "Simple API surface" },
      { id: "performance", label: "Low latency" },
      { id: "compatibility", label: "Backward compatibility" },
      { id: "documentation", label: "Easy to document" },
    ];
  }

  if (scope.includes("auth") || scope.includes("security")) {
    return [
      { id: "security", label: "Maximum security" },
      { id: "usability", label: "User convenience" },
      { id: "standards", label: "Industry standards" },
      { id: "simplicity", label: "Simple implementation" },
    ];
  }

  if (scope.includes("ui") || scope.includes("frontend") || scope.includes("design")) {
    return [
      { id: "usability", label: "User experience" },
      { id: "performance", label: "Fast load times" },
      { id: "accessibility", label: "Accessibility" },
      { id: "simplicity", label: "Clean and simple" },
    ];
  }

  return defaultOptions;
}
