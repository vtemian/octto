// src/tools/index.ts

import type { OpencodeClient } from "@opencode-ai/sdk";
import type { SessionStore } from "@session";
import { createStateStore } from "@state";

import { createBranchTools } from "./branch";
import { createPushQuestionTool } from "./push-question";
import { createQuestionTools } from "./questions";
import { createResponseTools } from "./responses";
import { createSessionTools } from "./session";

export function createOcttoTools(sessions: SessionStore, _client?: OpencodeClient) {
  const stateStore = createStateStore();

  return {
    ...createSessionTools(sessions),
    ...createQuestionTools(sessions),
    ...createResponseTools(sessions),
    ...createPushQuestionTool(sessions),
    ...createBranchTools(stateStore, sessions),
  };
}
