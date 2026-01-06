// src/tools/branch.ts
import { tool } from "@opencode-ai/plugin/tool";
import type { StateManager } from "../state/manager";
import type { SessionManager } from "../session/manager";
import type { QuestionType, QuestionConfig } from "../session/types";
import { evaluateBranch } from "./probe-logic";

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
      console.log(`[create_brainstorm] Called with ${args.branches.length} branches`);
      console.log(`[create_brainstorm] Request: ${args.request.substring(0, 100)}...`);
      const sessionId = generateId("ses");
      console.log(`[create_brainstorm] Generated session ID: ${sessionId}`);

      // Create state with branches
      console.log(`[create_brainstorm] Calling stateManager.createSession...`);
      await stateManager.createSession(
        sessionId,
        args.request,
        args.branches.map((b) => ({ id: b.id, scope: b.scope })),
      );
      console.log(`[create_brainstorm] State session created: ${sessionId}`);

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

  const record_branch_answer = tool({
    description: "Record a user's answer for a branch question. Call this after get_next_answer to persist the answer for context tracking.",
    args: {
      session_id: tool.schema.string().describe("Brainstorm session ID"),
      question_id: tool.schema.string().describe("Question ID that was answered"),
      answer: tool.schema.object({}).passthrough().describe("The user's answer"),
    },
    execute: async (args) => {
      console.log(`[record_branch_answer] Recording answer for question ${args.question_id}`);
      try {
        await stateManager.recordAnswer(args.session_id, args.question_id, args.answer);
        return `## Answer Recorded

**Question ID:** ${args.question_id}
**Answer:** ${JSON.stringify(args.answer)}

Answer persisted to state. Call get_branch_status to see updated context.`;
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
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

  const await_brainstorm_complete = tool({
    description: `Wait for brainstorm session to complete. Processes answers asynchronously as they arrive.
Returns when all branches are done with their findings.
This is the recommended way to run a brainstorm - just create_brainstorm then await_brainstorm_complete.`,
    args: {
      session_id: tool.schema.string().describe("Brainstorm session ID (state session)"),
      browser_session_id: tool.schema.string().describe("Browser session ID (for collecting answers)"),
    },
    execute: async (args) => {
      console.log(`[await_brainstorm_complete] Starting for session ${args.session_id}`);

      const pendingProcessing: Promise<void>[] = [];
      let iterations = 0;
      const maxIterations = 50; // Safety limit

      // Helper to check completion from fresh state
      async function isComplete(): Promise<boolean> {
        const state = await stateManager.getSession(args.session_id);
        if (!state) return true; // Session gone = done
        return Object.values(state.branches).every((b) => b.status === "done");
      }

      while (iterations < maxIterations) {
        iterations++;

        // Check if already complete (with fresh state)
        if (await isComplete()) {
          console.log(`[await_brainstorm_complete] All branches done after ${iterations} iterations`);
          break;
        }

        // Wait for next answer (BLOCKING - this is where we wait for user)
        console.log(`[await_brainstorm_complete] Waiting for next answer...`);
        const answerResult = await sessionManager.getNextAnswer({
          session_id: args.browser_session_id,
          block: true,
          timeout: 300000, // 5 min timeout
        });

        if (!answerResult.completed) {
          if (answerResult.status === "none_pending") {
            // No pending questions - wait for in-flight processing, then re-check
            console.log(`[await_brainstorm_complete] No pending questions, waiting for processing...`);
            await Promise.all(pendingProcessing);
            pendingProcessing.length = 0; // Clear completed
            continue;
          }
          if (answerResult.status === "timeout") {
            console.log(`[await_brainstorm_complete] Timeout waiting for answer`);
            break;
          }
          continue;
        }

        const { question_id, response } = answerResult;
        if (!question_id || response === undefined) {
          continue;
        }

        console.log(`[await_brainstorm_complete] Got answer for ${question_id}`);

        // NON-BLOCKING: Fire off async processing (NO stale state passed)
        const processing = processAnswerAsync(
          args.session_id,
          args.browser_session_id,
          question_id,
          response,
        );
        pendingProcessing.push(processing);
      }

      // Wait for any in-flight processing to complete
      console.log(`[await_brainstorm_complete] Waiting for ${pendingProcessing.length} pending tasks`);
      await Promise.all(pendingProcessing);

      // Final completion check with fresh state
      const finalState = await stateManager.getSession(args.session_id);
      if (!finalState) {
        return `Error: Session lost`;
      }

      const allComplete = Object.values(finalState.branches).every((b) => b.status === "done");

      if (!allComplete) {
        const findings = finalState.branch_order
          .map((id) => {
            const b = finalState.branches[id];
            return `### ${id}\n**Scope:** ${b.scope}\n**Status:** ${b.status}\n**Finding:** ${b.finding || "(pending)"}`;
          })
          .join("\n\n");

        return `## Brainstorm In Progress

**Request:** ${finalState.request}
**Iterations:** ${iterations}

${findings}

Some branches still exploring. Call await_brainstorm_complete again to continue.`;
      }

      // Build review summary
      const findingsSummary = finalState.branch_order
        .map((id) => {
          const b = finalState.branches[id];
          return `### ${b.scope}\n${b.finding || "No finding"}`;
        })
        .join("\n\n");

      const reviewContent = `# Design Summary

**Original Request:** ${finalState.request}

## Findings by Branch

${findingsSummary}

---
*Review the findings above. Approve to proceed with design document, or request changes.*`;

      // Push review question to browser
      console.log(`[await_brainstorm_complete] Pushing review for approval`);
      const { question_id: reviewQuestionId } = sessionManager.pushQuestion(
        args.browser_session_id,
        "review_section",
        {
          question: "Review & Approve Design",
          content: reviewContent,
          context: "Review the brainstorming summary and approve or request changes.",
        } as QuestionConfig,
      );

      // Wait for review approval
      console.log(`[await_brainstorm_complete] Waiting for review approval...`);
      const reviewResult = await sessionManager.getNextAnswer({
        session_id: args.browser_session_id,
        block: true,
        timeout: 600000, // 10 min for review
      });

      let approved = false;
      let feedback = "";

      if (reviewResult.completed && reviewResult.response) {
        const response = reviewResult.response as Record<string, unknown>;
        // review_section typically returns { approved: boolean, feedback?: string }
        approved = response.approved === true || response.choice === "yes";
        feedback = String(response.feedback || response.text || "");
      }

      console.log(`[await_brainstorm_complete] Review result: approved=${approved}`);

      const findings = finalState.branch_order
        .map((id) => {
          const b = finalState.branches[id];
          return `### ${id}\n**Scope:** ${b.scope}\n**Finding:** ${b.finding || "(no finding)"}`;
        })
        .join("\n\n");

      return `## Brainstorm Complete

**Request:** ${finalState.request}
**Branches:** ${finalState.branch_order.length}
**Iterations:** ${iterations}
**Review Status:** ${approved ? "APPROVED" : "CHANGES REQUESTED"}
${feedback ? `**Feedback:** ${feedback}` : ""}

${findings}

${approved ? "Design approved. Write the design document to docs/plans/." : "Changes requested. Review feedback and discuss with user before proceeding."}`;
    },
  });

  // Helper: Process a single answer asynchronously
  async function processAnswerAsync(
    sessionId: string,
    browserSessionId: string,
    questionId: string,
    answer: unknown,
  ): Promise<void> {
    console.log(`[processAnswerAsync] Processing answer for ${questionId}`);

    // Get FRESH state (not stale)
    const state = await stateManager.getSession(sessionId);
    if (!state) {
      console.log(`[processAnswerAsync] Session ${sessionId} not found`);
      return;
    }

    // Find which branch this question belongs to
    let branchId: string | null = null;
    for (const [id, branch] of Object.entries(state.branches)) {
      if (branch.questions.some((q) => q.id === questionId)) {
        branchId = id;
        break;
      }
    }

    if (!branchId) {
      console.log(`[processAnswerAsync] Question ${questionId} not found in any branch`);
      return;
    }

    // Skip if branch already done
    if (state.branches[branchId].status === "done") {
      console.log(`[processAnswerAsync] Branch ${branchId} already done, skipping`);
      return;
    }

    // Record the answer
    try {
      await stateManager.recordAnswer(sessionId, questionId, answer);
      console.log(`[processAnswerAsync] Recorded answer for ${questionId} in branch ${branchId}`);
    } catch (error) {
      console.log(`[processAnswerAsync] Error recording answer: ${error}`);
      return;
    }

    // Get FRESH state after recording answer
    const updatedState = await stateManager.getSession(sessionId);
    if (!updatedState) return;

    const branch = updatedState.branches[branchId];
    if (!branch || branch.status === "done") {
      return;
    }

    // Evaluate branch (inline probe logic)
    const probeResult = evaluateBranch(branch);
    console.log(`[processAnswerAsync] Probe result for ${branchId}: done=${probeResult.done}`);

    if (probeResult.done) {
      // Complete the branch
      await stateManager.completeBranch(sessionId, branchId, probeResult.finding || "No finding");
      console.log(`[processAnswerAsync] Completed branch ${branchId}`);
    } else if (probeResult.question) {
      // Push follow-up question
      const questionText =
        typeof probeResult.question.config === "object" && "question" in probeResult.question.config
          ? String((probeResult.question.config as { question: string }).question)
          : "Follow-up question";

      const { question_id: newQuestionId } = sessionManager.pushQuestion(
        browserSessionId,
        probeResult.question.type as QuestionType,
        probeResult.question.config,
      );

      await stateManager.addQuestionToBranch(sessionId, branchId, {
        id: newQuestionId,
        type: probeResult.question.type as QuestionType,
        text: questionText,
        config: probeResult.question.config,
      });

      console.log(`[processAnswerAsync] Pushed follow-up question ${newQuestionId} to branch ${branchId}`);
    }
  }

  return {
    create_brainstorm,
    get_branch_status,
    complete_branch,
    push_branch_question,
    record_branch_answer,
    get_session_summary,
    end_brainstorm,
    await_brainstorm_complete,
  };
}
