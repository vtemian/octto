// src/config-loader.ts
import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { AgentConfig } from "@opencode-ai/sdk";

/**
 * Safe properties that users can override for agents.
 * Intentionally limited to prevent prompt injection or behavior changes.
 */
export interface AgentOverride {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface BrainstormerConfig {
  agents?: Record<string, AgentOverride>;
}

/**
 * Load user configuration from ~/.config/opencode/brainstormer.json
 * Returns null if file doesn't exist or is invalid.
 */
export async function loadBrainstormerConfig(
  configDir?: string,
): Promise<BrainstormerConfig | null> {
  const baseDir = configDir ?? join(homedir(), ".config", "opencode");
  const configPath = join(baseDir, "brainstormer.json");

  try {
    const content = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(content) as Record<string, unknown>;

    // Sanitize: only allow known safe properties
    const config: BrainstormerConfig = {};

    if (parsed.agents && typeof parsed.agents === "object") {
      config.agents = {};
      for (const [agentName, overrides] of Object.entries(
        parsed.agents as Record<string, unknown>,
      )) {
        if (overrides && typeof overrides === "object") {
          const safeOverrides: AgentOverride = {};
          const o = overrides as Record<string, unknown>;

          if (typeof o.model === "string") {
            safeOverrides.model = o.model;
          }
          if (typeof o.temperature === "number") {
            safeOverrides.temperature = o.temperature;
          }
          if (typeof o.maxTokens === "number") {
            safeOverrides.maxTokens = o.maxTokens;
          }

          if (Object.keys(safeOverrides).length > 0) {
            config.agents[agentName] = safeOverrides;
          }
        }
      }
    }

    return Object.keys(config).length > 0 ? config : null;
  } catch {
    return null;
  }
}

/**
 * Merge plugin default agents with user overrides.
 * User overrides take precedence for safe properties only.
 */
export function mergeAgentConfigs(
  pluginAgents: Record<string, AgentConfig>,
  userConfig: BrainstormerConfig | null,
): Record<string, AgentConfig> {
  if (!userConfig?.agents) {
    return pluginAgents;
  }

  const merged: Record<string, AgentConfig> = {};

  for (const [name, agent] of Object.entries(pluginAgents)) {
    const overrides = userConfig.agents[name];
    if (overrides) {
      merged[name] = {
        ...agent,
        ...(overrides.model && { model: overrides.model }),
        ...(overrides.temperature !== undefined && {
          temperature: overrides.temperature,
        }),
        ...(overrides.maxTokens !== undefined && {
          maxTokens: overrides.maxTokens,
        }),
      };
    } else {
      merged[name] = agent;
    }
  }

  return merged;
}
