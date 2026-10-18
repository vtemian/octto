import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// start_session opens a browser for real. Mock before the adapter's module graph loads.
mock.module("../../src/session/browser", () => ({ openBrowser: async () => {} }));

import { Model } from "@opencode/plugin";
import type { AgentConfig } from "@opencode-ai/sdk";

import { createSessionProbe, setup, toAgentInfo, type V2Host } from "../../src/host/v2";

interface FakeTool {
  name: string;
  description: string;
  input: unknown;
  execute: (input: unknown, context: { sessionID: string }) => Promise<{ content?: unknown }>;
}

function blankAgent(id: string): Record<string, any> {
  return {
    id,
    name: id,
    request: { settings: {}, headers: {}, body: {} },
    mode: "primary",
    hidden: false,
    permissions: [],
  };
}

function createHost(directory = "/tmp/octto-v2-test") {
  const tools = new Map<string, FakeTool>();
  const agents = new Map<string, Record<string, any>>();
  const events: any[] = [];
  let push: ((event: any) => void) | undefined;
  const sessions = { created: [] as any[], prompted: [] as any[], waited: [] as string[], removed: [] as string[] };

  const host = {
    location: { directory },
    tool: {
      transform: async (edit: (editor: any) => void) => {
        edit({ add: (tool: FakeTool) => tools.set(tool.name, tool) });
        return { dispose: async () => {} };
      },
    },
    agent: {
      transform: async (edit: (editor: any) => void) => {
        edit({
          update: (id: string, mutate: (agent: Record<string, any>) => void) => {
            const agent = agents.get(id) ?? blankAgent(id);
            mutate(agent);
            agents.set(id, agent);
          },
        });
        return { dispose: async () => {} };
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            const event = await new Promise<any>((resolve) => {
              push = resolve;
              signal.addEventListener("abort", () => resolve(undefined), { once: true });
            });
            if (event === undefined) return;
            events.push(event);
            yield event;
          }
        },
      }),
    },
    session: {
      create: async (input: any) => {
        sessions.created.push(input);
        return { id: "ses_probe" };
      },
      prompt: async (input: any) => {
        sessions.prompted.push(input);
        return {};
      },
      wait: async ({ sessionID }: { sessionID: string }) => {
        sessions.waited.push(sessionID);
      },
      context: async () => [
        { type: "user", text: "ignored" },
        {
          type: "assistant",
          time: { created: 1, completed: 2 },
          content: [
            { type: "reasoning", text: "hmm" },
            { type: "text", text: '{"done": true,' },
            { type: "text", text: ' "finding": "f"}' },
          ],
        },
      ],
      remove: async ({ sessionID }: { sessionID: string }) => {
        sessions.removed.push(sessionID);
      },
    },
  };

  return { host: host as unknown as V2Host, tools, agents, sessions, emit: (event: any) => push?.(event) };
}

/**
 * Drives one real probe: starts a one-branch brainstorm, answers its question
 * and the plan review over the browser socket, and waits for the round to end.
 */
async function runOneProbe(tools: Map<string, FakeTool>): Promise<void> {
  const created = String(
    (
      await tools.get("create_brainstorm")!.execute(
        {
          request: "r",
          branches: [{ id: "b1", scope: "s", initial_question: { type: "confirm", config: { question: "Go?" } } }],
        },
        { sessionID: "host_probe" },
      )
    ).content,
  );
  const tag = (name: string) => created.match(new RegExp(`<${name}>([^<]+)</${name}>`))![1];
  const url = new URL(tag("url"));
  const ws = new WebSocket(`ws://${url.host}/ws?token=${url.searchParams.get("token")}`);
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type !== "question") return;
    const answer = message.questionType === "show_plan" ? { decision: "approve" } : { choice: "yes" };
    ws.send(JSON.stringify({ type: "response", id: message.id, answer }));
  };
  try {
    await tools
      .get("await_brainstorm_complete")!
      .execute(
        { session_id: tag("session_id"), browser_session_id: tag("browser_session") },
        { sessionID: "host_probe" },
      );
  } finally {
    ws.close();
  }
}

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met in time");
}

