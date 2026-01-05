// src/tools/branch.ts
import { tool } from "@opencode-ai/plugin/tool";
import type { StateManager } from "../state/manager";
import type { SessionManager } from "../session/manager";
import type { QuestionType, QuestionConfig } from "../session/types";

function generateId(prefix: string): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = `${prefix}_`;
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function createBranchTools(stateManager: StateManager, sessionManager: SessionManager) {
  const create_brainstorm = tool({
    description: "Create a new brainstorm session with exploration branches",
    args: {
      request: tool.schema.string().describe("The original user request"),
      branches: tool.schema
        .array(
          tool.schema.object({
            id: tool.schema.string(),
            scope: tool.schema.string(),
            initial_question: tool.schema.object({
              type: tool.schema.string(),
              config: tool.schema.object({}).passthrough(),
            }),
          }),
        )
        .describe("Branches to explore"),
    },
    execute: async (args) => {
      const sessionId = generateId("ses");

      // Create state with branches
      await stateManager.createSession(
        sessionId,
        args.request,
        args.branches.map((b) => ({ id: b.id, scope: b.scope })),
      );

      // Start browser session with first questions from each branch
      const initialQuestions = args.branches.map((b) => ({
        type: b.initial_question.type as QuestionType,
        config: b.initial_question.config as unknown as QuestionConfig,
      }));

      const browserSession = await sessionManager.startSession({
        title: "Brainstorming Session",
        questions: initialQuestions,
      });

      await stateManager.setBrowserSessionId(sessionId, browserSession.session_id);

      // Record initial questions in state
      for (let i = 0; i < args.branches.length; i++) {
        const branch = args.branches[i];
        const questionId = browserSession.question_ids?.[i];
        if (questionId) {
          const questionText =
            typeof branch.initial_question.config === "object" &&
            "question" in branch.initial_question.config
              ? String(branch.initial_question.config.question)
              : "Question";

          await stateManager.addQuestionToBranch(sessionId, branch.id, {
            id: questionId,
            type: branch.initial_question.type as QuestionType,
            text: questionText,
            config: branch.initial_question.config as unknown as QuestionConfig,
          });
        }
      }

      const branchList = args.branches.map((b) => `- ${b.id}: ${b.scope}`).join("\n");
      return `## Brainstorm Session Created

**Session ID:** ${sessionId}
**Browser Session:** ${browserSession.session_id}
**URL:** ${browserSession.url}

**Branches:**
${branchList}

Call get_next_answer(session_id="${browserSession.session_id}", block=true) to collect answers.`;
    },
  });

  const get_branch_status = tool({
    description: "Get the current status and context of a branch",
    args: {
      session_id: tool.schema.string().describe("Brainstorm session ID"),
      branch_id: tool.schema.string().describe("Branch ID"),
    },
    execute: async (args) => {
      const state = await stateManager.getSession(args.session_id);
      if (!state) return `Error: Session not found: ${args.session_id}`;

      const branch = state.branches[args.branch_id];
      if (!branch) return `Error: Branch not found: ${args.branch_id}`;

      const qas = branch.questions
        .map((q, i) => {
          const answerText = q.answer ? JSON.stringify(q.answer) : "(pending)";
          return `Q${i + 1}: ${q.text}\nA${i + 1}: ${answerText}`;
        })
        .join("\n\n");

      return `## Branch: ${args.branch_id}

**Scope:** ${branch.scope}
**Status:** ${branch.status}
**Finding:** ${branch.finding || "(none yet)"}

**Questions & Answers:**
${qas || "(no questions yet)"}`;
    },
  });

  const complete_branch = tool({
    description: "Mark a branch as done with its finding",
    args: {
      session_id: tool.schema.string().describe("Brainstorm session ID"),
      branch_id: tool.schema.string().describe("Branch ID"),
      finding: tool.schema.string().describe("Summary of what was learned"),
    },
    execute: async (args) => {
      const state = await stateManager.getSession(args.session_id);
      if (!state) return `Error: Session not found: ${args.session_id}`;

      const branch = state.branches[args.branch_id];
      if (!branch) return `Error: Branch not found: ${args.branch_id}`;

      await stateManager.completeBranch(args.session_id, args.branch_id, args.finding);
      return `## Branch Completed

**Branch:** ${args.branch_id}
**Status:** done
**Finding:** ${args.finding}`;
    },
  });

  const push_branch_question = tool({
    description: "Push a new question to a branch",
    args: {
      session_id: tool.schema.string().describe("Brainstorm session ID"),
      branch_id: tool.schema.string().describe("Branch ID"),
      question: tool.schema
        .object({
          type: tool.schema.string(),
          config: tool.schema.object({}).passthrough(),
        })
        .describe("Question to push"),
    },
    execute: async (args) => {
      const state = await stateManager.getSession(args.session_id);
      if (!state) return `Error: Session not found: ${args.session_id}`;
      if (!state.browser_session_id) return `Error: No browser session`;

      const questionText =
        typeof args.question.config === "object" && "question" in args.question.config
          ? String((args.question.config as { question: string }).question)
          : "Question";

      // Push to browser and get the assigned question ID
      const { question_id: questionId } = sessionManager.pushQuestion(
        state.browser_session_id,
        args.question.type as QuestionType,
        args.question.config as unknown as QuestionConfig,
      );

      // Record in state using the ID from pushQuestion
      await stateManager.addQuestionToBranch(args.session_id, args.branch_id, {
        id: questionId,
        type: args.question.type as QuestionType,
        text: questionText,
        config: args.question.config as unknown as QuestionConfig,
      });

      return `## Question Pushed

**Branch:** ${args.branch_id}
**Question ID:** ${questionId}
**Question:** ${questionText}

Call get_next_answer to collect the response.`;
    },
  });

  const get_session_summary = tool({
    description: "Get summary of all branches and their findings",
    args: {
      session_id: tool.schema.string().describe("Brainstorm session ID"),
    },
    execute: async (args) => {
      const state = await stateManager.getSession(args.session_id);
      if (!state) return `Error: Session not found: ${args.session_id}`;

      const branchSummaries = state.branch_order
        .map((id) => {
          const b = state.branches[id];
          const status = b.status === "done" ? "DONE" : "EXPLORING";
          const finding = b.finding || "(no finding yet)";
          return `### ${id} [${status}]\n**Scope:** ${b.scope}\n**Finding:** ${finding}`;
        })
        .join("\n\n");

      const allDone = Object.values(state.branches).every((b) => b.status === "done");

      return `## Session Summary

**Request:** ${state.request}
**Status:** ${allDone ? "COMPLETE" : "IN PROGRESS"}

${branchSummaries}`;
    },
  });

  const end_brainstorm = tool({
    description: "End a brainstorm session and get final summary",
    args: {
      session_id: tool.schema.string().describe("Brainstorm session ID"),
    },
    execute: async (args) => {
      const state = await stateManager.getSession(args.session_id);
      if (!state) return `Error: Session not found: ${args.session_id}`;

      // End browser session
      if (state.browser_session_id) {
        await sessionManager.endSession(state.browser_session_id);
      }

      // Build final summary
      const findings = state.branch_order
        .map((id) => {
          const b = state.branches[id];
          return `- **${b.scope}:** ${b.finding || "(no finding)"}`;
        })
        .join("\n");

      // Clean up state file
      await stateManager.deleteSession(args.session_id);

      return `## Brainstorm Complete

**Request:** ${state.request}

### Findings

${findings}

Write the design document based on these findings.`;
    },
  });

  return {
    create_brainstorm,
    get_branch_status,
    complete_branch,
    push_branch_question,
    get_session_summary,
    end_brainstorm,
  };
}
