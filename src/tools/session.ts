import { tool } from "@opencode-ai/plugin/tool";

import type { SessionStore } from "@/session";

import type { OcttoTool, OcttoTools } from "./types";

function formatSessionStarted(session: { session_id: string; url: string; question_ids?: string[] }): string {
  let output = `## Session Started

| Field | Value |
|-------|-------|
| Session ID | ${session.session_id} |
| URL | ${session.url} |
`;

  if (session.question_ids && session.question_ids.length > 0) {
    output += `| Questions | ${session.question_ids.length} loaded |\n\n`;
    output += `**Question IDs:** ${session.question_ids.join(", ")}\n\n`;
    output += `Browser opened with ${session.question_ids.length} questions ready.\n`;
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
        .enum([
          "pick_one",
          "pick_many",
          "confirm",
          "ask_text",
          "ask_image",
          "ask_file",
          "ask_code",
          "show_options",
          "show_diff",
          "show_plan",
          "review_section",
          "thumbs",
          "emoji_react",
          "slider",
          "rank",
          "rate",
        ])
        .describe("Question type"),
      config: tool.schema
        .looseObject({
          question: tool.schema.string().optional(),
          context: tool.schema.string().optional(),
          options: tool.schema.any().optional(),
          min: tool.schema.any().optional(),
          max: tool.schema.any().optional(),
          step: tool.schema.any().optional(),
          recommended: tool.schema.any().optional(),
          allowOther: tool.schema.any().optional(),
          allowFeedback: tool.schema.any().optional(),
          allowCancel: tool.schema.any().optional(),
          defaultValue: tool.schema.any().optional(),
          labels: tool.schema.any().optional(),
          emojis: tool.schema.any().optional(),
          yesLabel: tool.schema.any().optional(),
          noLabel: tool.schema.any().optional(),
          before: tool.schema.any().optional(),
          after: tool.schema.any().optional(),
          filePath: tool.schema.any().optional(),
          language: tool.schema.any().optional(),
          content: tool.schema.any().optional(),
          sections: tool.schema.any().optional(),
          markdown: tool.schema.any().optional(),
          placeholder: tool.schema.any().optional(),
          multiline: tool.schema.any().optional(),
          minLength: tool.schema.any().optional(),
          maxLength: tool.schema.any().optional(),
          accept: tool.schema.any().optional(),
          multiple: tool.schema.any().optional(),
          maxImages: tool.schema.any().optional(),
          maxFiles: tool.schema.any().optional(),
          maxSize: tool.schema.any().optional(),
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
        const session = await sessions.startSession({ title: args.title, questions: args.questions });
        return formatSessionStarted(session);
      } catch (error: unknown) {
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
      const ended = await sessions.endSession(args.session_id);
      if (ended.ok) {
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
