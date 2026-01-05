// tests/tools/brainstorm/summarize.test.ts
import { describe, it, expect } from "bun:test";
import { buildSummaryContext, SUMMARY_SYSTEM_PROMPT } from "../../../src/tools/brainstorm/summarize";
import type { BrainstormAnswer } from "../../../src/tools/brainstorm/types";

describe("Summary LLM Helper", () => {
  describe("buildSummaryContext", () => {
    it("should format context with all information", () => {
      const request = "Add caching to my API";
      const context = "The API is built with Express and handles 1000 req/s";
      const answers: BrainstormAnswer[] = [
        { question: "What's the primary goal?", type: "pick_one", answer: { selected: "speed" } },
        { question: "Any constraints?", type: "ask_text", answer: { text: "Must use Redis" } },
      ];

      const result = buildSummaryContext(request, context, answers);

      expect(result).toContain("USER REQUEST:");
      expect(result).toContain("Add caching to my API");
      expect(result).toContain("CONTEXT:");
      expect(result).toContain("Express");
      expect(result).toContain("BRAINSTORMING SESSION:");
      expect(result).toContain("What's the primary goal?");
      expect(result).toContain("speed");
    });
  });

  describe("SUMMARY_SYSTEM_PROMPT", () => {
    it("should include design document structure", () => {
      expect(SUMMARY_SYSTEM_PROMPT).toContain("Problem Statement");
      expect(SUMMARY_SYSTEM_PROMPT).toContain("Requirements");
      expect(SUMMARY_SYSTEM_PROMPT).toContain("Architecture");
    });
  });
});
