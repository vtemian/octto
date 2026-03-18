import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionStore, type SessionStore } from "../../src/session/sessions";
import { createStateStore, type StateStore } from "../../src/state/store";
import { processAnswer } from "../../src/tools/processor";

function createMockClient(probeResponse: { done: boolean; finding?: string; question?: unknown }) {
  const sessionId = "mock-probe-session";
  return {
    session: {
      create: async () => ({ data: { id: sessionId } }),
      prompt: async () => ({
        data: {
          parts: [{ type: "text", text: JSON.stringify(probeResponse) }],
        },
      }),
      delete: async () => ({}),
    },
  } as any;
}

describe("processAnswer", () => {
  let sessions: SessionStore;
  let stateStore: StateStore;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "octto-processor-test-"));
    sessions = createSessionStore({ skipBrowser: true });
    stateStore = createStateStore(tempDir);
  });

  afterEach(async () => {
    await sessions.cleanup();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should complete a branch when probe returns done", async () => {
    const state = await stateStore.createSession("ses_test", "test request", [{ id: "b1", scope: "scope1" }]);
    const browserSession = await sessions.startSession({ title: "Test" });
    await stateStore.setBrowserSessionId("ses_test", browserSession.session_id);

    const { question_id } = sessions.pushQuestion(browserSession.session_id, "confirm", { question: "Test?" });
    await stateStore.addQuestionToBranch("ses_test", "b1", {
      id: question_id,
      type: "confirm",
      text: "Test?",
      config: { question: "Test?" },
    });

    const client = createMockClient({ done: true, finding: "Test finding" });

    await processAnswer(
      stateStore,
      sessions,
      "ses_test",
      browserSession.session_id,
      question_id,
      { choice: "yes" },
      client,
    );

    const updated = await stateStore.getSession("ses_test");
    expect(updated?.branches.b1.status).toBe("done");
    expect(updated?.branches.b1.finding).toBe("Test finding");
  });

  it("should add follow-up question when probe returns not done", async () => {
    await stateStore.createSession("ses_test", "test request", [{ id: "b1", scope: "scope1" }]);
    const browserSession = await sessions.startSession({ title: "Test" });
    await stateStore.setBrowserSessionId("ses_test", browserSession.session_id);

    const { question_id } = sessions.pushQuestion(browserSession.session_id, "confirm", { question: "Test?" });
    await stateStore.addQuestionToBranch("ses_test", "b1", {
      id: question_id,
      type: "confirm",
      text: "Test?",
      config: { question: "Test?" },
    });

    const client = createMockClient({
      done: false,
      question: { type: "ask_text", config: { question: "Follow up?" } },
    });

    await processAnswer(
      stateStore,
      sessions,
      "ses_test",
      browserSession.session_id,
      question_id,
      { choice: "yes" },
      client,
    );

    const updated = await stateStore.getSession("ses_test");
    expect(updated?.branches.b1.status).toBe("exploring");
    expect(updated?.branches.b1.questions.length).toBe(2);
  });

  it("should silently return when session not found", async () => {
    const client = createMockClient({ done: true });
    await processAnswer(
      stateStore,
      sessions,
      "nonexistent",
      "browser_nonexistent",
      "q_nonexistent",
      { choice: "yes" },
      client,
    );
    // Should not throw
  });
});
