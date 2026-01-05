// tests/tools/brainstorm/probe.test.ts
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { callProbe, buildProbeContext, parseProbeResponse, formatAnswer } from "../../../src/tools/brainstorm/probe";
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

  describe("callProbe", () => {
    it("should return parsed probe response on success", async () => {
      const mockClient = {
        session: {
          prompt: mock(async () => ({
            data: {
              parts: [
                {
                  type: "text",
                  text: JSON.stringify({ done: true, reason: "Complete" }),
                },
              ],
            },
          })),
        },
      } as any;

      const result = await callProbe(mockClient, "session-1", "test request", []);

      expect(result.done).toBe(true);
      expect((result as any).reason).toBe("Complete");
    });

    it("should throw BrainstormError on empty response", async () => {
      const mockClient = {
        session: {
          prompt: mock(async () => ({
            data: null,
          })),
        },
      } as any;

      await expect(callProbe(mockClient, "session-1", "test", [])).rejects.toThrow("No response from probe LLM");
    });

    it("should throw BrainstormError on empty text", async () => {
      const mockClient = {
        session: {
          prompt: mock(async () => ({
            data: {
              parts: [],
            },
          })),
        },
      } as any;

      await expect(callProbe(mockClient, "session-1", "test", [])).rejects.toThrow("Empty response from probe LLM");
    });

    it("should strip markdown code blocks from response", async () => {
      const mockClient = {
        session: {
          prompt: mock(async () => ({
            data: {
              parts: [
                {
                  type: "text",
                  text: '```json\n{"done": true, "reason": "Done"}\n```',
                },
              ],
            },
          })),
        },
      } as any;

      const result = await callProbe(mockClient, "session-1", "test", []);

      expect(result.done).toBe(true);
    });

    it("should use default model when not specified", async () => {
      let capturedArgs: any;
      const mockClient = {
        session: {
          prompt: mock(async (args: any) => {
            capturedArgs = args;
            return {
              data: {
                parts: [{ type: "text", text: '{"done": true, "reason": "Done"}' }],
              },
            };
          }),
        },
      } as any;

      await callProbe(mockClient, "session-1", "test", []);

      expect(capturedArgs.body.model.providerID).toBe("anthropic");
      expect(capturedArgs.body.model.modelID).toBe("claude-sonnet-4");
    });

    it("should use custom model when specified", async () => {
      let capturedArgs: any;
      const mockClient = {
        session: {
          prompt: mock(async (args: any) => {
            capturedArgs = args;
            return {
              data: {
                parts: [{ type: "text", text: '{"done": true, "reason": "Done"}' }],
              },
            };
          }),
        },
      } as any;

      await callProbe(mockClient, "session-1", "test", [], "openai/gpt-4");

      expect(capturedArgs.body.model.providerID).toBe("openai");
      expect(capturedArgs.body.model.modelID).toBe("gpt-4");
    });
  });

  describe("formatAnswer", () => {
    it("should format pick_one answer", () => {
      const result = formatAnswer({
        question: "Choose one",
        type: "pick_one",
        answer: { selected: "option1" },
      });

      expect(result).toContain('selected "option1"');
    });

    it("should format pick_one with other", () => {
      const result = formatAnswer({
        question: "Choose one",
        type: "pick_one",
        answer: { other: "custom value" },
      });

      expect(result).toContain("other");
      expect(result).toContain("custom value");
    });

    it("should format pick_many answer", () => {
      const result = formatAnswer({
        question: "Choose many",
        type: "pick_many",
        answer: { selected: ["a", "b", "c"] },
      });

      expect(result).toContain("a");
      expect(result).toContain("b");
      expect(result).toContain("c");
    });

    it("should format confirm answer", () => {
      const result = formatAnswer({
        question: "Confirm?",
        type: "confirm",
        answer: { choice: "yes" },
      });

      expect(result).toContain("yes");
    });

    it("should format ask_text answer", () => {
      const result = formatAnswer({
        question: "Enter text",
        type: "ask_text",
        answer: { text: "user input here" },
      });

      expect(result).toContain("user input here");
    });

    it("should format slider answer", () => {
      const result = formatAnswer({
        question: "Rate",
        type: "slider",
        answer: { value: 7 },
      });

      expect(result).toContain("7");
    });

    it("should format thumbs answer", () => {
      const result = formatAnswer({
        question: "Good?",
        type: "thumbs",
        answer: { choice: "up" },
      });

      expect(result).toContain("up");
    });

    it("should format rank answer", () => {
      const result = formatAnswer({
        question: "Rank these",
        type: "rank",
        answer: { ranking: ["first", "second", "third"] },
      });

      expect(result).toContain("first");
      expect(result).toContain("second");
    });

    it("should format rate answer", () => {
      const result = formatAnswer({
        question: "Rate items",
        type: "rate",
        answer: { ratings: { item1: 5, item2: 3 } },
      });

      expect(result).toContain("item1");
      expect(result).toContain("5");
    });

    it("should format show_options answer", () => {
      const result = formatAnswer({
        question: "Pick option",
        type: "show_options",
        answer: { selected: "optA", feedback: "looks good" },
      });

      expect(result).toContain("optA");
      expect(result).toContain("looks good");
    });

    it("should handle unknown types with JSON fallback", () => {
      const result = formatAnswer({
        question: "Unknown",
        type: "ask_image" as any,
        answer: { data: "test" },
      });

      expect(result).toContain("test");
    });

    it("should handle null response", () => {
      const result = formatAnswer({
        question: "Test",
        type: "confirm",
        answer: null as any,
      });

      expect(result).toBe("No response");
    });

    it("should handle undefined response", () => {
      const result = formatAnswer({
        question: "Test",
        type: "confirm",
        answer: undefined as any,
      });

      expect(result).toBe("No response");
    });
  });
});
