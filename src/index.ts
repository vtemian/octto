// src/index.ts
import type { Plugin } from "@opencode-ai/plugin";
import type { ToolContext } from "@opencode-ai/plugin/tool";
import { SessionManager } from "./session/manager";
import { createBrainstormerTools } from "./tools";
import { agents } from "./agents";

interface QuestionRecord {
  id: string;
  type: string;
  text: string;
  config: unknown;
  answer?: unknown;
  answeredAt?: number;
}

interface SessionContext {
  title: string;
  originalRequest?: string;
  questions: Map<string, QuestionRecord>;  // Track ALL questions by ID
  questionOrder: string[];  // Track order questions were added
  awaitingApproval: boolean;
  approvalQuestionId?: string;
}

/**
 * Format an answer for the probe context
 */
function formatAnswerForProbe(type: string, answer: unknown): string {
  if (!answer || typeof answer !== "object") return String(answer);

  const a = answer as Record<string, unknown>;

  switch (type) {
    case "pick_one":
      if (a.other) return `Selected "other": "${a.other}"`;
      if (!a.selected) return "(no selection)";
      return `Selected "${a.selected}"`;

    case "pick_many": {
      const selectedArr = Array.isArray(a.selected) ? a.selected : [];
      const otherArr = Array.isArray(a.other) ? a.other : [];
      if (selectedArr.length === 0 && otherArr.length === 0) {
        return "(no selection)";
      }
      const selectedStr = selectedArr.length > 0 ? `Selected: "${selectedArr.join('", "')}"` : "";
      const otherStr = otherArr.length > 0 ? ` (also: "${otherArr.join('", "')}")` : "";
      return selectedStr + otherStr || "(no selection)";
    }

    case "confirm":
      return `Said ${a.choice || "(no response)"}`;

    case "ask_text":
      return a.text ? `Wrote: "${a.text}"` : "(no text provided)";

    case "show_options": {
      if (!a.selected) return "(no selection)";
      const feedback = a.feedback ? ` (feedback: "${a.feedback}")` : "";
      return `Chose "${a.selected}"${feedback}`;
    }

    case "thumbs":
      return `Gave thumbs ${a.choice || "(no response)"}`;

    case "slider":
      return `Set value to ${a.value ?? "(no value)"}`;

    case "review_section":
      return a.decision === "approve" ? "Approved" : `Requested revision: ${a.feedback || "(no feedback)"}`;

    default:
      return JSON.stringify(answer);
  }
}

