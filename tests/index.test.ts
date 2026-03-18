// tests/index.test.ts
import { describe, expect, it } from "bun:test";

import type { PluginInput } from "@opencode-ai/plugin";

// We need to test the plugin initialization behavior
// Since the plugin is a function that takes context, we test it directly

// Create a minimal mock context that satisfies PluginInput
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

describe("OcttoPlugin", () => {
  describe("initialization", () => {
    it("should export a default plugin function", async () => {
      const { default: plugin } = await import("../src");
      expect(typeof plugin).toBe("function");
    });

    it("should return tools when initialized", async () => {
      const { default: plugin } = await import("../src");

      const result = await plugin(createMockContext());

      expect(result.tool).toBeDefined();
      expect(typeof result.tool).toBe("object");
    });

    it("should include start_session tool", async () => {
      const { default: plugin } = await import("../src");

      const result = await plugin(createMockContext());

      expect(result.tool!.start_session).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(result.tool!.start_session.execute).toBeDefined();
    });

    it("should include push_question tool", async () => {
      const { default: plugin } = await import("../src");

      const result = await plugin(createMockContext());

      // brainstorm tool removed (caused deadlock), use push_question instead
      expect(result.tool!.push_question).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(result.tool!.push_question.execute).toBeDefined();
    });

    it("should include event handler", async () => {
      const { default: plugin } = await import("../src");

      const result = await plugin(createMockContext());

      expect(result.event).toBeDefined();
      expect(typeof result.event).toBe("function");
    });
  });

  describe("session tracking", () => {
    it("should handle session.deleted event without error when no sessions exist", async () => {
      const { default: plugin } = await import("../src");

      const result = await plugin(createMockContext());

      // Should not throw when handling event for unknown session
      await expect(
        result.event!({
          event: {
            type: "session.deleted",
            properties: { info: { id: "unknown_session" } },
          },
        } as any),
      ).resolves.toBeUndefined();
    });

    it("should ignore non-session.deleted events", async () => {
      const { default: plugin } = await import("../src");

      const result = await plugin(createMockContext());

      // Should not throw for other event types
      await expect(
        result.event!({
          event: {
            type: "other.event",
            properties: {},
          },
        } as any),
      ).resolves.toBeUndefined();
    });
  });
});
