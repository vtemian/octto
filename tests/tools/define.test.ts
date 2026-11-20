import { describe, expect, it } from "bun:test";

import { z } from "zod";

import { defineTool } from "../../src/tools/define";

describe("defineTool", () => {
  it("returns the definition unchanged so hosts can read description and args", async () => {
    const tool = defineTool({
      description: "echo",
      args: { text: z.string() },
      execute: async (args) => `got ${args.text}`,
    });

    expect(tool.description).toBe("echo");
    expect(Object.keys(tool.args)).toEqual(["text"]);
    expect(await tool.execute({ text: "hi" }, {})).toBe("got hi");
  });

  it("passes the host session id through the call context", async () => {
    const tool = defineTool({
      description: "who",
      args: {},
      execute: async (_args, call) => call.sessionID ?? "none",
    });

    expect(await tool.execute({}, { sessionID: "ses_host" })).toBe("ses_host");
    expect(await tool.execute({}, {})).toBe("none");
  });
});
