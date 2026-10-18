import { describe, expect, it } from "bun:test";

import { createClientProbe, joinTextParts, toV1Tool } from "../../src/host/v1";
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

describe("createClientProbe", () => {
  function fakeClient(calls: { created: unknown[]; prompted: any[]; deleted: unknown[] }) {
    return {
      session: {
        create: async (input: unknown) => {
          calls.created.push(input);
          return { data: { id: "ses_probe" } };
        },
        prompt: async (input: unknown) => {
          calls.prompted.push(input);
          return { data: { parts: [{ type: "text", text: '{"done": true, "finding": "f"}' }] } };
        },
        delete: async (input: unknown) => {
          calls.deleted.push(input);
          return {};
        },
      },
    };
  }

  it("prompts the agent with every tool denied, returns its text and deletes the session", async () => {
    const calls = { created: [], prompted: [] as any[], deleted: [] };

    const text = await createClientProbe(fakeClient(calls) as any).run("probe", "ctx");

    expect(text).toBe('{"done": true, "finding": "f"}');
    expect(calls.prompted[0]).toEqual({
      path: { id: "ses_probe" },
      body: { agent: "probe", tools: { "*": false }, parts: [{ type: "text", text: "ctx" }] },
    });
    expect(calls.deleted).toEqual([{ path: { id: "ses_probe" } }]);
  });
});