const BrainstormerPlugin: Plugin = async (ctx) => {
  // Create session manager
  const sessionManager = new SessionManager();

  // Track which brainstormer sessions belong to which OpenCode sessions
  const sessionsByOpenCodeSession = new Map<string, Set<string>>();

  // Track full conversation context per brainstorm session
  const sessionContexts = new Map<string, SessionContext>();

  // Create all tools with session tracking (pass client for brainstorm tool)
  const baseTools = createBrainstormerTools(sessionManager, ctx.client);

  // Access client for programmatic subagent calls
  const client = ctx.client;

  // Wrap start_session to track ownership and initialize context
  const originalStartSession = baseTools.start_session;
  const wrappedStartSession = {
    ...originalStartSession,
    execute: async (args: Record<string, unknown>, toolCtx: ToolContext) => {
      // Call original execute (which has enforcement)
      type StartSessionArgs = Parameters<typeof originalStartSession.execute>[0];
      const result = await originalStartSession.execute(args as StartSessionArgs, toolCtx);

      // If successful, track the session and initialize context
      const sessionIdMatch = result.match(/ses_[a-z0-9]+/);
      if (sessionIdMatch) {
        const brainstormSessionId = sessionIdMatch[0];
        const openCodeSessionId = toolCtx.sessionID;

        // Track OpenCode session ownership
        if (openCodeSessionId) {
          if (!sessionsByOpenCodeSession.has(openCodeSessionId)) {
            sessionsByOpenCodeSession.set(openCodeSessionId, new Set());
          }
          sessionsByOpenCodeSession.get(openCodeSessionId)!.add(brainstormSessionId);
        }

        // Initialize conversation context with questions map
        const typedArgs = args as { title?: string; questions?: Array<{ type: string; config: { question?: string } }> };
        const questionsMap = new Map<string, QuestionRecord>();
        const questionOrder: string[] = [];

        // Get the session to access question IDs
        const session = sessionManager.getSession(brainstormSessionId);
        if (session && typedArgs.questions) {
          // Map initial questions by their IDs
          const questionIds = Array.from(session.questions.keys());
          typedArgs.questions.forEach((q, idx) => {
            if (questionIds[idx]) {
              const qId = questionIds[idx];
              questionsMap.set(qId, {
                id: qId,
                type: q.type,
                text: q.config?.question || "Question",
                config: q.config,
              });
              questionOrder.push(qId);
            }
          });
        }

        sessionContexts.set(brainstormSessionId, {
          title: typedArgs.title || "Brainstorming Session",
          questions: questionsMap,
          questionOrder,
          awaitingApproval: false,
        });

        console.log(`[brainstormer] Initialized context for ${brainstormSessionId} with ${questionsMap.size} initial questions`);
      }

      return result;
    },
  };

  return {
    tool: {
      ...baseTools,
      start_session: wrappedStartSession,
    },

    config: async (config) => {
      // Add brainstormer agent (kept for backward compatibility)
      config.agent = {
        ...config.agent,
        ...agents,
      };
    },

    event: async ({ event }) => {
      // Cleanup sessions when OpenCode session is deleted
      if (event.type === "session.deleted") {
        const props = event.properties as { info?: { id?: string } } | undefined;
        const openCodeSessionId = props?.info?.id;

        if (openCodeSessionId) {
          const brainstormerSessions = sessionsByOpenCodeSession.get(openCodeSessionId);
          if (brainstormerSessions) {
            for (const sessionId of brainstormerSessions) {
              await sessionManager.endSession(sessionId);
            }
            sessionsByOpenCodeSession.delete(openCodeSessionId);
          }
        }
      }
    },

    // Hook to trigger probe after get_next_answer returns an answer
    "tool.execute.after": async (input, output) => {
      console.log(`[brainstormer-hook] tool.execute.after called for tool: ${input.tool}`);

      if (input.tool === "get_next_answer") {
        console.log(`[brainstormer-hook] get_next_answer output:`, output.output.substring(0, 200));

        // Check if we got an actual answer (not timeout/cancelled)
        const hasAnswerReceived = output.output.includes('## Answer Received');
        const hasCompletedTrue = output.output.includes('"completed": true');
        const hasStatusAnswered = output.output.includes('"status": "answered"');
        const hasAnswer = hasAnswerReceived || hasCompletedTrue || hasStatusAnswered;

        console.log(`[brainstormer-hook] hasAnswer: ${hasAnswer} (AnswerReceived=${hasAnswerReceived}, completed=${hasCompletedTrue}, status=${hasStatusAnswered})`);

        if (hasAnswer) {
          console.log(`[brainstormer-hook] TRIGGERING PROBE PROGRAMMATICALLY`);

          try {
            // Get brainstorm session ID for this OpenCode session
            const openCodeSessionId = input.sessionID;
            const brainstormSessions = sessionsByOpenCodeSession.get(openCodeSessionId);
            let effectiveSessionId: string | undefined;

            if (brainstormSessions && brainstormSessions.size > 0) {
              // Use the most recent brainstorm session for this OpenCode session
              effectiveSessionId = Array.from(brainstormSessions).pop();
            }

            // Fallback: try to extract from output
            if (!effectiveSessionId) {
              const sessionIdMatch = output.output.match(/ses_[a-z0-9]+/);
              effectiveSessionId = sessionIdMatch?.[0];
            }

            console.log(`[brainstormer-hook] OpenCode session: ${openCodeSessionId}, Brainstorm session: ${effectiveSessionId}`);

            if (effectiveSessionId && client) {
              // Get or create session context
              let context = sessionContexts.get(effectiveSessionId);
              if (!context) {
                console.log(`[brainstormer-hook] Creating NEW context for session ${effectiveSessionId}`);
                context = { title: "Brainstorming", questions: new Map(), questionOrder: [], awaitingApproval: false };
                sessionContexts.set(effectiveSessionId, context);
              }

              // Count answered questions
              const answeredCount = Array.from(context.questions.values()).filter(q => q.answer !== undefined).length;
              console.log(`[brainstormer-hook] Context has ${context.questions.size} questions, ${answeredCount} answered`);

              // Extract question ID and answer from output
              const questionIdMatch = output.output.match(/\*\*Question ID:\*\* (q_[a-z0-9]+)/);
              const responseMatch = output.output.match(/\*\*Response:\*\*\s*```json\s*([\s\S]*?)\s*```/);

              if (questionIdMatch && responseMatch) {
                const questionId = questionIdMatch[1];
                try {
                  const answer = JSON.parse(responseMatch[1]);

                  // Check if this is the approval response
                  if (context.awaitingApproval && questionId === context.approvalQuestionId) {
                    console.log(`[brainstormer-hook] Processing approval response`);
                    const typedAnswer = answer as { decision?: string; feedback?: string };
                    if (typedAnswer.decision === "approve") {
                      console.log(`[brainstormer-hook] User APPROVED the design`);
                      context.awaitingApproval = false;
                      output.output += `\n\n## Design Approved!\nUser approved the design. You may now end the session and write the design document.`;
                      return; // Don't trigger probe again
                    } else {
                      console.log(`[brainstormer-hook] User requested REVISION: ${typedAnswer.feedback}`);
                      context.awaitingApproval = false;
                      const feedbackNote = typedAnswer.feedback ? `\nFeedback: ${typedAnswer.feedback}` : "";
                      output.output += `\n\n## Revision Requested\nUser requested changes.${feedbackNote}\nContinuing brainstorming to address feedback...`;
                      // Fall through to trigger probe again
                    }
                  }

                  // Record the answer in our context
                  let questionRecord = context.questions.get(questionId);
                  if (!questionRecord) {
                    // Question not in our tracking - get it from session manager
                    const session = sessionManager.getSession(effectiveSessionId);
                    const sessionQuestion = session?.questions.get(questionId);
                    if (sessionQuestion) {
                      const questionText = sessionQuestion.config && typeof sessionQuestion.config === "object" && "question" in sessionQuestion.config
                        ? String((sessionQuestion.config as { question: string }).question)
                        : "Question";
                      questionRecord = {
                        id: questionId,
                        type: sessionQuestion.type,
                        text: questionText,
                        config: sessionQuestion.config,
                      };
                      context.questions.set(questionId, questionRecord);
                      context.questionOrder.push(questionId);
                      console.log(`[brainstormer-hook] Added missing question to context: ${questionId}`);
                    }
                  }

                  if (questionRecord) {
                    if (questionRecord.answer === undefined) {
                      questionRecord.answer = answer;
                      questionRecord.answeredAt = Date.now();
                      console.log(`[brainstormer-hook] Recorded answer for ${questionId}: "${questionRecord.text.substring(0, 40)}..."`);
                    } else {
                      console.log(`[brainstormer-hook] Question ${questionId} already has answer, skipping`);
                    }
                  } else {
                    console.log(`[brainstormer-hook] WARNING: Could not find question ${questionId} anywhere`);
                  }
                } catch (parseErr) {
                  console.log(`[brainstormer-hook] Could not parse answer JSON: ${parseErr}`);
                }
              } else {
                console.log(`[brainstormer-hook] Could not extract question ID or answer from output`);
              }

              // Build conversation history from ALL answered questions
              const answeredQuestions = context.questionOrder
                .map(id => context.questions.get(id)!)
                .filter(q => q.answer !== undefined);

              console.log(`[brainstormer-hook] Building probe context with ${answeredQuestions.length} answered questions`);

              const probeSession = await client.session.create({
                body: { title: "Probe Session" },
              });

              if (probeSession.data?.id) {
                console.log(`[brainstormer-hook] Probe session created: ${probeSession.data.id}`);

                // Build conversation history from answered questions
                const conversationHistory = answeredQuestions.map((q, i) => {
                  const answerText = formatAnswerForProbe(q.type, q.answer);
                  return `Q${i + 1} [${q.type}]: ${q.text}\nA${i + 1}: ${answerText}`;
                }).join("\n\n");

                console.log(`[brainstormer-hook] Conversation history preview (first 500 chars):\n${conversationHistory.substring(0, 500)}`);

                const totalQuestions = context.questions.size;

                const probePrompt = `<role>You are a brainstorming probe that helps refine ideas into actionable designs.</role>

<task>Analyze the conversation and decide: generate follow-up questions OR mark design as complete.</task>

<output-format>
Return ONLY valid JSON. No markdown, no explanations.

If more questions needed:
{"done": false, "reason": "what aspect needs exploration", "questions": [{"type": "pick_one", "config": {"question": "...", "options": [{"id": "a", "label": "..."}, {"id": "b", "label": "..."}]}}]}

If design is complete:
{"done": true, "reason": "summary of what was decided"}
</output-format>

<question-types>
- pick_one: Single choice. config: {question, options: [{id, label}], recommended?: id}
- pick_many: Multiple choice. config: {question, options: [{id, label}], min?, max?}
- confirm: Yes/No. config: {question, context?}
- ask_text: Free text. config: {question, placeholder?, multiline?}
- show_options: Choices with pros/cons. config: {question, options: [{id, label, pros?: [], cons?: []}], recommended?}
</question-types>

<question-quality>
Good questions:
- Dig deeper into specifics, not broader topics
- Build on previous answers
- Clarify ambiguity or tradeoffs
- Focus on constraints, requirements, edge cases

FORBIDDEN - DO NOT ASK:
- Questions already asked in conversation-history (even rephrased)
- Questions similar to ones already answered
- Generic questions like "What else?" or "Anything else?"
- Questions unrelated to the design goal

CRITICAL: Read the conversation-history carefully. If a topic was already covered, DO NOT ask about it again.
</question-quality>

<completeness-criteria>
Mark done:true when ALL of these are clear:
1. Core problem/goal is understood
2. Key requirements are identified
3. Main technical approach is decided
4. Critical constraints are known
5. At least 6-8 meaningful Q&As have occurred

Do NOT end just because you've asked many questions - end when the design is ACTUALLY clear.
</completeness-criteria>

<session-info>
Title: ${context.title}
Questions asked so far: ${totalQuestions}
</session-info>

<conversation-history>
${conversationHistory || "(First question being answered)"}
</conversation-history>

<latest-answer>
${output.output}
</latest-answer>`;

                console.log(`[brainstormer-hook] Calling probe...`);

                // Try to call probe - this might deadlock but let's see
                const probeResponse = await client.session.prompt({
                  path: { id: probeSession.data.id },
                  body: {
                    parts: [{ type: "text", text: probePrompt }],
                    model: { providerID: "anthropic", modelID: "claude-opus-4-5" },
                  },
                });

                console.log(`[brainstormer-hook] Probe responded!`);

                if (probeResponse.data?.parts) {
                  // Extract text from parts
                  let probeText = "";
                  for (const p of probeResponse.data.parts) {
                    if (p.type === "text" && "text" in p) {
                      probeText += (p as { text: string }).text;
                    }
                  }

                  console.log(`[brainstormer-hook] Probe result: ${probeText.substring(0, 200)}`);

                  // Parse probe response and push questions
                  try {
                    // Extract JSON from response - handle markdown blocks and extra text
                    let jsonStr = probeText;

                    // Remove markdown code blocks
                    jsonStr = jsonStr.replace(/```json\n?/g, "").replace(/```\n?/g, "");

                    // Try to find JSON object in the text
                    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                      jsonStr = jsonMatch[0];
                    }

                    console.log(`[brainstormer-hook] Extracted JSON: ${jsonStr.substring(0, 200)}`);

                    const probeResult = JSON.parse(jsonStr.trim());

                    // Check for pending questions in the session
                    const session = sessionManager.getSession(effectiveSessionId);
                    let pendingCount = 0;
                    if (session) {
                      for (const q of session.questions.values()) {
                        if (q.status === "pending") pendingCount++;
                      }
                    }

                    console.log(`[brainstormer-hook] Pending questions: ${pendingCount}`);

                    if (!probeResult.done && probeResult.questions) {
                      console.log(`[brainstormer-hook] Probe returned ${probeResult.questions.length} questions`);

                      // Build set of existing question texts for deduplication
                      const existingQuestionTexts = new Set<string>();
                      for (const q of context.questions.values()) {
                        existingQuestionTexts.add(q.text.toLowerCase().trim());
                      }

                      let pushedCount = 0;
                      for (const q of probeResult.questions) {
                        const questionText = q.config?.question || "Question";
                        const normalizedText = questionText.toLowerCase().trim();

                        // Check for exact or similar duplicates
                        let isDuplicate = existingQuestionTexts.has(normalizedText);
                        if (!isDuplicate) {
                          for (const existing of existingQuestionTexts) {
                            if (existing.length > 20 && normalizedText.length > 20) {
                              const existingCore = existing.replace(/^(which|what|how|should|do you|would you)\s+/i, "");
                              const newCore = normalizedText.replace(/^(which|what|how|should|do you|would you)\s+/i, "");
                              if (existingCore.includes(newCore.substring(0, 30)) || newCore.includes(existingCore.substring(0, 30))) {
                                isDuplicate = true;
                                console.log(`[brainstormer-hook] SKIPPING similar: "${questionText.substring(0, 50)}..."`);
                                break;
                              }
                            }
                          }
                        }

                        if (!isDuplicate) {
                          // Push to session manager and track in our context
                          const result = sessionManager.pushQuestion(effectiveSessionId, q.type, q.config);
                          const newId = result.question_id;

                          // Add to our tracking
                          context.questions.set(newId, {
                            id: newId,
                            type: q.type,
                            text: questionText,
                            config: q.config,
                          });
                          context.questionOrder.push(newId);
                          existingQuestionTexts.add(normalizedText);
                          pushedCount++;
                        }
                      }

                      console.log(`[brainstormer-hook] Pushed ${pushedCount}/${probeResult.questions.length} questions`);
                      output.output += `\n\n## Probe Result\n${pushedCount} new questions pushed. Call get_next_answer again.`;
                    } else if (pendingCount > 0) {
                      console.log(`[brainstormer-hook] Probe said done but ${pendingCount} questions pending - continuing`);
                      output.output += `\n\n## Probe Result\nProbe indicated design is ready, but ${pendingCount} questions still pending. Call get_next_answer to collect remaining answers.`;
                    } else {
                      // Probe said done and no pending questions - push approval question
                      console.log(`[brainstormer-hook] Design complete - pushing approval question`);

                      // Build summary from all answered questions
                      const answeredQs = context.questionOrder
                        .map(id => context.questions.get(id)!)
                        .filter(q => q.answer !== undefined);

                      console.log(`[brainstormer-hook] ========== BUILDING SUMMARY ==========`);
                      console.log(`[brainstormer-hook] Total answered: ${answeredQs.length}`);
                      answeredQs.forEach((q, i) => {
                        console.log(`[brainstormer-hook]   ${i + 1}. "${q.text.substring(0, 50)}..."`);
                      });
                      console.log(`[brainstormer-hook] ======================================`);

                      const summaryLines = answeredQs.map((q) => {
                        const answerText = formatAnswerForProbe(q.type, q.answer);
                        return `- **${q.text}**: ${answerText}`;
                      });

                      const summaryMarkdown = `## Design Summary

**${probeResult.reason || "Design exploration complete"}**

### Decisions Made

${summaryLines.join("\n")}

### Next Steps

If you approve, the brainstorming session will end and a design document will be created based on these decisions.

If you need changes, we'll continue refining the design.`;

                      // Push approval question using review_section for better formatting
                      const approvalResult = sessionManager.pushQuestion(effectiveSessionId, "review_section", {
                        question: "Review & Approve Design",
                        content: summaryMarkdown,
                        context: "Review the brainstorming summary and approve or request changes.",
                      });

                      // Mark that we're awaiting approval
                      context.awaitingApproval = true;
                      context.approvalQuestionId = approvalResult.question_id;

                      output.output += `\n\n## Design Ready for Approval\nPushed approval question (${approvalResult.question_id}). Call get_next_answer to get user's approval before ending session.`;
                    }
                  } catch (parseErr) {
                    console.log(`[brainstormer-hook] Failed to parse probe response: ${parseErr}`);
                    output.output += `\n\n## Probe Error\nFailed to parse probe response. Agent should call probe subagent manually.`;
                  }
                }

                // Cleanup probe session
                await client.session.delete({ path: { id: probeSession.data.id } }).catch(() => {});
              }
            } else {
              console.log(`[brainstormer-hook] No session ID found, cannot trigger probe`);
              output.output += `\n\n<PROBE-REQUIRED>Call probe subagent now!</PROBE-REQUIRED>`;
            }
          } catch (err) {
            console.log(`[brainstormer-hook] Error triggering probe: ${err}`);
            // Fall back to reminder
            output.output += `\n\n<PROBE-REQUIRED>Call probe subagent now!</PROBE-REQUIRED>`;
          }
        }
      }
    },

  };
};

export default BrainstormerPlugin;

// Re-export types for consumers
export type * from "./types";
export type * from "./tools/brainstorm/types";
