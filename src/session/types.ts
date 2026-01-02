// Session and Question types for the brainstormer plugin
import type { ServerWebSocket } from "bun";

export type QuestionStatus = "pending" | "answered" | "cancelled" | "timeout";

export interface Question {
  id: string;
  sessionId: string;
  type: QuestionType;
  config: QuestionConfig;
  status: QuestionStatus;
  createdAt: Date;
  answeredAt?: Date;
  response?: unknown;
}

export type QuestionType =
  | "pick_one"
  | "pick_many"
  | "confirm"
  | "rank"
  | "rate"
  | "ask_text"
  | "ask_image"
  | "ask_file"
  | "ask_code"
  | "show_diff"
  | "show_plan"
  | "show_options"
  | "review_section"
  | "thumbs"
  | "emoji_react"
  | "slider";

export type QuestionConfig =
  | import("../types").PickOneConfig
  | import("../types").PickManyConfig
  | import("../types").ConfirmConfig
  | import("../types").RankConfig
  | import("../types").RateConfig
  | import("../types").AskTextConfig
  | import("../types").AskImageConfig
  | import("../types").AskFileConfig
  | import("../types").AskCodeConfig
  | import("../types").ShowDiffConfig
  | import("../types").ShowPlanConfig
  | import("../types").ShowOptionsConfig
  | import("../types").ReviewSectionConfig
  | import("../types").ThumbsConfig
  | import("../types").EmojiReactConfig
  | import("../types").SliderConfig;

export interface Session {
  id: string;
  title?: string;
  port: number;
  url: string;
  createdAt: Date;
  questions: Map<string, Question>;
  wsConnected: boolean;
  server?: ReturnType<typeof Bun.serve>;
  wsClient?: ServerWebSocket<unknown>;
}

export interface StartSessionInput {
  title?: string;
}

export interface StartSessionOutput {
  session_id: string;
  url: string;
}

export interface EndSessionOutput {
  ok: boolean;
}

export interface PushQuestionOutput {
  question_id: string;
}

export interface GetAnswerInput {
  question_id: string;
  block?: boolean;
  timeout?: number;
}

export interface GetAnswerOutput {
  completed: boolean;
  status: QuestionStatus;
  response?: unknown;
  reason?: "timeout" | "cancelled" | "pending";
}

export interface ListQuestionsOutput {
  questions: Array<{
    id: string;
    type: QuestionType;
    status: QuestionStatus;
    createdAt: string;
    answeredAt?: string;
  }>;
}

// WebSocket message types
export interface WsQuestionMessage {
  type: "question";
  id: string;
  questionType: QuestionType;
  config: QuestionConfig;
}

export interface WsCancelMessage {
  type: "cancel";
  id: string;
}

export interface WsEndMessage {
  type: "end";
}

export interface WsResponseMessage {
  type: "response";
  id: string;
  answer: unknown;
}

export interface WsConnectedMessage {
  type: "connected";
}

export type WsServerMessage = WsQuestionMessage | WsCancelMessage | WsEndMessage;
export type WsClientMessage = WsResponseMessage | WsConnectedMessage;
