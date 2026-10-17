import type { AgentConfig } from "@opencode-ai/sdk";

import { AGENTS, type AgentName, agents } from "@/agents";
import { loadCustomConfig } from "@/config";
import { createFragmentInjector, getAgentSystemPromptPrefix, warnUnknownAgents } from "@/hooks";
import { createSessionStore, createTracker } from "@/session";
import { createOcttoTools, type OcttoTools, type ProbeRunner } from "@/tools";

export interface OcttoOptions {
  /** Project directory the host loaded octto for; fragments are read from here. */
  readonly directory: string;
  readonly probe: ProbeRunner;
  /** Where octto.json lives; defaults to ~/.config/opencode. */
  readonly configDir?: string;
}

export interface Octto {
  readonly tools: OcttoTools;
  /** Agents in v1 AgentConfig shape; the v2 adapter maps them. */
  readonly agents: Record<AgentName, AgentConfig>;
  /** The host conversation was deleted: end every octto session it owns. */
  onSessionDeleted(hostSessionId: string): Promise<void>;
  dispose(): Promise<void>;
}

const TRACKED_TOOLS = ["start_session", "create_brainstorm"] as const;

export async function createOctto({ directory, probe, configDir }: OcttoOptions): Promise<Octto> {
  const customConfig = await loadCustomConfig(agents, configDir);
  const fragments = await createFragmentInjector({ projectDir: directory }, customConfig.fragments);

  for (const agentName of Object.values(AGENTS)) {
    const prefix = getAgentSystemPromptPrefix(fragments, agentName);
    if (prefix && customConfig.agents[agentName]?.prompt) {
      customConfig.agents[agentName].prompt = prefix + customConfig.agents[agentName].prompt;
    }
  }
  warnUnknownAgents(customConfig.fragments);

  const sessions = createSessionStore({ port: customConfig.port });
  const tracker = createTracker(async (sessionId) => {
    await sessions.endSession(sessionId);
  });
  const tools = createOcttoTools(sessions, probe);

  // Brainstorm browser sessions are created inside create_brainstorm, not via
  // start_session: without tracking it too, deleting the host session
  // mid-brainstorm leaks the octto server (issue #58).
  for (const name of TRACKED_TOOLS) {
    tools[name] = tracker.wrap(tools[name]);
  }

  return {
    tools,
    agents: customConfig.agents,
    onSessionDeleted: (hostSessionId) => tracker.release(hostSessionId),
    dispose: () => sessions.cleanup(),
  };
}
