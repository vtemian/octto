import type { Server, ServerWebSocket } from "bun";
import type { SessionManager } from "./manager";
import type { WsClientMessage } from "./types";
import { getHtmlBundle } from "../ui/bundle";

interface WsData {
  sessionId: string;
}

export async function createServer(
  sessionId: string,
  manager: SessionManager,
): Promise<{ server: Server<WsData>; port: number }> {
  const htmlBundle = getHtmlBundle();

  const server = Bun.serve<WsData>({
    port: 0, // Random available port
    fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (url.pathname === "/ws") {
        const success = server.upgrade(req, {
          data: { sessionId },
        });
        if (success) {
          return undefined;
        }
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // Serve the bundled HTML app
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(htmlBundle, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
          },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      open(ws: ServerWebSocket<WsData>) {
        const { sessionId } = ws.data;
        manager.handleWsConnect(sessionId, ws);
      },
      close(ws: ServerWebSocket<WsData>) {
        const { sessionId } = ws.data;
        manager.handleWsDisconnect(sessionId);
      },
      message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
        const { sessionId } = ws.data;
        try {
          const parsed = JSON.parse(message.toString()) as WsClientMessage;
          manager.handleWsMessage(sessionId, parsed);
        } catch (error) {
          console.error("[brainstormer] Failed to parse WebSocket message:", error);
        }
      },
    },
  });

  // Port is always defined when using port: 0
  const port = server.port;
  if (port === undefined) {
    throw new Error("Failed to get server port");
  }

  return {
    server,
    port,
  };
}
