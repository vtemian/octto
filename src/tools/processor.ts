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

function formatBranchQuestions(questions: { type: string; text: string; answer?: unknown }[]): string[] {
  const lines: string[] = [];
  for (const q of questions) {
    lines.push(`  <question type="${q.type}">${q.text}</question>`);
    if (q.answer) {
      lines.push(`  <answer>${JSON.stringify(q.answer)}</answer>`);
    }
  }
  return lines;
}

function formatBranchXml(
  id: string,
  branch: {
    scope: string;
    status: string;
    questions: { type: string; text: string; answer?: unknown }[];
    finding: string | null;
  },
  isCurrent: boolean,
): string[] {
  const lines: string[] = [];
  lines.push(`<branch id="${id}" scope="${branch.scope}"${isCurrent ? ' current="true"' : ""}>`);
  lines.push(...formatBranchQuestions(branch.questions));
  if (branch.status === BRANCH_STATUSES.DONE && branch.finding) {
    lines.push(`  <finding>${branch.finding}</finding>`);
  }
  lines.push("</branch>");
  return lines;
}

function formatBranchContext(state: BrainstormState, branchId: string): string {
  const lines: string[] = [`<original_request>${state.request}</original_request>`, "", "<branches>"];

  for (const [id, branch] of Object.entries(state.branches)) {
    lines.push(...formatBranchXml(id, branch, id === branchId));
  }

  lines.push("</branches>");
  lines.push("");
  lines.push(`Evaluate the branch "${branchId}" and decide: ask another question or complete with a finding.`);

  return lines.join("\n");
}

async function runProbeAgent(client: OpencodeClient, state: BrainstormState, branchId: string): Promise<ProbeResult> {
  const sessionResult = await client.session.create({
    body: { title: `probe-${branchId}` },
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
        tools: {},
        parts: [{ type: "text", text: formatBranchContext(state, branchId) }],
      },
    });

    if (!promptResult.data) {
      throw new Error("Failed to get probe response");
    }

    const responseText = promptResult.data.parts
      .filter((part) => part.type === "text" && "text" in part)
      .map((part) => (part as { text: string }).text)
      .join("");

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { done: true, finding: "Could not parse probe response" };
    }

    return JSON.parse(jsonMatch[0]) as ProbeResult;
  } finally {
    await client.session.delete({ path: { id: probeSessionId } }).catch(() => {});
  }
}

function findBranchForQuestion(state: BrainstormState, questionId: string): string | null {
  for (const [id, branch] of Object.entries(state.branches)) {
    if (branch.questions.some((q) => q.id === questionId)) return id;
  }
  return null;
}

async function handleProbeResult(
  result: ProbeResult,
  stateStore: StateStore,
  sessions: SessionStore,
  sessionId: string,
  browserSessionId: string,
  branchId: string,
  branchScope: string,
): Promise<void> {
  if (result.done) {
    await stateStore.completeBranch(sessionId, branchId, result.finding || "No finding");
    return;
  }

  if (!result.question) return;

  const config = result.question.config as { question?: string; context?: string };
  const questionText = config.question ?? "Follow-up question";
  const configWithContext = {
    ...config,
    context: `[${branchScope}] ${config.context ?? ""}`.trim(),
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

  const branchId = findBranchForQuestion(state, questionId);
  if (!branchId) return;
  if (state.branches[branchId].status === BRANCH_STATUSES.DONE) return;

  try {
    await stateStore.recordAnswer(sessionId, questionId, answer);
  } catch (error: unknown) {
    console.error(`[octto] Failed to record answer for ${questionId}:`, error);
    throw error;
  }

  const updatedState = await stateStore.getSession(sessionId);
  if (!updatedState) return;

  const branch = updatedState.branches[branchId];
  if (!branch || branch.status === BRANCH_STATUSES.DONE) return;

  const result = await runProbeAgent(client, updatedState, branchId);
  await handleProbeResult(result, stateStore, sessions, sessionId, browserSessionId, branchId, branch.scope);
}
