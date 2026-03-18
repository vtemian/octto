// tests/tools/responses.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { createSessionStore, type SessionStore } from "../../src/session/sessions";
import { createResponseTools } from "../../src/tools/responses";

describe("Response Tools", () => {
  let sessions: SessionStore;
  let tools: ReturnType<typeof createResponseTools>;

  beforeEach(() => {
    sessions = createSessionStore({ skipBrowser: true });
    tools = createResponseTools(sessions);
  });

  afterEach(async () => {
    await sessions.cleanup();
  });

  describe("get_answer", () => {
    it("should return formatted markdown for a completed answer", async () => {
      const { session_id } = await sessions.startSession({ title: "Test" });
      const { question_id } = sessions.pushQuestion(session_id, "confirm", {
        question: "Approve?",
      });

      // Simulate user answering
      sessions.handleWsMessage(session_id, {
        type: "response",
        id: question_id,
        answer: { choice: "yes" },
      });

      const result = await tools.get_answer.execute({ question_id, block: false }, {} as any);

      expect(result).toContain("Answer Received");
      expect(result).toContain("answered");
      expect(result).toContain('"choice": "yes"');
    });

    it("should return waiting message for a pending answer", async () => {
      const { session_id } = await sessions.startSession({ title: "Test" });
      const { question_id } = sessions.pushQuestion(session_id, "confirm", {
        question: "Approve?",
      });

      const result = await tools.get_answer.execute({ question_id, block: false }, {} as any);

      expect(result).toContain("Waiting for Answer");
      expect(result).toContain("pending");
      expect(result).toContain("block=true");
    });
  });

  describe("get_next_answer", () => {
    it("should return formatted answer when one is available", async () => {
      const { session_id } = await sessions.startSession({ title: "Test" });
      const { question_id } = sessions.pushQuestion(session_id, "confirm", {
        question: "Ready?",
      });

      sessions.handleWsMessage(session_id, {
        type: "response",
        id: question_id,
        answer: { choice: "no" },
      });

      const result = await tools.get_next_answer.execute({ session_id, block: false }, {} as any);

      expect(result).toContain("Answer Received");
      expect(result).toContain(question_id);
      expect(result).toContain('"choice": "no"');
    });

    it("should return no pending questions message when queue is empty", async () => {
      const { session_id } = await sessions.startSession({ title: "Test" });

      const result = await tools.get_next_answer.execute({ session_id, block: false }, {} as any);

      expect(result).toContain("No Pending Questions");
    });
  });

  describe("list_questions", () => {
    it("should return table format with questions", async () => {
      const { session_id } = await sessions.startSession({ title: "Test" });
      sessions.pushQuestion(session_id, "confirm", { question: "Q1?" });
      sessions.pushQuestion(session_id, "pick_one", {
        question: "Q2?",
        options: [{ id: "a", label: "A" }],
      });

      const result = await tools.list_questions.execute({ session_id }, {} as any);

      expect(result).toContain("Questions");
      expect(result).toContain("| ID |");
      expect(result).toContain("confirm");
      expect(result).toContain("pick_one");
      expect(result).toContain("pending");
    });

    it("should return no questions message for empty session", async () => {
      const { session_id } = await sessions.startSession({ title: "Test" });

      const result = await tools.list_questions.execute({ session_id }, {} as any);

      expect(result).toBe("No questions found.");
    });
  });

  describe("cancel_question", () => {
    it("should return success message for cancelled question", async () => {
      const { session_id } = await sessions.startSession({ title: "Test" });
      const { question_id } = sessions.pushQuestion(session_id, "confirm", {
        question: "Cancel me?",
      });

      const result = await tools.cancel_question.execute({ question_id }, {} as any);

      expect(result).toContain(question_id);
      expect(result).toContain("cancelled");
    });

    it("should return failure message for non-existent question", async () => {
      const result = await tools.cancel_question.execute({ question_id: "q_nonexistent" }, {} as any);

      expect(result).toContain("Could not cancel");
      expect(result).toContain("q_nonexistent");
    });
  });
});
