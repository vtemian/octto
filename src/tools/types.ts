import type { z } from "zod";

/** The subset of the host tool context octto reads. Both hosts expose these. */
export interface ToolCall {
  readonly sessionID?: string;
  /** Fires when the user interrupts the call, so a blocking wait can stop taking answers. */
  readonly signal?: AbortSignal;
}

/**
 * A host-agnostic tool. `execute` is a method signature on purpose: method
 * bivariance lets defineTool() hand back a tool whose typed execute narrows
 * `args` without a type assertion.
 */
export interface OcttoTool {
  readonly description: string;
  readonly args: z.ZodRawShape;
  execute(args: unknown, call: ToolCall): Promise<string>;
}

export type OcttoTools = Record<string, OcttoTool>;
