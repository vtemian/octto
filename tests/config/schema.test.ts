// tests/config/schema.test.ts
import { describe, expect, it } from "bun:test";

import * as v from "valibot";

import { FragmentsSchema, OcttoConfigSchema } from "../../src/config/schema";

describe("OcttoConfigSchema", () => {
  describe("port field", () => {
    it("should accept valid port number", () => {
      const result = v.safeParse(OcttoConfigSchema, { port: 3000 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.port).toBe(3000);
      }
    });

    it("should accept port 0 (random port)", () => {
      const result = v.safeParse(OcttoConfigSchema, { port: 0 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.port).toBe(0);
      }
    });

    it("should accept maximum valid port 65535", () => {
      const result = v.safeParse(OcttoConfigSchema, { port: 65535 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.port).toBe(65535);
      }
    });

    it("should reject negative port", () => {
      const result = v.safeParse(OcttoConfigSchema, { port: -1 });
      expect(result.success).toBe(false);
    });

    it("should reject port above 65535", () => {
      const result = v.safeParse(OcttoConfigSchema, { port: 65536 });
      expect(result.success).toBe(false);
    });

    it("should reject non-integer port", () => {
      const result = v.safeParse(OcttoConfigSchema, { port: 3000.5 });
      expect(result.success).toBe(false);
    });

    it("should allow config without port (optional)", () => {
      const result = v.safeParse(OcttoConfigSchema, {});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.port).toBeUndefined();
      }
    });
  });

  describe("fragments field", () => {
    it("should accept valid fragments for known agents", () => {
      const result = v.safeParse(OcttoConfigSchema, {
        fragments: {
          octto: ["instruction 1", "instruction 2"],
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.fragments?.octto).toEqual(["instruction 1", "instruction 2"]);
      }
    });

    it("should accept fragments for multiple agents", () => {
      const result = v.safeParse(OcttoConfigSchema, {
        fragments: {
          octto: ["octto instruction"],
          bootstrapper: ["bootstrapper instruction"],
          probe: ["probe instruction"],
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.fragments?.octto).toEqual(["octto instruction"]);
        expect(result.output.fragments?.bootstrapper).toEqual(["bootstrapper instruction"]);
        expect(result.output.fragments?.probe).toEqual(["probe instruction"]);
      }
    });

    it("should accept empty fragments array", () => {
      const result = v.safeParse(OcttoConfigSchema, {
        fragments: {
          octto: [],
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.fragments?.octto).toEqual([]);
      }
    });

    it("should allow config without fragments (optional)", () => {
      const result = v.safeParse(OcttoConfigSchema, {});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.fragments).toBeUndefined();
      }
    });

    it("should reject unknown agent names in fragments", () => {
      const result = v.safeParse(OcttoConfigSchema, {
        fragments: {
          unknown_agent: ["instruction"],
        },
      });
      expect(result.success).toBe(false);
    });

    it("should reject non-string values in fragments array", () => {
      const result = v.safeParse(OcttoConfigSchema, {
        fragments: {
          octto: [123, "valid"],
        },
      });
      expect(result.success).toBe(false);
    });
  });

  describe("agents with variant", () => {
    it("should accept agent config with variant", () => {
      const result = v.safeParse(OcttoConfigSchema, {
        agents: {
          octto: { model: "openai/gpt-5.2", variant: "high" },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.agents?.octto?.variant).toBe("high");
      }
    });

    it("should accept agent config without variant", () => {
      const result = v.safeParse(OcttoConfigSchema, {
        agents: {
          octto: { model: "openai/gpt-5.2" },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.agents?.octto?.variant).toBeUndefined();
      }
    });

    it("should reject non-string variant", () => {
      const result = v.safeParse(OcttoConfigSchema, {
        agents: {
          octto: { variant: 123 },
        },
      });
      expect(result.success).toBe(false);
    });
  });
});

describe("FragmentsSchema", () => {
  it("should be optional", () => {
    const result = v.safeParse(FragmentsSchema, undefined);
    expect(result.success).toBe(true);
  });

  it("should accept valid fragment record", () => {
    const result = v.safeParse(FragmentsSchema, {
      octto: ["instruction"],
    });
    expect(result.success).toBe(true);
  });
});
