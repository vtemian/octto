// src/tools/session.ts
import { tool } from "@opencode-ai/plugin/tool";

import type { SessionStore } from "@/session";

import type { OcttoTool, OcttoTools } from "./types";

function formatSessionStarted(result: { session_id: string; url: string; question_ids?: string[] }): string {
  let output = `## Session Started

| Field | Value |
|-------|-------|
| Session ID | ${result.session_id} |
| URL | ${result.url} |
`;

  if (result.question_ids && result.question_ids.length > 0) {
    output += `| Questions | ${result.question_ids.length} loaded |\n\n`;
    output += `**Question IDs:** ${result.question_ids.join(", ")}\n\n`;
    output += `Browser opened with ${result.question_ids.length} questions ready.\n`;
    output += `Use get_next_answer(session_id, block=true) to get answers as user responds.`;
  } else {
    output += `\nBrowser opened. Use question tools to push questions.`;
  }

  return output;
}

const MISSING_QUESTIONS_ERROR = `## ERROR: questions parameter is REQUIRED

start_session MUST include questions. Browser should open with questions ready.

Example:
\`\`\`
start_session(
  title="Design Session",
  questions=[
    {type: "pick_one", config: {question: "What language?", options: [{id: "go", label: "Go"}]}},
    {type: "ask_text", config: {question: "Any constraints?"}}
  ]
)
\`\`\`

Please call start_session again WITH your prepared questions.`;

const questionsSchema = tool.schema
  .array(
    tool.schema.object({
      type: tool.schema
        .enum(["pick_one", "pick_many", "confirm", "ask_text", "show_options", "review_section", "thumbs", "slider"])
        .describe("Question type"),
      config: tool.schema
        .looseObject({
          question: tool.schema.string().optional(),
          context: tool.schema.string().optional(),
        })
        .describe("Question config (varies by type)"),
    }),
  )
  .describe("REQUIRED: Initial questions to display when browser opens. Must have at least 1.");

function buildStartSession(sessions: SessionStore): OcttoTool {
  return tool({
    description: `Start an interactive octto session with initial questions.
Opens a browser window with questions already displayed - no waiting.
REQUIRED: You MUST provide at least 1 question. Will fail without questions.`,
    args: {
      title: tool.schema.string().optional().describe("Session title (shown in browser)"),
      questions: questionsSchema,
    },
    execute: async (args) => {
      if (!args.questions || args.questions.length === 0) {
        return MISSING_QUESTIONS_ERROR;
      }

      try {
        const result = await sessions.startSession({ title: args.title, questions: args.questions });
        return formatSessionStarted(result);
      } catch (error) {
        return `Failed to start session: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}

function buildEndSession(sessions: SessionStore): OcttoTool {
  return tool({
    description: `End an interactive octto session.
Closes the browser window and cleans up resources.`,
    args: {
      session_id: tool.schema.string().describe("Session ID to end"),
    },
    execute: async (args) => {
      const result = await sessions.endSession(args.session_id);
      if (result.ok) {
        return `Session ${args.session_id} ended successfully.`;
      }
      return `Failed to end session ${args.session_id}. It may not exist.`;
    },
  });
}

export function createSessionTools(sessions: SessionStore): OcttoTools {
  return {
    start_session: buildStartSession(sessions),
    end_session: buildEndSession(sessions),
  };
}
