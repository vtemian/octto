// tests/tools/extractor.test.ts
import { describe, expect, it } from "bun:test";

import { extractAnswerSummary } from "../../src/tools/extractor";

describe("extractAnswerSummary", () => {
  it("should extract pick_one answer", () => {
    const result = extractAnswerSummary("pick_one", { selected: "option_a" });
    expect(result).toBe("option_a");
  });

  it("should extract pick_many answer", () => {
    const result = extractAnswerSummary("pick_many", { selected: ["a", "b", "c"] });
    expect(result).toBe("a, b, c");
  });

  it("should extract the freetext when pick_one is answered with other", () => {
    const result = extractAnswerSummary("pick_one", { selected: "other", other: "use Postgres instead" });
    expect(result).toBe("use Postgres instead");
  });

  it("should extract the freetext alongside selections when pick_many includes other", () => {
    const result = extractAnswerSummary("pick_many", { selected: ["redis", "other"], other: "also NATS" });
    expect(result).toBe("redis, also NATS");
  });

  it("should ignore a stray other field when other was not selected", () => {
    const result = extractAnswerSummary("pick_one", { selected: "option_a", other: "leftover" });
    expect(result).toBe("option_a");
  });

  it("should extract confirm answer", () => {
    const result = extractAnswerSummary("confirm", { choice: "yes" });
    expect(result).toBe("yes");
  });

  it("should extract thumbs answer", () => {
    const result = extractAnswerSummary("thumbs", { choice: "up" });
    expect(result).toBe("up");
  });

  it("should extract emoji_react answer", () => {
    const result = extractAnswerSummary("emoji_react", { emoji: "👍" });
    expect(result).toBe("👍");
  });

  it("should extract ask_text answer", () => {
    const result = extractAnswerSummary("ask_text", { text: "Some text" });
    expect(result).toBe("Some text");
  });

  it("should truncate long text answers", () => {
    const longText = "A".repeat(200);
    const result = extractAnswerSummary("ask_text", { text: longText });
    expect(result).toContain("...");
    expect(result.length).toBeLessThan(longText.length);
  });

  it("should extract slider answer", () => {
    const result = extractAnswerSummary("slider", { value: 7 });
    expect(result).toBe("7");
  });

  it("should extract rank answer in order", () => {
    const result = extractAnswerSummary("rank", {
      ranking: [
        { id: "c", rank: 3 },
        { id: "a", rank: 1 },
        { id: "b", rank: 2 },
      ],
    });
    expect(result).toBe("a → b → c");
  });

  it("should extract rate answer with top items", () => {
    const result = extractAnswerSummary("rate", {
      ratings: { high: 5, medium: 3, low: 1 },
    });
    expect(result).toContain("high: 5");
  });

  it("should handle empty ratings", () => {
    const result = extractAnswerSummary("rate", { ratings: {} });
    expect(result).toBe("no ratings");
  });

  it("should extract ask_code answer", () => {
    const result = extractAnswerSummary("ask_code", { code: "const x = 1;" });
    expect(result).toBe("const x = 1;");
  });

  it("should handle file uploads", () => {
    const result = extractAnswerSummary("ask_image", { images: [] });
    expect(result).toBe("file(s) uploaded");
  });

  it("should extract review answer", () => {
    const result = extractAnswerSummary("show_diff", { decision: "approve", feedback: "Looks good" });
    expect(result).toBe("approve: Looks good");
  });

  it("should extract show_options answer", () => {
    const result = extractAnswerSummary("show_options", { selected: "option_b", feedback: "Best choice" });
    expect(result).toBe("option_b: Best choice");
  });
});
