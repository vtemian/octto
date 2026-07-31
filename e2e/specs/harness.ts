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

export interface OpencodeRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
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

export async function collectRun(proc: Bun.Subprocess): Promise<OpencodeRun> {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}
