// src/tools/questions.ts
import { tool } from "@opencode-ai/plugin/tool";

import type { SessionStore } from "@/session";
import type { ConfirmConfig, PickManyConfig, PickOneConfig, RankConfig, RateConfig } from "@/types";

import { createQuestionToolFactory } from "./factory";
import type { OcttoTool, OcttoTools } from "./types";

const OPTIONS_EMPTY_ERROR = "options array must not be empty";
const QUESTION_DESCRIPTION = "Question to display";
const CONTEXT_DESCRIPTION = "Instructions/context";
const DEFAULT_RATE_MIN = 1;
const DEFAULT_RATE_MAX = 5;

const optionsSchema = tool.schema
  .array(
    tool.schema.object({
      id: tool.schema.string().describe("Unique option identifier"),
      label: tool.schema.string().describe("Display label"),
      description: tool.schema.string().optional().describe("Optional description"),
    }),
  )
  .describe("Available options");

function requireOptions(args: { options?: unknown[] }): string | null {
  if (!args.options || args.options.length === 0) return OPTIONS_EMPTY_ERROR;
  return null;
}

type ToolFactory = ReturnType<typeof createQuestionToolFactory>;

function buildPickOne(createTool: ToolFactory): OcttoTool {
  return createTool<PickOneConfig & { session_id: string }>({
    type: "pick_one",
    description: `Ask user to select ONE option from a list.
Response format: { selected: string } where selected is the chosen option id.`,
    args: {
      question: tool.schema.string().describe(QUESTION_DESCRIPTION),
      options: optionsSchema,
      recommended: tool.schema.string().optional().describe("Recommended option id (highlighted)"),
      allowOther: tool.schema.boolean().optional().describe("Allow custom 'other' input"),
    },
    validate: requireOptions,
    toConfig: (args) => ({
      question: args.question,
      options: args.options,
      recommended: args.recommended,
      allowOther: args.allowOther,
    }),
  });
}

function buildPickMany(createTool: ToolFactory): OcttoTool {
  return createTool<PickManyConfig & { session_id: string }>({
    type: "pick_many",
    description: `Ask user to select MULTIPLE options from a list.
Response format: { selected: string[] } where selected is array of chosen option ids.`,
    args: {
      question: tool.schema.string().describe(QUESTION_DESCRIPTION),
      options: optionsSchema,
      recommended: tool.schema.array(tool.schema.string()).optional().describe("Recommended option ids"),
      min: tool.schema.number().optional().describe("Minimum selections required"),
      max: tool.schema.number().optional().describe("Maximum selections allowed"),
      allowOther: tool.schema.boolean().optional().describe("Allow custom 'other' input"),
    },
    validate: (args) => {
      if (!args.options || args.options.length === 0) return OPTIONS_EMPTY_ERROR;
      if (args.min !== undefined && args.max !== undefined && args.min > args.max) {
        return `min (${args.min}) cannot be greater than max (${args.max})`;
      }
      return null;
    },
    toConfig: (args) => ({
      question: args.question,
      options: args.options,
      recommended: args.recommended,
      min: args.min,
      max: args.max,
      allowOther: args.allowOther,
    }),
  });
}

function buildConfirm(createTool: ToolFactory): OcttoTool {
  return createTool<ConfirmConfig & { session_id: string }>({
    type: "confirm",
    description: `Ask user for Yes/No confirmation.
Response format: { choice: "yes" | "no" | "cancel" }`,
    args: {
      question: tool.schema.string().describe(QUESTION_DESCRIPTION),
      context: tool.schema.string().optional().describe("Additional context/details"),
      yesLabel: tool.schema.string().optional().describe("Custom label for yes button"),
      noLabel: tool.schema.string().optional().describe("Custom label for no button"),
      allowCancel: tool.schema.boolean().optional().describe("Show cancel option"),
    },
    toConfig: (args) => ({
      question: args.question,
      context: args.context,
      yesLabel: args.yesLabel,
      noLabel: args.noLabel,
      allowCancel: args.allowCancel,
    }),
  });
}

