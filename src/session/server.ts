import type { Server, ServerWebSocket } from "bun";

import * as v from "valibot";

import { getHtmlBundle } from "@/ui";

import type { SessionStore } from "./sessions";
import { WsClientMessageSchema } from "./types";

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;

interface WsData {
  sessionId: string;
}

function handleFetch(
  req: Request,
  server: Server<WsData>,
  sessionId: string,
  htmlBundle: string,
): Response | undefined {
  const url = new URL(req.url);

  if (url.pathname === "/ws") {
    const success = server.upgrade(req, {
      data: { sessionId },
    });
    if (success) {
      return undefined;
    }
    return new Response("WebSocket upgrade failed", { status: HTTP_BAD_REQUEST });
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    return new Response(htmlBundle, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  }

  return new Response("Not Found", { status: HTTP_NOT_FOUND });
}

function handleWsOpen(ws: ServerWebSocket<WsData>, store: SessionStore): void {
  const { sessionId } = ws.data;
  store.handleWsConnect(sessionId, ws);
}

function handleWsClose(ws: ServerWebSocket<WsData>, store: SessionStore): void {
  const { sessionId } = ws.data;
  store.handleWsDisconnect(sessionId);
}

function handleWsMessage(ws: ServerWebSocket<WsData>, message: string | Buffer, store: SessionStore): void {
  const { sessionId } = ws.data;

  let parsed: v.InferOutput<typeof WsClientMessageSchema>;
  try {
    const raw: unknown = JSON.parse(message.toString());
    const parseResult = v.safeParse(WsClientMessageSchema, raw);
    if (!parseResult.success) {
      ws.send(
        JSON.stringify({
          type: "error",
          error: "Invalid message format",
          details: parseResult.issues.map((i) => i.message).join(", "),
        }),
      );
      return;
    }
    parsed = parseResult.output;
  } catch (error: unknown) {
    console.error("[octto] Failed to parse WebSocket message:", error);
    ws.send(
      JSON.stringify({
        type: "error",
        error: "Invalid message format",
        details: error instanceof Error ? error.message : "Parse failed",
      }),
    );
    return;
  }

  store.handleWsMessage(sessionId, parsed);
}

export async function createServer(
  sessionId: string,
  store: SessionStore,
  configuredPort?: number,
): Promise<{ server: Server<WsData>; port: number }> {
  const htmlBundle = getHtmlBundle();

  const server = Bun.serve<WsData>({
    port: configuredPort ?? 0,
    fetch: (req, srv) => handleFetch(req, srv, sessionId, htmlBundle),
    websocket: {
      open: (ws) => handleWsOpen(ws, store),
      close: (ws) => handleWsClose(ws, store),
      message: (ws, msg) => handleWsMessage(ws, msg, store),
    },
  });

  const port = server.port;
  if (port === undefined) {
    throw new Error("Failed to get server port");
  }

  return {
    server,
    port,
  };
}
