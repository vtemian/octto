import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionStore, type SessionStore } from "../../src/session/sessions";
import { createStateStore, type StateStore } from "../../src/state/store";
import { processAnswer } from "../../src/tools/processor";

function createProbe(probeResponse: { done: boolean; finding?: string; question?: unknown }) {
  const calls: { agent: string; text: string }[] = [];
  return {
    calls,
    runner: {
      run: async (agent: string, text: string) => {
        calls.push({ agent, text });
        return `Some prose first.\n${JSON.stringify(probeResponse)}`;
      },
    },
  };
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

  async function seedBranchQuestion() {
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

    return { browserSession, question_id };
  }

  it("should complete a branch when probe returns done", async () => {
    const { browserSession, question_id } = await seedBranchQuestion();
    const { runner } = createProbe({ done: true, finding: "Test finding" });

    await processAnswer(
      stateStore,
      sessions,
      "ses_test",
      browserSession.session_id,
      question_id,
      { choice: "yes" },
      runner,
    );

    const updated = await stateStore.getSession("ses_test");
    expect(updated?.branches.b1.status).toBe("done");
    expect(updated?.branches.b1.finding).toBe("Test finding");
  });

  it("asks the probe agent with the branch context", async () => {
    const { browserSession, question_id } = await seedBranchQuestion();
    const { runner, calls } = createProbe({ done: true, finding: "ok" });

    await processAnswer(
      stateStore,
      sessions,
      "ses_test",
      browserSession.session_id,
      question_id,
      { choice: "yes" },
      runner,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].agent).toBe("probe");
    expect(calls[0].text).toContain('<branch id="b1"');
    expect(calls[0].text).toContain("test request");
  });

  it("should add follow-up question when probe returns not done", async () => {
    const { browserSession, question_id } = await seedBranchQuestion();
    const { runner } = createProbe({
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
      runner,
    );

    const updated = await stateStore.getSession("ses_test");
    expect(updated?.branches.b1.status).toBe("exploring");
    expect(updated?.branches.b1.questions.length).toBe(2);
  });

  it("should complete the branch when the probe wants to continue but sends no question", async () => {
    const { browserSession, question_id } = await seedBranchQuestion();
    const { runner } = createProbe({ done: false });

    await processAnswer(
      stateStore,
      sessions,
      "ses_test",
      browserSession.session_id,
      question_id,
      { choice: "yes" },
      runner,
    );

    const updated = await stateStore.getSession("ses_test");
    expect(updated?.branches.b1.status).toBe("done");
    expect(updated?.branches.b1.finding).toBe("Probe returned no question");
  });

  it("propagates a probe failure so the caller can log it", async () => {
    const { browserSession, question_id } = await seedBranchQuestion();
    const failing = {
      run: async () => {
        throw new Error("probe unavailable");
      },
    };

    await expect(
      processAnswer(
        stateStore,
        sessions,
        "ses_test",
        browserSession.session_id,
        question_id,
        { choice: "yes" },
        failing,
      ),
    ).rejects.toThrow("probe unavailable");

    const updated = await stateStore.getSession("ses_test");
    expect(updated?.branches.b1.status).not.toBe("done");
  });

  it("should silently return when session not found", async () => {
    const { runner, calls } = createProbe({ done: true });
    await processAnswer(
      stateStore,
      sessions,
      "nonexistent",
      "browser_nonexistent",
      "q_nonexistent",
      { choice: "yes" },
      runner,
    );

    expect(calls).toHaveLength(0);
  });
});