function buildRank(createTool: ToolFactory): OcttoTool {
  return createTool<RankConfig & { session_id: string }>({
    type: "rank",
    description: `Ask user to rank/order items by dragging.
Response format: { ranked: string[] } where ranked is array of option ids in user's order (first = highest).`,
    args: {
      question: tool.schema.string().describe(QUESTION_DESCRIPTION),
      options: optionsSchema.describe("Items to rank"),
      context: tool.schema.string().optional().describe(CONTEXT_DESCRIPTION),
    },
    validate: requireOptions,
    toConfig: (args) => ({
      question: args.question,
      options: args.options,
      context: args.context,
    }),
  });
}

function buildRate(createTool: ToolFactory): OcttoTool {
  return createTool<RateConfig & { session_id: string }>({
    type: "rate",
    description: `Ask user to rate items on a numeric scale.
Response format: { ratings: Record<string, number> } where key is option id, value is rating.`,
    args: {
      question: tool.schema.string().describe(QUESTION_DESCRIPTION),
      options: optionsSchema.describe("Items to rate"),
      min: tool.schema.number().optional().describe("Minimum rating value (default: 1)"),
      max: tool.schema.number().optional().describe("Maximum rating value (default: 5)"),
      step: tool.schema.number().optional().describe("Rating step (default: 1)"),
    },
    validate: (args) => {
      if (!args.options || args.options.length === 0) return OPTIONS_EMPTY_ERROR;
      const min = args.min ?? DEFAULT_RATE_MIN;
      const max = args.max ?? DEFAULT_RATE_MAX;
      if (min >= max) return `min (${min}) must be less than max (${max})`;
      return null;
    },
    toConfig: (args) => ({
      question: args.question,
      options: args.options,
      min: args.min ?? DEFAULT_RATE_MIN,
      max: args.max ?? DEFAULT_RATE_MAX,
      step: args.step,
    }),
  });
}

export function createQuestionTools(sessions: SessionStore): OcttoTools {
  const createTool = createQuestionToolFactory(sessions);

  return {
    pick_one: buildPickOne(createTool),
    pick_many: buildPickMany(createTool),
    confirm: buildConfirm(createTool),
    rank: buildRank(createTool),
    rate: buildRate(createTool),
    ...createInputTools(sessions),
    ...createPresentationTools(sessions),
    ...createQuickTools(sessions),
  };
}

interface TextConfig {
  session_id: string;
  question: string;
  placeholder?: string;
  context?: string;
  multiline?: boolean;
  minLength?: number;
  maxLength?: number;
}

function buildAskText(createTool: ToolFactory): OcttoTool {
  return createTool<TextConfig>({
    type: "ask_text",
    description: `Ask user for text input (single or multi-line).
Response format: { text: string }`,
    args: {
      question: tool.schema.string().describe(QUESTION_DESCRIPTION),
      placeholder: tool.schema.string().optional().describe("Placeholder text"),
      context: tool.schema.string().optional().describe(CONTEXT_DESCRIPTION),
      multiline: tool.schema.boolean().optional().describe("Multi-line input (default: false)"),
      minLength: tool.schema.number().optional().describe("Minimum text length"),
      maxLength: tool.schema.number().optional().describe("Maximum text length"),
    },
    toConfig: (args) => ({
      question: args.question,
      placeholder: args.placeholder,
      context: args.context,
      multiline: args.multiline,
      minLength: args.minLength,
      maxLength: args.maxLength,
    }),
  });
}

interface ImageConfig {
  session_id: string;
  question: string;
  context?: string;
  multiple?: boolean;
  maxImages?: number;
}

function buildAskImage(createTool: ToolFactory): OcttoTool {
  return createTool<ImageConfig>({
    type: "ask_image",
    description: "Ask user to upload/paste image(s).",
    args: {
      question: tool.schema.string().describe(QUESTION_DESCRIPTION),
      context: tool.schema.string().optional().describe(CONTEXT_DESCRIPTION),
      multiple: tool.schema.boolean().optional().describe("Allow multiple images"),
      maxImages: tool.schema.number().optional().describe("Maximum number of images"),
    },
    toConfig: (args) => ({
      question: args.question,
      context: args.context,
      multiple: args.multiple,
      maxImages: args.maxImages,
    }),
  });
}

interface FileConfig {
  session_id: string;
  question: string;
  context?: string;
  multiple?: boolean;
  maxFiles?: number;
  accept?: string[];
  maxSize?: number;
}

