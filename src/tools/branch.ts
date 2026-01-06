// src/tools/branch.ts
import { tool } from "@opencode-ai/plugin/tool";

import type { QuestionConfig, QuestionType, SessionStore } from "@/session";
import type { StateStore } from "@/state";

import { formatBranchStatus, formatFindings, formatFindingsList, formatQASummary } from "./formatters";
import { processAnswer } from "./processor";
import type { OcttoTools } from "./types";

function generateId(prefix: string): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = `${prefix}_`;
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function createBranchTools(stateStore: StateStore, sessions: SessionStore): OcttoTools {
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
              config: tool.schema.looseObject({}),
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

      const branchSummaries = state.branch_order.map((id) => formatBranchStatus(state.branches[id])).join("\n\n");

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

      const findings = formatFindingsList(state);

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
        const processing = processAnswer(
          stateStore,
          sessions,
          args.session_id,
          args.browser_session_id,
          question_id,
          response,
        ).catch((error) => {
          console.error(`[octto] Error processing answer ${question_id}:`, error);
        });
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
        const findings = finalState.branch_order.map((id) => formatBranchStatus(finalState.branches[id])).join("\n\n");

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
          const qaSummary = formatQASummary(b);
          return {
            id,
            title: b.scope,
            content: `**Finding:** ${b.finding || "No finding"}\n\n**Discussion:**\n${qaSummary || "(no questions answered)"}`,
          };
        }),
      ];

      // Push show_plan to browser
      try {
        sessions.pushQuestion(args.browser_session_id, "show_plan", {
          question: "Review Design Plan",
          sections,
        } as QuestionConfig);
      } catch {
        // Session gone - return findings without review
        return `## Brainstorm Complete (Review Skipped)

**Request:** ${finalState.request}
**Branches:** ${finalState.branch_order.length}
**Note:** Browser session ended before review.

${formatFindings(finalState)}

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

      return `## Brainstorm Complete

**Request:** ${finalState.request}
**Branches:** ${finalState.branch_order.length}
**Iterations:** ${iterations}
**Review Status:** ${approved ? "APPROVED" : "CHANGES REQUESTED"}
${feedback ? `**Feedback:** ${feedback}` : ""}

${formatFindings(finalState)}

${approved ? "Design approved. Write the design document to docs/plans/." : "Changes requested. Review feedback and discuss with user before proceeding."}`;
    },
  });

  return {
    create_brainstorm,
    get_session_summary,
    end_brainstorm,
    await_brainstorm_complete,
  };
}
