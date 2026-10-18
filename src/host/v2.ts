import type { Model, Plugin } from "@opencode/plugin";
import type { AgentEditor } from "@opencode/plugin/promise/agent";
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";
import type { AgentConfig } from "@opencode-ai/sdk";
import { z } from "zod";

import { AGENTS, type AgentName, isAgentName } from "@/agents";
import { createOctto, type Octto } from "@/octto";
import type { OcttoTool, ProbeRunner } from "@/tools";

/** The slice of the v2 plugin context octto uses. Tests fake exactly this. */
export type V2Host = Pick<Plugin.Context, "location" | "tool" | "agent" | "event" | "session">;

type AgentRecord = Parameters<Parameters<AgentEditor["update"]>[1]>[0];
type ModelRef = ReturnType<typeof Model.Ref.parse>;
type Apply = (agent: AgentRecord) => void;
type Models = ReadonlyMap<string, ModelRef>;
type V2Tool = ToolInfo<z.ZodObject<z.ZodRawShape>, undefined>;
type SessionMessage = Awaited<ReturnType<V2Host["session"]["context"]>>[number];
type AssistantReply = Extract<SessionMessage, { type: "assistant" }>;
type ReplyPart = AssistantReply["content"][number];
type IdleMarker = Extract<SessionMessage, { type: "idle" }>;

const SESSION_DELETED = "session.deleted";
const PROBE_TITLE_PREFIX = "probe-";
const FAILED_OUTCOME = "failed";
/** The probe only reads user answers and emits JSON. */
const DENY_ALL_TOOLS = [{ action: "*", resource: "*", effect: "deny" }] as const;
const deletedSessionSchema = z.object({ data: z.object({ sessionID: z.string() }) });

/** The v1 SDK's AgentConfig declares no `variant`, but octto's custom config may carry one. */
const variantSchema = z.object({ variant: z.string().optional() });

export async function setup(host: V2Host, configDir?: string): Promise<Plugin.Cleanup> {
  // Filled once the agent models resolve, before any tool can run a probe.
  const models = new Map<string, ModelRef>();
  const octto = await createOctto({
    directory: host.location.directory,
    probe: createSessionProbe(host.session, models),
    configDir,
  });

  await host.tool.transform((editor) => {
    for (const [name, core] of Object.entries(octto.tools)) {
      editor.add(toV2Tool(name, core));
    }
  });
  await registerAgents(host, octto, models);
  const stopWatching = watchSessionDeletes(host, octto);

  return async () => {
    stopWatching();
    await octto.dispose();
  };
}

export async function toAgentInfo(agent: AgentRecord, config: AgentConfig): Promise<void> {
  applyConfig(agent, config, await resolveModel(config));
}

/**
 * v2 takes a session's model only from `session.create`, never from its agent,
 * so the probe passes the agent's resolved model itself.
 */
export function createSessionProbe(session: V2Host["session"], models: Models): ProbeRunner {
  return {
    async run(agent: AgentName, text: string): Promise<string> {
      const model = models.get(agent);
      const { id: sessionID } = await session.create({
        title: `${PROBE_TITLE_PREFIX}${agent}`,
        agent,
        permissions: [...DENY_ALL_TOOLS],
        ...(model ? { model } : {}),
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
  const reference = variant ? `${config.model}#${variant}` : config.model;
  try {
    return Model.Ref.parse(reference);
  } catch (error: unknown) {
    // A throw here would fail setup and the host would drop octto entirely;
    // v1 only fails the misconfigured agent, so fall back to the host default.
    console.warn(`[octto] ignoring model "${reference}", using the host default:`, error);
    return undefined;
  }
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

/**
 * Only a model the user chose is pinned. v1 keeps octto's built-in default, but
 * a v2 host may lack it, and pinning it there fails every probe and subagent run
 * that the host default would have answered.
 */
async function prepareAgents(octto: Octto, models: Map<string, ModelRef>): Promise<ReadonlyMap<string, Apply>> {
  const prepared = new Map<string, Apply>();
  for (const [name, config] of Object.entries(octto.agents)) {
    const model = isAgentName(name) && octto.modelOverrides.has(name) ? await resolveModel(config) : undefined;
    if (model !== undefined) models.set(name, model);
    prepared.set(name, (agent) => {
      applyConfig(agent, config, model);
      if (name === AGENTS.probe) lockDownProbe(agent);
    });
  }
  return prepared;
}

async function registerAgents(host: V2Host, octto: Octto, models: Map<string, ModelRef>): Promise<void> {
  // The host replays transforms synchronously, so the branded model refs are
  // resolved up front and the callback only assigns.
  const prepared = await prepareAgents(octto, models);
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

function isIdle(message: SessionMessage): message is IdleMarker {
  return message.type === "idle";
}

/**
 * Mirrors the host's own subagent reader: only a completed, error-free turn
 * counts. Throwing lets the processor close the branch with the provider's
 * reason instead of parsing an empty reply. A turn that fails before any
 * assistant message (an unroutable model) reports only on its idle marker.
 */
function lastAssistantText(messages: readonly SessionMessage[]): string {
  const idle = messages.filter(isIdle).at(-1);
  if (idle?.outcome === FAILED_OUTCOME) throw new Error(idle.error?.message ?? "Probe turn failed");
  const reply = messages.filter(isAssistant).filter(isCompleted).at(-1);
  if (!reply) throw new Error("Probe returned no completed reply");
  if (reply.error) throw new Error(reply.error.message);
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
