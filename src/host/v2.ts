import type { Plugin } from "@opencode/plugin";
import type { AgentEditor } from "@opencode/plugin/promise/agent";
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";
import type { AgentConfig } from "@opencode-ai/sdk";
import { z } from "zod";

import { AGENTS, type AgentName } from "@/agents";
import { createOctto, type Octto } from "@/octto";
import type { OcttoTool, ProbeRunner } from "@/tools";

/** The slice of the v2 plugin context octto uses. Tests fake exactly this. */
export type V2Host = Pick<Plugin.Context, "location" | "tool" | "agent" | "event" | "session">;

type AgentRecord = Parameters<Parameters<AgentEditor["update"]>[1]>[0];
type ModelRef = NonNullable<AgentRecord["model"]>;
type Apply = (agent: AgentRecord) => void;
type V2Tool = ToolInfo<z.ZodObject<z.ZodRawShape>, undefined>;
type SessionMessage = Awaited<ReturnType<V2Host["session"]["context"]>>[number];
type AssistantReply = Extract<SessionMessage, { type: "assistant" }>;
type ReplyPart = AssistantReply["content"][number];

const SESSION_DELETED = "session.deleted";
const PROBE_TITLE_PREFIX = "probe-";
/** The probe only reads user answers and emits JSON; v1 ran it with `tools: {}`. */
const DENY_ALL_TOOLS = [{ action: "*", resource: "*", effect: "deny" }] as const;
const deletedSessionSchema = z.object({ data: z.object({ sessionID: z.string() }) });

/** The v1 SDK's AgentConfig declares no `variant`, but octto's custom config may carry one. */
const variantSchema = z.object({ variant: z.string().optional() });

export async function setup(host: V2Host): Promise<Plugin.Cleanup> {
  const octto = await createOctto({ directory: host.location.directory, probe: createSessionProbe(host.session) });

  await host.tool.transform((editor) => {
    for (const [name, core] of Object.entries(octto.tools)) {
      editor.add(toV2Tool(name, core));
    }
  });
  await registerAgents(host, octto);
  const stopWatching = watchSessionDeletes(host, octto);

  return async () => {
    stopWatching();
    await octto.dispose();
  };
}

export async function toAgentInfo(agent: AgentRecord, config: AgentConfig): Promise<void> {
  applyConfig(agent, config, await resolveModel(config));
}

export function createSessionProbe(session: V2Host["session"]): ProbeRunner {
  return {
    async run(agent: AgentName, text: string): Promise<string> {
      const { id: sessionID } = await session.create({
        title: `${PROBE_TITLE_PREFIX}${agent}`,
        agent,
        permissions: [...DENY_ALL_TOOLS],
      });
      try {
        await session.prompt({ sessionID, text });
        await session.wait({ sessionID });
        return lastAssistantText(await session.context({ sessionID }));
      } finally {
        await removeQuietly(session, sessionID);
      }
    },
  };
}

function toV2Tool(name: string, core: OcttoTool): V2Tool {
  return {
    name,
    description: core.description,
    input: z.object(core.args),
    // Verified on 2.0.31: tools default to Code Mode only, and the agent prompts
    // call these by name, so they must be listed as direct function tools.
    options: { codemode: false },
    execute: async (input: unknown, context) => ({
      content: await core.execute(input, { sessionID: context.sessionID }),
    }),
  };
}

function variantOf(config: AgentConfig): string | undefined {
  const candidate: unknown = config;
  const parsed = variantSchema.safeParse(candidate);
  return parsed.success ? parsed.data.variant : undefined;
}

async function resolveModel(config: AgentConfig): Promise<ModelRef | undefined> {
  if (config.model === undefined) return undefined;
  // Dynamic on purpose: the v1 host must never load the v2 SDK.
  const { Model } = await import("@opencode/plugin");
  const variant = variantOf(config);
  return Model.Ref.parse(variant ? `${config.model}#${variant}` : config.model);
}

