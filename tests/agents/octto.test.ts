import { describe, expect, it } from "bun:test";

import { octto } from "../../src/agents";

describe("octto agent", () => {
  // Verified against 1.18.32 and 2.0.32: v1 names its subagent tool `task`,
  // v2 names it `subagent`, and neither has `background_task`.
  it("tells the model to bootstrap through a subagent tool that exists on either host", () => {
    expect(octto.prompt).toContain('subagent(agent="bootstrapper"');
    expect(octto.prompt).toContain('task(subagent_type="bootstrapper"');
    expect(octto.prompt).not.toContain("background_task");
  });
});
