/**
 * Plumbing for the OpenCode 2 tier.
 *
 * `opencode run --standalone` stalled intermittently on 2.0.31 before the first
 * model turn, so this tier drives a long-lived `opencode serve` over its HTTP API
 * and answers octto's questions over the websocket a browser would use.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stubPort, waitUntil } from "./harness";

const SERVER_PASSWORD = "octto-e2e";
const ANSWER_DELAY_MS = 300;
/** /api/info answers 401 without credentials, which still proves the server is up. */
const HTTP_SERVER_ERROR = 500;

export interface Api {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

export interface ServeHandle {
  readonly api: Api;
  stop(): void;
}

export interface AnswererHandle {
  readonly answered: readonly string[];
  stop(): void;
}

interface QuestionMessage {
  readonly type: "question";
  readonly id: string;
  readonly questionType: string;
  readonly config?: { readonly question?: string; readonly options?: readonly { readonly id: string }[] };
}

function isQuestion(value: unknown): value is QuestionMessage {
  return typeof value === "object" && value !== null && "type" in value && value.type === "question";
}

/** OpenCode 2 reads `plugins` and `providers`; the stub provider needs a credential via env. */
export function writeV2Config(home: string, pluginDir: string): void {
  const dir = join(home, ".config", "opencode");
  mkdirSync(dir, { recursive: true });

  const config = {
    $schema: "https://opencode.ai/config.json",
    model: "stub/stub-model",
    providers: {
      stub: {
        name: "Stub Provider",
        env: ["STUB_API_KEY"],
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${stubPort()}/v1` },
        models: { "stub-model": { name: "Stub Model" } },
      },
    },
    plugins: [pluginDir],
  };

  writeFileSync(join(dir, "opencode.jsonc"), JSON.stringify(config, null, 2));
}

function createApi(base: string, directory: string): Api {
  const headers = {
    authorization: `Basic ${btoa(`opencode:${SERVER_PASSWORD}`)}`,
    "content-type": "application/json",
  };
  const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const separator = path.includes("?") ? "&" : "?";
    const url = `${base}${path}${separator}directory=${encodeURIComponent(directory)}`;
    const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (_error: unknown) {
      return text;
    }
  };
  return { get: (path) => request("GET", path), post: (path, body) => request("POST", path, body) };
}

export async function startServe(
  home: string,
  directory: string,
  port: number,
  octtoPort: number,
): Promise<ServeHandle> {
  const proc = Bun.spawn(["opencode", "serve", "--port", String(port), "--log-level", "warn"], {
    cwd: directory,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      STUB_API_KEY: "stub-key",
      OCTTO_PORT: String(octtoPort),
      OPENCODE_SERVER_PASSWORD: SERVER_PASSWORD,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  const api = createApi(`http://127.0.0.1:${port}`, directory);

  await waitUntil(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/api/info`)).status < HTTP_SERVER_ERROR;
    } catch (_error: unknown) {
      return false;
    }
  }, "opencode serve");

  return { api, stop: () => proc.kill() };
}

/**
 * Stands in for the browser: picks the first option of every question and
 * approves the final plan review. Stays connected until stopped, because the
 * server only pushes follow-ups to the socket it currently holds.
 */
export function answerQuestions(pageUrl: string): AnswererHandle {
  const url = new URL(pageUrl);
  const ws = new WebSocket(`ws://${url.host}/ws?token=${url.searchParams.get("token")}`);
  const answered: string[] = [];
  const seen = new Set<string>();

  ws.onmessage = (event) => {
    const message: unknown = JSON.parse(String(event.data));
    if (!isQuestion(message) || seen.has(message.id)) return;
    seen.add(message.id);
    answered.push(message.questionType);
    const answer =
      message.questionType === "show_plan"
        ? { decision: "approve" }
        : { selected: message.config?.options?.[0]?.id ?? "yes" };
    setTimeout(() => ws.send(JSON.stringify({ type: "response", id: message.id, answer })), ANSWER_DELAY_MS);
  };

  return { answered, stop: () => ws.close() };
}
