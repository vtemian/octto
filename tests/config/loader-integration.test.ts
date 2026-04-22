// tests/config/loader-integration.test.ts
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentConfig } from "@opencode-ai/sdk";

import { AGENTS, type AgentName } from "../../src/agents";
import { loadCustomConfig } from "../../src/config/loader";

const stubAgents: Record<AgentName, AgentConfig> = {
  [AGENTS.octto]: { description: "octto", model: "test-model", prompt: "octto prompt" },
  [AGENTS.bootstrapper]: { description: "bootstrapper", model: "test-model", prompt: "bootstrapper prompt" },
  [AGENTS.probe]: { description: "probe", model: "test-model", prompt: "probe prompt" },
};

describe("loadCustomConfig", () => {
  let configDir: string;
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "octto-config-test-"));
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    rmSync(configDir, { recursive: true, force: true });
  });

  it("should return default agents when no config file exists", async () => {
    const result = await loadCustomConfig(stubAgents, configDir);

    expect(result.agents).toEqual(stubAgents);
    expect(result.port).toBe(0);
  });

  it("should merge valid config overrides into agents", async () => {
    writeFileSync(
      join(configDir, "octto.json"),
      JSON.stringify({
        agents: {
          octto: { model: "custom-model", temperature: 0.5 },
        },
        port: 3000,
      }),
    );

    const result = await loadCustomConfig(stubAgents, configDir);

    expect(result.agents.octto.model).toBe("custom-model");
    expect(result.agents.octto.prompt).toBe("octto prompt");
    expect(result.agents.bootstrapper.model).toBe("test-model");
    expect(result.port).toBe(3000);
  });

  it("should handle invalid JSON gracefully and return defaults", async () => {
    writeFileSync(join(configDir, "octto.json"), "{ not valid json }");

    const result = await loadCustomConfig(stubAgents, configDir);

    expect(result.agents).toEqual(stubAgents);
    expect(result.port).toBe(0);
  });

  it("should salvage valid agents from partially invalid config", async () => {
    writeFileSync(
      join(configDir, "octto.json"),
      JSON.stringify({
        agents: {
          octto: { model: "good-model" },
          bootstrapper: { temperature: 999 },
        },
      }),
    );

    const result = await loadCustomConfig(stubAgents, configDir);

    expect(result.agents.octto.model).toBe("good-model");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("should include fragments from config", async () => {
    writeFileSync(
      join(configDir, "octto.json"),
      JSON.stringify({
        fragments: {
          octto: ["Be concise"],
        },
      }),
    );

    const result = await loadCustomConfig(stubAgents, configDir);

    expect(result.fragments).toEqual({ octto: ["Be concise"] });
  });

  it("should apply top-level model to all agents", async () => {
    writeFileSync(
      join(configDir, "octto.json"),
      JSON.stringify({
        model: "anthropic/claude-sonnet-4",
      }),
    );

    const result = await loadCustomConfig(stubAgents, configDir);

    expect(result.agents.octto.model).toBe("anthropic/claude-sonnet-4");
    expect(result.agents.bootstrapper.model).toBe("anthropic/claude-sonnet-4");
    expect(result.agents.probe.model).toBe("anthropic/claude-sonnet-4");
    // Non-model fields should remain unchanged
    expect(result.agents.octto.prompt).toBe("octto prompt");
  });

  it("should let per-agent model override top-level model", async () => {
    writeFileSync(
      join(configDir, "octto.json"),
      JSON.stringify({
        model: "anthropic/claude-sonnet-4",
        agents: {
          probe: { model: "openai/gpt-4o" },
        },
      }),
    );

    const result = await loadCustomConfig(stubAgents, configDir);

    expect(result.agents.octto.model).toBe("anthropic/claude-sonnet-4");
    expect(result.agents.bootstrapper.model).toBe("anthropic/claude-sonnet-4");
    expect(result.agents.probe.model).toBe("openai/gpt-4o");
  });

  it("should use defaults when top-level model is not set", async () => {
    writeFileSync(
      join(configDir, "octto.json"),
      JSON.stringify({}),
    );

    const result = await loadCustomConfig(stubAgents, configDir);

    expect(result.agents.octto.model).toBe("test-model");
    expect(result.agents.bootstrapper.model).toBe("test-model");
    expect(result.agents.probe.model).toBe("test-model");
  });

  it("should salvage top-level model from partially invalid config", async () => {
    writeFileSync(
      join(configDir, "octto.json"),
      JSON.stringify({
        model: "anthropic/claude-sonnet-4",
        agents: {
          octto: { temperature: 999 },
        },
      }),
    );

    const result = await loadCustomConfig(stubAgents, configDir);

    // Top-level model should still apply even when agent config is invalid
    expect(result.agents.octto.model).toBe("anthropic/claude-sonnet-4");
    expect(result.agents.bootstrapper.model).toBe("anthropic/claude-sonnet-4");
    expect(result.agents.probe.model).toBe("anthropic/claude-sonnet-4");
    expect(warnSpy).toHaveBeenCalled();
  });
});
