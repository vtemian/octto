// src/index.ts
import type { Plugin } from "@opencode-ai/plugin";
import { SessionManager } from "./session/manager";
import { createBrainstormerTools } from "./tools";
import { agents } from "./agents";
import { loadBrainstormerConfig, mergeAgentConfigs } from "./config-loader";

const BrainstormerPlugin: Plugin = async (ctx) => {
  // Load user configuration and merge with default agents
  const userConfig = await loadBrainstormerConfig();
  const mergedAgents = mergeAgentConfigs(agents, userConfig);
  const sessionManager = new SessionManager();
  const sessionsByOpenCodeSession = new Map<string, Set<string>>();

  const baseTools = createBrainstormerTools(sessionManager, ctx.client);

  // Wrap start_session to track for cleanup
  const originalStartSession = baseTools.start_session;
  const wrappedStartSession = {
    ...originalStartSession,
    execute: async (args: Record<string, unknown>, toolCtx: import("@opencode-ai/plugin/tool").ToolContext) => {
      type StartSessionArgs = Parameters<typeof originalStartSession.execute>[0];
      const result = await originalStartSession.execute(args as StartSessionArgs, toolCtx);

      const sessionIdMatch = result.match(/ses_[a-z0-9]+/);
      if (sessionIdMatch && toolCtx.sessionID) {
        const brainstormSessionId = sessionIdMatch[0];
        const openCodeSessionId = toolCtx.sessionID;

        if (!sessionsByOpenCodeSession.has(openCodeSessionId)) {
          sessionsByOpenCodeSession.set(openCodeSessionId, new Set());
        }
        sessionsByOpenCodeSession.get(openCodeSessionId)!.add(brainstormSessionId);
      }

      return result;
    },
  };

  return {
    tool: {
      ...baseTools,
      start_session: wrappedStartSession,
    },

    config: async (config) => {
      config.agent = {
        ...config.agent,
        ...mergedAgents,
      };
    },

    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        const props = event.properties as { info?: { id?: string } } | undefined;
        const openCodeSessionId = props?.info?.id;

        if (openCodeSessionId) {
          const brainstormerSessions = sessionsByOpenCodeSession.get(openCodeSessionId);
          if (brainstormerSessions) {
            for (const sessionId of brainstormerSessions) {
              await sessionManager.endSession(sessionId);
            }
            sessionsByOpenCodeSession.delete(openCodeSessionId);
          }
        }
      }
    },
  };
};

export default BrainstormerPlugin;

export type * from "./types";
