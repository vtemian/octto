// tests/agents/bootstrapper.test.ts
import { describe, expect, it } from "bun:test";

import { bootstrapper } from "../../src/agents";

describe("bootstrapper agent", () => {
  it("should have correct configuration", () => {
    expect(bootstrapper.mode).toBe("subagent");
    expect(bootstrapper.model).toBe("openai/gpt-5.3-codex");
  });

  it("should have prompt that requests branches with scopes", () => {
    expect(bootstrapper.prompt).toContain("branches");
    expect(bootstrapper.prompt).toContain("scope");
    expect(bootstrapper.prompt).toContain("initial_question");
  });

  it("should request JSON output format", () => {
    expect(bootstrapper.prompt).toContain("JSON");
  });
});
