// tests/session/sessions.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { createSessionStore, type SessionStore } from "../../src/session/sessions";

describe("createSessionStore", () => {
  let sessions: SessionStore;

  beforeEach(() => {
    sessions = createSessionStore({ skipBrowser: true });
  });

  afterEach(async () => {
    await sessions.cleanup();
  });

  describe("startSession", () => {
    it("should create a session with unique ID", async () => {
      const result = await sessions.startSession({ title: "Test Session" });

      expect(result.session_id).toMatch(/^ses_[a-z0-9]{8}$/);
      expect(result.url).toMatch(/^http:\/\/localhost:\d+\/\?token=[a-f0-9]{48}$/);
    });

    it("should create multiple sessions with different IDs", async () => {
      const result1 = await sessions.startSession({});
      const result2 = await sessions.startSession({});

      expect(result1.session_id).not.toBe(result2.session_id);
      expect(result1.url).not.toBe(result2.url);
    });

    it("should use configured port when provided", async () => {
      const fixedPortSessions = createSessionStore({ skipBrowser: true, port: 9876 });
      try {
        const result = await fixedPortSessions.startSession({ title: "Fixed Port Session" });
        expect(result.url).toMatch(/^http:\/\/localhost:9876\/\?token=[a-f0-9]{48}$/);
      } finally {
        await fixedPortSessions.cleanup();
      }
    });

    it("should use random port when port is 0", async () => {
      const randomPortSessions = createSessionStore({ skipBrowser: true, port: 0 });
      try {
        const result = await randomPortSessions.startSession({});
        expect(result.url).toMatch(/^http:\/\/localhost:\d+\/\?token=[a-f0-9]{48}$/);
        // Port should be assigned (not 0)
        const port = Number(new URL(result.url).port);
        expect(port).toBeGreaterThan(0);
      } finally {
        await randomPortSessions.cleanup();
      }
    });
  });

  describe("endSession", () => {
    it("should end an existing session", async () => {
      const { session_id } = await sessions.startSession({});

      const result = await sessions.endSession(session_id);

      expect(result.ok).toBe(true);
    });

    it("should return ok=false for non-existent session", async () => {
      const result = await sessions.endSession("ses_nonexistent");

      expect(result.ok).toBe(false);
    });
  });

  describe("pushQuestion", () => {
    it("should push a question and return question ID", async () => {
      const { session_id } = await sessions.startSession({});

      const result = sessions.pushQuestion(session_id, "pick_one", {
        question: "Test question",
        options: [{ id: "a", label: "Option A" }],
      });

      expect(result.question_id).toMatch(/^q_[a-z0-9]{8}$/);
    });

    it("should throw for non-existent session", async () => {
      expect(() => {
        sessions.pushQuestion("ses_nonexistent", "pick_one", {
          question: "Test",
          options: [],
        });
      }).toThrow("Session not found");
    });
  });

  describe("getAnswer", () => {
    it("should return pending status for unanswered question", async () => {
      const { session_id } = await sessions.startSession({});
      const { question_id } = sessions.pushQuestion(session_id, "confirm", {
        question: "Test?",
      });

      const result = await sessions.getAnswer({ question_id, block: false });

      expect(result.completed).toBe(false);
      expect(result.status).toBe("pending");
    });

    it("should return cancelled status for non-existent question", async () => {
      const result = await sessions.getAnswer({ question_id: "q_nonexistent", block: false });

      expect(result.completed).toBe(false);
      expect(result.status).toBe("cancelled");
    });
  });

  describe("cancelQuestion", () => {
    it("should cancel a pending question", async () => {
      const { session_id } = await sessions.startSession({});
      const { question_id } = sessions.pushQuestion(session_id, "confirm", {
        question: "Test?",
      });

      const result = sessions.cancelQuestion(question_id);

      expect(result.ok).toBe(true);
    });

    it("should return ok=false for non-existent question", () => {
      const result = sessions.cancelQuestion("q_nonexistent");

      expect(result.ok).toBe(false);
    });
  });

  describe("listQuestions", () => {
    it("should list all questions across sessions", async () => {
      const { session_id } = await sessions.startSession({});
      sessions.pushQuestion(session_id, "confirm", { question: "Q1?" });
      sessions.pushQuestion(session_id, "pick_one", { question: "Q2?", options: [] });

      const result = sessions.listQuestions();

      expect(result.questions.length).toBe(2);
    });

    it("should filter by session ID", async () => {
      const { session_id: s1 } = await sessions.startSession({});
      const { session_id: s2 } = await sessions.startSession({});
      sessions.pushQuestion(s1, "confirm", { question: "Q1?" });
      sessions.pushQuestion(s2, "confirm", { question: "Q2?" });

      const result = sessions.listQuestions(s1);

      expect(result.questions.length).toBe(1);
    });
  });

  describe("getNextAnswer", () => {
    it("should timeout when blocking with no answers", async () => {
      const { session_id } = await sessions.startSession({});
      sessions.pushQuestion(session_id, "confirm", { question: "Test?" });

      const startTime = Date.now();
      const result = await sessions.getNextAnswer({ session_id, block: true, timeout: 100 });
      const elapsed = Date.now() - startTime;

      expect(result.completed).toBe(false);
      expect(result.status).toBe("timeout");
      expect(elapsed).toBeGreaterThanOrEqual(100);
    });
  });

  describe("WebSocket lifecycle", () => {
    const mockWs = { send: () => {} } as any;

    describe("handleWsConnect", () => {
      it("should mark session as connected", async () => {
        const { session_id } = await sessions.startSession({});

        // The session starts disconnected
        const sessionBefore = sessions.getSession(session_id);
        expect(sessionBefore?.wsConnected).toBe(false);

        // Simulate WebSocket connection
        sessions.handleWsConnect(session_id, mockWs);

        const sessionAfter = sessions.getSession(session_id);
        expect(sessionAfter?.wsConnected).toBe(true);
      });
    });

    describe("handleWsDisconnect", () => {
      it("should mark session as disconnected", async () => {
        const { session_id } = await sessions.startSession({});

        // Connect first
        sessions.handleWsConnect(session_id, mockWs);
        expect(sessions.getSession(session_id)?.wsConnected).toBe(true);

        // Then disconnect
        sessions.handleWsDisconnect(session_id);
        expect(sessions.getSession(session_id)?.wsConnected).toBe(false);
      });
    });

    describe("concurrent waiters", () => {
      it("should handle multiple waiters for same question", async () => {
        const { session_id } = await sessions.startSession({});
        const { question_id } = sessions.pushQuestion(session_id, "confirm", {
          question: "Test?",
        });

        // Start two concurrent waits
        const wait1 = sessions.getAnswer({
          question_id,
          block: true,
          timeout: 1000,
        });
        const wait2 = sessions.getAnswer({
          question_id,
          block: true,
          timeout: 1000,
        });

        // Simulate answer via WebSocket message
        sessions.handleWsMessage(session_id, {
          type: "response",
          id: question_id,
          answer: { choice: "yes" },
        });

        // Both should resolve
        const [result1, result2] = await Promise.all([wait1, wait2]);

        expect(result1.completed).toBe(true);
        expect(result2.completed).toBe(true);
        expect(result1.response).toEqual({ choice: "yes" });
        expect(result2.response).toEqual({ choice: "yes" });
      });

      it("should handle multiple session waiters correctly", async () => {
        const { session_id } = await sessions.startSession({});
        const { question_id: q1_id } = sessions.pushQuestion(session_id, "confirm", { question: "Q1?" });
        const { question_id: q2_id } = sessions.pushQuestion(session_id, "confirm", { question: "Q2?" });

        // Start two concurrent session-level waits
        const wait1 = sessions.getNextAnswer({
          session_id,
          block: true,
          timeout: 1000,
        });
        const wait2 = sessions.getNextAnswer({
          session_id,
          block: true,
          timeout: 1000,
        });

        // Submit first answer
        sessions.handleWsMessage(session_id, {
          type: "response",
          id: q1_id,
          answer: { choice: "yes" },
        });

        // First waiter should get first answer
        const result1 = await wait1;
        expect(result1.completed).toBe(true);
        expect(result1.question_id).toBe(q1_id);

        // Submit second answer
        sessions.handleWsMessage(session_id, {
          type: "response",
          id: q2_id,
          answer: { choice: "no" },
        });

        // Second waiter should get second answer
        const result2 = await wait2;
        expect(result2.completed).toBe(true);
        expect(result2.question_id).toBe(q2_id);
      });
    });

    describe("freetext answers", () => {
      it("should deliver the other freetext of a pick_one answer to a blocked caller", async () => {
        const { session_id } = await sessions.startSession({});
        const { question_id } = sessions.pushQuestion(session_id, "pick_one", {
          question: "Which datastore?",
          options: [{ id: "redis", label: "Redis" }],
          allowOther: true,
        });

        const wait = sessions.getAnswer({ question_id, block: true, timeout: 1000 });
        sessions.handleWsMessage(session_id, {
          type: "response",
          id: question_id,
          answer: { selected: "other", other: "SQLite with Litestream" },
        });

        const result = await wait;
        expect(result.completed).toBe(true);
        expect(result.response).toEqual({ selected: "other", other: "SQLite with Litestream" });
      });

      it("should deliver a pick_many answer mixing option ids with other freetext", async () => {
        const { session_id } = await sessions.startSession({});
        const { question_id } = sessions.pushQuestion(session_id, "pick_many", {
          question: "Which caches?",
          options: [{ id: "redis", label: "Redis" }],
          allowOther: true,
        });

        const wait = sessions.getAnswer({ question_id, block: true, timeout: 1000 });
        sessions.handleWsMessage(session_id, {
          type: "response",
          id: question_id,
          answer: { selected: ["redis", "other"], other: "Dragonfly" },
        });

        const result = await wait;
        expect(result.response).toEqual({ selected: ["redis", "other"], other: "Dragonfly" });
      });
    });
  });
});
