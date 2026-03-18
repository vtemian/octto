// tests/session/server.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { createSessionStore, type SessionStore } from "../../src/session/sessions";

describe("Server WebSocket error handling", () => {
  let sessions: SessionStore;
  let sessionId: string;
  let url: string;

  beforeEach(async () => {
    sessions = createSessionStore({ skipBrowser: true });
    const result = await sessions.startSession({
      title: "Server Test",
      questions: [{ type: "confirm", config: { question: "Test?" } }],
    });
    sessionId = result.session_id;
    url = result.url;
  });

  afterEach(async () => {
    await sessions.cleanup();
  });

  it("should send error response for invalid JSON over WebSocket", async () => {
    const wsUrl = `${url.replace("http", "ws")}/ws`;
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
    const originalError = console.error;
    console.error = () => {};
    try {
      ws.send("not valid json {{{");

      // Wait for error response
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    } finally {
      console.error = originalError;
    }

    // Close WS before cleanup
    ws.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const errorMessages = messages.filter((m) => {
      try {
        return JSON.parse(m).type === "error";
      } catch {
        return false;
      }
    });

    expect(errorMessages.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(errorMessages[0]);
    expect(parsed.type).toBe("error");
    expect(parsed.error).toBe("Invalid message format");
  });

  it("should send error response for message failing schema validation", async () => {
    const wsUrl = `${url.replace("http", "ws")}/ws`;
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
      } catch {
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
    const response = await fetch(`${url}/unknown`);

    expect(response.status).toBe(404);
  });

  it("should assign a valid port", async () => {
    const session = sessions.getSession(sessionId);

    expect(session).toBeDefined();
    expect(session!.port).toBeGreaterThan(0);
  });
});
