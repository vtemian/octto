// tests/state/state-store.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";

import { createStateStore, type StateStore } from "../../src/state/store";

const TEST_DIR = "/tmp/octto-state-store-test";

describe("createStateStore", () => {
  let stateStore: StateStore;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    stateStore = createStateStore(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("createSession", () => {
    it("should create a new session with branches", async () => {
      const state = await stateStore.createSession("ses_create1", "Add healthcheck", [
        { id: "services", scope: "Which services need healthchecks" },
        { id: "format", scope: "What format for healthcheck responses" },
      ]);

      expect(state.session_id).toBe("ses_create1");
      expect(state.request).toBe("Add healthcheck");
      expect(Object.keys(state.branches)).toHaveLength(2);
      expect(state.branches.services.scope).toBe("Which services need healthchecks");
      expect(state.branches.format.scope).toBe("What format for healthcheck responses");
      expect(state.branch_order).toEqual(["services", "format"]);
    });
  });

  describe("addQuestionToBranch", () => {
    it("should add question to the correct branch", async () => {
      await stateStore.createSession("ses_addq", "Test", [{ id: "branch1", scope: "Test scope" }]);

      const _question = await stateStore.addQuestionToBranch("ses_addq", "branch1", {
        id: "q_test1",
        type: "ask_text",
        text: "What is the goal?",
        config: { question: "What is the goal?" },
      });

      const state = await stateStore.getSession("ses_addq");
      expect(state!.branches.branch1.questions).toHaveLength(1);
      expect(state!.branches.branch1.questions[0].text).toBe("What is the goal?");
    });
  });

  describe("recordAnswer", () => {
    it("should record answer for a question", async () => {
      await stateStore.createSession("ses_answer", "Test", [{ id: "branch1", scope: "Test scope" }]);
      await stateStore.addQuestionToBranch("ses_answer", "branch1", {
        id: "q_ans1",
        type: "ask_text",
        text: "What is the goal?",
        config: { question: "What is the goal?" },
      });

      await stateStore.recordAnswer("ses_answer", "q_ans1", { text: "Build an API" });

      const state = await stateStore.getSession("ses_answer");
      expect(state!.branches.branch1.questions[0].answer).toEqual({ text: "Build an API" });
      expect(state!.branches.branch1.questions[0].answeredAt).toBeDefined();
    });
  });

  describe("completeBranch", () => {
    it("should mark branch as done with finding", async () => {
      await stateStore.createSession("ses_complete", "Test", [{ id: "branch1", scope: "Test scope" }]);

      await stateStore.completeBranch("ses_complete", "branch1", "User wants PostgreSQL and Redis");

      const state = await stateStore.getSession("ses_complete");
      expect(state!.branches.branch1.status).toBe("done");
      expect(state!.branches.branch1.finding).toBe("User wants PostgreSQL and Redis");
    });
  });

  describe("getNextExploringBranch", () => {
    it("should return first exploring branch", async () => {
      await stateStore.createSession("ses_next", "Test", [
        { id: "branch1", scope: "First scope" },
        { id: "branch2", scope: "Second scope" },
      ]);

      const branch = await stateStore.getNextExploringBranch("ses_next");
      expect(branch!.id).toBe("branch1");
    });

    it("should skip done branches", async () => {
      await stateStore.createSession("ses_skip", "Test", [
        { id: "branch1", scope: "First scope" },
        { id: "branch2", scope: "Second scope" },
      ]);
      await stateStore.completeBranch("ses_skip", "branch1", "Done");

      const branch = await stateStore.getNextExploringBranch("ses_skip");
      expect(branch!.id).toBe("branch2");
    });

    it("should return null when all branches done", async () => {
      await stateStore.createSession("ses_alldone", "Test", [{ id: "branch1", scope: "First scope" }]);
      await stateStore.completeBranch("ses_alldone", "branch1", "Done");

      const branch = await stateStore.getNextExploringBranch("ses_alldone");
      expect(branch).toBeNull();
    });
  });

  describe("isSessionComplete", () => {
    it("should return false when branches are exploring", async () => {
      await stateStore.createSession("ses_incomplete", "Test", [{ id: "branch1", scope: "First scope" }]);

      expect(await stateStore.isSessionComplete("ses_incomplete")).toBe(false);
    });

    it("should return true when all branches done", async () => {
      await stateStore.createSession("ses_allcomplete", "Test", [{ id: "branch1", scope: "First scope" }]);
      await stateStore.completeBranch("ses_allcomplete", "branch1", "Done");

      expect(await stateStore.isSessionComplete("ses_allcomplete")).toBe(true);
    });
  });
});