function applyConfig(agent: AgentRecord, config: AgentConfig, model: ModelRef | undefined): void {
  if (config.description !== undefined) agent.description = config.description;
  if (config.mode !== undefined) agent.mode = config.mode;
  if (config.prompt !== undefined) agent.system = config.prompt;
  if (model !== undefined) agent.model = model;
  if (config.temperature !== undefined) agent.request.body.temperature = config.temperature;
  if (config.maxSteps !== undefined) agent.steps = config.maxSteps;
}

function lockDownProbe(agent: AgentRecord): void {
  agent.permissions = [...DENY_ALL_TOOLS];
}

async function prepareAgents(octto: Octto): Promise<ReadonlyMap<string, Apply>> {
  const prepared = new Map<string, Apply>();
  for (const [name, config] of Object.entries(octto.agents)) {
    const model = await resolveModel(config);
    prepared.set(name, (agent) => {
      applyConfig(agent, config, model);
      if (name === AGENTS.probe) lockDownProbe(agent);
    });
  }
  return prepared;
}

async function registerAgents(host: V2Host, octto: Octto): Promise<void> {
  // The host replays transforms synchronously, so the branded model refs are
  // resolved up front and the callback only assigns.
  const prepared = await prepareAgents(octto);
  await host.agent.transform((editor) => {
    for (const [name, apply] of prepared) {
      editor.update(name, apply);
    }
  });
}

function isAssistant(message: SessionMessage): message is AssistantReply {
  return message.type === "assistant";
}

function isText(part: ReplyPart): part is Extract<ReplyPart, { type: "text" }> {
  return part.type === "text";
}

function isCompleted(reply: AssistantReply): boolean {
  return reply.time.completed !== undefined;
}

/**
 * Mirrors the host's own subagent reader: only a completed, error-free turn
 * counts. v1 threw on a failed probe; keeping that contract means a provider
 * outage is logged by the brainstorm loop instead of recorded as a finding.
 */
function lastAssistantText(messages: readonly SessionMessage[]): string {
  const completed = messages.filter(isAssistant).filter(isCompleted);
  const reply = completed.at(-1);
  if (!reply) throw new Error("Probe returned no completed reply");
  if (reply.error) throw new Error(`Probe failed: ${reply.error.message}`);
  return reply.content
    .filter(isText)
    .map((part) => part.text)
    .join("");
}

async function removeQuietly(session: V2Host["session"], sessionID: string): Promise<void> {
  try {
    await session.remove({ sessionID });
  } catch (error: unknown) {
    // The probe already has its answer (or its failure); a leaked throwaway
    // session is not worth failing the brainstorm over.
    console.warn(`[octto] failed to remove probe session ${sessionID}:`, error);
  }
}

async function relaySessionDeletes(host: V2Host, octto: Octto, signal: AbortSignal): Promise<void> {
  for await (const event of host.event.subscribe({ signal })) {
    if (event.type !== SESSION_DELETED) continue;
    await relayOne(octto, event);
  }
}

/** One bad event must not end the subscription for the plugin's lifetime. */
async function relayOne(octto: Octto, event: unknown): Promise<void> {
  const parsed = deletedSessionSchema.safeParse(event);
  if (!parsed.success) {
    console.error("[octto] ignoring malformed session.deleted event:", parsed.error.message);
    return;
  }
  try {
    await octto.onSessionDeleted(parsed.data.data.sessionID);
  } catch (error: unknown) {
    console.error(`[octto] failed to end sessions for ${parsed.data.data.sessionID}:`, error);
  }
}

function watchSessionDeletes(host: V2Host, octto: Octto): () => void {
  const controller = new AbortController();
  void relaySessionDeletes(host, octto, controller.signal).catch((error: unknown) => {
    if (controller.signal.aborted) return;
    console.error("[octto] host event stream ended unexpectedly:", error);
  });
  return () => controller.abort();
}