function buildAskFile(createTool: ToolFactory): OcttoTool {
  return createTool<FileConfig>({
    type: "ask_file",
    description: "Ask user to upload file(s).",
    args: {
      question: tool.schema.string().describe(QUESTION_DESCRIPTION),
      context: tool.schema.string().optional().describe(CONTEXT_DESCRIPTION),
      multiple: tool.schema.boolean().optional().describe("Allow multiple files"),
      maxFiles: tool.schema.number().optional().describe("Maximum number of files"),
      accept: tool.schema.array(tool.schema.string()).optional().describe("Allowed file types"),
      maxSize: tool.schema.number().optional().describe("Maximum file size in bytes"),
    },
    toConfig: (args) => ({
      question: args.question,
      context: args.context,
      multiple: args.multiple,
      maxFiles: args.maxFiles,
      accept: args.accept,
      maxSize: args.maxSize,
    }),
  });
}

interface CodeConfig {
  session_id: string;
  question: string;
  context?: string;
  language?: string;
  placeholder?: string;
}

function buildAskCode(createTool: ToolFactory): OcttoTool {
  return createTool<CodeConfig>({
    type: "ask_code",
    description: "Ask user for code input with syntax highlighting.",
    args: {
      question: tool.schema.string().describe(QUESTION_DESCRIPTION),
      context: tool.schema.string().optional().describe(CONTEXT_DESCRIPTION),
      language: tool.schema.string().optional().describe("Programming language for highlighting"),
      placeholder: tool.schema.string().optional().describe("Placeholder code"),
    },
    toConfig: (args) => ({
      question: args.question,
      context: args.context,
      language: args.language,
      placeholder: args.placeholder,
    }),
  });
}

function createInputTools(sessions: SessionStore): OcttoTools {
  const createTool = createQuestionToolFactory(sessions);
  return {
    ask_text: buildAskText(createTool),
    ask_image: buildAskImage(createTool),
    ask_file: buildAskFile(createTool),
    ask_code: buildAskCode(createTool),
  };
}

interface DiffConfig {
  session_id: string;
  question: string;
  before: string;
  after: string;
  filePath?: string;
  language?: string;
}

function buildShowDiff(createTool: ToolFactory): OcttoTool {
  return createTool<DiffConfig>({
    type: "show_diff",
    description: "Show a diff and ask user to approve/reject/edit.",
    args: {
      question: tool.schema.string().describe("Title/description of the change"),
      before: tool.schema.string().describe("Original content"),
      after: tool.schema.string().describe("Modified content"),
      filePath: tool.schema.string().optional().describe("File path for context"),
      language: tool.schema.string().optional().describe("Language for syntax highlighting"),
    },
    toConfig: (args) => ({
      question: args.question,
      before: args.before,
      after: args.after,
      filePath: args.filePath,
      language: args.language,
    }),
  });
}

const sectionSchema = tool.schema.array(
  tool.schema.object({
    id: tool.schema.string().describe("Section identifier"),
    title: tool.schema.string().describe("Section title"),
    content: tool.schema.string().describe("Section content (markdown)"),
  }),
);

interface PlanConfig {
  session_id: string;
  question: string;
  sections?: Array<{ id: string; title: string; content: string }>;
  markdown?: string;
}

function buildShowPlan(createTool: ToolFactory): OcttoTool {
  return createTool<PlanConfig>({
    type: "show_plan",
    description: `Show a plan/document for user review with annotations.
Response format: { approved: boolean, annotations?: Record<sectionId, string> }`,
    args: {
      question: tool.schema.string().describe("Plan title"),
      sections: sectionSchema.optional().describe("Plan sections"),
      markdown: tool.schema.string().optional().describe("Full markdown (alternative to sections)"),
    },
    toConfig: (args) => ({
      question: args.question,
      sections: args.sections || [],
      markdown: args.markdown,
    }),
  });
}

const prosConsOptionSchema = tool.schema.array(
  tool.schema.object({
    id: tool.schema.string().describe("Unique option identifier"),
    label: tool.schema.string().describe("Display label"),
    description: tool.schema.string().optional().describe("Optional description"),
    pros: tool.schema.array(tool.schema.string()).optional().describe("Advantages"),
    cons: tool.schema.array(tool.schema.string()).optional().describe("Disadvantages"),
  }),
);

interface ShowOptionsConfig {
  session_id: string;
  question: string;
  options: Array<{ id: string; label: string; description?: string; pros?: string[]; cons?: string[] }>;
  recommended?: string;
  allowFeedback?: boolean;
}

