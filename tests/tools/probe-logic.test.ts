// tests/tools/probe-logic.test.ts
import { describe, it, expect } from "bun:test";
import { evaluateBranch } from "../../src/tools/probe-logic";
import type { Branch } from "../../src/state/types";

function createBranch(overrides: Partial<Branch> = {}): Branch {
  return {
    id: "test_branch",
    scope: "Test scope",
    status: "exploring",
    questions: [],
    finding: null,
    ...overrides,
  };
}

describe("evaluateBranch", () => {
  describe("pending questions", () => {
    it("should wait when there are unanswered questions", () => {
      const branch = createBranch({
        questions: [
          { id: "q1", type: "ask_text", text: "Question 1", config: {} },
        ],
      });

      const result = evaluateBranch(branch);

      expect(result.done).toBe(false);
      expect(result.reason).toContain("pending");
    });
  });

  describe("completion rules", () => {
    it("should complete after 3+ answered questions", () => {
      const branch = createBranch({
        scope: "Database storage",
        questions: [
          { id: "q1", type: "pick_one", text: "Which DB?", config: {}, answer: { selected: "PostgreSQL" } },
          { id: "q2", type: "pick_one", text: "Priority?", config: {}, answer: { selected: "performance" } },
          { id: "q3", type: "confirm", text: "Ready?", config: {}, answer: { choice: "yes" } },
        ],
      });

      const result = evaluateBranch(branch);

      expect(result.done).toBe(true);
      expect(result.finding).toContain("Database storage");
      expect(result.finding).toContain("PostgreSQL");
    });

    it("should complete when user confirms direction is clear", () => {
      const branch = createBranch({
        scope: "API format",
        questions: [
          { id: "q1", type: "pick_one", text: "Format?", config: {}, answer: { selected: "JSON" } },
          { id: "q2", type: "confirm", text: "Is direction clear?", config: {}, answer: { choice: "yes" } },
        ],
      });

      const result = evaluateBranch(branch);

      expect(result.done).toBe(true);
      expect(result.finding).toBeDefined();
    });

    it("should ask for clarification when user says no to confirm", () => {
      const branch = createBranch({
        scope: "API format",
        questions: [
          { id: "q1", type: "pick_one", text: "Format?", config: {}, answer: { selected: "JSON" } },
          { id: "q2", type: "confirm", text: "Is direction clear?", config: {}, answer: { choice: "no" } },
        ],
      });

      const result = evaluateBranch(branch);

      expect(result.done).toBe(false);
      expect(result.question).toBeDefined();
      expect(result.question?.type).toBe("ask_text");
      expect(result.question?.config).toHaveProperty("question");
    });
  });

  describe("follow-up generation", () => {
    it("should generate priority question after first answer", () => {
      const branch = createBranch({
        scope: "Database storage",
        questions: [
          { id: "q1", type: "pick_one", text: "Which DB?", config: {}, answer: { selected: "PostgreSQL" } },
        ],
      });

      const result = evaluateBranch(branch);

      expect(result.done).toBe(false);
      expect(result.question).toBeDefined();
      expect(result.question?.type).toBe("pick_one");
    });

    it("should generate confirm question after second answer", () => {
      const branch = createBranch({
        scope: "API format",
        questions: [
          { id: "q1", type: "pick_one", text: "Format?", config: {}, answer: { selected: "JSON" } },
          { id: "q2", type: "pick_one", text: "Priority?", config: {}, answer: { selected: "simplicity" } },
        ],
      });

      const result = evaluateBranch(branch);

      expect(result.done).toBe(false);
      expect(result.question).toBeDefined();
      expect(result.question?.type).toBe("confirm");
    });
  });

  describe("finding synthesis", () => {
    it("should include main choice in finding", () => {
      const branch = createBranch({
        scope: "Auth method",
        questions: [
          { id: "q1", type: "pick_one", text: "Method?", config: {}, answer: { selected: "OAuth" } },
          { id: "q2", type: "pick_one", text: "Priority?", config: {}, answer: { selected: "security" } },
          { id: "q3", type: "confirm", text: "Ready?", config: {}, answer: { choice: "yes" } },
        ],
      });

      const result = evaluateBranch(branch);

      expect(result.finding).toContain("Auth method");
      expect(result.finding).toContain("OAuth");
    });

    it("should handle array selections", () => {
      const branch = createBranch({
        scope: "Services",
        questions: [
          { id: "q1", type: "pick_many", text: "Which?", config: {}, answer: { selected: ["DB", "Cache", "API"] } },
          { id: "q2", type: "pick_one", text: "Priority?", config: {}, answer: { selected: "reliability" } },
          { id: "q3", type: "confirm", text: "Ready?", config: {}, answer: { choice: "yes" } },
        ],
      });

      const result = evaluateBranch(branch);

      expect(result.finding).toContain("DB, Cache, API");
    });

    it("should handle text answers", () => {
      const branch = createBranch({
        scope: "Custom requirement",
        questions: [
          { id: "q1", type: "ask_text", text: "Details?", config: {}, answer: { text: "Need fast response times" } },
          { id: "q2", type: "pick_one", text: "Priority?", config: {}, answer: { selected: "performance" } },
          { id: "q3", type: "confirm", text: "Ready?", config: {}, answer: { choice: "yes" } },
        ],
      });

      const result = evaluateBranch(branch);

      expect(result.finding).toContain("Need fast response times");
    });

    it("should truncate long text answers", () => {
      const longText = "A".repeat(200);
      const branch = createBranch({
        scope: "Details",
        questions: [
          { id: "q1", type: "ask_text", text: "Details?", config: {}, answer: { text: longText } },
          { id: "q2", type: "pick_one", text: "Priority?", config: {}, answer: { selected: "simplicity" } },
          { id: "q3", type: "confirm", text: "Ready?", config: {}, answer: { choice: "yes" } },
        ],
      });

      const result = evaluateBranch(branch);

      expect(result.finding).toContain("...");
      expect(result.finding!.length).toBeLessThan(longText.length + 100);
    });

    it("should handle value-based answers (slider)", () => {
      const branch = createBranch({
        scope: "Priority level",
        questions: [
          { id: "q1", type: "slider", text: "Importance?", config: {}, answer: { value: 8 } },
          { id: "q2", type: "pick_one", text: "Area?", config: {}, answer: { selected: "performance" } },
          { id: "q3", type: "confirm", text: "Ready?", config: {}, answer: { choice: "yes" } },
        ],
      });

      const result = evaluateBranch(branch);

      expect(result.finding).toContain("8");
    });

    it("should handle ranking answers", () => {
      const branch = createBranch({
        scope: "Feature priority",
        questions: [
          {
            id: "q1",
            type: "rank",
            text: "Rank features",
            config: {},
            answer: {
              ranking: [
                { id: "security", rank: 2 },
                { id: "performance", rank: 1 },
                { id: "usability", rank: 3 },
              ],
            },
          },
          { id: "q2", type: "pick_one", text: "Priority?", config: {}, answer: { selected: "simplicity" } },
          { id: "q3", type: "confirm", text: "Ready?", config: {}, answer: { choice: "yes" } },
        ],
      });

      const result = evaluateBranch(branch);

      // Should show ranked items in order
      expect(result.finding).toContain("performance → security → usability");
    });

    it("should handle ratings answers", () => {
      const branch = createBranch({
        scope: "Satisfaction feedback",
        questions: [
          {
            id: "q1",
            type: "rate",
            text: "Rate features",
            config: {},
            answer: {
              ratings: {
                branching: 5,
                async: 3,
                summaries: 4,
              },
            },
          },
          { id: "q2", type: "pick_one", text: "Priority?", config: {}, answer: { selected: "quality" } },
          { id: "q3", type: "confirm", text: "Ready?", config: {}, answer: { choice: "yes" } },
        ],
      });

      const result = evaluateBranch(branch);

      // Should show top-rated items
      expect(result.finding).toContain("branching: 5");
    });
  });

  describe("scope-based priority options", () => {
    it("should provide database-specific options for database scope", () => {
      const branch = createBranch({
        scope: "Database storage",
        questions: [
          { id: "q1", type: "pick_one", text: "Which DB?", config: {}, answer: { selected: "PostgreSQL" } },
        ],
      });

      const result = evaluateBranch(branch);

      expect(result.question?.type).toBe("pick_one");
      const config = result.question?.config as { options?: Array<{ id: string }> };
      const optionIds = config.options?.map((o) => o.id) || [];
      expect(optionIds).toContain("consistency");
    });

    it("should provide API-specific options for API scope", () => {
      const branch = createBranch({
        scope: "API endpoints",
        questions: [
          { id: "q1", type: "pick_one", text: "Style?", config: {}, answer: { selected: "REST" } },
        ],
      });

      const result = evaluateBranch(branch);

      const config = result.question?.config as { options?: Array<{ id: string }> };
      const optionIds = config.options?.map((o) => o.id) || [];
      expect(optionIds).toContain("compatibility");
    });

    it("should provide security-specific options for auth scope", () => {
      const branch = createBranch({
        scope: "Authentication method",
        questions: [
          { id: "q1", type: "pick_one", text: "Method?", config: {}, answer: { selected: "OAuth" } },
        ],
      });

      const result = evaluateBranch(branch);

      const config = result.question?.config as { options?: Array<{ id: string }> };
      const optionIds = config.options?.map((o) => o.id) || [];
      expect(optionIds).toContain("security");
    });
  });

  describe("edge cases", () => {
    it("should handle empty branch", () => {
      const branch = createBranch({ questions: [] });

      const result = evaluateBranch(branch);

      // No questions, no answers, should generate first follow-up or complete
      expect(result).toBeDefined();
    });

    it("should handle branch with no finding gracefully", () => {
      const branch = createBranch({
        scope: "Test",
        questions: [
          { id: "q1", type: "pick_one", text: "Q?", config: {}, answer: { selected: "A" } },
          { id: "q2", type: "pick_one", text: "Q?", config: {}, answer: { selected: "B" } },
          { id: "q3", type: "pick_one", text: "Q?", config: {}, answer: { selected: "C" } },
        ],
      });

      const result = evaluateBranch(branch);

      expect(result.done).toBe(true);
      expect(result.finding).toBeDefined();
      expect(result.finding).not.toBe("");
    });

    it("should handle answers with unknown format", () => {
      const branch = createBranch({
        scope: "Test",
        questions: [
          { id: "q1", type: "custom", text: "Q?", config: {}, answer: { unknownField: "value" } },
          { id: "q2", type: "custom", text: "Q?", config: {}, answer: { anotherField: 123 } },
          { id: "q3", type: "custom", text: "Q?", config: {}, answer: {} },
        ],
      });

      const result = evaluateBranch(branch);

      expect(result.done).toBe(true);
      expect(result.finding).toBeDefined();
    });
  });
});
