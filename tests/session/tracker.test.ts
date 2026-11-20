import { describe, expect, it } from "bun:test";

import { createTracker } from "../../src/session/tracker";
import type { OcttoTool } from "../../src/tools/types";

function sessionTool(sessionId: string, output = sessionId): OcttoTool {
  return {
    description: "open a browser session",
    args: {},
    async execute(_args, call) {
      await call.trackBrowserSession?.(sessionId);
      return output;
    },
  };
}

describe("createTracker", () => {
  it("only ends browser sessions registered by the deleted host session", async () => {
    const ended: string[] = [];
    const tracker = createTracker(async (id) => {
      ended.push(id);
    });
    const tool = tracker.wrap(sessionTool("ses_abc123", "state ses_other browser ses_def456"));
    const otherTool = tracker.wrap(sessionTool("ses_def456"));

    await tool.execute({}, { sessionID: "host_1" });
    await otherTool.execute({}, { sessionID: "host_2" });
    await tracker.release("host_1");

    expect(ended).toEqual(["ses_abc123"]);
    await tracker.release("host_2");
    expect(ended).toEqual(["ses_abc123", "ses_def456"]);
  });

  it("ends a browser session opened by a tool still running after host deletion", async () => {
    const ended: string[] = [];
    const tracker = createTracker(async (id) => {
      ended.push(id);
    });
    const tool = tracker.wrap({
      description: "slow creation",
      args: {},
      async execute(_args, call) {
        await tracker.release("host_1");
        await call.trackBrowserSession?.("ses_late");
        return "opened";
      },
    });

    expect(await tool.execute({}, { sessionID: "host_1" })).toBe("opened");
    expect(ended).toEqual(["ses_late"]);
  });

  it("ignores calls without a host session id", async () => {
    const ended: string[] = [];
    const tracker = createTracker(async (id) => {
      ended.push(id);
    });
    const tool = tracker.wrap(sessionTool("ses_orphan"));

    await tool.execute({}, {});
    await tracker.release("host_1");

    expect(ended).toEqual([]);
  });

  it("releases a host session only once", async () => {
    let calls = 0;
    const tracker = createTracker(async () => {
      calls += 1;
    });
    const tool = tracker.wrap(sessionTool("ses_once"));

    await tool.execute({}, { sessionID: "host_1" });
    await tracker.release("host_1");
    await tracker.release("host_1");

    expect(calls).toBe(1);
  });

  it("returns the tool output unchanged", async () => {
    const tracker = createTracker(async () => {});
    const tool = tracker.wrap(sessionTool("ses_x", "<brainstorm_created>ses_x</brainstorm_created>"));

    expect(await tool.execute({}, { sessionID: "h" })).toBe("<brainstorm_created>ses_x</brainstorm_created>");
  });
});
