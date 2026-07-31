import type { Plugin } from "@opencode-ai/plugin";
import type { AgentConfig } from "@opencode-ai/sdk";

import { AGENTS, agents } from "@/agents";
import { loadCustomConfig } from "@/config";
import { createFragmentInjector, getAgentSystemPromptPrefix, warnUnknownAgents } from "@/hooks";
import { createSessionStore } from "@/session";
import type { OcttoTool } from "@/tools";
import { createOcttoTools, outputText } from "@/tools";

/**
 * Layers octto's agents onto whatever the host resolved so far.
 *
 * Merges per agent rather than replacing the entry, so keys other plugins set
 * (permissions, for example) survive. Each entry is a fresh object: handing out
 * our own would let another plugin's in-place mutation reach octto's state and
 * persist across config resolutions.
 */
type ResolvedAgents = Record<string, AgentConfig | undefined>;

function mergeAgents(existing: ResolvedAgents | undefined, ours: Record<string, AgentConfig>): ResolvedAgents {
  const merged: ResolvedAgents = { ...existing };

  for (const [name, agent] of Object.entries(ours)) {
    merged[name] = { ...merged[name], ...agent };
  }

  return merged;
}

function wrapWithTracking(tool: OcttoTool, tracked: Map<string, Set<string>>): void {
  const originalExecute = tool.execute;
  tool.execute = async (args, toolCtx) => {
    const executeOutput = await originalExecute(args, toolCtx);
    const match = outputText(executeOutput).match(/ses_[a-z0-9]+/);

    if (match && toolCtx.sessionID) {
      if (!tracked.has(toolCtx.sessionID)) {
        tracked.set(toolCtx.sessionID, new Set());
      }
      tracked.get(toolCtx.sessionID)?.add(match[0]);
    }

    return executeOutput;
  };
}

const Octto: Plugin = async ({ client, directory }) => {
  const customConfig = await loadCustomConfig(agents);
  const fragments = await createFragmentInjector({ projectDir: directory }, customConfig.fragments);

  for (const agentName of Object.values(AGENTS)) {
    const prefix = getAgentSystemPromptPrefix(fragments, agentName);
    if (prefix && customConfig.agents[agentName]?.prompt) {
      customConfig.agents[agentName].prompt = prefix + customConfig.agents[agentName].prompt;
    }
  }

  warnUnknownAgents(customConfig.fragments);
  const sessions = createSessionStore({ port: customConfig.port });
  const tracked = new Map<string, Set<string>>();
  const tools = createOcttoTools(sessions, client);

  wrapWithTracking(tools.start_session, tracked);

  return {
    tool: tools,

    config: async (config) => {
      config.agent = mergeAgents(config.agent, customConfig.agents);
    },

    event: async ({ event }) => {
      if (event.type !== "session.deleted") return;

      const id = event.properties.info.id;
      const octtoSessions = id && tracked.get(id);

      if (octtoSessions) {
        for (const sessionId of octtoSessions) {
          await sessions.endSession(sessionId);
        }
        tracked.delete(id);
      }
    },
  };
};

export default Octto;

export type * from "./types";
