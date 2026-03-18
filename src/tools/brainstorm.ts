// src/tools/brainstorm.ts
import { tool } from "@opencode-ai/plugin/tool";

import type { Answer, ReviewAnswer, SessionStore } from "@/session";
import { QUESTION_TYPES, QUESTIONS, STATUSES } from "@/session";
import { BRANCH_STATUSES, type BrainstormState, createStateStore, type StateStore } from "@/state";

import { formatBranchStatus, formatFindings, formatFindingsList, formatQASummary } from "./formatters";
import { processAnswer } from "./processor";
import type { OcttoTool, OcttoTools, OpencodeClient } from "./types";
import { generateSessionId } from "./utils";

const MAX_ITERATIONS = 50;
const ANSWER_TIMEOUT_MS = 300_000;
const REVIEW_TIMEOUT_MS = 600_000;

const branchesSchema = tool.schema
  .array(
    tool.schema.object({
      id: tool.schema.string(),
      scope: tool.schema.string(),
      initial_question: tool.schema.object({
        type: tool.schema.enum(QUESTION_TYPES),
        config: tool.schema.looseObject({
          question: tool.schema.string().optional(),
          context: tool.schema.string().optional(),
        }),
      }),
    }),
  )
  .describe("Branches to explore");

// --- Extracted helper functions ---

interface CollectionResult {
  state: BrainstormState | null;
  allComplete: boolean;
}

function enqueueAnswerProcessing(
  stateStore: StateStore,
  sessions: SessionStore,
  sessionId: string,
  browserSessionId: string,
  questionId: string,
  response: Answer,
  client: OpencodeClient,
  pendingProcessing: Promise<void>[],
): void {
  const processing = processAnswer(
    stateStore,
    sessions,
    sessionId,
    browserSessionId,
    questionId,
    response,
    client,
  ).catch((error: unknown) => {
    console.error(`[octto] Error processing answer ${questionId}:`, error);
  });
  pendingProcessing.push(processing);
}

async function flushPending(pending: Promise<void>[]): Promise<void> {
  await Promise.all(pending);
  pending.length = 0;
}

async function processOneAnswer(
  answer: { completed: boolean; status?: string; question_id?: string; response?: unknown },
  pending: Promise<void>[],
  stateStore: StateStore,
  sessions: SessionStore,
  sessionId: string,
  browserSessionId: string,
  client: OpencodeClient,
): Promise<"continue" | "break"> {
  if (!answer.completed) {
    if (answer.status === STATUSES.NONE_PENDING) await flushPending(pending);
    return answer.status === STATUSES.TIMEOUT ? "break" : "continue";
  }

  const { question_id, response } = answer;
  if (question_id && response !== undefined) {
    enqueueAnswerProcessing(
      stateStore,
      sessions,
      sessionId,
      browserSessionId,
      question_id,
      response as Answer,
      client,
      pending,
    );
  }
  return "continue";
}

async function collectAnswers(
  stateStore: StateStore,
  sessions: SessionStore,
  sessionId: string,
  browserSessionId: string,
  client: OpencodeClient,
): Promise<CollectionResult> {
  const pending: Promise<void>[] = [];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (await stateStore.isSessionComplete(sessionId)) break;

    const answer = await sessions.getNextAnswer({
      session_id: browserSessionId,
      block: true,
      timeout: ANSWER_TIMEOUT_MS,
    });

    const action = await processOneAnswer(answer, pending, stateStore, sessions, sessionId, browserSessionId, client);
    if (action === "break") break;
  }

  await Promise.all(pending);

  const [state, allComplete] = await Promise.all([
    stateStore.getSession(sessionId),
    stateStore.isSessionComplete(sessionId),
  ]);

  return { state, allComplete };
}

interface ReviewSection {
  id: string;
  title: string;
  content: string;
}

