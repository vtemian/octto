// tests/state/persistence.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { StatePersistence } from "../../src/state/persistence";
import type { BrainstormState } from "../../src/state/types";

const TEST_DIR = "/tmp/brainstorm-test";

describe("StatePersistence", () => {
  let persistence: StatePersistence;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    persistence = new StatePersistence(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("save and load", () => {
    it("should save state to file and load it back", async () => {
      const state: BrainstormState = {
        session_id: "ses_test123",
        browser_session_id: "ses_browser1",
        request: "Add healthcheck endpoints",
        created_at: Date.now(),
        updated_at: Date.now(),
        branches: {
          infrastructure: {
            id: "infrastructure",
            scope: "Which services need healthchecks",
            status: "exploring",
            questions: [],
            finding: null,
          },
        },
        branch_order: ["infrastructure"],
      };

      await persistence.save(state);

      const loaded = await persistence.load("ses_test123");

      expect(loaded).not.toBeNull();
      expect(loaded!.session_id).toBe("ses_test123");
      expect(loaded!.request).toBe("Add healthcheck endpoints");
      expect(loaded!.branches.infrastructure.scope).toBe("Which services need healthchecks");
    });

    it("should return null for non-existent session", async () => {
      const loaded = await persistence.load("ses_nonexistent");
      expect(loaded).toBeNull();
    });

    it("should create directory if it does not exist", async () => {
      const state: BrainstormState = {
        session_id: "ses_new",
        browser_session_id: null,
        request: "Test",
        created_at: Date.now(),
        updated_at: Date.now(),
        branches: {},
        branch_order: [],
      };

      await persistence.save(state);

      expect(existsSync(TEST_DIR)).toBe(true);
    });
  });

  describe("delete", () => {
    it("should delete state file", async () => {
      const state: BrainstormState = {
        session_id: "ses_delete",
        browser_session_id: null,
        request: "Delete me",
        created_at: Date.now(),
        updated_at: Date.now(),
        branches: {},
        branch_order: [],
      };

      await persistence.save(state);
      expect(await persistence.load("ses_delete")).not.toBeNull();

      await persistence.delete("ses_delete");
      expect(await persistence.load("ses_delete")).toBeNull();
    });
  });

  describe("list", () => {
    it("should list all session IDs", async () => {
      const state1: BrainstormState = {
        session_id: "ses_list1",
        browser_session_id: null,
        request: "First",
        created_at: Date.now(),
        updated_at: Date.now(),
        branches: {},
        branch_order: [],
      };
      const state2: BrainstormState = {
        session_id: "ses_list2",
        browser_session_id: null,
        request: "Second",
        created_at: Date.now(),
        updated_at: Date.now(),
        branches: {},
        branch_order: [],
      };

      await persistence.save(state1);
      await persistence.save(state2);

      const ids = await persistence.list();
      expect(ids).toContain("ses_list1");
      expect(ids).toContain("ses_list2");
    });
  });
});
