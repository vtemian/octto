import type { ServerWebSocket } from "bun";

import { DEFAULT_ANSWER_TIMEOUT_MS } from "../constants";
import { openBrowser } from "./browser";
import { createServer } from "./server";
import type {
  EndSessionOutput,
  GetAnswerInput,
  GetAnswerOutput,
  GetNextAnswerInput,
  GetNextAnswerOutput,
  ListQuestionsOutput,
  PushQuestionOutput,
  Question,
  QuestionConfig,
  QuestionType,
  Session,
  StartSessionInput,
  StartSessionOutput,
  WsClientMessage,
  WsServerMessage,
} from "./types";
import { createWaiters } from "./waiter";

function generateId(prefix: string): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = `${prefix}_`;
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export interface SessionStoreOptions {
  /** Skip opening browser - useful for tests */
  skipBrowser?: boolean;
}

export interface SessionStore {
  startSession: (input: StartSessionInput) => Promise<StartSessionOutput>;
  endSession: (sessionId: string) => Promise<EndSessionOutput>;
  pushQuestion: (sessionId: string, type: QuestionType, config: QuestionConfig) => PushQuestionOutput;
  getAnswer: (input: GetAnswerInput) => Promise<GetAnswerOutput>;
  getNextAnswer: (input: GetNextAnswerInput) => Promise<GetNextAnswerOutput>;
  cancelQuestion: (questionId: string) => { ok: boolean };
  listQuestions: (sessionId?: string) => ListQuestionsOutput;
  handleWsConnect: (sessionId: string, ws: ServerWebSocket<unknown>) => void;
  handleWsDisconnect: (sessionId: string) => void;
  handleWsMessage: (sessionId: string, message: WsClientMessage) => void;
  getSession: (sessionId: string) => Session | undefined;
  cleanup: () => Promise<void>;
}

