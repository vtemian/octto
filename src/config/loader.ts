import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentConfig } from "@opencode-ai/sdk";
import * as v from "valibot";

import { AGENTS, type AgentName, isAgentName } from "@/agents";

import { AgentOverrideSchema, type Fragments, MAX_PORT, type OcttoConfig, OcttoConfigSchema } from "./schema";

export type { AgentOverride, Fragments, OcttoConfig } from "./schema";

export interface CustomConfig {
  agents: Record<AgentName, AgentConfig>;
  port: number;
  fragments: Fragments;
}

const OCTTO_PORT_ENV = "OCTTO_PORT";
const DEFAULT_PORT = 0;

/**
 * Resolve port from environment variable or config.
 * Priority: OCTTO_PORT env var > config port > default (0 = random)
 */
export function resolvePort(configPort?: number): number {
  const envValue = process.env[OCTTO_PORT_ENV];

  if (envValue !== undefined) {
    const parsed = Number(envValue);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_PORT) {
      return parsed;
    }
  }

  return configPort ?? DEFAULT_PORT;
}

const VALID_AGENT_NAMES = Object.values(AGENTS);

function formatValidationErrors(issues: v.BaseIssue<unknown>[]): string {
  return issues
    .map((issue) => {
      const path = issue.path?.map((p) => p.key).join(".") ?? "root";
      return `  - ${path}: ${issue.message}`;
    })
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function salvageModel(parsed: Record<string, unknown>): string | undefined {
  if ("model" in parsed && typeof parsed.model === "string" && parsed.model.length > 0) {
    return parsed.model;
  }
  return undefined;
}

function salvageAgentOverrides(parsed: Record<string, unknown>): OcttoConfig["agents"] | undefined {
  if (!("agents" in parsed) || !isRecord(parsed.agents)) {
    return undefined;
  }

  const validAgents: OcttoConfig["agents"] = {};
  let hasValidAgent = false;

  for (const [name, override] of Object.entries(parsed.agents)) {
    if (!isAgentName(name)) {
      console.warn(`[octto] Unknown agent "${name}" - valid names: ${VALID_AGENT_NAMES.join(", ")}`);
      continue;
    }

    const agentResult = v.safeParse(AgentOverrideSchema, override);
    if (agentResult.success) {
      validAgents[name] = agentResult.output;
      hasValidAgent = true;
    } else {
      console.warn(`[octto] Invalid config for agent "${name}":`);
      console.warn(formatValidationErrors(agentResult.issues));
    }
  }

  return hasValidAgent ? validAgents : undefined;
}

function salvageValidConfig(parsed: Record<string, unknown>): OcttoConfig | null {
  const model = salvageModel(parsed);
  const agents = salvageAgentOverrides(parsed);

  if (model || agents) {
    console.warn("[octto] Partial config loaded - some overrides applied despite errors");
    return { ...(model ? { model } : {}), ...(agents ? { agents } : {}) };
  }

  console.warn("[octto] No valid overrides found in config, using defaults");
  return null;
}

async function load(configDir?: string): Promise<OcttoConfig | null> {
  const baseDir = configDir ?? join(homedir(), ".config", "opencode");
  const configPath = join(baseDir, "octto.json");

  let parsed: unknown;
  try {
    const content = await readFile(configPath, "utf-8");
    parsed = JSON.parse(content);
  } catch (_error: unknown) {
    /* config file not found or unreadable */
    return null;
  }

  const configValidation = v.safeParse(OcttoConfigSchema, parsed);
  if (configValidation.success) {
    return configValidation.output;
  }

  console.warn(`[octto] Config validation errors in ${configPath}:`);
  console.warn(formatValidationErrors(configValidation.issues));

  if (!isRecord(parsed)) {
    console.warn("[octto] No valid agents found in config, using defaults");
    return null;
  }

  return salvageValidConfig(parsed);
}

/**
 * Load user configuration and merge with plugin agents.
 * Returns merged agent configs with user overrides applied, and resolved port.
 *
 * Merge order (later wins):
 *   1. Built-in agent defaults
 *   2. Top-level `model` (applied to every agent)
 *   3. Per-agent `agents.<name>` overrides
 */
export async function loadCustomConfig(
  agents: Record<AgentName, AgentConfig>,
  configDir?: string,
): Promise<CustomConfig> {
  const config = await load(configDir);

  const mergedAgents = { ...agents };

  // Apply top-level model to all agents first
  if (config?.model) {
    for (const name of Object.values(AGENTS)) {
      mergedAgents[name] = { ...mergedAgents[name], model: config.model };
    }
  }

  // Then apply per-agent overrides (these take precedence)
  for (const [name, override] of Object.entries(config?.agents ?? {})) {
    if (!isAgentName(name)) continue;
    mergedAgents[name] = { ...mergedAgents[name], ...override };
  }

  return {
    agents: mergedAgents,
    port: resolvePort(config?.port),
    fragments: config?.fragments,
  };
}
