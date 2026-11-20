import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// start_session opens a browser for real. Mock before the core module graph loads.
mock.module("../src/session/browser", () => ({ openBrowser: async () => {} }));

import { createOctto, type Octto } from "../src/octto";

const probe = { run: async () => '{"done": true, "finding": "n/a"}' };

describe("createOctto", () => {
  let octto: Octto | undefined;
  let directory: string;

  const pinnedPort = process.env.OCTTO_PORT;

  // Doubles as configDir, so the developer's own octto.json (port, model, fragments)
  // stays out; a pinned OCTTO_PORT would collide with their running octto.
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "octto-core-test-"));
    delete process.env.OCTTO_PORT;
  });

  afterEach(async () => {
    await octto?.dispose();
    octto = undefined;
    rmSync(directory, { recursive: true, force: true });
    if (pinnedPort !== undefined) process.env.OCTTO_PORT = pinnedPort;
  });

  it("exposes every tool and the three agents", async () => {
    octto = await createOctto({ directory, probe, configDir: directory });

    expect(Object.keys(octto.tools)).toContain("start_session");
    expect(Object.keys(octto.tools)).toContain("create_brainstorm");
    expect(Object.keys(octto.tools)).toContain("push_question");
    expect(Object.keys(octto.agents).sort()).toEqual(["bootstrapper", "octto", "probe"]);
    expect(octto.agents.octto.prompt).toBeDefined();
  });

  it("ends the octto sessions a host session created when that host session is deleted", async () => {
    octto = await createOctto({ directory, probe, configDir: directory });
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
    octto = await createOctto({ directory, probe, configDir: directory });
    await expect(octto.onSessionDeleted("nobody")).resolves.toBeUndefined();
  });
});
