import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { AgentConfig } from "@opencode-ai/sdk";

import { AGENTS, type AgentName, agents } from "@/agents";
import { loadCustomConfig } from "@/config";
import { createFragmentInjector, getAgentSystemPromptPrefix, warnUnknownAgents } from "@/hooks";
import { createSessionStore } from "@/session";
import type { OcttoTool, ProbeRunner } from "@/tools";
import { createOcttoTools } from "@/tools";

type Client = PluginInput["client"];

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
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args, toolCtx) => {
    const output = await originalExecute(args, toolCtx);

    // A tool result can mention several session ids (create_brainstorm returns
    // both the state session and the browser session that owns the server).
    // Track them all: endSession no-ops on ids the session store doesn't own.
    if (toolCtx.sessionID) {
      if (!tracked.has(toolCtx.sessionID)) {
        tracked.set(toolCtx.sessionID, new Set());
      }
      const octtoSessions = tracked.get(toolCtx.sessionID);
      for (const match of output.matchAll(/ses_[a-z0-9]+/g)) {
        octtoSessions?.add(match[0]);
      }
    }

    return output;
  };
}

function joinTextParts(parts: readonly { type: string; text?: unknown }[]): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("");
}

// Temporary: the v1 host adapter takes this over once src/host/ lands.
function createClientProbe(client: Client): ProbeRunner {
  return {
    async run(agent: AgentName, text: string): Promise<string> {
      const session = await client.session.create({ body: { title: `probe-${agent}` } });
      if (!session.data) throw new Error("Failed to create probe session");
      const sessionId = session.data.id;

      try {
        const prompt = await client.session.prompt({
          path: { id: sessionId },
          body: { agent, tools: {}, parts: [{ type: "text", text }] },
        });
        if (!prompt.data) throw new Error("Failed to get probe response");
        return joinTextParts(prompt.data.parts);
      } finally {
        await client.session.delete({ path: { id: sessionId } }).catch((_error: unknown) => {
          /* cleanup errors are non-fatal */
        });
      }
    },
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
  const tools = createOcttoTools(sessions, createClientProbe(client));

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
