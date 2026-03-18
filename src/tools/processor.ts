import * as v from "valibot";

import { AGENTS } from "@/agents";
import type { Answer, SessionStore } from "@/session";
import { QUESTION_TYPES } from "@/session";
import { BRANCH_STATUSES, type BrainstormState, type StateStore } from "@/state";

import type { OpencodeClient } from "./types";

const ProbeResultSchema = v.object({
  done: v.boolean(),
  finding: v.optional(v.string()),
  question: v.optional(
    v.object({
      type: v.picklist(QUESTION_TYPES),
      config: v.record(v.string(), v.unknown()),
    }),
  ),
});

type ProbeResult = v.InferOutput<typeof ProbeResultSchema>;

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

export function parseProbeResponse(parts: { type: string; [key: string]: unknown }[]): ProbeResult {
  const responseText = parts
    .filter(
      (part): part is typeof part & { text: string } =>
        part.type === "text" && "text" in part && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");

  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { done: true, finding: "Could not parse probe response" };
  }

  const parsed = v.safeParse(ProbeResultSchema, JSON.parse(jsonMatch[0]));
  if (!parsed.success) {
    return { done: true, finding: "Could not validate probe response" };
  }
  return parsed.output;
}

async function runProbeAgent(client: OpencodeClient, state: BrainstormState, branchId: string): Promise<ProbeResult> {
  const session = await client.session.create({
    body: { title: `probe-${branchId}` },
  });

  if (!session.data) {
    throw new Error("Failed to create probe session");
  }

  const probeSessionId = session.data.id;

  try {
    const prompt = await client.session.prompt({
      path: { id: probeSessionId },
      body: {
        agent: AGENTS.probe,
        tools: {},
        parts: [{ type: "text", text: formatBranchContext(state, branchId) }],
      },
    });

    if (!prompt.data) {
      throw new Error("Failed to get probe response");
    }

    return parseProbeResponse(prompt.data.parts);
  } finally {
    await client.session.delete({ path: { id: probeSessionId } }).catch((_error: unknown) => {
      /* cleanup errors are non-fatal */
    });
  }
}

function findBranchForQuestion(state: BrainstormState, questionId: string): string | null {
  for (const [id, branch] of Object.entries(state.branches)) {
    if (branch.questions.some((q) => q.id === questionId)) return id;
  }
  return null;
}

async function handleProbeResult(
  probe: ProbeResult,
  stateStore: StateStore,
  sessions: SessionStore,
  sessionId: string,
  browserSessionId: string,
  branchId: string,
  branchScope: string,
): Promise<void> {
  if (probe.done) {
    await stateStore.completeBranch(sessionId, branchId, probe.finding || "No finding");
    return;
  }

  if (!probe.question) return;

  const rawQuestion = probe.question.config.question;
  const rawContext = probe.question.config.context;
  const questionText = typeof rawQuestion === "string" ? rawQuestion : "Follow-up question";
  const contextText = typeof rawContext === "string" ? rawContext : "";
  const configWithContext = {
    ...probe.question.config,
    question: questionText,
    context: `[${branchScope}] ${contextText}`.trim(),
  };

  const { question_id: newQuestionId } = sessions.pushQuestion(
    browserSessionId,
    probe.question.type,
    configWithContext,
  );

  await stateStore.addQuestionToBranch(sessionId, branchId, {
    id: newQuestionId,
    type: probe.question.type,
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

  const probe = await runProbeAgent(client, updatedState, branchId);
  await handleProbeResult(probe, stateStore, sessions, sessionId, browserSessionId, branchId, branch.scope);
}
