// src/index.ts

import type { Plugin } from "@opencode-ai/plugin";

import { agents } from "@/agents";
import { loadCustomConfig } from "@/config";
import { createSessionStore } from "@/session";
import { createOcttoTools } from "@/tools";

const Octto: Plugin = async ({ client }) => {
  const customConfig = await loadCustomConfig(agents);
  const sessions = createSessionStore();
  const tracked = new Map<string, Set<string>>();
  const tools = createOcttoTools(sessions, client);

  const originalExecute = tools.start_session.execute;
  tools.start_session.execute = async (args, toolCtx) => {
    const result = await originalExecute(args, toolCtx);
    const match = result.match(/ses_[a-z0-9]+/);

    if (match && toolCtx.sessionID) {
      if (!tracked.has(toolCtx.sessionID)) {
        tracked.set(toolCtx.sessionID, new Set());
      }
      tracked.get(toolCtx.sessionID)!.add(match[0]);
    }

    return result;
  };

  return {
    tool: tools,

    config: async (config) => {
      config.agent = { ...config.agent, ...customConfig };
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
