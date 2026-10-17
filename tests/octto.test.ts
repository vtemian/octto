import { afterEach, describe, expect, it, mock } from "bun:test";

// start_session opens a browser for real. Mock before the core module graph loads.
mock.module("../src/session/browser", () => ({ openBrowser: async () => {} }));

import { createOctto, type Octto } from "../src/octto";

const probe = { run: async () => '{"done": true, "finding": "n/a"}' };

describe("createOctto", () => {
  let octto: Octto | undefined;

  afterEach(async () => {
    await octto?.dispose();
    octto = undefined;
  });

  it("exposes every tool and the three agents", async () => {
    octto = await createOctto({ directory: "/tmp/octto-core-test", probe });

    expect(Object.keys(octto.tools)).toContain("start_session");
    expect(Object.keys(octto.tools)).toContain("create_brainstorm");
    expect(Object.keys(octto.tools)).toContain("push_question");
    expect(Object.keys(octto.agents).sort()).toEqual(["bootstrapper", "octto", "probe"]);
    expect(octto.agents.octto.prompt).toBeDefined();
  });

  it("ends the octto sessions a host session created when that host session is deleted", async () => {
    octto = await createOctto({ directory: "/tmp/octto-core-test", probe });
    const started = await octto.tools.start_session.execute(
      { title: "t", questions: [{ type: "confirm", config: { question: "Go?" } }] },
      { sessionID: "host_1" },
    );
    const url = started.match(/http:\/\/localhost:\d+\/\?token=[a-f0-9]+/)?.[0];
    expect(url).toBeDefined();
    expect((await fetch(url!)).ok).toBe(true);

    await octto.onSessionDeleted("host_1");

    await expect(fetch(url!)).rejects.toThrow();
  });

  it("ignores unknown host sessions", async () => {
    octto = await createOctto({ directory: "/tmp/octto-core-test", probe });
    await expect(octto.onSessionDeleted("nobody")).resolves.toBeUndefined();
  });
});
