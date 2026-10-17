import { describe, expect, it } from "bun:test";

import { joinTextParts, toV1Tool } from "../../src/host/v1";
import type { OcttoTool } from "../../src/tools/types";

describe("toV1Tool", () => {
  it("keeps description and args and forwards the host session id", async () => {
    let seen: string | undefined;
    const core: OcttoTool = {
      description: "d",
      args: {},
      execute: async (_args, call) => {
        seen = call.sessionID;
        return "ok";
      },
    };

    const v1 = toV1Tool(core);
    const output = await v1.execute({}, { sessionID: "ses_host" } as any);

    expect(v1.description).toBe("d");
    expect(output).toBe("ok");
    expect(seen).toBe("ses_host");
  });
});

describe("joinTextParts", () => {
  it("concatenates text parts in order and skips other kinds", () => {
    const parts = [
      { type: "text", text: '{"done": true, ' },
      { type: "image", url: "x" },
      { type: "text", text: '"finding": "concatenated"}' },
    ];
    expect(joinTextParts(parts)).toBe('{"done": true, "finding": "concatenated"}');
  });

  it("returns an empty string when there is no text", () => {
    expect(joinTextParts([{ type: "image" }])).toBe("");
  });
});
