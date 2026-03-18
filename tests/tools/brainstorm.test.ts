// tests/tools/brainstorm.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionStore } from "../../src/session/sessions";
import { createBrainstormTools } from "../../src/tools/brainstorm";

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
  });
});
