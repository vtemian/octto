import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { type ToolDefinition, tool } from "@opencode-ai/plugin/tool";
import type { AgentConfig } from "@opencode-ai/sdk";

import type { AgentName } from "@/agents";
import { createOctto } from "@/octto";
import type { OcttoTool, ProbeRunner } from "@/tools";

type ResolvedAgents = Record<string, AgentConfig | undefined>;
type Client = PluginInput["client"];

/**
 * An empty map adds no rules, leaving the probe every tool; a permission ask in
 * its parentless session would then wait forever, since nobody can answer it.
 */
const DENY_ALL_TOOLS = { "*": false } as const;

/**
 * Layers octto's agents onto whatever the host resolved so far.
 *
 * Merges per agent rather than replacing the entry, so keys other plugins set
 * (permissions, for example) survive. Each entry is a fresh object: handing out
 * our own would let another plugin's in-place mutation reach octto's state and
 * persist across config resolutions.
 */
export function mergeAgents(existing: ResolvedAgents | undefined, ours: Record<string, AgentConfig>): ResolvedAgents {
  const merged: ResolvedAgents = { ...existing };
  for (const [name, agent] of Object.entries(ours)) {
    merged[name] = { ...merged[name], ...agent };
  }
  return merged;
}

export function joinTextParts(parts: readonly { type: string; text?: unknown }[]): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("");
}

export function toV1Tool(core: OcttoTool): ToolDefinition {
  return tool({
    description: core.description,
    args: core.args,
    execute: (args, context) => core.execute(args, { sessionID: context.sessionID }),
  });
}

export function createClientProbe(client: Client): ProbeRunner {
  return {
    async run(agent: AgentName, text: string): Promise<string> {
      const session = await client.session.create({ body: { title: `probe-${agent}` } });
      if (!session.data) throw new Error("Failed to create probe session");
      const sessionId = session.data.id;

      try {
        const prompt = await client.session.prompt({
          path: { id: sessionId },
          body: { agent, tools: DENY_ALL_TOOLS, parts: [{ type: "text", text }] },
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

export const server: Plugin = async ({ client, directory }) => {
  const octto = await createOctto({ directory, probe: createClientProbe(client) });

  const tools: Record<string, ToolDefinition> = {};
  for (const [name, core] of Object.entries(octto.tools)) {
    tools[name] = toV1Tool(core);
  }

  const hooks: Hooks = {
    tool: tools,
    config: async (config) => {
      config.agent = mergeAgents(config.agent, octto.agents);
    },
    event: async ({ event }) => {
      if (event.type !== "session.deleted") return;
      await octto.onSessionDeleted(event.properties.info.id);
    },
  };
  return hooks;
};
