// e2e/v2/brainstorm-round.test.ts
/**
 * OpenCode 2 tier: one full brainstorm round through the real v2 host.
 *
 * This is the spec that caught the Code Mode trap: plugin tools default to being
 * reachable only through v2's `execute` tool, so a model calling
 * `create_brainstorm` by name got "No tool named ... is currently available".
 * The adapter now registers every octto tool with `codemode: false`. It also
 * covers the v2 probe path (session create, prompt, wait, context, remove),
 * which no v1 harness could exercise.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { octtoPort, type StubHandle, startStub, waitUntil } from "../specs/harness";
import {
  type AnswererHandle,
  answerQuestions,
  PROBE_TEMPERATURE,
  type ServeHandle,
  startServe,
  writeV2Config,
} from "../specs/v2";

const PLUGIN_DIR = process.env.OCTTO_PLUGIN_DIR ?? "/work";
const SCRIPT = join(import.meta.dir, "..", "scripts", "brainstorm-round.json");
const PROBE_REPLY = 'Analysis done.\n{"done": true, "finding": "Redis with TTL expiry"}';
const SERVE_PORT = 4211;
const ROUND_TIMEOUT_MS = 180_000;
const POLL_MS = 2_000;

interface Listing {
  readonly data?: unknown;
}

function dataOf(value: unknown): unknown {
  return typeof value === "object" && value !== null && "data" in value ? (value as Listing).data : value;
}

describe("OpenCode 2: full brainstorm round", () => {
  let home: string;
  let project: string;
  let stub: StubHandle;
  let serve: ServeHandle;
  let answerer: AnswererHandle | undefined;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "octto-v2-home-"));
    project = mkdtempSync(join(tmpdir(), "octto-v2-proj-"));
    Bun.spawnSync(["git", "init", "-q", project]);
    writeV2Config(home, PLUGIN_DIR);
    process.env.STUB_PROBE_REPLY = PROBE_REPLY;
    stub = await startStub(SCRIPT);
    serve = await startServe(home, project, SERVE_PORT, octtoPort());
  });

  afterAll(() => {
    answerer?.stop();
    serve?.stop();
    stub?.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it("registers the three octto agents", async () => {
    await waitUntil(async () => {
      // Until the server is ready the route answers with an error body, not a list.
      const agents = dataOf(await serve.api.get("/api/agent"));
      return Array.isArray(agents) && agents.some((a) => a?.id === "octto");
    }, "octto agents");
    const agents = dataOf(await serve.api.get("/api/agent")) as {
      id: string;
      mode: string;
      hidden: boolean;
      permissions: { effect: string }[];
    }[];
    expect(agents.map((a) => a.id)).toEqual(expect.arrayContaining(["octto", "bootstrapper", "probe"]));
    // Rules are last-match-wins and user rules land after ours, so the deny-all
    // alone cannot hold; the subagent tool refuses primary and lists no hidden agents.
    const probe = agents.find((a) => a.id === "probe");
    expect(probe?.permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    expect(probe?.mode).toBe("primary");
    expect(probe?.hidden).toBe(true);
  });

  it("runs create_brainstorm, two probes and the plan review to approval", async () => {
    const session = dataOf(await serve.api.post("/api/session", { agent: "octto", title: "e2e-v2" })) as { id: string };
    await serve.api.post(`/api/session/${session.id}/prompt`, { text: "Add a caching layer to the API" });

    const messages = async (): Promise<string> =>
      JSON.stringify(dataOf(await serve.api.get(`/api/session/${session.id}/message`)));

    let pageUrl: string | undefined;
    await waitUntil(async () => {
      pageUrl = (await messages()).match(/http:\/\/localhost:\d+\/\?token=[a-f0-9]+/)?.[0];
      return pageUrl !== undefined;
    }, "create_brainstorm output with the octto URL");
    answerer = answerQuestions(pageUrl!);

    const deadline = Date.now() + ROUND_TIMEOUT_MS;
    let transcript = "";
    while (Date.now() < deadline && !transcript.includes("E2E_DONE")) {
      await Bun.sleep(POLL_MS);
      transcript = await messages();
    }

    expect(transcript).toContain("E2E_DONE");
    expect(transcript).toContain('<brainstorm_complete status=\\"approved\\">');
    expect(transcript).toContain("Redis with TTL expiry");
    expect(transcript).not.toContain("No tool named");
    expect(answerer.answered).toEqual(["pick_one", "pick_one", "show_plan"]);

    // v2 drops an agent's request body; only the context hook reaches the wire.
    const seen = (await (await fetch(`http://127.0.0.1:${stub.port}/seen`)).json()) as {
      probe: boolean;
      temperature: number | null;
    }[];
    const probes = seen.filter((request) => request.probe);
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((request) => request.temperature === PROBE_TEMPERATURE)).toBe(true);
    expect(seen.filter((request) => !request.probe).every((request) => request.temperature === null)).toBe(true);
  });
});
