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
  questions: Map<string, QuestionRecord>;
  questionOrder: string[];
  awaitingApproval: boolean;
  approvalQuestionId?: string;
}

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
  const sessionManager = new SessionManager();
  const sessionsByOpenCodeSession = new Map<string, Set<string>>();
  const sessionContexts = new Map<string, SessionContext>();
  const baseTools = createBrainstormerTools(sessionManager, ctx.client);
  const client = ctx.client;

  const originalStartSession = baseTools.start_session;
  const wrappedStartSession = {
    ...originalStartSession,
    execute: async (args: Record<string, unknown>, toolCtx: ToolContext) => {
      type StartSessionArgs = Parameters<typeof originalStartSession.execute>[0];
      const result = await originalStartSession.execute(args as StartSessionArgs, toolCtx);

      const sessionIdMatch = result.match(/ses_[a-z0-9]+/);
      if (sessionIdMatch) {
        const brainstormSessionId = sessionIdMatch[0];
        const openCodeSessionId = toolCtx.sessionID;

        if (openCodeSessionId) {
          if (!sessionsByOpenCodeSession.has(openCodeSessionId)) {
            sessionsByOpenCodeSession.set(openCodeSessionId, new Set());
          }
          sessionsByOpenCodeSession.get(openCodeSessionId)!.add(brainstormSessionId);
        }

        const typedArgs = args as { title?: string; questions?: Array<{ type: string; config: { question?: string } }> };
        const questionsMap = new Map<string, QuestionRecord>();
        const questionOrder: string[] = [];

        const session = sessionManager.getSession(brainstormSessionId);
        if (session && typedArgs.questions) {
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
      config.agent = {
        ...config.agent,
        ...agents,
      };
    },

    event: async ({ event }) => {
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

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "get_next_answer") return;

      const hasAnswer = output.output.includes('## Answer Received') ||
                        output.output.includes('"completed": true') ||
                        output.output.includes('"status": "answered"');

      if (!hasAnswer) return;

      try {
        const openCodeSessionId = input.sessionID;
        const brainstormSessions = sessionsByOpenCodeSession.get(openCodeSessionId);
        let effectiveSessionId: string | undefined;

        // DEBUG: Track session lookup
        const debugInfo = {
          openCodeSessionId,
          knownOpenCodeSessions: Array.from(sessionsByOpenCodeSession.keys()),
          brainstormSessionsForThis: brainstormSessions ? Array.from(brainstormSessions) : [],
          allContextKeys: Array.from(sessionContexts.keys()),
        };

        if (brainstormSessions && brainstormSessions.size > 0) {
          effectiveSessionId = Array.from(brainstormSessions).pop();
        }

        if (!effectiveSessionId) {
          const sessionIdMatch = output.output.match(/ses_[a-z0-9]+/);
          effectiveSessionId = sessionIdMatch?.[0];
        }

        if (!effectiveSessionId || !client) {
          output.output += `\n\n<PROBE-REQUIRED>Call probe subagent now!</PROBE-REQUIRED>\n[DEBUG: ${JSON.stringify(debugInfo)}]`;
          return;
        }

        let context = sessionContexts.get(effectiveSessionId);
        const isNewContext = !context;
        if (!context) {
          context = { title: "Brainstorming", questions: new Map(), questionOrder: [], awaitingApproval: false };
          sessionContexts.set(effectiveSessionId, context);
        }

        // Track state for debugging
        const answeredBefore = Array.from(context.questions.values()).filter(q => q.answer !== undefined).length;

        // Add debug to output
        output.output += `\n[DEBUG: ocsid=${openCodeSessionId?.substring(0,8)}, bsid=${effectiveSessionId}, new=${isNewContext}, answered=${answeredBefore}, contexts=${sessionContexts.size}]`;

        const questionIdMatch = output.output.match(/\*\*Question ID:\*\* (q_[a-z0-9]+)/);
        const responseMatch = output.output.match(/\*\*Response:\*\*\s*```json\s*([\s\S]*?)\s*```/);

        if (questionIdMatch && responseMatch) {
          const questionId = questionIdMatch[1];
          try {
            const answer = JSON.parse(responseMatch[1]);

            if (context.awaitingApproval && questionId === context.approvalQuestionId) {
              const typedAnswer = answer as { decision?: string; feedback?: string };
              if (typedAnswer.decision === "approve") {
                context.awaitingApproval = false;
                output.output += `\n\n## Design Approved!\nUser approved the design. You may now end the session and write the design document.`;
                return;
              } else {
                context.awaitingApproval = false;
                const feedbackNote = typedAnswer.feedback ? `\nFeedback: ${typedAnswer.feedback}` : "";
                output.output += `\n\n## Revision Requested\nUser requested changes.${feedbackNote}\nContinuing brainstorming to address feedback...`;
              }
            }

            let questionRecord = context.questions.get(questionId);
            if (!questionRecord) {
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
              }
            }

            if (questionRecord && questionRecord.answer === undefined) {
              questionRecord.answer = answer;
              questionRecord.answeredAt = Date.now();
            }
          } catch {
            // Could not parse answer JSON
          }
        }

        const answeredQuestions = context.questionOrder
          .map(id => context.questions.get(id)!)
          .filter(q => q.answer !== undefined);

        const probeSession = await client.session.create({
          body: { title: "Probe Session" },
        });

        if (!probeSession.data?.id) return;

        const conversationHistory = answeredQuestions.map((q, i) => {
          const answerText = formatAnswerForProbe(q.type, q.answer);
          return `Q${i + 1} [${q.type}]: ${q.text}\nA${i + 1}: ${answerText}`;
        }).join("\n\n");

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

        const probeResponse = await client.session.prompt({
          path: { id: probeSession.data.id },
          body: {
            parts: [{ type: "text", text: probePrompt }],
            model: { providerID: "anthropic", modelID: "claude-opus-4-5" },
          },
        });

        if (probeResponse.data?.parts) {
          let probeText = "";
          for (const p of probeResponse.data.parts) {
            if (p.type === "text" && "text" in p) {
              probeText += (p as { text: string }).text;
            }
          }

          try {
            let jsonStr = probeText;
            jsonStr = jsonStr.replace(/```json\n?/g, "").replace(/```\n?/g, "");
            const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              jsonStr = jsonMatch[0];
            }

            const probeResult = JSON.parse(jsonStr.trim());

            const session = sessionManager.getSession(effectiveSessionId);
            let pendingCount = 0;
            if (session) {
              for (const q of session.questions.values()) {
                if (q.status === "pending") pendingCount++;
              }
            }

            if (!probeResult.done && probeResult.questions && probeResult.questions.length > 0) {
              const q = probeResult.questions[0];
              const questionText = q.config?.question || "Question";

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
                let overlap = 0;
                for (const kw of newKeywords) {
                  if (existingKeywords.has(kw)) overlap++;
                }
                if (newKeywords.size > 0 && overlap / newKeywords.size > 0.5) {
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

                const answeredAfter = Array.from(context.questions.values()).filter(q => q.answer !== undefined).length;
                output.output += `\n\n## Probe Result\nNew question pushed. Call get_next_answer again.\n[Context: session=${effectiveSessionId}, new=${isNewContext}, answered=${answeredBefore}→${answeredAfter}, total=${context.questions.size}]`;
              } else {
                probeResult.done = true;
                probeResult.reason = "Enough information gathered";
              }
            }

            if (probeResult.done) {
              if (pendingCount > 0) {
                output.output += `\n\n## Probe Result\nProbe indicated design is ready, but ${pendingCount} questions still pending. Call get_next_answer to collect remaining answers.`;
              } else {
                const answeredQs = context.questionOrder
                  .map(id => context.questions.get(id)!)
                  .filter(q => q.answer !== undefined);

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

                const approvalResult = sessionManager.pushQuestion(effectiveSessionId, "review_section", {
                  question: "Review & Approve Design",
                  content: summaryMarkdown,
                  context: "Review the brainstorming summary and approve or request changes.",
                });

                context.awaitingApproval = true;
                context.approvalQuestionId = approvalResult.question_id;

                output.output += `\n\n## Design Ready for Approval\nPushed approval question (${approvalResult.question_id}). Call get_next_answer to get user's approval before ending session.`;
              }
            }
          } catch {
            output.output += `\n\n## Probe Error\nFailed to parse probe response. Agent should call probe subagent manually.`;
          }
        }

        await client.session.delete({ path: { id: probeSession.data.id } }).catch(() => {});
      } catch {
        output.output += `\n\n<PROBE-REQUIRED>Call probe subagent now!</PROBE-REQUIRED>`;
      }
    },
  };
};

export default BrainstormerPlugin;

export type * from "./types";
export type * from "./tools/brainstorm/types";
