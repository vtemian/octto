/**
 * Shared plumbing for the end-to-end suite.
 *
 * Everything except the model is real: the opencode runtime, the octto plugin,
 * the browser and the websocket round-trip. The model is a scripted stub so a
 * run is deterministic and free.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const READY_POLL_MS = 100;
const DEFAULT_STUB_PORT = 8787;
const DEFAULT_OCTTO_PORT = 7777;
const DEFAULT_CDP_PORT = 9222;
const OUTPUT_TAIL_CHARS = 1500;
const READY_TIMEOUT_MS = 30_000;

export interface StubHandle {
  readonly port: number;
  stop: () => void;
}

export function stubPort(): number {
  return Number(process.env.STUB_PORT ?? DEFAULT_STUB_PORT);
}

export function octtoPort(): number {
  return Number(process.env.OCTTO_PORT ?? DEFAULT_OCTTO_PORT);
}

export function cdpPort(): number {
  return Number(process.env.CDP_PORT ?? DEFAULT_CDP_PORT);
}

export async function waitUntil(check: () => Promise<boolean> | boolean, label: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(READY_POLL_MS);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function startStub(scriptPath: string): Promise<StubHandle> {
  const port = stubPort();
  const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "stub-provider", "server.ts")], {
    env: { ...process.env, STUB_SCRIPT: scriptPath, STUB_PORT: String(port) },
    stdout: "inherit",
    stderr: "inherit",
  });

  await waitUntil(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
    } catch {
      return false;
    }
  }, "stub provider");

  return { port, stop: () => proc.kill() };
}

/**
 * Local plugins load by absolute path in the `plugin` array. The documented
 * `.opencode/plugins/` directory did not load them; the array does.
 */
export function writeOpencodeConfig(home: string, pluginPaths: readonly string[]): void {
  const dir = join(home, ".config", "opencode");
  mkdirSync(dir, { recursive: true });

  const config = {
    $schema: "https://opencode.ai/config.json",
    model: "stub/stub-model",
    provider: {
      stub: {
        npm: "@ai-sdk/openai-compatible",
        name: "Stub Provider",
        options: { baseURL: `http://127.0.0.1:${stubPort()}/v1`, apiKey: "stub-key" },
        models: { "stub-model": { name: "Stub Model" } },
      },
    },
    plugin: [...pluginPaths],
  };

  writeFileSync(join(dir, "opencode.json"), JSON.stringify(config, null, 2));
}

export function spawnOpencode(home: string, agent: string, message: string): Bun.Subprocess {
  return Bun.spawn(
    ["opencode", "run", "--format", "json", "--auto", "--agent", agent, "--log-level", "ERROR", message],
    {
      cwd: "/work",
      env: { ...process.env, HOME: home, OCTTO_PORT: String(octtoPort()) },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

/**
 * Reads the event stream until every marker has appeared, then stops the run.
 *
 * Waiting on process exit is not reliable here: octto keeps an HTTP server
 * alive for the session, so the markers are the real completion signal.
 */
async function pump(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  markers: readonly string[],
  deadline: number,
  onChunk: (text: string) => string,
): Promise<boolean> {
  const decoder = new TextDecoder();

  while (Date.now() < deadline) {
    // A bare read() blocks forever once the stream goes quiet, which would
    // strand the deadline check at the top of this loop.
    const next: ReadableStreamReadResult<Uint8Array> | null = await Promise.race([
      reader.read(),
      Bun.sleep(Math.max(0, deadline - Date.now())).then(() => null),
    ]);
    if (!next) return false;

    const seen = onChunk(next.value ? decoder.decode(next.value, { stream: true }) : "");
    if (markers.every((m) => seen.includes(m))) return true;
    if (next.done) return false;
  }
  return false;
}

export async function readUntil(proc: Bun.Subprocess, markers: readonly string[], timeoutMs: number): Promise<string> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  let seen = "";
  const append = (text: string): string => {
    seen += text;
    return seen;
  };

  try {
    if (await pump(reader, markers, Date.now() + timeoutMs, append)) return seen;
  } finally {
    reader.releaseLock();
    proc.kill();
  }

  const missing = markers.filter((m) => !seen.includes(m));
  throw new Error(`Never saw ${JSON.stringify(missing)} in opencode output. Got:\n${seen.slice(-OUTPUT_TAIL_CHARS)}`);
}
