import { z } from "zod";

import { type SessionStore, STATUSES } from "@/session";

import { defineTool } from "./define";
import type { OcttoTool, OcttoTools } from "./types";

function buildGetAnswer(sessions: SessionStore): OcttoTool {
  return defineTool({
    description: `Get the answer to a SPECIFIC question.
By default returns immediately with current status.
Set block=true to wait for user response (with optional timeout).
NOTE: Prefer get_next_answer for better flow - it returns whichever question user answers first.`,
    args: {
      question_id: z.string().describe("Question ID from a question tool"),
      block: z.boolean().optional().describe("Wait for response (default: false)"),
      timeout: z.number().optional().describe("Max milliseconds to wait if blocking (default: 300000 = 5 min)"),
    },
    execute: async (args) => {
      const answer = await sessions.getAnswer({
        question_id: args.question_id,
        block: args.block,
        timeout: args.timeout,
      });

      if (answer.completed) {
        return `## Answer Received

**Status:** ${answer.status}

**Response:**
\`\`\`json
${JSON.stringify(answer.response, null, 2)}
\`\`\``;
      }

      return `## Waiting for Answer

**Status:** ${answer.status}
**Reason:** ${answer.reason}

${answer.status === STATUSES.PENDING ? "User has not answered yet. Call again with block=true to wait." : ""}`;
    },
  });
}

function buildGetNextAnswer(sessions: SessionStore): OcttoTool {
  return defineTool({
    description: `Wait for ANY question to be answered. Returns whichever question the user answers first.
This is the PREFERRED way to get answers - lets user answer in any order.
Push multiple questions, then call this repeatedly to get answers as they come.`,
    args: {
      session_id: z.string().describe("Session ID from start_session"),
      block: z.boolean().optional().describe("Wait for response (default: false)"),
      timeout: z.number().optional().describe("Max milliseconds to wait if blocking (default: 300000 = 5 min)"),
    },
    execute: async (args) => {
      const nextAnswer = await sessions.getNextAnswer({
        session_id: args.session_id,
        block: args.block,
        timeout: args.timeout,
      });

      if (nextAnswer.completed) {
        return `## Answer Received

**Question ID:** ${nextAnswer.question_id}
**Question Type:** ${nextAnswer.question_type}
**Status:** ${nextAnswer.status}

**Response:**
\`\`\`json
${JSON.stringify(nextAnswer.response, null, 2)}
\`\`\``;
      }

      if (nextAnswer.status === STATUSES.NONE_PENDING) {
        return `## No Pending Questions

All questions have been answered or there are no questions in the queue.
Push more questions or end the session.`;
      }

      return `## Waiting for Answer

**Status:** ${nextAnswer.status}
${nextAnswer.reason === STATUSES.TIMEOUT ? "Timed out waiting for response." : "No answer yet."}`;
    },
  });
}

function buildListQuestions(sessions: SessionStore): OcttoTool {
  return defineTool({
    description: `List all questions and their status for a session.`,
    args: {
      session_id: z.string().optional().describe("Session ID (omit for all sessions)"),
    },
    execute: async (args) => {
      const listing = sessions.listQuestions(args.session_id);

      if (listing.questions.length === 0) {
        return "No questions found.";
      }

      let output = "## Questions\n\n";
      output += "| ID | Type | Status | Created | Answered |\n";
      output += "|----|------|--------|---------|----------|\n";

      for (const q of listing.questions) {
        output += `| ${q.id} | ${q.type} | ${q.status} | ${q.createdAt} | ${q.answeredAt || "-"} |\n`;
      }

      return output;
    },
  });
}

function buildCancelQuestion(sessions: SessionStore): OcttoTool {
  return defineTool({
    description: `Cancel a pending question.
The question will be removed from the user's queue.`,
    args: {
      question_id: z.string().describe("Question ID to cancel"),
    },
    execute: async (args) => {
      const cancellation = sessions.cancelQuestion(args.question_id);
      if (cancellation.ok) {
        return `Question ${args.question_id} cancelled.`;
      }
      return `Could not cancel question ${args.question_id}. It may already be answered or not exist.`;
    },
  });
}

export function createResponseTools(sessions: SessionStore): OcttoTools {
  return {
    get_answer: buildGetAnswer(sessions),
    get_next_answer: buildGetNextAnswer(sessions),
    list_questions: buildListQuestions(sessions),
    cancel_question: buildCancelQuestion(sessions),
  };
}
