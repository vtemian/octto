import { describe, expect, it } from "bun:test";

describe("entrypoint shape", () => {
  it("default-exports an object both OpenCode 1.18.29+ and OpenCode 2 accept", async () => {
    const { default: octto } = await import("../src");

    expect(typeof octto).toBe("object");
    expect(octto.id).toBe("octto");
    expect(typeof octto.setup).toBe("function");
    expect(typeof octto.server).toBe("function");
    expect("tui" in octto).toBe(false);
  });
});
