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

    // A tool result can mention several session ids (create_brainstorm returns
    // both the state session and the browser session that owns the server).
    // Track them all: endSession no-ops on ids the session store doesn't own.
    if (toolCtx.sessionID) {
      if (!tracked.has(toolCtx.sessionID)) {
        tracked.set(toolCtx.sessionID, new Set());
      }
      const octtoSessions = tracked.get(toolCtx.sessionID);
      for (const match of outputText(executeOutput).matchAll(/ses_[a-z0-9]+/g)) {
        octtoSessions?.add(match[0]);
      }
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
  // Brainstorm browser sessions are created inside create_brainstorm, not via
  // start_session: without wrapping it too, deleting the opencode session
  // mid-brainstorm leaks the octto server (issue #58).
  wrapWithTracking(tools.create_brainstorm, tracked);

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
