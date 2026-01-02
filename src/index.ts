// src/index.ts
import type { Plugin } from "@opencode-ai/plugin";
import { SessionManager } from "./session/manager";
import { createBrainstormerTools } from "./tools";

const BrainstormerPlugin: Plugin = async (ctx) => {
  // Create session manager
  const sessionManager = new SessionManager();

  // Track which brainstormer sessions belong to which OpenCode sessions
  const sessionsByOpenCodeSession = new Map<string, Set<string>>();

  // Create all tools with session tracking
  const baseTools = createBrainstormerTools(sessionManager);

  // Wrap start_session to track ownership
  const wrappedStartSession = {
    ...baseTools.start_session,
    execute: async (args: { title?: string }, toolCtx: { sessionID: string }) => {
      const result = await sessionManager.startSession({ title: args.title });

      // Track this brainstormer session
      const openCodeSessionId = toolCtx.sessionID;
      if (!sessionsByOpenCodeSession.has(openCodeSessionId)) {
        sessionsByOpenCodeSession.set(openCodeSessionId, new Set());
      }
      sessionsByOpenCodeSession.get(openCodeSessionId)!.add(result.session_id);

      return `## Session Started

| Field | Value |
|-------|-------|
| Session ID | ${result.session_id} |
| URL | ${result.url} |

Browser opened. Use question tools (pick_one, confirm, etc.) to push questions.
Use get_answer to retrieve responses.`;
    },
  };

  return {
    tool: {
      ...baseTools,
      start_session: wrappedStartSession,
    },

    event: async ({ event }) => {
      // Cleanup sessions when OpenCode session is deleted
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

// Re-export types for consumers
export type * from "./types";
