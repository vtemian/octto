// src/index.ts
import type { Plugin } from "@opencode-ai/plugin";
import type { ToolContext } from "@opencode-ai/plugin/tool";
import { SessionManager } from "./session/manager";
import { createBrainstormerTools } from "./tools";
import { agents } from "./agents";

interface ConversationEntry {
  questionId: string;
  questionText: string;
  questionType: string;
  answer: unknown;
}

interface SessionContext {
  title: string;
  originalRequest?: string;
  conversation: ConversationEntry[];
  questionCount: number;
  awaitingApproval: boolean;
  approvalQuestionId?: string;
}

/**
 * Extract question text - this is a placeholder, actual question comes from session
 */
function extractQuestionText(_answer: unknown): string {
  return "Question"; // Will be replaced with actual question from session
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
      return `Selected "${a.selected}"`;

    case "pick_many": {
      const selected = Array.isArray(a.selected) ? a.selected.join('", "') : a.selected;
      const other = Array.isArray(a.other) && a.other.length ? ` (also: "${a.other.join('", "')}")` : "";
      return `Selected: "${selected}"${other}`;
    }

    case "confirm":
      return `Said ${a.choice}`;

    case "ask_text":
      return `Wrote: "${a.text}"`;

    case "show_options": {
      const feedback = a.feedback ? ` (feedback: "${a.feedback}")` : "";
      return `Chose "${a.selected}"${feedback}`;
    }

    case "thumbs":
      return `Gave thumbs ${a.choice}`;

    case "slider":
      return `Set value to ${a.value}`;

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

        // Initialize conversation context
        const typedArgs = args as { title?: string; questions?: Array<{ type: string; config: { question?: string } }> };
        const initialQuestionCount = typedArgs.questions?.length || 0;

        sessionContexts.set(brainstormSessionId, {
          title: typedArgs.title || "Brainstorming Session",
          conversation: [],
          questionCount: initialQuestionCount,
          awaitingApproval: false,
        });

        console.log(`[brainstormer] Initialized context for ${brainstormSessionId} with ${initialQuestionCount} initial questions`);
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
        const hasAnswer = output.output.includes('"completed": true') ||
                          output.output.includes('"status": "answered"') ||
                          output.output.includes('## Answer Received');

        console.log(`[brainstormer-hook] hasAnswer: ${hasAnswer}`);

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
                context = { title: "Brainstorming", conversation: [], questionCount: 0, awaitingApproval: false };
                sessionContexts.set(effectiveSessionId, context);
              } else {
                console.log(`[brainstormer-hook] Using EXISTING context with ${context.conversation.length} Q&As`);
              }

              // Check if this is the approval response
              if (context.awaitingApproval) {
                console.log(`[brainstormer-hook] Processing approval response`);

                // Extract the answer (review_section returns {decision: "approve"|"revise", feedback?: string})
                const responseMatch = output.output.match(/\*\*Response:\*\*\s*```json\s*([\s\S]*?)\s*```/);
                if (responseMatch) {
                  try {
                    const answer = JSON.parse(responseMatch[1]) as { decision?: string; feedback?: string };
                    if (answer.decision === "approve") {
                      console.log(`[brainstormer-hook] User APPROVED the design`);
                      context.awaitingApproval = false;
                      output.output += `\n\n## Design Approved!\nUser approved the design. You may now end the session and write the design document.`;
                      return; // Don't trigger probe again
                    } else {
                      console.log(`[brainstormer-hook] User requested REVISION`);
                      context.awaitingApproval = false;
                      const feedbackNote = answer.feedback ? `\nFeedback: ${answer.feedback}` : "";
                      output.output += `\n\n## Revision Requested\nUser requested changes.${feedbackNote}\nContinuing brainstorming to address feedback...`;
                      // Fall through to trigger probe again
                    }
                  } catch {
                    console.log(`[brainstormer-hook] Could not parse approval response`);
                  }
                }
              }

              // Extract Q&A from output and add to conversation
              const questionIdMatch = output.output.match(/\*\*Question ID:\*\* (q_[a-z0-9]+)/);
              const questionTypeMatch = output.output.match(/\*\*Question Type:\*\* (\w+)/);
              const responseMatch = output.output.match(/\*\*Response:\*\*\s*```json\s*([\s\S]*?)\s*```/);

              if (questionIdMatch && responseMatch) {
                try {
                  const answer = JSON.parse(responseMatch[1]);
                  const questionId = questionIdMatch[1];

                  // Get actual question text from session
                  const session = sessionManager.getSession(effectiveSessionId);
                  let questionText = "Question";
                  if (session) {
                    const question = session.questions.get(questionId);
                    if (question?.config && typeof question.config === "object" && "question" in question.config) {
                      questionText = String((question.config as { question: string }).question);
                    }
                  }

                  context.conversation.push({
                    questionId,
                    questionText,
                    questionType: questionTypeMatch?.[1] || "unknown",
                    answer,
                  });
                  console.log(`[brainstormer-hook] Added Q&A #${context.conversation.length}: "${questionText.substring(0, 40)}..." -> ${JSON.stringify(answer).substring(0, 30)}`);
                } catch {
                  console.log(`[brainstormer-hook] Could not parse answer JSON`);
                }
              }

              console.log(`[brainstormer-hook] Creating probe session...`);

              const probeSession = await client.session.create({
                body: { title: "Probe Session" },
              });

              if (probeSession.data?.id) {
                console.log(`[brainstormer-hook] Probe session created: ${probeSession.data.id}`);

                // Build full conversation history for probe
                const conversationHistory = context.conversation.map((entry, i) => {
                  const answerText = formatAnswerForProbe(entry.questionType, entry.answer);
                  return `Q${i + 1} [${entry.questionType}]: ${entry.questionText}\nA${i + 1}: ${answerText}`;
                }).join("\n\n");

                const totalQuestions = context.questionCount + context.conversation.length;

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

Bad questions:
- Repeating what was already asked
- Too generic ("What else?")
- Unrelated to the design goal
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
                      console.log(`[brainstormer-hook] Pushing ${probeResult.questions.length} questions`);

                      for (const q of probeResult.questions) {
                        sessionManager.pushQuestion(effectiveSessionId, q.type, q.config);
                      }

                      output.output += `\n\n## Probe Result\n${probeResult.questions.length} new questions pushed. Call get_next_answer again.`;
                    } else if (pendingCount > 0) {
                      // Probe said done, but there are still pending questions!
                      console.log(`[brainstormer-hook] Probe said done but ${pendingCount} questions pending - continuing`);
                      output.output += `\n\n## Probe Result\nProbe indicated design is ready, but ${pendingCount} questions still pending. Call get_next_answer to collect remaining answers.`;
                    } else {
                      // Probe said done and no pending questions - push approval question
                      console.log(`[brainstormer-hook] Design complete - pushing approval question`);

                      // Build summary from conversation - show question: answer pairs
                      const summaryLines = context.conversation.map((entry) => {
                        const answerText = formatAnswerForProbe(entry.questionType, entry.answer);
                        return `- **${entry.questionText}**: ${answerText}`;
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
