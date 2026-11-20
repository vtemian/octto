// tests/integration/multi-agent.test.ts
import { describe, expect, it } from "bun:test";

import { parseProbeResponse } from "../../src/tools/processor";

describe("Multi-Agent Integration", () => {
  describe("parseProbeResponse", () => {
    it("should parse a probe response with a follow-up question", () => {
      const result = parseProbeResponse(
        `Here's my analysis:\n\n{"done": false, "finding": "Need more info", "question": {"type": "slider", "config": {"question": "Expected number of users?", "min": 1, "max": 1000000}}}`,
      );

      expect(result.done).toBe(false);
      expect(result.finding).toBe("Need more info");
      expect(result.question).toBeDefined();
      expect(result.question!.type).toBe("slider");
      expect(result.question!.config.question).toBe("Expected number of users?");
    });

    it("should parse a done probe response without a question", () => {
      const result = parseProbeResponse(`{"done": true, "finding": "All key decisions have been made"}`);

      expect(result.done).toBe(true);
      expect(result.finding).toBe("All key decisions have been made");
      expect(result.question).toBeUndefined();
    });

    it("should parse text the host already concatenated from several parts", () => {
      const result = parseProbeResponse('{"done": true, "finding": "concatenated"}');

      expect(result.done).toBe(true);
      expect(result.finding).toBe("concatenated");
    });

    it("should return fallback when response has no JSON", () => {
      const result = parseProbeResponse("No JSON here at all");

      expect(result.done).toBe(true);
      expect(result.finding).toBe("Could not parse probe response");
    });

    it("should return fallback when JSON fails Valibot schema validation", () => {
      // Missing required 'done' field
      const result = parseProbeResponse('{"finding": "no done field"}');

      expect(result.done).toBe(true);
      expect(result.finding).toBe("Could not validate probe response");
    });

    it("should not throw when prose braces precede the probe JSON", () => {
      const result = parseProbeResponse(
        'Thinking about {the scope} now.\n{"done": false, "question": {"type": "pick_one", "config": {}}}',
      );

      expect(result.done).toBe(true);
      expect(result.finding).toBe("Could not parse probe response");
    });

    it("should extract JSON embedded in surrounding text", () => {
      const result = parseProbeResponse(
        `Let me think about this...\n\n{"done": false, "question": {"type": "confirm", "config": {"question": "Ready to proceed?"}}}\n\nThat's my assessment.`,
      );

      expect(result.done).toBe(false);
      expect(result.question).toBeDefined();
      expect(result.question!.type).toBe("confirm");
    });

    it("should handle an empty reply", () => {
      const result = parseProbeResponse("");

      expect(result.done).toBe(true);
      expect(result.finding).toBe("Could not parse probe response");
    });

    it("should reject invalid question type via Valibot validation", () => {
      const result = parseProbeResponse(
        '{"done": false, "question": {"type": "invalid_type", "config": {"question": "test"}}}',
      );

      expect(result.done).toBe(true);
      expect(result.finding).toBe("Could not validate probe response");
    });

    it("should accept valid question types from QUESTION_TYPES", () => {
      const validTypes = ["pick_one", "pick_many", "confirm", "ask_text", "slider"];

      for (const questionType of validTypes) {
        const result = parseProbeResponse(
          `{"done": false, "question": {"type": "${questionType}", "config": {"question": "test"}}}`,
        );

        expect(result.done).toBe(false);
        expect(result.question!.type).toBe(questionType);
      }
    });
  });
});
