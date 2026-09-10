/**
 * Minimal Chrome DevTools Protocol client.
 *
 * playwright-core hangs on the CDP websocket handshake under Bun, while a raw
 * WebSocket connects fine, so the suite talks to Chrome directly. Everything
 * needed here is Runtime.evaluate against a page target.
 */

const POLL_MS = 100;
const CONNECT_TIMEOUT_MS = 10_000;
const EVAL_TIMEOUT_MS = 15_000;
const EXPR_PREVIEW_CHARS = 60;
const ERROR_PREVIEW_CHARS = 300;

export interface CdpTarget {
  readonly id: string;
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl?: string;
}

export interface CdpSession {
  evaluate: <T>(expression: string) => Promise<T>;
  close: () => void;
}

function isTargetList(value: unknown): value is CdpTarget[] {
  return Array.isArray(value);
}

export async function listTargets(port: number): Promise<CdpTarget[]> {
  const parsed: unknown = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return isTargetList(parsed) ? parsed : [];
}

export async function waitForTarget(port: number, urlPrefix: string, timeoutMs: number): Promise<CdpTarget> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const targets = await listTargets(port);
    const page = targets.find((t) => t.type === "page" && t.url.startsWith(urlPrefix) && t.webSocketDebuggerUrl);
    if (page) return page;
    await Bun.sleep(POLL_MS);
  }

  const seen = (await listTargets(port)).map((t) => `${t.type}:${t.url}`).join(", ");
  throw new Error(`No page target for ${urlPrefix} within ${timeoutMs}ms. Saw: ${seen || "none"}`);
}

interface CdpReply {
  readonly id?: number;
  readonly result?: { readonly result?: { readonly value?: unknown }; readonly exceptionDetails?: unknown };
}

function parseReply(raw: unknown): CdpReply {
  if (typeof raw !== "string") return {};
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === "object" && parsed !== null ? parsed : {};
}

function awaitOpen(socket: WebSocket, wsUrl: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP connect timed out: ${wsUrl}`)), CONNECT_TIMEOUT_MS);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`CDP socket error: ${wsUrl}`));
    };
  });
}

function sendEvaluate<T>(
  socket: WebSocket,
  pending: Map<number, (reply: CdpReply) => void>,
  id: number,
  expression: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`CDP evaluate timed out: ${expression.slice(0, EXPR_PREVIEW_CHARS)}`)),
      EVAL_TIMEOUT_MS,
    );

    pending.set(id, (reply) => {
      clearTimeout(timer);
      const failure = reply.result?.exceptionDetails;
      if (failure) {
        reject(new Error(`Evaluate threw: ${JSON.stringify(failure).slice(0, ERROR_PREVIEW_CHARS)}`));
        return;
      }
      resolve(reply.result?.result?.value as T);
    });

    socket.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    );
  });
}

export async function connect(wsUrl: string): Promise<CdpSession> {
  const socket = new WebSocket(wsUrl);
  const pending = new Map<number, (reply: CdpReply) => void>();
  let nextId = 1;

  socket.onmessage = (event: MessageEvent) => {
    const reply = parseReply(event.data);
    if (reply.id === undefined) return;
    pending.get(reply.id)?.(reply);
    pending.delete(reply.id);
  };

  await awaitOpen(socket, wsUrl);

  return {
    evaluate: <T>(expression: string): Promise<T> => sendEvaluate<T>(socket, pending, nextId++, expression),
    close: () => {
      socket.close();
      // Detaching CDP leaves the tab open in the shared chromium, and a later
      // spec's waitForTarget would latch onto the stale page. Close the tab
      // itself via the DevTools HTTP API (fire and forget).
      const targetId = wsUrl.split("/").pop();
      const port = new URL(wsUrl).port;
      if (targetId) {
        void fetch(`http://127.0.0.1:${port}/json/close/${targetId}`).catch(() => {});
      }
    },
  };
}

/** Polls an expression in the page until it reports ready, so tests never race the render. */
export async function waitInPage(
  session: CdpSession,
  expression: string,
  label: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  // The tab may still be loading, so a probe that throws counts as "not yet"
  // rather than failing the test.
  const guarded = `(() => { try { return Boolean(${expression}); } catch { return false; } })()`;

  while (Date.now() < deadline) {
    if (await session.evaluate<boolean>(guarded)) return;
    await Bun.sleep(POLL_MS);
  }

  throw new Error(`Timed out waiting in page for ${label}`);
}
