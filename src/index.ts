// src/index.ts

import type { Plugin } from "@opencode-ai/plugin";

import { AGENTS, agents } from "@/agents";
import { loadCustomConfig } from "@/config";
import { createFragmentInjector, getAgentSystemPromptPrefix, warnUnknownAgents } from "@/hooks";
import { createSessionStore } from "@/session";
import { createOcttoTools } from "@/tools";
import type { OcttoTool } from "@/tools/types";

function wrapWithTracking(tool: OcttoTool, tracked: Map<string, Set<string>>): void {
  const originalExecute = tool.execute;
  tool.execute = async (args, toolCtx) => {
    const result = await originalExecute(args, toolCtx);
    const match = result.match(/ses_[a-z0-9]+/);

    if (match && toolCtx.sessionID) {
      if (!tracked.has(toolCtx.sessionID)) {
        tracked.set(toolCtx.sessionID, new Set());
      }
      tracked.get(toolCtx.sessionID)?.add(match[0]);
    }

    return result;
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
      config.agent = { ...config.agent, ...customConfig.agents };
    },

    event: async ({ event }) => {
      if (event.type !== "session.deleted") return;

      const props = event.properties as { info?: { id?: string } };
      const id = props?.info?.id;
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
