// src/tools/session.ts
import { tool } from "@opencode-ai/plugin/tool";
import type { SessionManager } from "../session/manager";
import type { QuestionType, QuestionConfig } from "../session/types";

export function createSessionTools(manager: SessionManager) {
  const start_session = tool({
    description: `Start an interactive brainstormer session with initial questions.
Opens a browser window with questions already displayed - no waiting.
ALWAYS provide your prepared questions here for instant display.`,
    args: {
      title: tool.schema.string().optional().describe("Session title (shown in browser)"),
      questions: tool.schema
        .array(
          tool.schema.object({
            type: tool.schema
              .enum([
                "pick_one",
                "pick_many",
                "confirm",
                "ask_text",
                "show_options",
                "review_section",
                "thumbs",
                "slider",
              ])
              .describe("Question type"),
            config: tool.schema.object({}).passthrough().describe("Question config (varies by type)"),
          }),
        )
        .optional()
        .describe("Initial questions to display immediately when browser opens"),
    },
    execute: async (args) => {
      try {
        const questions = args.questions?.map((q) => ({
          type: q.type as QuestionType,
          config: q.config as unknown as QuestionConfig,
        }));
        const result = await manager.startSession({ title: args.title, questions });

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
      } catch (error) {
        return `Failed to start session: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  const end_session = tool({
    description: `End an interactive brainstormer session.
Closes the browser window and cleans up resources.`,
    args: {
      session_id: tool.schema.string().describe("Session ID to end"),
    },
    execute: async (args) => {
      const result = await manager.endSession(args.session_id);
      if (result.ok) {
        return `Session ${args.session_id} ended successfully.`;
      }
      return `Failed to end session ${args.session_id}. It may not exist.`;
    },
  });

  return { start_session, end_session };
}
