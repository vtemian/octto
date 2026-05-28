import { tool } from "@opencode-ai/plugin/tool";

import type { BaseConfig, QuestionType, SessionStore } from "@/session";

import type { OcttoTool, OcttoTools } from "./types";

type ArgsSchema = Parameters<typeof tool>[0]["args"];

interface QuestionToolConfig<T> {
  type: QuestionType;
  description: string;
  args: ArgsSchema;
  validate?: (args: T) => string | null;
  toConfig: (args: T) => BaseConfig;
}

type QuestionToolBuilder = <T extends { session_id: string }>(config: QuestionToolConfig<T>) => OcttoTool;

/**
 * Shared config schema for push_question and start_session.
 * All properties are .any().optional() so that looseObject passes them
 * through Zod parsing without stripping fields like options, min, max, etc.
 */
const questionConfigSchema = tool.schema
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
  .describe("Question configuration (varies by type)");

export function createQuestionToolFactory(sessions: SessionStore): QuestionToolBuilder {
  return function createQuestionTool<T extends { session_id: string }>(config: QuestionToolConfig<T>): OcttoTool {
    return tool({
      description: `${config.description}
Returns immediately with question_id. Use get_answer to retrieve response.`,
      args: {
        session_id: tool.schema.string().describe("Session ID from start_session"),
        ...config.args,
      },
      execute: async (args) => {
        // zod schema types from tool() don't carry generic T, so the cast is unavoidable
        const validationError = config.validate?.(args as unknown as T);
        if (validationError) return `Failed: ${validationError}`;

        try {
          const questionConfig = config.toConfig(args as unknown as T);
          const pushed = sessions.pushQuestion(args.session_id, config.type, questionConfig);
          return `Question pushed: ${pushed.question_id}\nUse get_answer("${pushed.question_id}") to retrieve response.`;
        } catch (error: unknown) {
          return `Failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    });
  };
}

export function createPushQuestionTool(sessions: SessionStore): OcttoTools {
  const push_question = tool({
    description: `Push a question to the session queue. This is the generic tool for adding any question type.
The question will appear in the browser for the user to answer.`,
    args: {
      session_id: tool.schema.string().describe("Session ID from start_session"),
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
      config: questionConfigSchema,
    },
    execute: async (args) => {
      try {
        const pushed = sessions.pushQuestion(args.session_id, args.type, args.config);
        return `Question pushed: ${pushed.question_id}\nType: ${args.type}\nUse get_next_answer(session_id, block=true) to wait for the user's response.`;
      } catch (error: unknown) {
        return `Failed to push question: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  return { push_question };
}