describe("v2 setup", () => {
  let cleanup: (() => Promise<void> | void) | undefined;
  let configDir: string;

  // Without this, setup() reads the developer's own ~/.config/opencode/octto.json.
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "octto-v2-config-"));
  });

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
    rmSync(configDir, { recursive: true, force: true });
  });

  function writeOcttoConfig(config: unknown): void {
    writeFileSync(join(configDir, "octto.json"), JSON.stringify(config));
  }

  it("registers every octto tool with a zod input and string content", async () => {
    const { host, tools } = createHost();
    cleanup = await setup(host, configDir);

    const start = tools.get("start_session");
    expect(start).toBeDefined();
    expect(tools.has("create_brainstorm")).toBe(true);
    expect(tools.has("push_question")).toBe(true);
    expect(typeof (start!.input as any)["~standard"]).toBe("object");
    // Without codemode: false the host lists a plugin tool only inside Code Mode's
    // execute() and the model's direct call fails with "No tool named ...".
    expect((start as any).options).toEqual({ codemode: false });

    const result = await tools.get("list_questions")!.execute({}, { sessionID: "host_1" });
    expect(result.content).toBe("No questions found.");
  });

  it("upserts the three agents", async () => {
    const { host, agents } = createHost();
    cleanup = await setup(host, configDir);

    expect([...agents.keys()].sort()).toEqual(["bootstrapper", "octto", "probe"]);
    const octto = agents.get("octto")!;
    expect(octto.mode).toBe("primary");
    expect(octto.system).toContain("brainstorming");
    expect(octto.request.body.temperature).toBe(0.7);
  });

  it("leaves the built-in model unpinned, so a host that lacks it falls back to its own default", async () => {
    const { host, agents, tools, sessions } = createHost(configDir);
    cleanup = await setup(host, configDir);

    expect(agents.get("octto")!.model).toBeUndefined();
    await runOneProbe(tools);
    expect(sessions.created.at(-1).model).toBeUndefined();
    // State follows the project, not the host's cwd ($HOME under v2's service).
    expect(readdirSync(join(configDir, ".octto")).some((file) => file.startsWith("ses_"))).toBe(true);
  });

  it("pins a model the user chose in octto.json on the agent and on its probe sessions", async () => {
    writeOcttoConfig({ agents: { probe: { model: "cap2/probe-model", variant: "high" } } });
    const { host, agents, tools, sessions } = createHost(configDir);
    cleanup = await setup(host, configDir);

    const pinned = { providerID: "cap2", id: "probe-model", variant: "high" };
    expect(agents.get("probe")!.model).toEqual(pinned);
    expect(agents.get("octto")!.model).toBeUndefined();
    await runOneProbe(tools);
    expect(sessions.created.at(-1).model).toEqual(pinned);
  });

  it("still loads when octto.json names a model without a provider, falling back to the host default", async () => {
    writeOcttoConfig({ model: "gpt-5" });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { host, tools, agents } = createHost();

    try {
      cleanup = await setup(host, configDir);
      expect(warn).toHaveBeenCalledWith(
        '[octto] ignoring model "gpt-5", using the host default:',
        expect.objectContaining({ message: "Invalid model reference: gpt-5" }),
      );
    } finally {
      warn.mockRestore();
    }

    expect(tools.has("create_brainstorm")).toBe(true);
    expect(agents.get("octto")!.model).toBeUndefined();
  });

  it("denies every tool to the probe agent, which only reads user answers", async () => {
    const { host, agents } = createHost();
    cleanup = await setup(host, configDir);

    expect(agents.get("probe")!.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
    expect(agents.get("octto")!.permissions).toEqual([]);
  });

  it("keeps relaying session deletes after one handler throws", async () => {
    const { host, tools, emit } = createHost();
    cleanup = await setup(host, configDir);
    const started = await tools
      .get("start_session")!
      .execute({ title: "t", questions: [{ type: "confirm", config: { question: "Go?" } }] }, { sessionID: "host_2" });
    const url = String(started.content).match(/http:\/\/localhost:\d+\/\?token=[a-f0-9]+/)?.[0];
    const quiet = console.error;
    console.error = () => {};

    try {
      emit({ type: "session.deleted" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      emit({ type: "session.deleted", data: { sessionID: "host_2" } });

      await waitUntil(() =>
        fetch(url!).then(
          () => false,
          () => true,
        ),
      );
      await expect(fetch(url!)).rejects.toThrow();
    } finally {
      console.error = quiet;
    }
  });

  it("ends octto sessions when the host session is deleted", async () => {
    const { host, tools, emit } = createHost();
    cleanup = await setup(host, configDir);

    const started = await tools
      .get("start_session")!
      .execute({ title: "t", questions: [{ type: "confirm", config: { question: "Go?" } }] }, { sessionID: "host_1" });
    const url = String(started.content).match(/http:\/\/localhost:\d+\/\?token=[a-f0-9]+/)?.[0];
    expect(url).toBeDefined();
    expect((await fetch(url!)).ok).toBe(true);

    emit({ type: "session.deleted", data: { sessionID: "host_1" } });

    await waitUntil(() =>
      fetch(url!).then(
        () => false,
        () => true,
      ),
    );
    await expect(fetch(url!)).rejects.toThrow();
  });
});

describe("toAgentInfo", () => {
  it("maps v1 agent config onto the v2 agent record", async () => {
    const agent = blankAgent("probe");
    const config: AgentConfig & { maxSteps?: number; variant?: string } = {
      description: "d",
      mode: "subagent",
      model: "openai/gpt-5.3-codex",
      variant: "high",
      temperature: 0.5,
      maxSteps: 7,
      prompt: "sys",
    };

    await toAgentInfo(agent as any, config);

    expect(agent.description).toBe("d");
    expect(agent.mode).toBe("subagent");
    expect(agent.system).toBe("sys");
    expect(agent.model).toEqual({ providerID: "openai", id: "gpt-5.3-codex", variant: "high" });
    expect(agent.request.body.temperature).toBe(0.5);
    expect(agent.steps).toBe(7);
  });

  it("leaves host defaults alone for fields the config does not set", async () => {
    const agent = blankAgent("probe");

    await toAgentInfo(agent as any, { description: "only this" });

    expect(agent.description).toBe("only this");
    expect(agent.mode).toBe("primary");
    expect(agent.model).toBeUndefined();
    expect(agent.system).toBeUndefined();
    expect(agent.steps).toBeUndefined();
    expect(agent.request.body).toEqual({});
  });
});

describe("createSessionProbe", () => {
  it("creates, prompts, waits, reads the last assistant text and removes the session", async () => {
    const { host, sessions } = createHost();

    const text = await createSessionProbe(host.session, new Map()).run("probe", "ctx");

    expect(text).toBe('{"done": true, "finding": "f"}');
    expect(sessions.created[0]).toEqual({
      title: "probe-probe",
      agent: "probe",
      permissions: [{ action: "*", resource: "*", effect: "deny" }],
    });
    expect(sessions.prompted[0]).toEqual({ sessionID: "ses_probe", text: "ctx" });
    expect(sessions.waited).toEqual(["ses_probe"]);
    expect(sessions.removed).toEqual(["ses_probe"]);
  });

  it("creates the session on the agent's model, since v2 never reads a session model from its agent", async () => {
    const { host, sessions } = createHost();
    const model = Model.Ref.parse("cap2/probe-model#high");

    await createSessionProbe(host.session, new Map([["probe", model]])).run("probe", "ctx");

    expect(sessions.created[0].model).toEqual({ providerID: "cap2", id: "probe-model", variant: "high" });
  });

  it("removes the session even when the prompt fails", async () => {
    const { host, sessions } = createHost();
    const failing = {
      ...host.session,
      wait: async () => {
        throw new Error("model down");
      },
    };

    await expect(
      createSessionProbe(failing as unknown as V2Host["session"], new Map()).run("probe", "ctx"),
    ).rejects.toThrow("model down");
    expect(sessions.removed).toEqual(["ses_probe"]);
  });

  it("throws when no completed assistant reply came back, rather than returning empty text", async () => {
    const { host, sessions } = createHost();
    const silent = { ...host.session, context: async () => [] };

    await expect(
      createSessionProbe(silent as unknown as V2Host["session"], new Map()).run("probe", "ctx"),
    ).rejects.toThrow("no completed reply");
    expect(sessions.removed).toEqual(["ses_probe"]);
  });

  it("throws with the provider's message when the model turn errored", async () => {
    const { host } = createHost();
    const errored = {
      ...host.session,
      context: async () => [
        {
          type: "assistant",
          time: { created: 1, completed: 2 },
          error: { type: "ProviderModelNotFoundError", message: "Model not found: openai/gpt-5.3-codex" },
          content: [],
        },
      ],
    };

    await expect(
      createSessionProbe(errored as unknown as V2Host["session"], new Map()).run("probe", "ctx"),
    ).rejects.toThrow(/^Model not found: openai\/gpt-5\.3-codex$/);
  });

  it("throws the idle marker's error when the turn failed before any assistant reply", async () => {
    const { host } = createHost();
    const unroutable = {
      ...host.session,
      context: async () => [
        { type: "user", text: "ctx" },
        {
          type: "idle",
          outcome: "failed",
          error: { type: "provider.no-route", message: "Model unavailable: openai/gpt-5.3-codex" },
        },
      ],
    };

    await expect(
      createSessionProbe(unroutable as unknown as V2Host["session"], new Map()).run("probe", "ctx"),
    ).rejects.toThrow(/^Model unavailable: openai\/gpt-5\.3-codex$/);
  });

  it("skips an assistant message that is still streaming", async () => {
    const { host } = createHost();
    const streaming = {
      ...host.session,
      context: async () => [
        { type: "assistant", time: { created: 1, completed: 2 }, content: [{ type: "text", text: "done one" }] },
        { type: "assistant", time: { created: 3 }, content: [{ type: "text", text: "partial" }] },
      ],
    };

    const text = await createSessionProbe(streaming as unknown as V2Host["session"], new Map()).run("probe", "ctx");

    expect(text).toBe("done one");
  });
});
