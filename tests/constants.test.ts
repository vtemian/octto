// tests/constants.test.ts
import { describe, it, expect } from "bun:test";
import { DEFAULT_ANSWER_TIMEOUT_MS, DEFAULT_MAX_QUESTIONS, DEFAULT_PROBE_MODEL } from "../src/constants";

describe("constants", () => {
  it("should export DEFAULT_ANSWER_TIMEOUT_MS as 5 minutes", () => {
    expect(DEFAULT_ANSWER_TIMEOUT_MS).toBe(300000);
  });

  it("should export DEFAULT_MAX_QUESTIONS as 15", () => {
    expect(DEFAULT_MAX_QUESTIONS).toBe(15);
  });

  it("should export DEFAULT_PROBE_MODEL as claude-opus-4-5", () => {
    expect(DEFAULT_PROBE_MODEL).toBe("anthropic/claude-opus-4-5");
  });
});
