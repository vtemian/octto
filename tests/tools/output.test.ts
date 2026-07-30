// tests/tools/output.test.ts
import { describe, expect, it } from "bun:test";

import { outputText } from "../../src/tools/output";

describe("outputText", () => {
  it("should return a bare string result unchanged", () => {
    expect(outputText("<session_started>ses_abc123</session_started>")).toBe(
      "<session_started>ses_abc123</session_started>",
    );
  });

  it("should return an empty string result unchanged", () => {
    expect(outputText("")).toBe("");
  });

  it("should read the output field of a structured result", () => {
    expect(outputText({ output: "<session_started>ses_abc123</session_started>" })).toBe(
      "<session_started>ses_abc123</session_started>",
    );
  });

  it("should ignore title and metadata on a structured result", () => {
    const executeOutput = {
      title: "Start session",
      output: "ses_xyz789",
      metadata: { duration: 12 },
    };

    expect(outputText(executeOutput)).toBe("ses_xyz789");
  });

  it("should expose output that session tracking can match a session id in", () => {
    const structured = outputText({ output: "opened ses_abc123 for review" });
    const bare = outputText("opened ses_abc123 for review");

    expect(structured.match(/ses_[a-z0-9]+/)?.[0]).toBe("ses_abc123");
    expect(bare.match(/ses_[a-z0-9]+/)?.[0]).toBe("ses_abc123");
  });
});
