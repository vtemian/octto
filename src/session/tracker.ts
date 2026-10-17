import type { OcttoTool } from "@/tools";

export interface Tracker {
  /** Returns a tool whose output is scanned for octto session ids. */
  wrap(tool: OcttoTool): OcttoTool;
  /** Ends every octto session the host session owns, then forgets it. */
  release(hostSessionId: string): Promise<void>;
}

const SESSION_ID_PATTERN = /ses_[a-z0-9]+/g;

export function createTracker(endSession: (sessionId: string) => Promise<void>): Tracker {
  const owned = new Map<string, Set<string>>();

  function remember(hostSessionId: string, output: string): void {
    const sessions = owned.get(hostSessionId) ?? new Set<string>();
    for (const match of output.matchAll(SESSION_ID_PATTERN)) {
      sessions.add(match[0]);
    }
    owned.set(hostSessionId, sessions);
  }

  return {
    wrap(tool) {
      return {
        ...tool,
        async execute(args, call) {
          // A tool result can mention several ids (create_brainstorm returns the
          // state session and the browser session). Track them all: endSession
          // no-ops on ids the session store does not own.
          const output = await tool.execute(args, call);
          if (call.sessionID) remember(call.sessionID, text(output));
          return output;
        },
      };
    },

    async release(hostSessionId) {
      const sessions = owned.get(hostSessionId);
      if (!sessions) return;
      owned.delete(hostSessionId);
      for (const sessionId of sessions) {
        await endSession(sessionId);
      }
    },
  };
}

// Goes away once the tools refactor makes execute() return a plain string.
function text(output: string | { readonly output: string }): string {
  return typeof output === "string" ? output : output.output;
}
