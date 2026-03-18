export interface BaseConfig {
  title?: string;
  /** Timeout in seconds (0 = no timeout) */
  timeout?: number;
  theme?: "light" | "dark" | "auto";
}

export interface Option {
  id: string;
  label: string;
  description?: string;
}

export interface OptionWithPros extends Option {
  pros?: string[];
  cons?: string[];
}

export interface RatedOption extends Option {
  /** Filled after response */
  rating?: number;
}

export interface RankedOption extends Option {
  /** Filled after response */
  rank?: number;
}

export interface PickOneConfig extends BaseConfig {
  question: string;
  options: Option[];
  recommended?: string;
  allowOther?: boolean;
}

export interface PickManyConfig extends BaseConfig {
  question: string;
  options: Option[];
  recommended?: string[];
  min?: number;
  max?: number;
  allowOther?: boolean;
}

export interface ConfirmConfig extends BaseConfig {
  question: string;
  context?: string;
  yesLabel?: string;
  noLabel?: string;
  allowCancel?: boolean;
}

export interface RankConfig extends BaseConfig {
  question: string;
  options: Option[];
  context?: string;
}

export interface RateConfig extends BaseConfig {
  question: string;
  options: Option[];
  min?: number;
  max?: number;
  /** Default: 1 */
  step?: number;
  labels?: { min?: string; max?: string };
}

export interface AskTextConfig extends BaseConfig {
  question: string;
  placeholder?: string;
  context?: string;
  multiline?: boolean;
  minLength?: number;
  maxLength?: number;
}

export interface AskImageConfig extends BaseConfig {
  question: string;
  context?: string;
  multiple?: boolean;
  maxImages?: number;
  accept?: string[];
}

export interface AskFileConfig extends BaseConfig {
  question: string;
  context?: string;
  multiple?: boolean;
  maxFiles?: number;
  accept?: string[];
  /** In bytes */
  maxSize?: number;
}

export interface AskCodeConfig extends BaseConfig {
  question: string;
  context?: string;
  /** For syntax highlighting */
  language?: string;
  placeholder?: string;
}

export interface ShowDiffConfig extends BaseConfig {
  question: string;
  before: string;
  after: string;
  filePath?: string;
  /** For syntax highlighting */
  language?: string;
}

export interface PlanSection {
  id: string;
  title: string;
  /** Markdown content */
  content: string;
}

export interface ShowPlanConfig extends BaseConfig {
  question: string;
  sections: PlanSection[];
  /** Alternative to sections */
  markdown?: string;
}

export interface ShowOptionsConfig extends BaseConfig {
  question: string;
  options: OptionWithPros[];
  recommended?: string;
  allowFeedback?: boolean;
}

export interface ReviewSectionConfig extends BaseConfig {
  question: string;
  /** Markdown content */
  content: string;
  context?: string;
}

export interface ThumbsConfig extends BaseConfig {
  question: string;
  context?: string;
}

export interface EmojiReactConfig extends BaseConfig {
  question: string;
  context?: string;
  /** Default: common set */
  emojis?: string[];
}

export interface SliderConfig extends BaseConfig {
  question: string;
  context?: string;
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;
  labels?: { min?: string; max?: string; mid?: string };
}

export interface BaseResponse {
  completed: boolean;
  cancelReason?: "timeout" | "cancelled" | "closed";
}

export interface PickOneResponse extends BaseResponse {
  selected?: string;
  other?: string;
}

export interface PickManyResponse extends BaseResponse {
  selected: string[];
  other?: string[];
}

export interface ConfirmResponse extends BaseResponse {
  choice?: "yes" | "no" | "cancel";
}

export interface RankResponse extends BaseResponse {
  /** First = highest */
  ranking: string[];
}

export interface RateResponse extends BaseResponse {
  ratings: Record<string, number>;
}

export interface AskTextResponse extends BaseResponse {
  text?: string;
}

export interface AskImageResponse extends BaseResponse {
  images: Array<{
    filename: string;
    mimeType: string;
    /** Base64 encoded */
    content: string;
  }>;
  /** Alternative to upload */
  paths?: string[];
}

export interface AskFileResponse extends BaseResponse {
  files: Array<{
    filename: string;
    mimeType: string;
    /** Base64 encoded */
    content: string;
  }>;
  /** Alternative to upload */
  paths?: string[];
}

export interface AskCodeResponse extends BaseResponse {
  code?: string;
  language?: string;
}

export interface ShowDiffResponse extends BaseResponse {
  decision?: "approve" | "reject" | "edit";
  /** Populated when decision is "edit" */
  edited?: string;
  feedback?: string;
}

export interface Annotation {
  id: string;
  /** Section id or line range */
  target: string;
  type: "comment" | "suggest" | "delete" | "approve";
  content?: string;
}

export interface ShowPlanResponse extends BaseResponse {
  decision?: "approve" | "reject" | "revise";
  annotations: Annotation[];
  feedback?: string;
}

export interface ShowOptionsResponse extends BaseResponse {
  selected?: string;
  feedback?: string;
}

export interface ReviewSectionResponse extends BaseResponse {
  decision?: "approve" | "revise";
  feedback?: string;
}

export interface ThumbsResponse extends BaseResponse {
  choice?: "up" | "down";
}

export interface EmojiReactResponse extends BaseResponse {
  emoji?: string;
}

export interface SliderResponse extends BaseResponse {
  value?: number;
}
