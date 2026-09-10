// tests/index-tracking.test.ts
/**
 * Issue #58 regression test: create_brainstorm's browser session must be
 * tracked like start_session's, so the session.deleted handler tears the
 * octto server down instead of leaking it.
 */
import { afterAll, describe, expect, it, mock } from "bun:test";
import { rm } from "node:fs/promises";

import type { PluginInput } from "@opencode-ai/plugin";

// create_brainstorm opens a browser for real. Mock before the plugin module
// graph loads (each test file gets a fresh module registry).
mock.module("../src/session/browser", () => ({
  openBrowser: async () => {},
}));

function createMockContext(): PluginInput {
  return {
    client: {} as any,
    project: {} as any,
    directory: "/test",
    worktree: "/test",
    serverUrl: new URL("http://localhost:3000"),
    $: {} as any,
  };
}

function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  return (result as { output?: string }).output ?? "";
}

describe("session tracking (issue #58)", () => {
  afterAll(async () => {
    // create_brainstorm persists branch state under .octto/
    await rm(".octto", { recursive: true, force: true });
  });

  it("should end the brainstorm browser session when the opencode session is deleted", async () => {
    const { default: plugin } = await import("../src");
    const result = await plugin(createMockContext());

    const executeOutput = await result.tool!.create_brainstorm.execute(
      {
        request: "test request",
        branches: [
          {
            id: "backend",
            scope: "Cache backend",
            initial_question: { type: "confirm", config: { question: "Use Redis?" } },
          },
        ],
      },
      { sessionID: "opencode_session_1" } as any,
    );

    const url = resultText(executeOutput).match(/http:\/\/localhost:\d+\/\?token=[a-f0-9]+/)?.[0];
    expect(url).toBeDefined();

    const before = await fetch(url as string);
    expect(before.ok).toBe(true);

    await result.event!({
      event: { type: "session.deleted", properties: { info: { id: "opencode_session_1" } } },
    } as any);

    await expect(fetch(url as string)).rejects.toThrow();
  });
});
