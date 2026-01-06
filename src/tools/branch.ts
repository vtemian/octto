// src/tools/branch.ts
import { tool } from "@opencode-ai/plugin/tool";
import type { QuestionConfig, QuestionType, SessionStore } from "@session";
import type { StateStore } from "@state";

import { evaluateBranch } from "./probe-logic";

function generateId(prefix: string): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = `${prefix}_`;
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function createBranchTools(stateStore: StateStore, sessions: SessionStore) {
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
      await stateStore.createSession(
        sessionId,
        args.request,
        args.branches.map((b) => ({ id: b.id, scope: b.scope })),
      );

      // Start browser session with first questions from each branch
      // Add branch scope as context so user knows which aspect they're answering
      const initialQuestions = args.branches.map((b) => ({
        type: b.initial_question.type as QuestionType,
        config: {
          ...b.initial_question.config,
          context: `[${b.scope}] ${(b.initial_question.config as Record<string, unknown>).context || ""}`.trim(),
        } as unknown as QuestionConfig,
      }));

      const browserSession = await sessions.startSession({
        title: "Brainstorming Session",
        questions: initialQuestions,
      });

      await stateStore.setBrowserSessionId(sessionId, browserSession.session_id);

      // Record initial questions in state
      for (let i = 0; i < args.branches.length; i++) {
        const branch = args.branches[i];
        const questionId = browserSession.question_ids?.[i];
        if (questionId) {
          const questionText =
            typeof branch.initial_question.config === "object" && "question" in branch.initial_question.config
              ? String(branch.initial_question.config.question)
              : "Question";

          await stateStore.addQuestionToBranch(sessionId, branch.id, {
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

  const get_session_summary = tool({
    description: "Get summary of all branches and their findings",
    args: {
      session_id: tool.schema.string().describe("Brainstorm session ID"),
    },
    execute: async (args) => {
      const state = await stateStore.getSession(args.session_id);
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
      const state = await stateStore.getSession(args.session_id);
      if (!state) return `Error: Session not found: ${args.session_id}`;

      // End browser session
      if (state.browser_session_id) {
        await sessions.endSession(state.browser_session_id);
      }

      // Build final summary
      const findings = state.branch_order
        .map((id) => {
          const b = state.branches[id];
          return `- **${b.scope}:** ${b.finding || "(no finding)"}`;
        })
        .join("\n");

      // Clean up state file
      await stateStore.deleteSession(args.session_id);

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
      const pendingProcessing: Promise<void>[] = [];
      let iterations = 0;
      const maxIterations = 50; // Safety limit

      // Helper to check completion from fresh state
      async function isComplete(): Promise<boolean> {
        const state = await stateStore.getSession(args.session_id);
        if (!state) return true; // Session gone = done
        return Object.values(state.branches).every((b) => b.status === "done");
      }

      while (iterations < maxIterations) {
        iterations++;

        // Check if already complete (with fresh state)
        if (await isComplete()) {
          break;
        }

        // Wait for next answer (BLOCKING - this is where we wait for user)
        const answerResult = await sessions.getNextAnswer({
          session_id: args.browser_session_id,
          block: true,
          timeout: 300000, // 5 min timeout
        });

        if (!answerResult.completed) {
          if (answerResult.status === "none_pending") {
            // No pending questions - wait for in-flight processing, then re-check
            await Promise.all(pendingProcessing);
            pendingProcessing.length = 0; // Clear completed
            continue;
          }
          if (answerResult.status === "timeout") {
            break;
          }
          continue;
        }

        const { question_id, response } = answerResult;
        if (!question_id || response === undefined) {
          continue;
        }

        // NON-BLOCKING: Fire off async processing (NO stale state passed)
        // Wrap in error handler to prevent unhandled rejections
        const processing = processAnswerAsync(args.session_id, args.browser_session_id, question_id, response).catch(
          (error) => {
            console.error(`[octto] Error processing answer ${question_id}:`, error);
          },
        );
        pendingProcessing.push(processing);
      }

      // Wait for any in-flight processing to complete
      await Promise.all(pendingProcessing);

      // Final completion check with fresh state
      const finalState = await stateStore.getSession(args.session_id);
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

      // Build sections for show_plan - one per branch plus summary
      const sections = [
        {
          id: "summary",
          title: "Original Request",
          content: finalState.request,
        },
        ...finalState.branch_order.map((id) => {
          const b = finalState.branches[id];
          const qaSummary = b.questions
            .filter((q) => q.answer !== undefined)
            .map((q) => {
              const ans = q.answer as Record<string, unknown>;
              const answerText = ans.selected || ans.choice || ans.text || JSON.stringify(ans);
              return `- **${q.text}**\n  → ${answerText}`;
            })
            .join("\n");

          return {
            id,
            title: b.scope,
            content: `**Finding:** ${b.finding || "No finding"}\n\n**Discussion:**\n${qaSummary || "(no questions answered)"}`,
          };
        }),
      ];

      // Push show_plan to browser
      // Wrap in try-catch in case session was deleted between completion check and push
      let _reviewQuestionId: string;
      try {
        const pushResult = sessions.pushQuestion(args.browser_session_id, "show_plan", {
          question: "Review Design Plan",
          sections,
        } as QuestionConfig);
        _reviewQuestionId = pushResult.question_id;
      } catch (_error) {
        // Session gone - return findings without review
        const findings = finalState.branch_order
          .map((id) => {
            const b = finalState.branches[id];
            return `### ${id}\n**Scope:** ${b.scope}\n**Finding:** ${b.finding || "(no finding)"}`;
          })
          .join("\n\n");

        return `## Brainstorm Complete (Review Skipped)

**Request:** ${finalState.request}
**Branches:** ${finalState.branch_order.length}
**Note:** Browser session ended before review.

${findings}

Write the design document to docs/plans/.`;
      }

      // Wait for review approval
      const reviewResult = await sessions.getNextAnswer({
        session_id: args.browser_session_id,
        block: true,
        timeout: 600000, // 10 min for review
      });

      let approved = false;
      let feedback = "";

      if (reviewResult.completed && reviewResult.response) {
        const response = reviewResult.response as Record<string, unknown>;
        // show_plan returns { approved: boolean, annotations?: Record<sectionId, string> }
        approved = response.approved === true || response.choice === "yes";
        const annotations = response.annotations as Record<string, string> | undefined;
        if (annotations) {
          feedback = Object.entries(annotations)
            .map(([section, note]) => `[${section}] ${note}`)
            .join("\n");
        } else {
          feedback = String(response.feedback || response.text || "");
        }
      }

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
    // Get FRESH state (not stale)
    const state = await stateStore.getSession(sessionId);
    if (!state) {
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
      return;
    }

    // Skip if branch already done
    if (state.branches[branchId].status === "done") {
      return;
    }

    // Record the answer
    try {
      await stateStore.recordAnswer(sessionId, questionId, answer);
    } catch (error) {
      console.error(`[octto] Failed to record answer for ${questionId}:`, error);
      // Don't silently lose the answer - rethrow so caller knows processing failed
      throw error;
    }

    // Get FRESH state after recording answer
    const updatedState = await stateStore.getSession(sessionId);
    if (!updatedState) return;

    const branch = updatedState.branches[branchId];
    if (!branch || branch.status === "done") {
      return;
    }

    // Evaluate branch (inline probe logic)
    const probeResult = evaluateBranch(branch);

    if (probeResult.done) {
      // Complete the branch
      await stateStore.completeBranch(sessionId, branchId, probeResult.finding || "No finding");
    } else if (probeResult.question) {
      // Push follow-up question with branch scope as context
      const questionText =
        typeof probeResult.question.config === "object" && "question" in probeResult.question.config
          ? String((probeResult.question.config as { question: string }).question)
          : "Follow-up question";

      const originalConfig = probeResult.question.config as unknown as Record<string, unknown>;
      const configWithContext = {
        ...originalConfig,
        context: `[${branch.scope}] ${originalConfig.context || ""}`.trim(),
      };

      const { question_id: newQuestionId } = sessions.pushQuestion(
        browserSessionId,
        probeResult.question.type as QuestionType,
        configWithContext as QuestionConfig,
      );

      await stateStore.addQuestionToBranch(sessionId, branchId, {
        id: newQuestionId,
        type: probeResult.question.type as QuestionType,
        text: questionText,
        config: configWithContext as QuestionConfig,
      });
    }
  }

  return {
    create_brainstorm,
    get_session_summary,
    end_brainstorm,
    await_brainstorm_complete,
  };
}
