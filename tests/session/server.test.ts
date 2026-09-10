// tests/session/server.test.ts
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import { createSessionStore, type SessionStore } from "../../src/session/sessions";

describe("Server WebSocket error handling", () => {
  let sessions: SessionStore;
  let sessionId: string;
  let url: string;
  let wsUrl: string;
  let token: string;

  beforeEach(async () => {
    sessions = createSessionStore({ skipBrowser: true });
    const result = await sessions.startSession({
      title: "Server Test",
      questions: [{ type: "confirm", config: { question: "Test?" } }],
    });
    sessionId = result.session_id;
    url = result.url;
    const parsed = new URL(url);
    token = parsed.searchParams.get("token") ?? "";
    wsUrl = `ws://${parsed.host}/ws?token=${token}`;
  });

  afterEach(async () => {
    await sessions.cleanup();
  });

  it("should send error response for invalid JSON over WebSocket", async () => {
    const ws = new WebSocket(wsUrl);

    const messages: string[] = [];
    const ready = new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    ws.onmessage = (event) => {
      messages.push(typeof event.data === "string" ? event.data : "");
    };

    await ready;

    // Suppress expected console.error from the invalid JSON parse
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    ws.send("not valid json {{{");

    // Wait for error response
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[octto]"), expect.anything());
    errorSpy.mockRestore();

    // Close WS before cleanup
    ws.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const errorMessages = messages.filter((m) => {
      try {
        return JSON.parse(m).type === "error";
      } catch (_error: unknown) {
        return false;
      }
    });

    expect(errorMessages.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(errorMessages[0]);
    expect(parsed.type).toBe("error");
    expect(parsed.error).toBe("Invalid message format");
  });

  it("should send error response for message failing schema validation", async () => {
    const ws = new WebSocket(wsUrl);

    const messages: string[] = [];
    const ready = new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    ws.onmessage = (event) => {
      messages.push(typeof event.data === "string" ? event.data : "");
    };

    await ready;

    // Send valid JSON but invalid schema (missing required fields)
    ws.send(JSON.stringify({ type: "unknown_type", data: 123 }));

    // Wait for error response
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    // Close WS before cleanup
    ws.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const errorMessages = messages.filter((m) => {
      try {
        return JSON.parse(m).type === "error";
      } catch (_error: unknown) {
        return false;
      }
    });

    expect(errorMessages.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(errorMessages[0]);
    expect(parsed.type).toBe("error");
    expect(parsed.error).toBe("Invalid message format");
    expect(parsed.details).toBeDefined();
  });

  it("should serve HTML on root path", async () => {
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
  });

  it("should return 404 for unknown paths", async () => {
    const response = await fetch(`http://${new URL(url).host}/unknown`);

    expect(response.status).toBe(404);
  });

  it("should assign a valid port", async () => {
    const session = sessions.getSession(sessionId);

    expect(session).toBeDefined();
    expect(session!.port).toBeGreaterThan(0);
  });

  it("should resolve endSession even while a browser socket is still open", async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });

    const outcome = await Promise.race([
      sessions.endSession(sessionId).then(() => "resolved" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2000)),
    ]);

    expect(outcome).toBe("resolved");
  });

  it("should bind to loopback only", () => {
    const session = sessions.getSession(sessionId);

    expect(session?.server?.hostname).toBe("127.0.0.1");
  });

  it("should reject a websocket upgrade from a foreign origin", async () => {
    const response = await fetch(`http://${new URL(url).host}/ws?token=${token}`, {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        Origin: "http://evil.example",
      },
    });

    expect(response.status).toBe(403);
  });

  it("should still accept a websocket with no origin header", async () => {
    const ws = new WebSocket(wsUrl);
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
    });

    expect(opened).toBe(true);
    ws.close();
  });

  it("should reject a websocket upgrade when the host header is not loopback", async () => {
    // DNS rebinding points an attacker's domain at 127.0.0.1, so the browser sends
    // that domain as both Host and Origin and they match each other.
    const port = Number(new URL(url).port);
    const status = await rawUpgradeStatus(port, `evil.example:${port}`, `http://evil.example:${port}`, token);

    expect(status).toBe(403);
  });

  it("should reject HTML requests without a token", async () => {
    const response = await fetch(`http://${new URL(url).host}/`);

    expect(response.status).toBe(401);
  });

  it("should reject HTML requests with a wrong token", async () => {
    const response = await fetch(`http://${new URL(url).host}/?token=${"0".repeat(48)}`);

    expect(response.status).toBe(401);
  });

  it("should reject a websocket upgrade without a token", async () => {
    const response = await fetch(`http://${new URL(url).host}/ws`, {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });

    expect(response.status).toBe(403);
  });

  it("should reject a response whose answer has no valid shape", async () => {
    const ws = new WebSocket(wsUrl);

    const messages: string[] = [];
    const ready = new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    ws.onmessage = (event) => {
      messages.push(typeof event.data === "string" ? event.data : "");
    };

    await ready;
    ws.send(JSON.stringify({ type: "response", id: "q_whatever", answer: { exploit: "payload" } }));
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    ws.close();

    const errorMessages = messages.filter((m) => {
      try {
        return JSON.parse(m).type === "error";
      } catch (_error: unknown) {
        return false;
      }
    });

    expect(errorMessages.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(errorMessages[0]).error).toBe("Invalid message format");
  });
});

/** fetch() forbids setting Host, so drive the upgrade over a raw socket. */
async function rawUpgradeStatus(port: number, host: string, origin: string, token: string): Promise<number> {
  const request = [
    `GET /ws?token=${token} HTTP/1.1`,
    `Host: ${host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Version: 13",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    `Origin: ${origin}`,
  ].join("\r\n");

  let received = "";
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data: (_socket, chunk) => {
        received += chunk.toString();
      },
    },
  });
  socket.write(`${request}\r\n\r\n`);

  await waitUntil(() => received.includes("\r\n"));
  socket.end();

  return Number(received.split(" ")[1]);
}

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
