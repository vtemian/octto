// tests/integration/multi-agent.test.ts
import { describe, expect, it } from "bun:test";

import { parseProbeResponse } from "../../src/tools/processor";

describe("Multi-Agent Integration", () => {
  describe("parseProbeResponse", () => {
    it("should parse a probe response with a follow-up question", () => {
      const parts = [
        {
          type: "text",
          text: `Here's my analysis:\n\n{"done": false, "finding": "Need more info", "question": {"type": "slider", "config": {"question": "Expected number of users?", "min": 1, "max": 1000000}}}`,
        },
      ];

      const result = parseProbeResponse(parts);

      expect(result.done).toBe(false);
      expect(result.finding).toBe("Need more info");
      expect(result.question).toBeDefined();
      expect(result.question!.type).toBe("slider");
      expect(result.question!.config.question).toBe("Expected number of users?");
    });

    it("should parse a done probe response without a question", () => {
      const parts = [
        {
          type: "text",
          text: `{"done": true, "finding": "All key decisions have been made"}`,
        },
      ];

      const result = parseProbeResponse(parts);

      expect(result.done).toBe(true);
      expect(result.finding).toBe("All key decisions have been made");
      expect(result.question).toBeUndefined();
    });

    it("should concatenate multiple text parts before parsing", () => {
      const parts = [
        { type: "text", text: '{"done": true, ' },
        { type: "text", text: '"finding": "concatenated"}' },
      ];

      const result = parseProbeResponse(parts);

      expect(result.done).toBe(true);
      expect(result.finding).toBe("concatenated");
    });

    it("should skip non-text parts", () => {
      const parts = [
        { type: "image", url: "http://example.com/img.png" },
        { type: "text", text: '{"done": true, "finding": "only text matters"}' },
      ];

      const result = parseProbeResponse(parts);

      expect(result.done).toBe(true);
      expect(result.finding).toBe("only text matters");
    });

    it("should return fallback when response has no JSON", () => {
      const parts = [{ type: "text", text: "No JSON here at all" }];

      const result = parseProbeResponse(parts);

      expect(result.done).toBe(true);
      expect(result.finding).toBe("Could not parse probe response");
    });

    it("should return fallback when JSON fails Valibot schema validation", () => {
      // Missing required 'done' field
      const parts = [{ type: "text", text: '{"finding": "no done field"}' }];

      const result = parseProbeResponse(parts);

      expect(result.done).toBe(true);
      expect(result.finding).toBe("Could not validate probe response");
    });

    it("should extract JSON embedded in surrounding text", () => {
      const parts = [
        {
          type: "text",
          text: `Let me think about this...\n\n{"done": false, "question": {"type": "confirm", "config": {"question": "Ready to proceed?"}}}\n\nThat's my assessment.`,
        },
      ];

      const result = parseProbeResponse(parts);

      expect(result.done).toBe(false);
      expect(result.question).toBeDefined();
      expect(result.question!.type).toBe("confirm");
    });

    it("should handle empty parts array", () => {
      const result = parseProbeResponse([]);

      expect(result.done).toBe(true);
      expect(result.finding).toBe("Could not parse probe response");
    });

    it("should reject invalid question type via Valibot validation", () => {
      const parts = [
        {
          type: "text",
          text: '{"done": false, "question": {"type": "invalid_type", "config": {"question": "test"}}}',
        },
      ];

      const result = parseProbeResponse(parts);

      expect(result.done).toBe(true);
      expect(result.finding).toBe("Could not validate probe response");
    });

    it("should accept valid question types from QUESTION_TYPES", () => {
      const validTypes = ["pick_one", "pick_many", "confirm", "ask_text", "slider"];

      for (const questionType of validTypes) {
        const parts = [
          {
            type: "text",
            text: `{"done": false, "question": {"type": "${questionType}", "config": {"question": "test"}}}`,
          },
        ];

        const result = parseProbeResponse(parts);

        expect(result.done).toBe(false);
        expect(result.question!.type).toBe(questionType);
      }
    });
  });
});
