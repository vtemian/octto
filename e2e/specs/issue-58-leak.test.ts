// e2e/specs/issue-58-leak.test.ts
/**
 * Issue #58 regression spec: deleting an opencode session mid-brainstorm must
 * tear the brainstorm's octto server down.
 *
 * The plugin's session.deleted cleanup used to end only sessions created
 * through the tracked `start_session` tool. `create_brainstorm` browser
 * sessions were untracked, so deleting the opencode session mid-brainstorm
 * leaked the octto server: the stale page kept serving and replaying its
 * questions, and - because the harness pins OCTTO_PORT - the next brainstorm
 * in the same process could not even bind. That live-but-orphaned page was
 * the "blank page: waiting for questions" trap from issue #58.
 *
 * create_brainstorm is now tracked like start_session, so session.deleted
 * ends the brainstorm's server too. These assertions encode the FIXED
 * behavior: this spec FAILS on v0.4.2 and earlier.
 *
 * The leak is per-process, so this drives a long-lived `opencode serve` over
 * its HTTP API; the one-shot `opencode run` would take the servers down with
 * it.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { octtoPort, type StubHandle, startStub, waitUntil, writeOpencodeConfig } from "./harness";

const PLUGIN_PATH = "/work/dist/index.js";
const SCRIPT = join(import.meta.dir, "..", "scripts", "issue-58-leak.json");
const SERVE_PORT = 4099;
const SERVE = `http://127.0.0.1:${SERVE_PORT}`;
const OCTTO_URL = `http://localhost:${octtoPort()}`;
const WS_COLLECT_MS = 2_500;

interface ProbeResult {
  http: boolean;
  questions: string[] | null;
}

function collectQuestions(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const ids: string[] = [];
    const ws = new WebSocket(`ws://localhost:${octtoPort()}/ws`);
    const timer = setTimeout(() => {
      ws.close();
      resolve(ids);
    }, WS_COLLECT_MS);
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.type === "question") ids.push(msg.id);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("octto websocket connect failed"));
    };
  });
}

async function probeOctto(): Promise<ProbeResult> {
  const http = await fetch(OCTTO_URL).then(
    (r) => r.ok,
    () => false,
  );
  if (!http) return { http: false, questions: null };
  return { http: true, questions: await collectQuestions() };
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${SERVE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function spawnServe(home: string): Bun.Subprocess {
  return Bun.spawn(
    ["opencode", "serve", "--hostname", "127.0.0.1", "--port", String(SERVE_PORT), "--log-level", "ERROR"],
    {
      cwd: "/work",
      env: { ...process.env, HOME: home, OCTTO_PORT: String(octtoPort()) },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
}

/**
 * The first request to a fresh opencode serve triggers one-time lazy init
 * (provider package download, plugin load) that can take tens of seconds, and a
 * bare fetch() can outlive any polling deadline while it waits. Per-attempt
 * aborts keep the overall deadline honest.
 */
async function waitForServe(timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastProblem = "no response yet";

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${SERVE}/session`, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) return;
      lastProblem = `HTTP ${res.status}`;
    } catch (error) {
      lastProblem = String(error).slice(0, 200);
    }
    await Bun.sleep(500);
  }

  throw new Error(`opencode serve never became ready: ${lastProblem}`);
}

async function newSession(): Promise<string> {
  const created = (await api("/session", { method: "POST", body: "{}" })) as { id: string };
  return created.id;
}

async function prompt(sessionId: string, text: string): Promise<void> {
  await api(`/session/${sessionId}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({ agent: "build", parts: [{ type: "text", text }] }),
  });
}

async function deleteSession(sessionId: string): Promise<void> {
  try {
    await api(`/session/${sessionId}`, { method: "DELETE" });
  } catch (error) {
    // Deleting mid-turn may conflict; abort first, then retry once.
    console.log("[issue-58:leak] direct delete failed, aborting first:", String(error).slice(-200));
    await api(`/session/${sessionId}/abort`, { method: "POST", body: "{}" });
    await api(`/session/${sessionId}`, { method: "DELETE" });
  }
}

describe("issue #58: deleting a session tears its brainstorm server down", () => {
  let stub: StubHandle;
  let home: string;
  let serve: Bun.Subprocess | undefined;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "octto-e2e-home-"));
    stub = await startStub(SCRIPT);
    writeOpencodeConfig(home, [PLUGIN_PATH]);
    serve = spawnServe(home);
    await waitForServe();
    console.log("[issue-58:leak] serve is ready");
  }, 200_000);

  afterAll(() => {
    serve?.kill();
    stub?.stop();
    rmSync(home, { recursive: true, force: true });
  });

  it("stops the stale server after the opencode session is deleted", async () => {
    console.log("[issue-58:leak] step 1: create session");
    const s1 = await newSession();
    console.log("[issue-58:leak] step 2: prompt", s1);
    await prompt(s1, "Brainstorm a caching layer for the API.");
    console.log("[issue-58:leak] step 3: wait for octto server");

    await waitUntil(
      () =>
        fetch(OCTTO_URL).then(
          (r) => r.ok,
          () => false,
        ),
      "octto server",
    );
    const before = await probeOctto();
    console.log("[issue-58:leak] before delete:", JSON.stringify(before));
    expect(before.questions?.length).toBe(2);

    await deleteSession(s1);
    await Bun.sleep(2_000);

    // The brainstorm's browser session is tracked, so session.deleted ends it:
    // the server must be gone rather than replaying orphaned questions.
    const after = await probeOctto();
    console.log("[issue-58:leak] after delete:", JSON.stringify(after));
    expect(after.http, "the stale octto server still serves (leak from #58)").toBe(false);
    expect(after.questions, "the stale session still replays questions (leak from #58)").toBeNull();

    // With the port released, the next brainstorm in the same process binds
    // cleanly and serves its own questions.
    const s2 = await newSession();
    await prompt(s2, "Brainstorm a caching layer for the API.");

    await waitUntil(
      () =>
        fetch(OCTTO_URL).then(
          (r) => r.ok,
          () => false,
        ),
      "second brainstorm's octto server",
    );
    const rebound = await probeOctto();
    console.log("[issue-58:leak] second brainstorm:", JSON.stringify(rebound));
    expect(rebound.questions?.length, "second brainstorm did not serve its questions").toBe(2);
  }, 240_000);
});
