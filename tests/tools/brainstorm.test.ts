// tests/tools/brainstorm.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionStore } from "../../src/session/sessions";
import { createStateStore } from "../../src/state/store";
import { createBrainstormTools } from "../../src/tools/brainstorm";
import { outputText } from "../../src/tools/output";

describe("Brainstorm Tools", () => {
  let sessions: ReturnType<typeof createSessionStore>;
  let tools: ReturnType<typeof createBrainstormTools>;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "octto-brainstorm-test-"));
    sessions = createSessionStore({ skipBrowser: true });
    tools = createBrainstormTools(sessions, undefined as any, tempDir);
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
      const result = outputText(
        await tools.create_brainstorm.execute(
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
        ),
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

      const startedAt = performance.now();
      const output = outputText(
        await tools.await_brainstorm_complete.execute(
          { session_id: "ses_stalled", browser_session_id: browser.session_id },
          {} as any,
        ),
      );
      const elapsed = performance.now() - startedAt;

      expect(output).not.toContain("Collected 50 answers");
      expect(output).toContain("end_brainstorm");
      expect(elapsed).toBeLessThan(1000);
    });
  });
});
