import type { z } from "zod";

import type { OcttoTool, ToolCall } from "./types";

interface ToolDefinition<Args extends z.ZodRawShape> {
  readonly description: string;
  readonly args: Args;
  execute(args: z.infer<z.ZodObject<Args>>, call: ToolCall): Promise<string>;
}

/** Identity with typing: hosts wrap the result, octto code gets typed args. */
export function defineTool<Args extends z.ZodRawShape>(definition: ToolDefinition<Args>): OcttoTool {
  return definition;
}
