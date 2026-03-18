// src/tools/types.ts

import type { ToolContext } from "@opencode-ai/plugin/tool";
import type { createOpencodeClient } from "@opencode-ai/sdk";

// Using `any` to avoid exposing zod types in declaration files.
// The actual tools are typesafe via zod schemas.
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface OcttoTool {
  description: string;
  // biome-ignore lint/suspicious/noExplicitAny: zod schema type not exposed in declaration files
  args: any;
  // biome-ignore lint/suspicious/noExplicitAny: zod schema type not exposed in declaration files
  execute: (args: any, context: ToolContext) => Promise<string>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export type OcttoTools = Record<string, OcttoTool>;

export type OpencodeClient = ReturnType<typeof createOpencodeClient>;