function buildShowOptions(createTool: ToolFactory): OcttoTool {
  return createTool<ShowOptionsConfig>({
    type: "show_options",
    description: `Show options with pros/cons for user to select.
Response format: { selected: string, feedback?: string } where selected is the chosen option id.`,
    args: {
      question: tool.schema.string().describe(QUESTION_DESCRIPTION),
      options: prosConsOptionSchema.describe("Options with pros/cons"),
      recommended: tool.schema.string().optional().describe("Recommended option id"),
      allowFeedback: tool.schema.boolean().optional().describe("Allow text feedback with selection"),
    },
    validate: (args) => {
      if (!args.options || args.options.length === 0) return OPTIONS_EMPTY_ERROR;
      return null;
    },
    toConfig: (args) => ({
      question: args.question,
      options: args.options,
      recommended: args.recommended,
      allowFeedback: args.allowFeedback,
    }),
  });
}

interface ReviewConfig {
  session_id: string;
  question: string;
  content: string;
  context?: string;
}

function buildReviewSection(createTool: ToolFactory): OcttoTool {
  return createTool<ReviewConfig>({
    type: "review_section",
    description: "Show content section for user review with inline feedback.",
    args: {
      question: tool.schema.string().describe("Section title"),
      content: tool.schema.string().describe("Section content (markdown)"),
      context: tool.schema.string().optional().describe("Context about what to review"),
    },
    toConfig: (args) => ({
      question: args.question,
      content: args.content,
      context: args.context,
    }),
  });
}

function createPresentationTools(sessions: SessionStore): OcttoTools {
  const createTool = createQuestionToolFactory(sessions);
  return {
    show_diff: buildShowDiff(createTool),
    show_plan: buildShowPlan(createTool),
    show_options: buildShowOptions(createTool),
    review_section: buildReviewSection(createTool),
  };
}

interface ThumbsConfig {
  session_id: string;
  question: string;
  context?: string;
}

function buildThumbs(createTool: ToolFactory): OcttoTool {
  return createTool<ThumbsConfig>({
    type: "thumbs",
    description: `Ask user for quick thumbs up/down feedback.
Response format: { choice: "up" | "down" }`,
    args: {
      question: tool.schema.string().describe(QUESTION_DESCRIPTION),
      context: tool.schema.string().optional().describe("Context to show"),
    },
    toConfig: (args) => ({
      question: args.question,
      context: args.context,
    }),
  });
}

interface EmojiConfig {
  session_id: string;
  question: string;
  context?: string;
  emojis?: string[];
}

function buildEmojiReact(createTool: ToolFactory): OcttoTool {
  return createTool<EmojiConfig>({
    type: "emoji_react",
    description: "Ask user to react with an emoji.",
    args: {
      question: tool.schema.string().describe(QUESTION_DESCRIPTION),
      context: tool.schema.string().optional().describe("Context to show"),
      emojis: tool.schema.array(tool.schema.string()).optional().describe("Available emoji options"),
    },
    toConfig: (args) => ({
      question: args.question,
      context: args.context,
      emojis: args.emojis,
    }),
  });
}

interface SliderConfig {
  session_id: string;
  question: string;
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;
  context?: string;
}

function buildSlider(createTool: ToolFactory): OcttoTool {
  return createTool<SliderConfig>({
    type: "slider",
    description: `Ask user to select a value on a numeric slider.
Response format: { value: number }`,
    args: {
      question: tool.schema.string().describe(QUESTION_DESCRIPTION),
      min: tool.schema.number().describe("Minimum value"),
      max: tool.schema.number().describe("Maximum value"),
      step: tool.schema.number().optional().describe("Step size (default: 1)"),
      defaultValue: tool.schema.number().optional().describe("Default value"),
      context: tool.schema.string().optional().describe(CONTEXT_DESCRIPTION),
    },
    validate: (args) => {
      if (args.min >= args.max) return `min (${args.min}) must be less than max (${args.max})`;
      return null;
    },
    toConfig: (args) => ({
      question: args.question,
      min: args.min,
      max: args.max,
      step: args.step,
      defaultValue: args.defaultValue,
      context: args.context,
    }),
  });
}

function createQuickTools(sessions: SessionStore): OcttoTools {
  const createTool = createQuestionToolFactory(sessions);
  return {
    thumbs: buildThumbs(createTool),
    emoji_react: buildEmojiReact(createTool),
    slider: buildSlider(createTool),
  };
}
