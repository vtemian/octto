import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentConfig } from "@opencode-ai/sdk";
import * as v from "valibot";

import { AGENTS } from "@/agents";

import { AgentOverrideSchema, type OcttoConfig, OcttoConfigSchema } from "./schema";

export type { AgentOverride, OcttoConfig } from "./schema";

const VALID_AGENT_NAMES = Object.values(AGENTS);

function formatValidationErrors(issues: v.BaseIssue<unknown>[]): string {
  return issues
    .map((issue) => {
      const path = issue.path?.map((p) => p.key).join(".") ?? "root";
      return `  - ${path}: ${issue.message}`;
    })
    .join("\n");
}

/**
 * Load raw user configuration from ~/.config/opencode/octto.json
 * Uses partial validation: logs errors but salvages valid agent overrides.
 */
async function load(configDir?: string): Promise<OcttoConfig | null> {
  const baseDir = configDir ?? join(homedir(), ".config", "opencode");
  const configPath = join(baseDir, "octto.json");

  let parsed: unknown;
  try {
    const content = await readFile(configPath, "utf-8");
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  // Try full validation first
  const result = v.safeParse(OcttoConfigSchema, parsed);
  if (result.success) {
    return result.output;
  }

  // Full validation failed - try partial validation
  console.warn(`[octto] Config validation errors in ${configPath}:`);
  console.warn(formatValidationErrors(result.issues));

  // Attempt to salvage valid agents
  if (typeof parsed !== "object" || parsed === null || !("agents" in parsed)) {
    console.warn("[octto] No valid agents found in config, using defaults");
    return null;
  }

  const rawAgents = (parsed as { agents: unknown }).agents;
  if (typeof rawAgents !== "object" || rawAgents === null) {
    console.warn("[octto] Invalid agents format, using defaults");
    return null;
  }

  const validAgents: OcttoConfig["agents"] = {};
  let hasValidAgent = false;

  for (const [name, override] of Object.entries(rawAgents)) {
    if (!VALID_AGENT_NAMES.includes(name as AGENTS)) {
      console.warn(`[octto] Unknown agent "${name}" - valid names: ${VALID_AGENT_NAMES.join(", ")}`);
      continue;
    }

    const agentResult = v.safeParse(AgentOverrideSchema, override);
    if (agentResult.success) {
      validAgents[name as AGENTS] = agentResult.output;
      hasValidAgent = true;
    } else {
      console.warn(`[octto] Invalid config for agent "${name}":`);
      console.warn(formatValidationErrors(agentResult.issues));
    }
  }

  if (!hasValidAgent) {
    console.warn("[octto] No valid agent overrides found, using defaults");
    return null;
  }

  console.warn("[octto] Partial config loaded - some overrides applied despite errors");
  return { agents: validAgents };
}

/**
 * Load user configuration and merge with plugin agents.
 * Returns merged agent configs with user overrides applied.
 */
export async function loadCustomConfig(
  agents: Record<AGENTS, AgentConfig>,
  configDir?: string,
): Promise<Record<AGENTS, AgentConfig>> {
  const config = await load(configDir);

  if (!config?.agents) {
    return agents;
  }

  const result = { ...agents };
  for (const [name, override] of Object.entries(config.agents)) {
    result[name as AGENTS] = { ...agents[name as AGENTS], ...override };
  }

  return result;
}
