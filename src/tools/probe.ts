import type { AgentName } from "@/agents";

/**
 * Runs one prompt against an octto agent on a throwaway session and returns the
 * assistant's text. Each host implements it on its own session API.
 */
export interface ProbeRunner {
  run(agent: AgentName, text: string): Promise<string>;
}
