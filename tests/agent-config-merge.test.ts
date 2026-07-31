// tests/agent-config-merge.test.ts
import { describe, expect, it } from "bun:test";

import type { PluginInput } from "@opencode-ai/plugin";

function createMockContext(): PluginInput {
  return {
    client: {} as never,
    project: {} as never,
    directory: "/test",
    worktree: "/test",
    serverUrl: new URL("http://localhost:3000"),
    $: {} as never,
  };
}

interface AgentShape {
  model?: string;
  permission?: Record<string, string>;
}

async function applyConfig(agent: Record<string, AgentShape>): Promise<Record<string, AgentShape>> {
  const { default: plugin } = await import("../src");
  const hooks = await plugin(createMockContext());
  const config = { agent };
  await hooks.config?.(config as never);
  return config.agent;
}

describe("agent config merge", () => {
  it("should keep keys another plugin set on the same agent", async () => {
    const merged = await applyConfig({ octto: { permission: { submit_plan: "allow" } } });

    // octto owns model/prompt; it must not wipe unrelated keys it never sets.
    expect(merged.octto?.permission).toEqual({ submit_plan: "allow" });
    expect(merged.octto?.model).toBeDefined();
  });

  it("should not leak its internal agent objects into the resolved config", async () => {
    const first = await applyConfig({});
    const octto = first.octto;
    expect(octto).toBeDefined();

    // Another plugin mutating the resolved config must not reach octto's own state.
    if (octto) octto.permission = { submit_plan: "deny" };

    const second = await applyConfig({});
    expect(second.octto?.permission).toBeUndefined();
  });

  it("should hand out a distinct agent object on every resolution", async () => {
    const first = await applyConfig({});
    const second = await applyConfig({});

    expect(first.octto).not.toBe(second.octto);
  });

  it("should not accumulate injected prompt fragments across plugin instantiations", async () => {
    const { default: plugin } = await import("../src");
    const marker = "<user-instructions>";

    const countIn = async (): Promise<number> => {
      const hooks = await plugin(createMockContext());
      const config: { agent: Record<string, { prompt?: string }> } = { agent: {} };
      await hooks.config?.(config as never);
      return config.agent.octto?.prompt?.split(marker).length ?? 0;
    };

    const first = await countIn();
    const second = await countIn();

    // Re-instantiating must re-prefix a clean prompt, not stack onto the last one.
    expect(second).toBe(first);
  });
});
