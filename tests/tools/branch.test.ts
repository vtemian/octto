// tests/tools/branch.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "fs";
import { createBranchTools } from "../../src/tools/branch";
import { StateManager } from "../../src/state/manager";
import { SessionManager } from "../../src/session/manager";

const TEST_DIR = "/tmp/brainstorm-branch-test";

describe("Branch Tools", () => {
  let stateManager: StateManager;
  let sessionManager: SessionManager;
  let tools: ReturnType<typeof createBranchTools>;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    stateManager = new StateManager(TEST_DIR);
    sessionManager = new SessionManager({ skipBrowser: true });
    tools = createBranchTools(stateManager, sessionManager);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("create_brainstorm", () => {
    it("should create brainstorm session with branches", async () => {
      const result = await tools.create_brainstorm.execute({
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
      }, {} as any);

      expect(result).toContain("ses_");
      expect(result).toContain("services");
    });
  });

});
