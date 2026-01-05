// tests/tools/brainstorm/probe.test.ts
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { callProbe, buildProbeContext, parseProbeResponse } from "../../../src/tools/brainstorm/probe";
import type { BrainstormAnswer, ProbeResponse } from "../../../src/tools/brainstorm/types";

describe("Probe LLM Helper", () => {
  describe("buildProbeContext", () => {
    it("should format context with request and answers", () => {
      const request = "Add caching to my API";
      const answers: BrainstormAnswer[] = [
        { question: "What's the primary goal?", type: "pick_one", answer: { selected: "speed" } },
        { question: "Any constraints?", type: "ask_text", answer: { text: "Must use Redis" } },
      ];

      const context = buildProbeContext(request, answers);

      expect(context).toContain("ORIGINAL REQUEST:");
      expect(context).toContain("Add caching to my API");
      expect(context).toContain("CONVERSATION:");
      expect(context).toContain("Q1 [pick_one]: What's the primary goal?");
      expect(context).toContain('A1: User selected "speed"');
      expect(context).toContain("Q2 [ask_text]: Any constraints?");
      expect(context).toContain('A2: User wrote: "Must use Redis"');
    });

    it("should handle empty answers", () => {
      const context = buildProbeContext("Build a feature", []);

      expect(context).toContain("ORIGINAL REQUEST:");
      expect(context).toContain("Build a feature");
      expect(context).toContain("CONVERSATION:");
      expect(context).toContain("(No answers yet)");
    });
  });

  describe("parseProbeResponse", () => {
    it("should parse valid done response", () => {
      const json = '{"done": true, "reason": "Design is complete"}';

      const result = parseProbeResponse(json);

      expect(result.done).toBe(true);
      expect((result as { done: true; reason: string }).reason).toBe("Design is complete");
    });

    it("should parse valid continue response", () => {
      const json = JSON.stringify({
        done: false,
        reason: "Need to understand scale",
        question: {
          type: "pick_one",
          config: {
            question: "Expected traffic?",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
          },
        },
      });

      const result = parseProbeResponse(json);

      expect(result.done).toBe(false);
      expect((result as { done: false; question: { type: string } }).question.type).toBe("pick_one");
    });

    it("should throw on invalid JSON", () => {
      expect(() => parseProbeResponse("not json")).toThrow("Failed to parse probe response as JSON");
    });

    it("should throw on missing done field", () => {
      expect(() => parseProbeResponse('{"reason": "test"}')).toThrow("missing 'done' boolean field");
    });

    it("should throw on missing question when done is false", () => {
      expect(() => parseProbeResponse('{"done": false, "reason": "test"}')).toThrow("must include 'question' object");
    });
  });
});
