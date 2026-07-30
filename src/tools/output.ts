import type { ToolResult } from "@opencode-ai/plugin/tool";

// The plugin SDK lets a tool return either a bare string or a structured
// result; callers that scan tool output need the text either way.
export function outputText(executeOutput: ToolResult): string {
  return typeof executeOutput === "string" ? executeOutput : executeOutput.output;
}
