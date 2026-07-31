import { OTHER_OPTION_ID } from "@/constants";
import type { Answer, QuestionAnswers, QuestionType } from "@/session";
import { QUESTIONS } from "@/session";

const MAX_TEXT_LENGTH = 100;
const MAX_DISPLAYED_RATINGS = 3;

function typedAnswer<T extends QuestionType>(_type: T, answer: Answer): QuestionAnswers[T] {
  // _type is used only for type inference; the switch in extractAnswerSummary provides runtime safety
  return answer as QuestionAnswers[T];
}

function truncateText(text: string): string {
  return text.length > MAX_TEXT_LENGTH ? `${text.substring(0, MAX_TEXT_LENGTH)}...` : text;
}

// eslint-disable-next-line max-lines-per-function -- single switch dispatch over all question types
export function extractAnswerSummary(type: QuestionType, answer: Answer): string {
  switch (type) {
    case QUESTIONS.PICK_ONE: {
      const picked = typedAnswer(QUESTIONS.PICK_ONE, answer);
      return picked.selected === OTHER_OPTION_ID && picked.other ? picked.other : picked.selected;
    }

    case QUESTIONS.PICK_MANY: {
      const picked = typedAnswer(QUESTIONS.PICK_MANY, answer);
      return picked.selected.map((id) => (id === OTHER_OPTION_ID && picked.other ? picked.other : id)).join(", ");
    }

    case QUESTIONS.CONFIRM:
      return typedAnswer(QUESTIONS.CONFIRM, answer).choice;

    case QUESTIONS.THUMBS:
      return typedAnswer(QUESTIONS.THUMBS, answer).choice;

    case QUESTIONS.EMOJI_REACT:
      return typedAnswer(QUESTIONS.EMOJI_REACT, answer).emoji;

    case QUESTIONS.ASK_TEXT:
      return truncateText(typedAnswer(QUESTIONS.ASK_TEXT, answer).text);

    case QUESTIONS.SLIDER:
      return String(typedAnswer(QUESTIONS.SLIDER, answer).value);

    case QUESTIONS.RANK: {
      const ranked = typedAnswer(QUESTIONS.RANK, answer);
      const sorted = [...ranked.ranking].sort((a, b) => a.rank - b.rank);
      return sorted.map((r) => r.id).join(" → ");
    }

    case QUESTIONS.RATE: {
      const rated = typedAnswer(QUESTIONS.RATE, answer);
      const entries = Object.entries(rated.ratings);
      if (entries.length === 0) return "no ratings";
      const sorted = entries.sort((a, b) => b[1] - a[1]);
      return sorted
        .slice(0, MAX_DISPLAYED_RATINGS)
        .map(([k, rating]) => `${k}: ${rating}`)
        .join(", ");
    }

    case QUESTIONS.ASK_CODE:
      return truncateText(typedAnswer(QUESTIONS.ASK_CODE, answer).code);

    case QUESTIONS.ASK_IMAGE:
    case QUESTIONS.ASK_FILE:
      return "file(s) uploaded";

    case QUESTIONS.SHOW_DIFF:
    case QUESTIONS.SHOW_PLAN:
    case QUESTIONS.REVIEW_SECTION: {
      const review = typedAnswer(QUESTIONS.REVIEW_SECTION, answer);
      return review.feedback ? `${review.decision}: ${truncateText(review.feedback)}` : review.decision;
    }

    case QUESTIONS.SHOW_OPTIONS: {
      const option = typedAnswer(QUESTIONS.SHOW_OPTIONS, answer);
      return option.feedback ? `${option.selected}: ${truncateText(option.feedback)}` : option.selected;
    }

    default: {
      const _exhaustive: never = type;
      return String(_exhaustive);
    }
  }
}
