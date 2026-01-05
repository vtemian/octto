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

                const probePrompt = `<role>You are a focused brainstorming probe. Your job is to gather just enough info to proceed, not to exhaustively explore.</role>

<CRITICAL-RULES>
1. Generate ONLY 1 QUESTION per response (never more)
2. NEVER ask the same question in different words
3. If user gives empty/vague answer, MOVE ON - don't ask again
4. After 4-5 good answers, you probably have enough - mark done
5. Prefer actionable questions over exploratory ones
</CRITICAL-RULES>

<output-format>
Return ONLY valid JSON. No markdown, no explanations.

If ONE more question needed:
{"done": false, "reason": "brief reason", "questions": [{"type": "...", "config": {...}}]}

If design is complete:
{"done": true, "reason": "summary of decisions"}
</output-format>

<question-types>
- pick_one: config: {question, options: [{id, label}]}
- pick_many: config: {question, options: [{id, label}]}
- confirm: config: {question}
- ask_text: config: {question, placeholder?}
</question-types>

<DUPLICATE-DETECTION>
These are ALL THE SAME QUESTION - never ask variants:
- "What issues are you seeing?" = "What problems have you noticed?" = "What concerns you?"
- "Which files need work?" = "Are there specific files?" = "What files concern you?"
- "What type of X?" = "What kind of X?" = "What X are you looking for?"

If conversation-history contains ANY question about a topic, that topic is CLOSED.
</DUPLICATE-DETECTION>

<EMPTY-ANSWER-HANDLING>
If user answers with:
- "(no text provided)" or "(no selection)" → They don't know/care. MOVE ON.
- Empty text → Accept it and proceed with defaults
- "I don't know" → Stop asking about that topic

Do NOT keep asking for specifics if user isn't providing them.
</EMPTY-ANSWER-HANDLING>

<WHEN-TO-STOP>
Mark done:true when ANY of these is true:
- User has answered 4+ substantive questions
- Core goal and approach are clear (even if details aren't)
- User gives vague answers repeatedly (they want you to decide)
- You'd be asking a 3rd question on the same topic

When in doubt, STOP and let the user proceed. They can always revise.
</WHEN-TO-STOP>

<session-info>
Title: ${context.title}
Questions asked: ${totalQuestions}
</session-info>

<conversation-history>
${conversationHistory || "(First question)"}
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

                    if (!probeResult.done && probeResult.questions && probeResult.questions.length > 0) {
                      // ENFORCE: Only take the first question (probe should only generate 1)
                      const q = probeResult.questions[0];
                      const questionText = q.config?.question || "Question";
                      const normalizedText = questionText.toLowerCase().trim();

                      console.log(`[brainstormer-hook] Probe returned question: "${questionText.substring(0, 60)}..."`);

                      // Check for duplicates using keyword extraction
                      const extractKeywords = (text: string): Set<string> => {
                        const stopWords = new Set(["what", "which", "how", "do", "you", "are", "is", "the", "a", "an", "to", "for", "in", "on", "of", "want", "need", "like", "would", "should", "have", "any", "there", "specific", "particular"]);
                        return new Set(
                          text.toLowerCase()
                            .replace(/[?.,!]/g, "")
                            .split(/\s+/)
                            .filter(w => w.length > 2 && !stopWords.has(w))
                        );
                      };

                      const newKeywords = extractKeywords(questionText);
                      let isDuplicate = false;

                      for (const existing of context.questions.values()) {
                        const existingKeywords = extractKeywords(existing.text);
                        // Count overlapping keywords
                        let overlap = 0;
                        for (const kw of newKeywords) {
                          if (existingKeywords.has(kw)) overlap++;
                        }
                        // If more than 50% keywords overlap, it's a duplicate
                        if (newKeywords.size > 0 && overlap / newKeywords.size > 0.5) {
                          console.log(`[brainstormer-hook] DUPLICATE detected (${overlap}/${newKeywords.size} keywords overlap with "${existing.text.substring(0, 40)}...")`);
                          isDuplicate = true;
                          break;
                        }
                      }

                      if (!isDuplicate) {
                        const result = sessionManager.pushQuestion(effectiveSessionId, q.type, q.config);
                        const newId = result.question_id;

                        context.questions.set(newId, {
                          id: newId,
                          type: q.type,
                          text: questionText,
                          config: q.config,
                        });
                        context.questionOrder.push(newId);

                        console.log(`[brainstormer-hook] Pushed question: ${newId}`);
                        output.output += `\n\n## Probe Result\nNew question pushed. Call get_next_answer again.`;
                      } else {
                        // Duplicate detected - mark as done instead of asking again
                        console.log(`[brainstormer-hook] Duplicate question, marking session as done`);
                        probeResult.done = true;
                        probeResult.reason = "Enough information gathered";
                      }
                    }

                    // Check if we should show approval (probe said done OR duplicate detected)
                    if (probeResult.done) {
                      if (pendingCount > 0) {
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
