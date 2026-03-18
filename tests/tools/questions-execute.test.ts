// tests/tools/questions-execute.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { createSessionStore, type SessionStore } from "../../src/session/sessions";
import { createQuestionTools } from "../../src/tools/questions";

describe("Question Tool Execute Functions", () => {
  let sessions: SessionStore;
  let tools: ReturnType<typeof createQuestionTools>;
  let sessionId: string;

  beforeEach(async () => {
    sessions = createSessionStore({ skipBrowser: true });
    tools = createQuestionTools(sessions);
    const result = await sessions.startSession({ title: "Question Execute Test" });
    sessionId = result.session_id;
  });

  afterEach(async () => {
    await sessions.cleanup();
  });

  describe("pick_one", () => {
    it("should push a question and return the question_id", async () => {
      const result = await tools.pick_one.execute(
        {
          session_id: sessionId,
          question: "Pick a color",
          options: [
            { id: "red", label: "Red" },
            { id: "blue", label: "Blue" },
          ],
        },
        {} as any,
      );

      expect(result).toContain("Question pushed:");
      expect(result).toMatch(/q_[a-z0-9]+/);
      expect(result).toContain("get_answer");
    });

    it("should return validation error for empty options", async () => {
      const result = await tools.pick_one.execute(
        {
          session_id: sessionId,
          question: "Pick something",
          options: [],
        },
        {} as any,
      );

      expect(result).toContain("Failed");
      expect(result).toContain("options array must not be empty");
    });

    it("should return failure for non-existent session", async () => {
      const result = await tools.pick_one.execute(
        {
          session_id: "ses_nonexistent",
          question: "Pick a color",
          options: [{ id: "red", label: "Red" }],
        },
        {} as any,
      );

      expect(result).toContain("Failed");
      expect(result).toContain("Session not found");
    });
  });

  describe("pick_many", () => {
    it("should push a pick_many question and return question_id", async () => {
      const result = await tools.pick_many.execute(
        {
          session_id: sessionId,
          question: "Select features",
          options: [
            { id: "auth", label: "Authentication" },
            { id: "cache", label: "Caching" },
          ],
        },
        {} as any,
      );

      expect(result).toContain("Question pushed:");
      expect(result).toMatch(/q_[a-z0-9]+/);
    });

    it("should return validation error when min > max", async () => {
      const result = await tools.pick_many.execute(
        {
          session_id: sessionId,
          question: "Select features",
          options: [
            { id: "auth", label: "Authentication" },
            { id: "cache", label: "Caching" },
          ],
          min: 5,
          max: 1,
        },
        {} as any,
      );

      expect(result).toContain("Failed");
      expect(result).toContain("min (5) cannot be greater than max (1)");
    });
  });

  describe("rate", () => {
    it("should push a rate question", async () => {
      const result = await tools.rate.execute(
        {
          session_id: sessionId,
          question: "Rate these features",
          options: [
            { id: "speed", label: "Speed" },
            { id: "safety", label: "Safety" },
          ],
        },
        {} as any,
      );

      expect(result).toContain("Question pushed:");
      expect(result).toMatch(/q_[a-z0-9]+/);
    });

    it("should return validation error when min >= max", async () => {
      const result = await tools.rate.execute(
        {
          session_id: sessionId,
          question: "Rate features",
          options: [{ id: "speed", label: "Speed" }],
          min: 10,
          max: 5,
        },
        {} as any,
      );

      expect(result).toContain("Failed");
      expect(result).toContain("min (10) must be less than max (5)");
    });

    it("should return validation error for empty options", async () => {
      const result = await tools.rate.execute(
        {
          session_id: sessionId,
          question: "Rate features",
          options: [],
        },
        {} as any,
      );

      expect(result).toContain("Failed");
      expect(result).toContain("options array must not be empty");
    });
  });

  describe("confirm", () => {
    it("should push a confirm question", async () => {
      const result = await tools.confirm.execute(
        {
          session_id: sessionId,
          question: "Do you approve?",
        },
        {} as any,
      );

      expect(result).toContain("Question pushed:");
      expect(result).toMatch(/q_[a-z0-9]+/);
    });
  });

  describe("rank", () => {
    it("should push a rank question", async () => {
      const result = await tools.rank.execute(
        {
          session_id: sessionId,
          question: "Rank priorities",
          options: [
            { id: "perf", label: "Performance" },
            { id: "sec", label: "Security" },
          ],
        },
        {} as any,
      );

      expect(result).toContain("Question pushed:");
    });

    it("should return validation error for empty options", async () => {
      const result = await tools.rank.execute(
        {
          session_id: sessionId,
          question: "Rank priorities",
          options: [],
        },
        {} as any,
      );

      expect(result).toContain("Failed");
      expect(result).toContain("options array must not be empty");
    });
  });

  describe("slider", () => {
    it("should push a slider question", async () => {
      const result = await tools.slider.execute(
        {
          session_id: sessionId,
          question: "How many users?",
          min: 0,
          max: 1000,
        },
        {} as any,
      );

      expect(result).toContain("Question pushed:");
    });

    it("should return validation error when min >= max", async () => {
      const result = await tools.slider.execute(
        {
          session_id: sessionId,
          question: "How many?",
          min: 100,
          max: 100,
        },
        {} as any,
      );

      expect(result).toContain("Failed");
      expect(result).toContain("min (100) must be less than max (100)");
    });
  });

  describe("ask_text", () => {
    it("should push an ask_text question", async () => {
      const result = await tools.ask_text.execute(
        {
          session_id: sessionId,
          question: "What is your name?",
          placeholder: "Enter name...",
        },
        {} as any,
      );

      expect(result).toContain("Question pushed:");
      expect(result).toMatch(/q_[a-z0-9]+/);
    });
  });
});
