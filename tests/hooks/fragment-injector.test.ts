// tests/hooks/fragment-injector.test.ts
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  formatFragmentsBlock,
  levenshteinDistance,
  loadProjectFragments,
  mergeFragments,
  warnUnknownAgents,
} from "../../src/hooks/fragment-injector";

describe("formatFragmentsBlock", () => {
  it("should return empty string for undefined fragments", () => {
    expect(formatFragmentsBlock(undefined)).toBe("");
  });

  it("should return empty string for empty array", () => {
    expect(formatFragmentsBlock([])).toBe("");
  });

  it("should format single fragment as XML block", () => {
    const result = formatFragmentsBlock(["Custom instruction"]);
    expect(result).toBe("<user-instructions>\n- Custom instruction\n</user-instructions>\n\n");
  });

  it("should format multiple fragments as XML block with bullet points", () => {
    const result = formatFragmentsBlock(["Instruction 1", "Instruction 2", "Instruction 3"]);
    expect(result).toBe(
      "<user-instructions>\n- Instruction 1\n- Instruction 2\n- Instruction 3\n</user-instructions>\n\n",
    );
  });
});

describe("mergeFragments", () => {
  it("should return empty object when both are undefined", () => {
    expect(mergeFragments(undefined, undefined)).toEqual({});
  });

  it("should return global fragments when project is undefined", () => {
    const global = { octto: ["global instruction"] };
    expect(mergeFragments(global, undefined)).toEqual({ octto: ["global instruction"] });
  });

  it("should return project fragments when global is undefined", () => {
    const project = { octto: ["project instruction"] };
    expect(mergeFragments(undefined, project)).toEqual({ octto: ["project instruction"] });
  });

  it("should merge fragments for same agent (global first, project appended)", () => {
    const global = { octto: ["global instruction"] };
    const project = { octto: ["project instruction"] };
    expect(mergeFragments(global, project)).toEqual({
      octto: ["global instruction", "project instruction"],
    });
  });

  it("should keep fragments for different agents separate", () => {
    const global = { octto: ["octto instruction"] };
    const project = { bootstrapper: ["bootstrapper instruction"] };
    expect(mergeFragments(global, project)).toEqual({
      octto: ["octto instruction"],
      bootstrapper: ["bootstrapper instruction"],
    });
  });

  it("should merge complex multi-agent fragments", () => {
    const global = {
      octto: ["octto global 1", "octto global 2"],
      probe: ["probe global"],
    };
    const project = {
      octto: ["octto project"],
      bootstrapper: ["bootstrapper project"],
    };
    expect(mergeFragments(global, project)).toEqual({
      octto: ["octto global 1", "octto global 2", "octto project"],
      probe: ["probe global"],
      bootstrapper: ["bootstrapper project"],
    });
  });
});

describe("loadProjectFragments", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "octto-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("should return undefined when .octto directory does not exist", async () => {
    const result = await loadProjectFragments(tempDir);
    expect(result).toBeUndefined();
  });

  it("should return undefined when fragments.json does not exist", async () => {
    await mkdir(join(tempDir, ".octto"));
    const result = await loadProjectFragments(tempDir);
    expect(result).toBeUndefined();
  });

  it("should load valid fragments.json", async () => {
    await mkdir(join(tempDir, ".octto"));
    await writeFile(join(tempDir, ".octto", "fragments.json"), JSON.stringify({ octto: ["project instruction"] }));

    const result = await loadProjectFragments(tempDir);
    expect(result).toEqual({ octto: ["project instruction"] });
  });

  it("should return undefined for invalid JSON", async () => {
    await mkdir(join(tempDir, ".octto"));
    await writeFile(join(tempDir, ".octto", "fragments.json"), "not valid json");

    const result = await loadProjectFragments(tempDir);
    expect(result).toBeUndefined();
  });

  it("should return undefined for invalid schema (wrong type)", async () => {
    await mkdir(join(tempDir, ".octto"));
    await writeFile(join(tempDir, ".octto", "fragments.json"), JSON.stringify({ octto: "not an array" }));

    const result = await loadProjectFragments(tempDir);
    expect(result).toBeUndefined();
  });
});

describe("levenshteinDistance", () => {
  it("should return 0 for identical strings", () => {
    expect(levenshteinDistance("octto", "octto")).toBe(0);
  });

  it("should return length of b for empty a", () => {
    expect(levenshteinDistance("", "octto")).toBe(5);
  });

  it("should return length of a for empty b", () => {
    expect(levenshteinDistance("octto", "")).toBe(5);
  });

  it("should calculate single character substitution", () => {
    expect(levenshteinDistance("octto", "octta")).toBe(1);
  });

  it("should calculate single character insertion", () => {
    expect(levenshteinDistance("octto", "octtoo")).toBe(1);
  });

  it("should calculate single character deletion", () => {
    expect(levenshteinDistance("octto", "octt")).toBe(1);
  });

  it("should handle typical typos", () => {
    expect(levenshteinDistance("octto", "octo")).toBe(1); // missing t
    expect(levenshteinDistance("bootstrapper", "bootsrapper")).toBe(1); // typo
  });
});

describe("warnUnknownAgents", () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("should not warn for valid agent names", () => {
    warnUnknownAgents({ octto: ["instruction"], bootstrapper: ["instruction"] });
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("should not warn for undefined fragments", () => {
    warnUnknownAgents(undefined);
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("should not warn for empty fragments", () => {
    warnUnknownAgents({});
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("should warn for unknown agent name", () => {
    warnUnknownAgents({ unknown_agent: ["instruction"] } as any);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[octto] Unknown agent "unknown_agent" in fragments'),
    );
  });

  it("should suggest similar agent name for typos", () => {
    warnUnknownAgents({ octo: ["instruction"] } as any);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Did you mean "octto"?'));
  });

  it("should suggest multiple similar names when applicable", () => {
    // "prob" is close to "probe"
    warnUnknownAgents({ prob: ["instruction"] } as any);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Did you mean "probe"?'));
  });
});
