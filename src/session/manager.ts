import type { ServerWebSocket } from "bun";
import type {
  Session,
  Question,
  QuestionType,
  QuestionConfig,
  QuestionStatus,
  WsServerMessage,
  WsClientMessage,
  StartSessionInput,
  StartSessionOutput,
  EndSessionOutput,
  PushQuestionOutput,
  GetAnswerInput,
  GetAnswerOutput,
  GetNextAnswerInput,
  GetNextAnswerOutput,
  ListQuestionsOutput,
} from "./types";
import { openBrowser } from "./browser";
import { createServer } from "./server";

function generateId(prefix: string): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = `${prefix}_`;
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export interface SessionManagerOptions {
  /** Skip opening browser - useful for tests */
  skipBrowser?: boolean;
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private questionToSession: Map<string, string> = new Map();
  private responseWaiters: Map<string, Array<(response: unknown) => void>> = new Map();
  // Session-level waiters for "any answer" - used by getNextAnswer
  private sessionWaiters: Map<string, Array<(questionId: string, response: unknown) => void>> = new Map();
  private options: SessionManagerOptions;

  constructor(options: SessionManagerOptions = {}) {
    this.options = options;
  }

  async startSession(input: StartSessionInput): Promise<StartSessionOutput> {
    const sessionId = generateId("ses");

    // Create server on random port
    const { server, port } = await createServer(sessionId, this);

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

    this.sessions.set(sessionId, session);

    // Add initial questions if provided (before opening browser)
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
        this.questionToSession.set(questionId, sessionId);
        questionIds.push(questionId);
      }
    }

    // Open browser (unless skipped for tests)
    if (!this.options.skipBrowser) {
      await openBrowser(url);
    }

    return {
      session_id: sessionId,
      url,
      question_ids: questionIds.length > 0 ? questionIds : undefined,
    };
  }

  async endSession(sessionId: string): Promise<EndSessionOutput> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false };
    }

    // Send end message to client
    if (session.wsClient) {
      const msg: WsServerMessage = { type: "end" };
      session.wsClient.send(JSON.stringify(msg));
    }

    // Stop server
    if (session.server) {
      session.server.stop();
    }

    // Clean up question mappings
    for (const questionId of session.questions.keys()) {
      this.questionToSession.delete(questionId);
      this.responseWaiters.delete(questionId);
    }

    this.sessions.delete(sessionId);
    return { ok: true };
  }

  pushQuestion(sessionId: string, type: QuestionType, config: QuestionConfig): PushQuestionOutput {
    const session = this.sessions.get(sessionId);
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
    this.questionToSession.set(questionId, sessionId);

    // Send to client if connected
    if (session.wsConnected && session.wsClient) {
      const msg: WsServerMessage = {
        type: "question",
        id: questionId,
        questionType: type,
        config,
      };
      session.wsClient.send(JSON.stringify(msg));
    } else if (!this.options.skipBrowser) {
      // Re-open browser if not connected
      openBrowser(session.url).catch(console.error);
    }

    return { question_id: questionId };
  }

  async getAnswer(input: GetAnswerInput): Promise<GetAnswerOutput> {
    const sessionId = this.questionToSession.get(input.question_id);
    if (!sessionId) {
      return {
        completed: false,
        status: "cancelled",
        reason: "cancelled",
      };
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        completed: false,
        status: "cancelled",
        reason: "cancelled",
      };
    }

    const question = session.questions.get(input.question_id);
    if (!question) {
      return {
        completed: false,
        status: "cancelled",
        reason: "cancelled",
      };
    }

    // Already answered
    if (question.status === "answered") {
      return {
        completed: true,
        status: "answered",
        response: question.response,
      };
    }

    // Already cancelled or timed out
    if (question.status === "cancelled" || question.status === "timeout") {
      return {
        completed: false,
        status: question.status,
        reason: question.status,
      };
    }

    // Non-blocking: return current status
    if (!input.block) {
      return {
        completed: false,
        status: "pending",
        reason: "pending",
      };
    }

    // Blocking: wait for response
    const timeout = input.timeout ?? 300000; // 5 minutes default

    return new Promise<GetAnswerOutput>((resolve) => {
      const timeoutId = setTimeout(() => {
        // Remove waiter
        const waiters = this.responseWaiters.get(input.question_id) || [];
        const idx = waiters.indexOf(waiterCallback);
        if (idx >= 0) waiters.splice(idx, 1);

        question.status = "timeout";
        resolve({
          completed: false,
          status: "timeout",
          reason: "timeout",
        });
      }, timeout);

      const waiterCallback = (response: unknown) => {
        clearTimeout(timeoutId);
        if (response && typeof response === "object" && "cancelled" in response) {
          resolve({
            completed: false,
            status: "cancelled",
            reason: "cancelled",
          });
        } else {
          resolve({
            completed: true,
            status: "answered",
            response,
          });
        }
      };

      // Register waiter
      const waiters = this.responseWaiters.get(input.question_id) || [];
      waiters.push(waiterCallback);
      this.responseWaiters.set(input.question_id, waiters);
    });
  }

  async getNextAnswer(input: GetNextAnswerInput): Promise<GetNextAnswerOutput> {
    const session = this.sessions.get(input.session_id);
    if (!session) {
      return {
        completed: false,
        status: "none_pending",
        reason: "none_pending",
      };
    }

    // Check if any question is answered but not yet retrieved
    for (const question of session.questions.values()) {
      if (question.status === "answered" && !question.retrieved) {
        // Mark as retrieved so we don't return it again
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

    // Check if there are any pending questions (not answered, not cancelled, not timed out)
    const hasPending = Array.from(session.questions.values()).some((q) => q.status === "pending");

    if (!hasPending) {
      return {
        completed: false,
        status: "none_pending",
        reason: "none_pending",
      };
    }

    // Non-blocking: return current status
    if (!input.block) {
      return {
        completed: false,
        status: "pending",
      };
    }

    // Blocking: wait for any response in this session
    const timeout = input.timeout ?? 300000; // 5 minutes default

    return new Promise<GetNextAnswerOutput>((resolve) => {
      const timeoutId = setTimeout(() => {
        // Remove waiter
        const waiters = this.sessionWaiters.get(input.session_id) || [];
        const idx = waiters.indexOf(waiterCallback);
        if (idx >= 0) waiters.splice(idx, 1);

        resolve({
          completed: false,
          status: "timeout",
          reason: "timeout",
        });
      }, timeout);

      const waiterCallback = (questionId: string, response: unknown) => {
        clearTimeout(timeoutId);
        // Remove this waiter
        const waiters = this.sessionWaiters.get(input.session_id) || [];
        const idx = waiters.indexOf(waiterCallback);
        if (idx >= 0) waiters.splice(idx, 1);

        const question = session.questions.get(questionId);
        resolve({
          completed: true,
          question_id: questionId,
          question_type: question?.type,
          status: "answered",
          response,
        });
      };

      // Register session-level waiter
      const waiters = this.sessionWaiters.get(input.session_id) || [];
      waiters.push(waiterCallback);
      this.sessionWaiters.set(input.session_id, waiters);
    });
  }

  cancelQuestion(questionId: string): { ok: boolean } {
    const sessionId = this.questionToSession.get(questionId);
    if (!sessionId) {
      return { ok: false };
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false };
    }

    const question = session.questions.get(questionId);
    if (!question || question.status !== "pending") {
      return { ok: false };
    }

    question.status = "cancelled";

    // Notify client
    if (session.wsClient) {
      const msg: WsServerMessage = { type: "cancel", id: questionId };
      session.wsClient.send(JSON.stringify(msg));
    }

    // Notify waiters
    const waiters = this.responseWaiters.get(questionId) || [];
    for (const waiter of waiters) {
      waiter({ cancelled: true });
    }
    this.responseWaiters.delete(questionId);

    return { ok: true };
  }

  listQuestions(sessionId?: string): ListQuestionsOutput {
    const questions: ListQuestionsOutput["questions"] = [];

    const sessionsToCheck = sessionId
      ? [this.sessions.get(sessionId)].filter(Boolean)
      : Array.from(this.sessions.values());

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

    // Sort by creation time, newest first
    questions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return { questions };
  }

  // Called by WebSocket server when client connects
  handleWsConnect(sessionId: string, ws: ServerWebSocket<unknown>): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.wsConnected = true;
    session.wsClient = ws;

    // Send all pending questions
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
  }

  // Called by WebSocket server when client disconnects
  handleWsDisconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.wsConnected = false;
    session.wsClient = undefined;
  }

  // Called by WebSocket server when client sends a message
  handleWsMessage(sessionId: string, message: WsClientMessage): void {
    if (message.type === "connected") {
      // Already handled in handleWsConnect
      return;
    }

    if (message.type === "response") {
      const session = this.sessions.get(sessionId);
      if (!session) return;

      const question = session.questions.get(message.id);
      if (!question || question.status !== "pending") return;

      question.status = "answered";
      question.answeredAt = new Date();
      question.response = message.answer;

      // Notify question-specific waiters
      const waiters = this.responseWaiters.get(message.id) || [];
      for (const waiter of waiters) {
        waiter(message.answer);
      }

      // Notify session-level waiters (for getNextAnswer)
      const sessionWaiters = this.sessionWaiters.get(sessionId) || [];
      // Only notify the first waiter (others will get subsequent answers)
      if (sessionWaiters.length > 0) {
        const waiter = sessionWaiters.shift()!;
        waiter(message.id, message.answer);
        this.sessionWaiters.set(sessionId, sessionWaiters);
      }
      this.responseWaiters.delete(message.id);
    }
  }

  // Get session by ID (for server to access)
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  // Clean up all sessions (for plugin shutdown)
  async cleanup(): Promise<void> {
    for (const sessionId of this.sessions.keys()) {
      await this.endSession(sessionId);
    }
  }
}