export function createSessionStore(options: SessionStoreOptions = {}): SessionStore {
  const sessions = new Map<string, Session>();
  const questionToSession = new Map<string, string>();
  const responseWaiters = createWaiters<string, unknown>();
  const sessionWaiters = createWaiters<string, { questionId: string; response: unknown }>();

  const store: SessionStore = {
    async startSession(input: StartSessionInput): Promise<StartSessionOutput> {
      const sessionId = generateId("ses");

      const { server, port } = await createServer(sessionId, store);
      const url = `http://localhost:${port}`;

      const session: Session = {
        id: sessionId,
        title: input.title,
        port,
        url,
        createdAt: new Date(),
        questions: new Map(),
        wsConnected: false,
        server,
      };

      sessions.set(sessionId, session);

      const questionIds: string[] = [];
      if (input.questions && input.questions.length > 0) {
        for (const q of input.questions) {
          const questionId = generateId("q");
          const question: Question = {
            id: questionId,
            sessionId,
            type: q.type,
            config: q.config,
            status: "pending",
            createdAt: new Date(),
          };
          session.questions.set(questionId, question);
          questionToSession.set(questionId, sessionId);
          questionIds.push(questionId);
        }
      }

      if (!options.skipBrowser) {
        try {
          await openBrowser(url);
        } catch (error) {
          // Clean up on browser open failure
          sessions.delete(sessionId);
          for (const qId of questionIds) {
            questionToSession.delete(qId);
          }
          server.stop();
          throw error;
        }
      }

      return {
        session_id: sessionId,
        url,
        question_ids: questionIds.length > 0 ? questionIds : undefined,
      };
    },

    async endSession(sessionId: string): Promise<EndSessionOutput> {
      const session = sessions.get(sessionId);
      if (!session) {
        return { ok: false };
      }

      if (session.wsClient) {
        const msg: WsServerMessage = { type: "end" };
        session.wsClient.send(JSON.stringify(msg));
      }

      if (session.server) {
        session.server.stop();
      }

      for (const questionId of session.questions.keys()) {
        questionToSession.delete(questionId);
        responseWaiters.clear(questionId);
      }

      sessions.delete(sessionId);
      return { ok: true };
    },

    pushQuestion(sessionId: string, type: QuestionType, config: QuestionConfig): PushQuestionOutput {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const questionId = generateId("q");

      const question: Question = {
        id: questionId,
        sessionId,
        type,
        config,
        status: "pending",
        createdAt: new Date(),
      };

      session.questions.set(questionId, question);
      questionToSession.set(questionId, sessionId);

      if (session.wsConnected && session.wsClient) {
        const msg: WsServerMessage = {
          type: "question",
          id: questionId,
          questionType: type,
          config,
        };
        session.wsClient.send(JSON.stringify(msg));
      } else if (!options.skipBrowser) {
        openBrowser(session.url).catch(console.error);
      }

      return { question_id: questionId };
    },

    async getAnswer(input: GetAnswerInput): Promise<GetAnswerOutput> {
      const sessionId = questionToSession.get(input.question_id);
      if (!sessionId) {
        return { completed: false, status: "cancelled", reason: "cancelled" };
      }

      const session = sessions.get(sessionId);
      if (!session) {
        return { completed: false, status: "cancelled", reason: "cancelled" };
      }

      const question = session.questions.get(input.question_id);
      if (!question) {
        return { completed: false, status: "cancelled", reason: "cancelled" };
      }

      if (question.status === "answered") {
        return { completed: true, status: "answered", response: question.response };
      }

      if (question.status === "cancelled" || question.status === "timeout") {
        return { completed: false, status: question.status, reason: question.status };
      }

      if (!input.block) {
        return { completed: false, status: "pending", reason: "pending" };
      }

      const timeout = input.timeout ?? DEFAULT_ANSWER_TIMEOUT_MS;

      return new Promise<GetAnswerOutput>((resolve) => {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;

        const cleanup = responseWaiters.register(input.question_id, (response) => {
          if (timeoutId) clearTimeout(timeoutId);
          if (response && typeof response === "object" && "cancelled" in response) {
            resolve({ completed: false, status: "cancelled", reason: "cancelled" });
          } else {
            resolve({ completed: true, status: "answered", response });
          }
        });

        timeoutId = setTimeout(() => {
          cleanup();
          question.status = "timeout";
          resolve({ completed: false, status: "timeout", reason: "timeout" });
        }, timeout);
      });
    },

    async getNextAnswer(input: GetNextAnswerInput): Promise<GetNextAnswerOutput> {
      const session = sessions.get(input.session_id);
      if (!session) {
        return { completed: false, status: "none_pending", reason: "none_pending" };
      }

      for (const question of session.questions.values()) {
        if (question.status === "answered" && !question.retrieved) {
          question.retrieved = true;
          return {
            completed: true,
            question_id: question.id,
            question_type: question.type,
            status: "answered",
            response: question.response,
          };
        }
      }

      const hasPending = Array.from(session.questions.values()).some((q) => q.status === "pending");

      if (!hasPending) {
        return { completed: false, status: "none_pending", reason: "none_pending" };
      }

      if (!input.block) {
        return { completed: false, status: "pending" };
      }

      const timeout = input.timeout ?? DEFAULT_ANSWER_TIMEOUT_MS;

      return new Promise<GetNextAnswerOutput>((resolve) => {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;

        const cleanup = sessionWaiters.register(input.session_id, ({ questionId, response }) => {
          if (timeoutId) clearTimeout(timeoutId);
          const question = session.questions.get(questionId);
          if (question) question.retrieved = true;
          resolve({
            completed: true,
            question_id: questionId,
            question_type: question?.type,
            status: "answered",
            response,
          });
        });

        timeoutId = setTimeout(() => {
          cleanup();
          resolve({ completed: false, status: "timeout", reason: "timeout" });
        }, timeout);
      });
    },

    cancelQuestion(questionId: string): { ok: boolean } {
      const sessionId = questionToSession.get(questionId);
      if (!sessionId) {
        return { ok: false };
      }

      const session = sessions.get(sessionId);
      if (!session) {
        return { ok: false };
      }

      const question = session.questions.get(questionId);
      if (!question || question.status !== "pending") {
        return { ok: false };
      }

      question.status = "cancelled";

      if (session.wsClient) {
        const msg: WsServerMessage = { type: "cancel", id: questionId };
        session.wsClient.send(JSON.stringify(msg));
      }

      responseWaiters.notifyAll(questionId, { cancelled: true });

      return { ok: true };
    },

    listQuestions(sessionId?: string): ListQuestionsOutput {
      const questions: ListQuestionsOutput["questions"] = [];

      const sessionsToCheck = sessionId ? [sessions.get(sessionId)].filter(Boolean) : Array.from(sessions.values());

      for (const session of sessionsToCheck) {
        if (!session) continue;
        for (const question of session.questions.values()) {
          questions.push({
            id: question.id,
            type: question.type,
            status: question.status,
            createdAt: question.createdAt.toISOString(),
            answeredAt: question.answeredAt?.toISOString(),
          });
        }
      }

      questions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      return { questions };
    },

    handleWsConnect(sessionId: string, ws: ServerWebSocket<unknown>): void {
      const session = sessions.get(sessionId);
      if (!session) return;

      session.wsConnected = true;
      session.wsClient = ws;

      for (const question of session.questions.values()) {
        if (question.status === "pending") {
          const msg: WsServerMessage = {
            type: "question",
            id: question.id,
            questionType: question.type,
            config: question.config,
          };
          ws.send(JSON.stringify(msg));
        }
      }
    },

    handleWsDisconnect(sessionId: string): void {
      const session = sessions.get(sessionId);
      if (!session) return;

      session.wsConnected = false;
      session.wsClient = undefined;
    },

    handleWsMessage(sessionId: string, message: WsClientMessage): void {
      if (message.type === "connected") {
        return;
      }

      if (message.type === "response") {
        const session = sessions.get(sessionId);
        if (!session) return;

        const question = session.questions.get(message.id);
        if (!question || question.status !== "pending") return;

        question.status = "answered";
        question.answeredAt = new Date();
        question.response = message.answer;

        responseWaiters.notifyAll(message.id, message.answer);
        sessionWaiters.notifyFirst(sessionId, {
          questionId: message.id,
          response: message.answer,
        });
      }
    },

    getSession(sessionId: string): Session | undefined {
      return sessions.get(sessionId);
    },

    async cleanup(): Promise<void> {
      for (const sessionId of sessions.keys()) {
        await store.endSession(sessionId);
      }
    },
  };

  return store;
}
