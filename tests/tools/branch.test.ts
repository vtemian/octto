// tests/tools/branch.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";

import { createSessionStore } from "../../src/session/sessions";
import { createStateStore } from "../../src/state/store";
import { createBranchTools } from "../../src/tools/branch";

const TEST_DIR = "/tmp/octto-branch-test";

describe("Branch Tools", () => {
  let stateStore: ReturnType<typeof createStateStore>;
  let sessions: ReturnType<typeof createSessionStore>;
  let tools: ReturnType<typeof createBranchTools>;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    stateStore = createStateStore(TEST_DIR);
    sessions = createSessionStore({ skipBrowser: true });
    tools = createBranchTools(stateStore, sessions);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
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
