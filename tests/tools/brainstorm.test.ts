// tests/tools/brainstorm.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionStore } from "../../src/session/sessions";
import { createStateStore } from "../../src/state/store";
import { createBrainstormTools } from "../../src/tools/brainstorm";

// These tests never reach the probe: the stalled session has no answer to process.
const idleProbe = { run: async () => '{"done": true}' };

describe("Brainstorm Tools", () => {
  let sessions: ReturnType<typeof createSessionStore>;
  let tools: ReturnType<typeof createBrainstormTools>;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "octto-brainstorm-test-"));
    sessions = createSessionStore({ skipBrowser: true });
    tools = createBrainstormTools(sessions, idleProbe, tempDir);
  });

  afterEach(async () => {
    await sessions.cleanup();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("create_brainstorm", () => {
    it("should create brainstorm session with branches", async () => {
      const result = await tools.create_brainstorm.execute(
        {
          request: "Add healthcheck",
          branches: [
            {
              id: "services",
              scope: "Which services to monitor",
              initial_question: {
                type: "ask_text",
                config: { question: "What services?" },
              },
            },
          ],
        },
        {} as any,
      );

      expect(result).toContain("ses_");
      expect(result).toContain("services");
    });

    it("should point the agent at await_brainstorm_complete rather than a manual answer loop", async () => {
      const result = await tools.create_brainstorm.execute(
        {
          request: "Add healthcheck",
          branches: [
            {
              id: "services",
              scope: "Which services to monitor",
              initial_question: {
                type: "ask_text",
                config: { question: "What services?" },
              },
            },
          ],
        },
        {} as any,
      );

      const nextAction = result.slice(result.indexOf("<next_action>"), result.indexOf("</next_action>"));
      expect(nextAction).toContain("await_brainstorm_complete");
      expect(nextAction).not.toContain("Call get_next_answer");
    });
  });

  describe("await_brainstorm_complete", () => {
    it("should stop collecting instead of spinning when nothing is pending", async () => {
      const stateStore = createStateStore(tempDir);
      await stateStore.createSession("ses_stalled", "req", [{ id: "b1", scope: "scope one" }]);
      const browser = await sessions.startSession({});

      const output = await tools.await_brainstorm_complete.execute(
        { session_id: "ses_stalled", browser_session_id: browser.session_id },
        {} as any,
      );

      // The stall is observable in the message, not the clock: the old loop spun
      // through all 50 iterations just as fast and then told the agent to retry.
      expect(output).not.toContain("Collected 50 answers");
      expect(output).toContain("cannot progress on its own");
      expect(output).toContain("end_brainstorm");
    });

    it("stops waiting when the call is interrupted, without pushing the plan review", async () => {
      const stateStore = createStateStore(tempDir);
      await stateStore.createSession("ses_int", "req", [{ id: "b1", scope: "scope one" }]);
      const browser = await sessions.startSession({ questions: [{ type: "confirm", config: { question: "Go?" } }] });
      const interrupted = new AbortController();

      const call = tools.await_brainstorm_complete.execute(
        { session_id: "ses_int", browser_session_id: browser.session_id },
        { signal: interrupted.signal },
      );
      interrupted.abort();

      expect(await call).toContain("<brainstorm_interrupted>");
      const types = sessions.listQuestions(browser.session_id).questions.map((q) => q.type);
      expect(types).toEqual(["confirm"]);
    });

    it("cancels its plan review when interrupted, so the retry's review is the only one open", async () => {
      const stateStore = createStateStore(tempDir);
      await stateStore.createSession("ses_rev", "req", [{ id: "b1", scope: "scope one" }]);
      await stateStore.completeBranch("ses_rev", "b1", "done");
      const browser = await sessions.startSession({});
      const interrupted = new AbortController();

      const call = tools.await_brainstorm_complete.execute(
        { session_id: "ses_rev", browser_session_id: browser.session_id },
        { signal: interrupted.signal },
      );
      await waitForQuestion(sessions, browser.session_id, "show_plan");
      interrupted.abort();

      expect(await call).toContain("<brainstorm_interrupted>");
      const review = sessions.listQuestions(browser.session_id).questions.find((q) => q.type === "show_plan");
      expect(review?.status).toBe("cancelled");
    });
  });
});

async function waitForQuestion(
  sessions: ReturnType<typeof createSessionStore>,
  sessionId: string,
  type: string,
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!sessions.listQuestions(sessionId).questions.some((q) => q.type === type)) {
    if (Date.now() > deadline) throw new Error(`no ${type} question in time`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
