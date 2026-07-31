/**
 * OpenAI-compatible chat-completions server that replays a fixed script.
 *
 * opencode drives real agents through this, so the plugin, the browser and the
 * websocket round-trip stay genuine while the model's output becomes
 * deterministic. Turn N of the script answers the request carrying N prior
 * assistant messages, which keeps the server stateless across retries.
 */

const DEFAULT_PORT = 8787;
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

export interface ToolTurn {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

export interface TextTurn {
  readonly text: string;
}

export type ScriptTurn = ToolTurn | TextTurn;

interface ChatMessage {
  readonly role: string;
  readonly content?: unknown;
}

/**
 * Scripts cannot hardcode ids the tools mint at runtime, so an argument of the
 * form {"$extract": "<regex>"} is replaced by the last match seen anywhere in
 * the conversation so far.
 */
interface ExtractRef {
  readonly $extract: string;
}

function isExtractRef(value: unknown): value is ExtractRef {
  return typeof value === "object" && value !== null && "$extract" in value;
}

function lastMatch(messages: readonly ChatMessage[], pattern: string): string {
  const regex = new RegExp(pattern, "g");
  const matches = messages.flatMap((m) => JSON.stringify(m.content ?? "").match(regex) ?? []);
  const found = matches.at(-1);
  if (!found) throw new Error(`No match for /${pattern}/ in conversation so far`);
  return found;
}

function resolveArgs(args: Record<string, unknown>, messages: readonly ChatMessage[]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      isExtractRef(value) ? lastMatch(messages, value.$extract) : value,
    ]),
  );
}

interface ChatRequest {
  readonly model?: string;
  readonly messages?: readonly ChatMessage[];
  readonly stream?: boolean;
}

function isToolTurn(turn: ScriptTurn): turn is ToolTurn {
  return "tool" in turn;
}

function isChatRequest(body: unknown): body is ChatRequest {
  return typeof body === "object" && body !== null;
}

function isScriptTurn(value: unknown): value is ScriptTurn {
  return typeof value === "object" && value !== null && ("tool" in value || "text" in value);
}

async function loadScript(path: string): Promise<readonly ScriptTurn[]> {
  const parsed: unknown = await Bun.file(path).json();
  if (!Array.isArray(parsed)) throw new Error(`Script ${path} must be a JSON array of turns`);

  const turns: unknown[] = parsed;
  if (!turns.every(isScriptTurn)) throw new Error(`Script ${path} turns must be {tool,args} or {text}`);
  return turns;
}

function assistantTurnsSoFar(request: ChatRequest): number {
  return (request.messages ?? []).filter((m) => m.role === "assistant").length;
}

function chunk(model: string, delta: Record<string, unknown>, finish: string | null): string {
  const payload = {
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function streamTurn(model: string, turn: ScriptTurn, args: Record<string, unknown>): string {
  const head = chunk(model, { role: "assistant" }, null);

  if (!isToolTurn(turn)) {
    return `${head + chunk(model, { content: turn.text }, null) + chunk(model, {}, "stop")}data: [DONE]\n\n`;
  }

  const call = chunk(
    model,
    {
      tool_calls: [
        {
          index: 0,
          id: `call_${turn.tool}`,
          type: "function",
          function: { name: turn.tool, arguments: JSON.stringify(args) },
        },
      ],
    },
    null,
  );
  return `${head + call + chunk(model, {}, "tool_calls")}data: [DONE]\n\n`;
}

function completionBody(model: string, turn: ScriptTurn, args: Record<string, unknown>): Record<string, unknown> {
  const message = isToolTurn(turn)
    ? {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call_${turn.tool}`,
            type: "function",
            function: { name: turn.tool, arguments: JSON.stringify(args) },
          },
        ],
      }
    : { role: "assistant", content: turn.text };

  return {
    id: "chatcmpl-stub",
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message, finish_reason: isToolTurn(turn) ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// Past the end of the script the model must stop, or opencode would loop forever.
const EXHAUSTED: TextTurn = { text: "Script exhausted." };

export function createStubProvider(scriptPath: string, port: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/health") return new Response("ok");

      if (url.pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "stub-model", object: "model" }] });
      }

      if (!url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }

      const body: unknown = await request.json();
      if (!isChatRequest(body)) return new Response("bad request", { status: 400 });

      const script = await loadScript(scriptPath);
      const index = assistantTurnsSoFar(body);
      const turn = script[index] ?? EXHAUSTED;
      const model = body.model ?? "stub-model";
      const args = isToolTurn(turn) ? resolveArgs(turn.args, body.messages ?? []) : {};

      console.log(`[stub] turn ${index}: ${isToolTurn(turn) ? `tool ${turn.tool} ${JSON.stringify(args)}` : "text"}`);

      if (body.stream === false) return Response.json(completionBody(model, turn, args));

      return new Response(streamTurn(model, turn, args), { headers: SSE_HEADERS });
    },
  });
}

if (import.meta.main) {
  const scriptPath = process.env.STUB_SCRIPT;
  if (!scriptPath) throw new Error("STUB_SCRIPT must point at a script JSON file");

  const port = Number(process.env.STUB_PORT ?? DEFAULT_PORT);
  createStubProvider(scriptPath, port);
  console.log(`[stub] listening on ${port}, replaying ${scriptPath}`);
}
