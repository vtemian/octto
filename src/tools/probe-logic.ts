// src/tools/probe-logic.ts
// Inline probe logic - evaluates branch context and decides next action

import type {
  Answer,
  AskCodeAnswer,
  AskTextAnswer,
  BaseConfig,
  ConfirmAnswer,
  EmojiReactAnswer,
  PickManyAnswer,
  PickOneAnswer,
  QuestionType,
  RankAnswer,
  RateAnswer,
  ReviewAnswer,
  ShowOptionsAnswer,
  SliderAnswer,
  ThumbsAnswer,
} from "@/session";
import { QUESTIONS } from "@/session";
import type { Branch, BranchQuestion } from "@/state";

export interface ProbeResult {
  done: boolean;
  reason: string;
  finding?: string;
  question?: {
    type: QuestionType;
    config: BaseConfig;
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
  const lastQuestion = answeredQuestions[answeredQuestions.length - 1];
  if (lastQuestion?.type === QUESTIONS.CONFIRM && lastQuestion.answer) {
    const ans = lastQuestion.answer as ConfirmAnswer;

    // If user confirmed "ready to proceed", mark done
    if (ans.choice === "yes") {
      return {
        done: true,
        reason: "User confirmed direction is clear",
        finding: synthesizeFinding(branch),
      };
    }

    // If user said "no" to confirm, ask what's unclear
    if (ans.choice === "no") {
      return {
        done: false,
        reason: "User wants to clarify something",
        question: {
          type: QUESTIONS.ASK_TEXT,
          config: {
            question: `What aspect of "${branch.scope}" needs more discussion?`,
            placeholder: "What's unclear or needs more thought?",
            multiline: true,
          },
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
  const answeredQuestions = branch.questions.filter(
    (q): q is BranchQuestion & { answer: Answer } => q.answer !== undefined,
  );

  if (answeredQuestions.length === 0) {
    return `${branch.scope}: No specific direction determined`;
  }

  const answers = answeredQuestions.map((q) => extractAnswerSummary(q.type, q.answer));

  // Build a coherent finding
  const mainChoice = answers[0]; // First answer is usually the main decision
  const qualifiers = answers.slice(1).filter((a) => a && !a.includes("ready to proceed"));

  if (qualifiers.length > 0) {
    return `${branch.scope}: ${mainChoice}. Additional considerations: ${qualifiers.join(", ")}`;
  }
  return `${branch.scope}: ${mainChoice}`;
}

// --- Answer Extraction ---

const MAX_TEXT_LENGTH = 100;

function truncateText(text: string): string {
  return text.length > MAX_TEXT_LENGTH ? `${text.substring(0, MAX_TEXT_LENGTH)}...` : text;
}

export function extractAnswerSummary(type: QuestionType, answer: Answer): string {
  switch (type) {
    case QUESTIONS.PICK_ONE:
      return (answer as PickOneAnswer).selected;

    case QUESTIONS.PICK_MANY:
      return (answer as PickManyAnswer).selected.join(", ");

    case QUESTIONS.CONFIRM:
      return (answer as ConfirmAnswer).choice;

    case QUESTIONS.THUMBS:
      return (answer as ThumbsAnswer).choice;

    case QUESTIONS.EMOJI_REACT:
      return (answer as EmojiReactAnswer).emoji;

    case QUESTIONS.ASK_TEXT:
      return truncateText((answer as AskTextAnswer).text);

    case QUESTIONS.SLIDER:
      return String((answer as SliderAnswer).value);

    case QUESTIONS.RANK: {
      const rankAnswer = answer as RankAnswer;
      const sorted = [...rankAnswer.ranking].sort((a, b) => a.rank - b.rank);
      return sorted.map((r) => r.id).join(" → ");
    }

    case QUESTIONS.RATE: {
      const rateAnswer = answer as RateAnswer;
      const entries = Object.entries(rateAnswer.ratings);
      if (entries.length === 0) return "no ratings";
      const sorted = entries.sort((a, b) => b[1] - a[1]);
      return sorted
        .slice(0, 3)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
    }

    case QUESTIONS.ASK_CODE:
      return truncateText((answer as AskCodeAnswer).code);

    case QUESTIONS.ASK_IMAGE:
    case QUESTIONS.ASK_FILE:
      return "file(s) uploaded";

    case QUESTIONS.SHOW_DIFF:
    case QUESTIONS.SHOW_PLAN:
    case QUESTIONS.REVIEW_SECTION: {
      const reviewAnswer = answer as ReviewAnswer;
      return reviewAnswer.feedback
        ? `${reviewAnswer.decision}: ${truncateText(reviewAnswer.feedback)}`
        : reviewAnswer.decision;
    }

    case QUESTIONS.SHOW_OPTIONS: {
      const optAnswer = answer as ShowOptionsAnswer;
      return optAnswer.feedback ? `${optAnswer.selected}: ${truncateText(optAnswer.feedback)}` : optAnswer.selected;
    }

    default: {
      // Exhaustiveness check - if we get here, we missed a case
      const _exhaustive: never = type;
      return String(_exhaustive);
    }
  }
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
    const firstQuestion = answeredQuestions[0];
    if (!firstQuestion.answer) return null;
    const chosenOption = extractAnswerSummary(firstQuestion.type, firstQuestion.answer);

    // Contextual follow-up based on what they chose
    return {
      type: QUESTIONS.PICK_ONE,
      config: {
        question: `What's most important for "${chosenOption}"?`,
        options: generatePriorityOptions(scope),
      },
    };
  }

  // After second answer: confirm direction
  if (answeredCount === 2) {
    return {
      type: QUESTIONS.CONFIRM,
      config: {
        question: `Is the direction clear for "${branch.scope}"?`,
        context: "Yes = we have enough info. No = let's discuss more.",
      },
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
