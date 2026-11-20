// tests/state/persistence.test.ts
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStatePersistence, type StatePersistence } from "../../src/state/persistence";
import type { BrainstormState } from "../../src/state/types";

const STATE_SIZE = 2_000_000;

describe("createStatePersistence", () => {
  let persistence: StatePersistence;
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "octto-persistence-test-"));
    persistence = createStatePersistence(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("save and load", () => {
    it("creates and replaces state files without granting group or public access", async () => {
      const state: BrainstormState = {
        session_id: "ses_private",
        browser_session_id: null,
        request: "Private brainstorm",
        created_at: Date.now(),
        updated_at: Date.now(),
        branches: {},
        branch_order: [],
      };
      const filePath = join(testDir, "ses_private.json");
      const groupAndPublicBits = 0o077;

      await persistence.save(state);
      expect(statSync(filePath).mode & groupAndPublicBits).toBe(0);
      await persistence.save(state);
      expect(statSync(filePath).mode & groupAndPublicBits).toBe(0);
    });

    it("never lets a concurrent load see a half-written file", async () => {
      const state: BrainstormState = {
        session_id: "ses_race",
        browser_session_id: null,
        // Large enough that a truncate-then-write save is observable mid-write.
        request: "x".repeat(STATE_SIZE),
        created_at: Date.now(),
        updated_at: Date.now(),
        branches: {},
        branch_order: [],
      };
      await persistence.save(state);

      const rounds = Array.from({ length: 50 }, () =>
        Promise.all([persistence.save(state), persistence.load("ses_race")]),
      );
      const loads = (await Promise.all(rounds)).map(([, loaded]) => loaded?.request.length);

      expect(loads.every((length) => length === STATE_SIZE)).toBe(true);
    });

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

    it("should return null for valid JSON with invalid schema", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      // Write a valid JSON file that doesn't match BrainstormState schema
      const filePath = join(testDir, "ses_corrupt.json");
      await Bun.write(filePath, JSON.stringify({ not_a: "valid_state" }));

      const loaded = await persistence.load("ses_corrupt");
      expect(loaded).toBeNull();
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
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

      expect(existsSync(testDir)).toBe(true);
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

  describe("session ID validation", () => {
    it("should reject session IDs with path traversal sequences", async () => {
      const state: BrainstormState = {
        session_id: "../etc/passwd",
        browser_session_id: null,
        request: "Malicious",
        created_at: Date.now(),
        updated_at: Date.now(),
        branches: {},
        branch_order: [],
      };

      expect(() => persistence.save(state)).toThrow("Invalid session ID: ../etc/passwd");
    });

    it("should reject session IDs with slashes", async () => {
      await expect(persistence.load("foo/bar")).rejects.toThrow("Invalid session ID: foo/bar");
    });

    it("should reject session IDs with dots", async () => {
      await expect(persistence.delete("session.id")).rejects.toThrow("Invalid session ID: session.id");
    });

    it("should accept valid session IDs with alphanumeric, underscore, and hyphen", async () => {
      const state: BrainstormState = {
        session_id: "ses_valid-123_ABC",
        browser_session_id: null,
        request: "Valid",
        created_at: Date.now(),
        updated_at: Date.now(),
        branches: {},
        branch_order: [],
      };

      await persistence.save(state);
      const loaded = await persistence.load("ses_valid-123_ABC");
      expect(loaded).not.toBeNull();
      expect(loaded!.session_id).toBe("ses_valid-123_ABC");
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