function buildReviewSections(state: BrainstormState): ReviewSection[] {
  return [
    {
      id: "summary",
      title: "Original Request",
      content: state.request,
    },
    ...state.branch_order.map((id) => {
      const b = state.branches[id];
      const qaSummary = formatQASummary(b);
      return {
        id,
        title: b.scope,
        content: `**Finding:** ${b.finding || "No finding"}\n\n**Discussion:**\n${qaSummary || "(no questions answered)"}`,
      };
    }),
  ];
}

interface ReviewResult {
  approved: boolean;
  feedback: string;
}

async function waitForReviewApproval(sessions: SessionStore, browserSessionId: string): Promise<ReviewResult> {
  const result = await sessions.getNextAnswer({
    session_id: browserSessionId,
    block: true,
    timeout: REVIEW_TIMEOUT_MS,
  });

  if (!result.completed || !result.response) {
    return { approved: false, feedback: "" };
  }

  const response = result.response as ReviewAnswer;
  return {
    approved: response.decision === "approve",
    feedback: response.feedback ?? "",
  };
}

// --- Format functions ---

function formatInProgressResult(state: BrainstormState): string {
  const branches = state.branch_order.map((id) => formatBranchStatus(state.branches[id])).join("\n");
  return `<brainstorm_in_progress>
  <request>${state.request}</request>
  <branches>
${branches}
  </branches>
  <next_action>Call await_brainstorm_complete again to continue</next_action>
</brainstorm_in_progress>`;
}

function formatSkippedReviewResult(state: BrainstormState): string {
  return `<brainstorm_complete status="review_skipped">
  <request>${state.request}</request>
  <branch_count>${state.branch_order.length}</branch_count>
  <note>Browser session ended before review</note>
  ${formatFindings(state)}
  <next_action>Write the design document to docs/plans/</next_action>
</brainstorm_complete>`;
}

function formatCompletionResult(state: BrainstormState, approved: boolean, feedback: string): string {
  const feedbackXml = feedback ? `\n  <feedback>${feedback}</feedback>` : "";
  const nextAction = approved
    ? "Write the design document to docs/plans/"
    : "Review feedback and discuss with user before proceeding";
  return `<brainstorm_complete status="${approved ? "approved" : "changes_requested"}">
  <request>${state.request}</request>
  <branch_count>${state.branch_order.length}</branch_count>${feedbackXml}
  ${formatFindings(state)}
  <next_action>${nextAction}</next_action>
</brainstorm_complete>`;
}

// --- Tool definitions ---

interface BranchInput {
  id: string;
  scope: string;
  initial_question: {
    type: (typeof QUESTION_TYPES)[number];
    config: { question?: string; context?: string };
  };
}

async function registerBranchQuestions(
  store: StateStore,
  sessions: SessionStore,
  sessionId: string,
  branches: BranchInput[],
): Promise<{ session_id: string; url: string }> {
  const initialQuestions = branches.map((b) => {
    const { type, config } = b.initial_question;
    const context = `[${b.scope}] ${config.context ?? ""}`.trim();
    return { type, config: { ...config, context } };
  });

  const browserSession = await sessions.startSession({
    title: "Brainstorming Session",
    questions: initialQuestions,
  });

  await store.setBrowserSessionId(sessionId, browserSession.session_id);

  for (const [i, branch] of branches.entries()) {
    const questionId = browserSession.question_ids?.[i];
    if (!questionId) continue;
    const { type, config } = branch.initial_question;
    await store.addQuestionToBranch(sessionId, branch.id, {
      id: questionId,
      type,
      text: config.question ?? "Question",
      config,
    });
  }

  return browserSession;
}

