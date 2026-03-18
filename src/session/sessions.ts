import type { ServerWebSocket } from "bun";

import { DEFAULT_ANSWER_TIMEOUT_MS } from "@/constants";
import { generateQuestionId, generateSessionId } from "@/tools/utils";

import { openBrowser } from "./browser";
import { createServer } from "./server";
import {
  type Answer,
  type BaseConfig,
  type EndSessionOutput,
  type GetAnswerInput,
  type GetAnswerOutput,
  type GetNextAnswerInput,
  type GetNextAnswerOutput,
  type ListQuestionsOutput,
  type PushQuestionOutput,
  type Question,
  type QuestionType,
  type Session,
  STATUSES,
  type StartSessionInput,
  type StartSessionOutput,
  WS_MESSAGES,
  type WsClientMessage,
  type WsServerMessage,
} from "./types";
import { createWaiters } from "./waiter";

export interface SessionStoreOptions {
  readonly skipBrowser?: boolean;
  readonly port?: number;
}

export interface SessionStore {
  startSession: (input: StartSessionInput) => Promise<StartSessionOutput>;
  endSession: (sessionId: string) => Promise<EndSessionOutput>;
  pushQuestion: (sessionId: string, type: QuestionType, config: BaseConfig) => PushQuestionOutput;
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

interface StoreState {
  readonly sessions: Map<string, Session>;
  readonly questionToSession: Map<string, string>;
  readonly responseWaiters: ReturnType<typeof createWaiters<string, Answer | { cancelled: true }>>;
  readonly sessionWaiters: ReturnType<typeof createWaiters<string, { questionId: string; response: Answer }>>;
  readonly options: SessionStoreOptions;
}

function addQuestionsToSession(
  session: Session,
  questions: StartSessionInput["questions"],
  questionToSession: Map<string, string>,
): string[] {
  return (questions ?? []).map((q) => {
    const questionId = generateQuestionId();
    const question: Question = {
      id: questionId,
      sessionId: session.id,
      type: q.type,
      config: q.config,
      status: STATUSES.PENDING,
      createdAt: new Date(),
    };
    session.questions.set(questionId, question);
    questionToSession.set(questionId, session.id);
    return questionId;
  });
}

async function startSession(
  state: StoreState,
  store: SessionStore,
  input: StartSessionInput,
): Promise<StartSessionOutput> {
  const sessionId = generateSessionId();
  const { server, port } = await createServer(sessionId, store, state.options.port);
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
  state.sessions.set(sessionId, session);

  const questionIds = addQuestionsToSession(session, input.questions, state.questionToSession);

  if (!state.options.skipBrowser) {
    await openBrowser(url).catch((error: unknown) => {
      state.sessions.delete(sessionId);
      for (const qId of questionIds) state.questionToSession.delete(qId);
      void server.stop();
      throw error;
    });
  }

  return {
    session_id: sessionId,
    url,
    question_ids: questionIds.length > 0 ? questionIds : undefined,
  };
}

async function endSession(state: StoreState, sessionId: string): Promise<EndSessionOutput> {
  const session = state.sessions.get(sessionId);
  if (!session) {
    return { ok: false };
  }

  if (session.wsClient) {
    const msg: WsServerMessage = { type: WS_MESSAGES.END };
    session.wsClient.send(JSON.stringify(msg));
  }

  if (session.server) {
    await session.server.stop();
  }

  for (const questionId of session.questions.keys()) {
    state.questionToSession.delete(questionId);
    state.responseWaiters.clear(questionId);
  }

  state.sessions.delete(sessionId);
  return { ok: true };
}

function pushQuestion(
  state: StoreState,
  sessionId: string,
  type: QuestionType,
  config: BaseConfig,
): PushQuestionOutput {
  const session = state.sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const questionId = generateQuestionId();

  const question: Question = {
    id: questionId,
    sessionId,
    type,
    config,
    status: STATUSES.PENDING,
    createdAt: new Date(),
  };

  session.questions.set(questionId, question);
  state.questionToSession.set(questionId, sessionId);

  if (session.wsConnected && session.wsClient) {
    const msg: WsServerMessage = {
      type: WS_MESSAGES.QUESTION,
      id: questionId,
      questionType: type,
      config,
    };
    session.wsClient.send(JSON.stringify(msg));
  } else if (!state.options.skipBrowser) {
    void openBrowser(session.url).catch(console.error);
  }

  return { question_id: questionId };
}

function resolveExistingAnswer(state: StoreState, questionId: string): GetAnswerOutput | undefined {
  const sessionId = state.questionToSession.get(questionId);
  if (!sessionId) {
    return { completed: false, status: STATUSES.CANCELLED, reason: STATUSES.CANCELLED };
  }

  const session = state.sessions.get(sessionId);
  if (!session) {
    return { completed: false, status: STATUSES.CANCELLED, reason: STATUSES.CANCELLED };
  }

  const question = session.questions.get(questionId);
  if (!question) {
    return { completed: false, status: STATUSES.CANCELLED, reason: STATUSES.CANCELLED };
  }

  if (question.status === STATUSES.ANSWERED) {
    return { completed: true, status: STATUSES.ANSWERED, response: question.response };
  }

  if (question.status === STATUSES.CANCELLED || question.status === STATUSES.TIMEOUT) {
    return { completed: false, status: question.status, reason: question.status };
  }

  return undefined;
}

function waitForAnswer(state: StoreState, input: GetAnswerInput, question: Question): Promise<GetAnswerOutput> {
  const timeout = input.timeout ?? DEFAULT_ANSWER_TIMEOUT_MS;

  return new Promise<GetAnswerOutput>((resolve) => {
    const cleanup = state.responseWaiters.register(input.question_id, (response) => {
      clearTimeout(timeoutId);
      if (response && typeof response === "object" && "cancelled" in response) {
        resolve({ completed: false, status: STATUSES.CANCELLED, reason: STATUSES.CANCELLED });
      } else {
        resolve({ completed: true, status: STATUSES.ANSWERED, response });
      }
    });

    const timeoutId = setTimeout(() => {
      cleanup();
      question.status = STATUSES.TIMEOUT;
      resolve({ completed: false, status: STATUSES.TIMEOUT, reason: STATUSES.TIMEOUT });
    }, timeout);
  });
}

async function getAnswer(state: StoreState, input: GetAnswerInput): Promise<GetAnswerOutput> {
  const existing = resolveExistingAnswer(state, input.question_id);
  if (existing) return existing;

  if (!input.block) {
    return { completed: false, status: STATUSES.PENDING, reason: STATUSES.PENDING };
  }

  const sessionId = state.questionToSession.get(input.question_id);
  const session = sessionId ? state.sessions.get(sessionId) : undefined;
  const question = session?.questions.get(input.question_id);
  if (!sessionId || !session || !question) {
    return { completed: false, status: STATUSES.CANCELLED, reason: STATUSES.CANCELLED };
  }
  return waitForAnswer(state, input, question);
}

function findUnretrievedAnswer(session: Session): GetNextAnswerOutput | undefined {
  for (const question of session.questions.values()) {
    if (question.status === STATUSES.ANSWERED && !question.retrieved) {
      question.retrieved = true;
      return {
        completed: true,
        question_id: question.id,
        question_type: question.type,
        status: STATUSES.ANSWERED,
        response: question.response,
      };
    }
  }
  return undefined;
}

function waitForNextAnswer(
  state: StoreState,
  session: Session,
  input: GetNextAnswerInput,
): Promise<GetNextAnswerOutput> {
  const timeout = input.timeout ?? DEFAULT_ANSWER_TIMEOUT_MS;

  return new Promise<GetNextAnswerOutput>((resolve) => {
    const cleanup = state.sessionWaiters.register(input.session_id, ({ questionId, response }) => {
      clearTimeout(timeoutId);
      const question = session.questions.get(questionId);
      if (question) question.retrieved = true;
      resolve({
        completed: true,
        question_id: questionId,
        question_type: question?.type,
        status: STATUSES.ANSWERED,
        response,
      });
    });

    const timeoutId = setTimeout(() => {
      cleanup();
      resolve({ completed: false, status: STATUSES.TIMEOUT, reason: STATUSES.TIMEOUT });
    }, timeout);
  });
}

async function getNextAnswer(state: StoreState, input: GetNextAnswerInput): Promise<GetNextAnswerOutput> {
  const session = state.sessions.get(input.session_id);
  if (!session) {
    return { completed: false, status: STATUSES.NONE_PENDING, reason: STATUSES.NONE_PENDING };
  }

  const unretrieved = findUnretrievedAnswer(session);
  if (unretrieved) return unretrieved;

  const hasPending = Array.from(session.questions.values()).some((q) => q.status === STATUSES.PENDING);

  if (!hasPending) {
    return { completed: false, status: STATUSES.NONE_PENDING, reason: STATUSES.NONE_PENDING };
  }

  if (!input.block) {
    return { completed: false, status: STATUSES.PENDING };
  }

  return waitForNextAnswer(state, session, input);
}

function cancelQuestion(state: StoreState, questionId: string): { ok: boolean } {
  const sessionId = state.questionToSession.get(questionId);
  if (!sessionId) return { ok: false };

  const session = state.sessions.get(sessionId);
  if (!session) return { ok: false };

  const question = session.questions.get(questionId);
  if (!question || question.status !== STATUSES.PENDING) return { ok: false };

  question.status = STATUSES.CANCELLED;

  if (session.wsClient) {
    const msg: WsServerMessage = { type: WS_MESSAGES.CANCEL, id: questionId };
    session.wsClient.send(JSON.stringify(msg));
  }

  state.responseWaiters.notifyAll(questionId, { cancelled: true });

  return { ok: true };
}

function listQuestions(state: StoreState, sessionId?: string): ListQuestionsOutput {
  const questions: ListQuestionsOutput["questions"] = [];

  const sessionsToCheck = sessionId
    ? [state.sessions.get(sessionId)].filter(Boolean)
    : Array.from(state.sessions.values());

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
}

function handleWsConnect(state: StoreState, sessionId: string, ws: ServerWebSocket<unknown>): void {
  const session = state.sessions.get(sessionId);
  if (!session) return;

  session.wsConnected = true;
  session.wsClient = ws;

  for (const question of session.questions.values()) {
    if (question.status === STATUSES.PENDING) {
      const msg: WsServerMessage = {
        type: WS_MESSAGES.QUESTION,
        id: question.id,
        questionType: question.type,
        config: question.config,
      };
      ws.send(JSON.stringify(msg));
    }
  }
}

function handleWsDisconnect(state: StoreState, sessionId: string): void {
  const session = state.sessions.get(sessionId);
  if (!session) return;

  session.wsConnected = false;
  session.wsClient = undefined;
}

function handleWsMessage(state: StoreState, sessionId: string, message: WsClientMessage): void {
  if (message.type === WS_MESSAGES.CONNECTED) return;

  if (message.type !== WS_MESSAGES.RESPONSE) return;

  const session = state.sessions.get(sessionId);
  if (!session) return;

  const question = session.questions.get(message.id);
  if (!question || question.status !== STATUSES.PENDING) return;

  question.status = STATUSES.ANSWERED;
  question.answeredAt = new Date();
  question.response = message.answer;

  state.responseWaiters.notifyAll(message.id, message.answer);
  state.sessionWaiters.notifyFirst(sessionId, {
    questionId: message.id,
    response: message.answer,
  });
}

export function createSessionStore(options: SessionStoreOptions = {}): SessionStore {
  const state: StoreState = {
    sessions: new Map(),
    questionToSession: new Map(),
    responseWaiters: createWaiters(),
    sessionWaiters: createWaiters(),
    options,
  };

  const store: SessionStore = {
    startSession: (input) => startSession(state, store, input),
    endSession: (sessionId) => endSession(state, sessionId),
    pushQuestion: (sessionId, type, config) => pushQuestion(state, sessionId, type, config),
    getAnswer: (input) => getAnswer(state, input),
    getNextAnswer: (input) => getNextAnswer(state, input),
    cancelQuestion: (questionId) => cancelQuestion(state, questionId),
    listQuestions: (sessionId) => listQuestions(state, sessionId),
    handleWsConnect: (sessionId, ws) => handleWsConnect(state, sessionId, ws),
    handleWsDisconnect: (sessionId) => handleWsDisconnect(state, sessionId),
    handleWsMessage: (sessionId, message) => handleWsMessage(state, sessionId, message),
    getSession: (sessionId) => state.sessions.get(sessionId),
    cleanup: async () => {
      for (const sessionId of state.sessions.keys()) {
        await store.endSession(sessionId);
      }
    },
  };

  return store;
}
