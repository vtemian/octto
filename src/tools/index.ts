import type { SessionStore } from "@/session";

import { createBrainstormTools } from "./brainstorm";
import { createPushQuestionTool } from "./factory";
import type { ProbeRunner } from "./probe";
import { createQuestionTools } from "./questions";
import { createResponseTools } from "./responses";
import { createSessionTools } from "./session";
import type { OcttoTools } from "./types";

export type { ProbeRunner } from "./probe";
export type { OcttoTool, OcttoTools, ToolCall } from "./types";

export function createOcttoTools(sessions: SessionStore, probe: ProbeRunner): OcttoTools {
  return {
    ...createSessionTools(sessions),
    ...createQuestionTools(sessions),
    ...createResponseTools(sessions),
    ...createPushQuestionTool(sessions),
    ...createBrainstormTools(sessions, probe),
  };
}
