import { describe, expect, it } from "bun:test";

import { createTracker } from "../../src/session/tracker";
import type { OcttoTool } from "../../src/tools/types";

function echoTool(output: string): OcttoTool {
  return { description: "echo", args: {}, execute: async () => output };
}

describe("createTracker", () => {
  it("records every octto session id a tracked tool mentions, per host session", async () => {
    const ended: string[] = [];
    const tracker = createTracker(async (id) => {
      ended.push(id);
    });
    const tool = tracker.wrap(echoTool("state ses_abc123 browser ses_def456"));

    await tool.execute({}, { sessionID: "host_1" });
    await tracker.release("host_1");

    expect(ended.sort()).toEqual(["ses_abc123", "ses_def456"]);
  });

  it("ignores calls without a host session id", async () => {
    const ended: string[] = [];
    const tracker = createTracker(async (id) => {
      ended.push(id);
    });
    const tool = tracker.wrap(echoTool("ses_orphan"));

    await tool.execute({}, {});
    await tracker.release("host_1");

    expect(ended).toEqual([]);
  });

  it("releases a host session only once", async () => {
    let calls = 0;
    const tracker = createTracker(async () => {
      calls += 1;
    });
    const tool = tracker.wrap(echoTool("ses_once"));

    await tool.execute({}, { sessionID: "host_1" });
    await tracker.release("host_1");
    await tracker.release("host_1");

    expect(calls).toBe(1);
  });

  it("returns the tool output unchanged", async () => {
    const tracker = createTracker(async () => {});
    const tool = tracker.wrap(echoTool("<brainstorm_created>ses_x</brainstorm_created>"));

    expect(await tool.execute({}, { sessionID: "h" })).toBe("<brainstorm_created>ses_x</brainstorm_created>");
  });
});
