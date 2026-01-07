// src/tools/processor.ts

import { AGENTS } from "@/agents";
import type { Answer, QuestionType, SessionStore } from "@/session";
import { BRANCH_STATUSES, type BrainstormState, type StateStore } from "@/state";

import type { OpencodeClient } from "./types";

interface ProbeResult {
  done: boolean;
  finding?: string;
  question?: {
    type: QuestionType;
    config: Record<string, unknown>;
  };
}

function formatBranchContext(state: BrainstormState, branchId: string): string {
  const lines: string[] = [];

  lines.push(`<original_request>${state.request}</original_request>`);
  lines.push("");
  lines.push("<branches>");

  for (const [id, branch] of Object.entries(state.branches)) {
    const isCurrent = id === branchId;
    lines.push(`<branch id="${id}" scope="${branch.scope}"${isCurrent ? ' current="true"' : ""}>`);

    for (const q of branch.questions) {
      lines.push(`  <question type="${q.type}">${q.text}</question>`);
      if (q.answer) {
        lines.push(`  <answer>${JSON.stringify(q.answer)}</answer>`);
      }
    }

    if (branch.status === BRANCH_STATUSES.DONE && branch.finding) {
      lines.push(`  <finding>${branch.finding}</finding>`);
    }

    lines.push("</branch>");
  }

  lines.push("</branches>");
  lines.push("");
  lines.push(`Evaluate the branch "${branchId}" and decide: ask another question or complete with a finding.`);

  return lines.join("\n");
}

async function runProbeAgent(client: OpencodeClient, state: BrainstormState, branchId: string): Promise<ProbeResult> {
  const sessionResult = await client.session.create({
    body: {
      title: `probe-${branchId}`,
    },
  });

  if (!sessionResult.data) {
    throw new Error("Failed to create probe session");
  }

  const probeSessionId = sessionResult.data.id;

  try {
    const promptResult = await client.session.prompt({
      path: { id: probeSessionId },
      body: {
        agent: AGENTS.probe,
        tools: {}, // Disable all tools
        parts: [{ type: "text", text: formatBranchContext(state, branchId) }],
      },
    });

    if (!promptResult.data) {
      throw new Error("Failed to get probe response");
    }

    // Extract text from response parts
    let responseText = "";
    for (const part of promptResult.data.parts) {
      if (part.type === "text" && "text" in part) {
        responseText += (part as { text: string }).text;
      }
    }

    // Parse JSON from response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[octto] Probe response not valid JSON:", responseText);
      return { done: true, finding: "Could not parse probe response" };
    }

    return JSON.parse(jsonMatch[0]) as ProbeResult;
  } finally {
    // Clean up the probe session
    await client.session.delete({ path: { id: probeSessionId } }).catch(() => {
      // Ignore cleanup errors
    });
  }
}

export async function processAnswer(
  stateStore: StateStore,
  sessions: SessionStore,
  sessionId: string,
  browserSessionId: string,
  questionId: string,
  answer: Answer,
  client: OpencodeClient,
): Promise<void> {
  const state = await stateStore.getSession(sessionId);
  if (!state) return;

  // Find which branch this question belongs to
  let branchId: string | null = null;
  for (const [id, branch] of Object.entries(state.branches)) {
    if (branch.questions.some((q) => q.id === questionId)) {
      branchId = id;
      break;
    }
  }

  if (!branchId) return;
  if (state.branches[branchId].status === BRANCH_STATUSES.DONE) return;

  // Record the answer
  try {
    await stateStore.recordAnswer(sessionId, questionId, answer);
  } catch (error) {
    console.error(`[octto] Failed to record answer for ${questionId}:`, error);
    throw error;
  }

  // Get fresh state after recording
  const updatedState = await stateStore.getSession(sessionId);
  if (!updatedState) return;

  const branch = updatedState.branches[branchId];
  if (!branch || branch.status === BRANCH_STATUSES.DONE) return;

  // Evaluate branch using probe agent
  const result = await runProbeAgent(client, updatedState, branchId);

  if (result.done) {
    await stateStore.completeBranch(sessionId, branchId, result.finding || "No finding");
    return;
  }

  if (result.question) {
    const config = result.question.config as { question?: string; context?: string };
    const questionText = config.question ?? "Follow-up question";
    const existingContext = config.context ?? "";
    const configWithContext = {
      ...config,
      context: `[${branch.scope}] ${existingContext}`.trim(),
    };

    const { question_id: newQuestionId } = sessions.pushQuestion(
      browserSessionId,
      result.question.type,
      configWithContext,
    );

    await stateStore.addQuestionToBranch(sessionId, branchId, {
      id: newQuestionId,
      type: result.question.type,
      text: questionText,
      config: configWithContext,
    });
  }
}
