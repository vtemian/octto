import { beforeEach, describe, expect, it } from "bun:test";

import { createWaiters, type Waiters, waitForResponse } from "../../src/session/waiter";

describe("createWaiters", () => {
  let waiters: Waiters<string, unknown>;

  beforeEach(() => {
    waiters = createWaiters<string, unknown>();
  });

  describe("register", () => {
    it("should register a waiter and return cleanup function", () => {
      let _resolved = false;
      const cleanup = waiters.register("key1", () => {
        _resolved = true;
      });

      expect(typeof cleanup).toBe("function");
      expect(waiters.has("key1")).toBe(true);
    });

    it("should allow multiple waiters for same key", () => {
      waiters.register("key1", () => {});
      waiters.register("key1", () => {});

      expect(waiters.count("key1")).toBe(2);
    });

    it("cleanup should remove only that waiter", () => {
      const cleanup1 = waiters.register("key1", () => {});
      waiters.register("key1", () => {});

      cleanup1();

      expect(waiters.count("key1")).toBe(1);
    });
  });

  describe("notifyFirst", () => {
    it("should call only the first waiter", async () => {
      const calls: number[] = [];
      waiters.register("key1", () => calls.push(1));
      waiters.register("key1", () => calls.push(2));

      waiters.notifyFirst("key1", "data");

      expect(calls).toEqual([1]);
      expect(waiters.count("key1")).toBe(1);
    });

    it("should do nothing if no waiters", () => {
      // Should not throw
      waiters.notifyFirst("nonexistent", "data");
    });
  });

  describe("notifyAll", () => {
    it("should call all waiters for a key", () => {
      const calls: number[] = [];
      waiters.register("key1", () => calls.push(1));
      waiters.register("key1", () => calls.push(2));

      waiters.notifyAll("key1", "data");

      expect(calls).toEqual([1, 2]);
    });

    it("should remove all waiters after notification", () => {
      waiters.register("key1", () => {});
      waiters.register("key1", () => {});

      waiters.notifyAll("key1", "data");

      expect(waiters.has("key1")).toBe(false);
    });
  });

  describe("immutability", () => {
    it("should not mutate original array when adding waiter", () => {
      waiters.register("key1", () => {});
      const countBefore = waiters.count("key1");

      waiters.register("key1", () => {});

      // Original count should have been 1, now 2
      expect(countBefore).toBe(1);
      expect(waiters.count("key1")).toBe(2);
    });

    it("should not mutate original array when removing waiter", () => {
      const cleanup = waiters.register("key1", () => {});
      waiters.register("key1", () => {});

      const countBefore = waiters.count("key1");
      cleanup();

      expect(countBefore).toBe(2);
      expect(waiters.count("key1")).toBe(1);
    });
  });

  describe("clear", () => {
    it("should remove all waiters for a key", () => {
      waiters.register("key1", () => {});
      waiters.register("key1", () => {});

      waiters.clear("key1");

      expect(waiters.has("key1")).toBe(false);
    });
  });
});

describe("waitForResponse", () => {
  let waiters: Waiters<string, string>;

  beforeEach(() => {
    waiters = createWaiters<string, string>();
  });

  it("should resolve when waiter is notified", async () => {
    const promise = waitForResponse(waiters, "key1", 1000);

    // Simulate async notification
    setTimeout(() => waiters.notifyFirst("key1", "result"), 10);

    const result = await promise;
    expect(result).toEqual({ ok: true, payload: "result" });
  });

  it("should timeout if not notified in time", async () => {
    const result = await waitForResponse(waiters, "key1", 50);

    expect(result).toEqual({ ok: false, reason: "timeout" });
  });

  it("should cleanup waiter on timeout", async () => {
    await waitForResponse(waiters, "key1", 50);

    expect(waiters.has("key1")).toBe(false);
  });

  it("should cleanup timeout on success", async () => {
    const promise = waitForResponse(waiters, "key1", 1000);

    setTimeout(() => waiters.notifyFirst("key1", "result"), 10);

    await promise;

    // If timeout wasn't cleaned up, this would fail or hang
    expect(waiters.has("key1")).toBe(false);
  });
});
