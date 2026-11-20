import type { OcttoTool } from "@/tools";

export interface Tracker {
  /** Gives a session-creating tool a callback to register the browser session it opened. */
  wrap(tool: OcttoTool): OcttoTool;
  /** Ends every octto session the host session owns, then forgets it. */
  release(hostSessionId: string): Promise<void>;
}

interface Ownership {
  readonly sessions: Set<string>;
  released: boolean;
}

export function createTracker(endSession: (sessionId: string) => Promise<void>): Tracker {
  const owned = new Map<string, Ownership>();

  async function endQuietly(sessionId: string): Promise<void> {
    try {
      await endSession(sessionId);
    } catch (error: unknown) {
      console.error(`[octto] Failed to end browser session ${sessionId}:`, error);
    }
  }

  return {
    wrap(tool) {
      return {
        ...tool,
        async execute(args, call) {
          if (!call.sessionID) return tool.execute(args, call);
          const owner = owned.get(call.sessionID) ?? { sessions: new Set<string>(), released: false };
          owned.set(call.sessionID, owner);
          return tool.execute(args, {
            ...call,
            async trackBrowserSession(sessionId) {
              // The call may finish opening a browser after the host has been deleted.
              if (owner.released) await endQuietly(sessionId);
              else owner.sessions.add(sessionId);
            },
          });
        },
      };
    },

    async release(hostSessionId) {
      const owner = owned.get(hostSessionId);
      if (!owner) return;
      owned.delete(hostSessionId);
      owner.released = true;
      await Promise.all([...owner.sessions].map(endQuietly));
    },
  };
}
