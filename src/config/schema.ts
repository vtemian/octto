import * as v from "valibot";

import { AGENTS } from "@/agents";

export const AgentOverrideSchema = v.partial(
  v.object({
    model: v.string(),
    variant: v.string(),
    temperature: v.pipe(v.number(), v.minValue(0), v.maxValue(2)),
    maxSteps: v.pipe(v.number(), v.integer(), v.minValue(1)),
  }),
);

export const PortSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(65535));

export const FragmentsSchema = v.optional(v.record(v.enum(AGENTS), v.array(v.string())));

export const OcttoConfigSchema = v.object({
  agents: v.optional(v.record(v.enum(AGENTS), AgentOverrideSchema)),
  port: v.optional(PortSchema),
  fragments: FragmentsSchema,
});

export type AgentOverride = v.InferOutput<typeof AgentOverrideSchema>;
export type Fragments = v.InferOutput<typeof FragmentsSchema>;
export type OcttoConfig = v.InferOutput<typeof OcttoConfigSchema>;