function buildCreateBrainstormTool(store: StateStore, sessions: SessionStore): OcttoTool {
  return tool({
    description: "Create a new brainstorm session with exploration branches",
    args: {
      request: tool.schema.string().describe("The original user request"),
      branches: branchesSchema,
    },
    execute: async (args) => {
      const sessionId = generateSessionId();
      await store.createSession(
        sessionId,
        args.request,
        args.branches.map((b) => ({ id: b.id, scope: b.scope })),
      );
      const browserSession = await registerBranchQuestions(store, sessions, sessionId, args.branches);

      const branchesXml = args.branches.map((b) => `    <branch id="${b.id}">${b.scope}</branch>`).join("\n");
      return `<brainstorm_created>
  <session_id>${sessionId}</session_id>
  <browser_session>${browserSession.session_id}</browser_session>
  <url>${browserSession.url}</url>
  <branches>
${branchesXml}
  </branches>
  <next_action>Call get_next_answer(session_id="${browserSession.session_id}", block=true)</next_action>
</brainstorm_created>`;
    },
  });
}

function buildGetSessionSummaryTool(store: StateStore): OcttoTool {
  return tool({
    description: "Get summary of all branches and their findings",
    args: {
      session_id: tool.schema.string().describe("Brainstorm session ID"),
    },
    execute: async (args) => {
      const state = await store.getSession(args.session_id);
      if (!state) return `<error>Session not found: ${args.session_id}</error>`;

      const branches = state.branch_order.map((id) => formatBranchStatus(state.branches[id])).join("\n");
      const allDone = Object.values(state.branches).every((b) => b.status === BRANCH_STATUSES.DONE);

      return `<session_summary>
  <request>${state.request}</request>
  <status>${allDone ? "complete" : "in_progress"}</status>
  <branches>
${branches}
  </branches>
</session_summary>`;
    },
  });
}

function buildEndBrainstormTool(store: StateStore, sessions: SessionStore): OcttoTool {
  return tool({
    description: "End a brainstorm session and get final summary",
    args: {
      session_id: tool.schema.string().describe("Brainstorm session ID"),
    },
    execute: async (args) => {
      const state = await store.getSession(args.session_id);
      if (!state) return `<error>Session not found: ${args.session_id}</error>`;

      if (state.browser_session_id) {
        await sessions.endSession(state.browser_session_id);
      }

      const findings = formatFindingsList(state);
      await store.deleteSession(args.session_id);

      return `<brainstorm_ended>
  <request>${state.request}</request>
  ${findings}
  <next_action>Write the design document based on these findings</next_action>
</brainstorm_ended>`;
    },
  });
}

function buildAwaitBrainstormCompleteTool(
  store: StateStore,
  sessions: SessionStore,
  client: OpencodeClient,
): OcttoTool {
  return tool({
    description: `Wait for brainstorm session to complete. Processes answers asynchronously as they arrive.
Returns when all branches are done with their findings.
This is the recommended way to run a brainstorm - just create_brainstorm then await_brainstorm_complete.`,
    args: {
      session_id: tool.schema.string().describe("Brainstorm session ID (state session)"),
      browser_session_id: tool.schema.string().describe("Browser session ID (for collecting answers)"),
    },
    execute: async (args) => {
      const { state, allComplete } = await collectAnswers(
        store,
        sessions,
        args.session_id,
        args.browser_session_id,
        client,
      );

      if (!state) return "<error>Session lost</error>";
      if (!allComplete) return formatInProgressResult(state);

      const sections = buildReviewSections(state);

      try {
        sessions.pushQuestion(args.browser_session_id, QUESTIONS.SHOW_PLAN, {
          question: "Review Design Plan",
          sections,
        });
      } catch {
        return formatSkippedReviewResult(state);
      }

      const { approved, feedback } = await waitForReviewApproval(sessions, args.browser_session_id);
      return formatCompletionResult(state, approved, feedback);
    },
  });
}

export function createBrainstormTools(sessions: SessionStore, client: OpencodeClient): OcttoTools {
  const store = createStateStore();

  return {
    create_brainstorm: buildCreateBrainstormTool(store, sessions),
    get_session_summary: buildGetSessionSummaryTool(store),
    end_brainstorm: buildEndBrainstormTool(store, sessions),
    await_brainstorm_complete: buildAwaitBrainstormCompleteTool(store, sessions, client),
  };
}
