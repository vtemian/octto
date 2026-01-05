// src/tools/brainstorm/orchestrator.ts
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { SessionManager } from "../../session/manager";
import type { QuestionConfig } from "../../session/types";
import type { BrainstormInput, BrainstormOutput, BrainstormAnswer } from "./types";
import { BrainstormError } from "./types";
import { callProbe } from "./probe";
import { callSummarize } from "./summarize";
import { DEFAULT_MAX_QUESTIONS, DEFAULT_PROBE_MODEL, DEFAULT_ANSWER_TIMEOUT_MS } from "../../constants";

export class BrainstormOrchestrator {
  private sessionManager: SessionManager;
  private client: OpencodeClient;
  private opencodeSessionId: string;

  constructor(sessionManager: SessionManager, client: OpencodeClient, opencodeSessionId: string) {
    this.sessionManager = sessionManager;
    this.client = client;
    this.opencodeSessionId = opencodeSessionId;
  }

  /**
   * Extract question text from a question config
   */
  extractQuestionText(config: QuestionConfig | Record<string, unknown>): string {
    if (typeof config === "object" && config !== null && "question" in config) {
      return String((config as { question: unknown }).question);
    }
    return "";
  }

  /**
   * Push questions from probe response to session
   * Returns number of questions pushed
   */
  private pushProbeQuestions(
    probeResult: import("./types").ProbeResponseContinue,
    sessionId: string,
    questionTexts: Map<string, { text: string; type: string }>,
    maxQ: number,
    currentCount: number,
  ): number {
    let pushed = 0;
    for (const question of probeResult.questions) {
      if (currentCount + pushed >= maxQ) {
        break;
      }

      const pushResult = this.sessionManager.pushQuestion(sessionId, question.type, question.config);

      questionTexts.set(pushResult.question_id, {
        text: this.extractQuestionText(question.config),
        type: question.type,
      });

      pushed++;
    }
    return pushed;
  }

  /**
   * Run the complete brainstorming flow
   */
  async run(input: BrainstormInput): Promise<BrainstormOutput> {
    const { context, request, initial_questions, max_questions, model } = input;
    const maxQ = max_questions ?? DEFAULT_MAX_QUESTIONS;
    const llmModel = model ?? DEFAULT_PROBE_MODEL;

    // Validate input
    if (!initial_questions || initial_questions.length === 0) {
      throw new BrainstormError("invalid_response", "At least one initial question is required");
    }

    // Create a child session for internal LLM calls (probe/summarize)
    // This avoids deadlock from prompting the same session that's running the tool
    const childSession = await this.client.session.create({
      body: {
        parentID: this.opencodeSessionId,
        title: "Brainstorm LLM Session",
      },
    });

    const llmSessionId = childSession.data?.id;
    if (!llmSessionId) {
      throw new BrainstormError("llm_error", "Failed to create child session for LLM calls");
    }

    // Start browser session with initial questions
    const sessionResult = await this.sessionManager.startSession({
      title: "Brainstorming Session",
      questions: initial_questions,
    });

    const brainstormSessionId = sessionResult.session_id;
    const answers: BrainstormAnswer[] = [];

    // Track question texts for answer collection
    const questionTexts = new Map<string, { text: string; type: string }>();
    for (let i = 0; i < initial_questions.length; i++) {
      const qId = sessionResult.question_ids?.[i];
      if (qId) {
        questionTexts.set(qId, {
          text: this.extractQuestionText(initial_questions[i].config),
          type: initial_questions[i].type,
        });
      }
    }

    try {
      // Main answer loop - sequential but with multi-question probe responses
      let questionCount = initial_questions.length;
      let done = false;

      while (!done && questionCount <= maxQ) {
        // Wait for next answer
        const answerResult = await this.sessionManager.getNextAnswer({
          session_id: brainstormSessionId,
          block: true,
          timeout: DEFAULT_ANSWER_TIMEOUT_MS,
        });

        // Handle timeout or no pending
        if (!answerResult.completed) {
          if (answerResult.status === "timeout") {
            throw new BrainstormError("timeout", "Timed out waiting for user response");
          }
          if (answerResult.status === "none_pending") {
            break;
          }
          continue;
        }

        // Record the answer
        const qInfo = questionTexts.get(answerResult.question_id!);
        if (qInfo) {
          answers.push({
            question: qInfo.text,
            type: answerResult.question_type as import("../../session/types").QuestionType,
            answer: answerResult.response,
          });
        }

        // Check max before calling probe
        if (questionCount >= maxQ) {
          break;
        }

        // Call probe to get next questions (can return 1-5)
        const probeResult = await callProbe(this.client, llmSessionId, request, answers, llmModel);

        if (probeResult.done) {
          done = true;
        } else {
          // Push all questions from probe
          for (const question of probeResult.questions) {
            if (questionCount >= maxQ) {
              done = true;
              break;
            }

            const pushResult = this.sessionManager.pushQuestion(
              brainstormSessionId,
              question.type,
              question.config,
            );

            questionTexts.set(pushResult.question_id, {
              text: this.extractQuestionText(question.config),
              type: question.type,
            });

            questionCount++;
          }
        }
      }

      // End the browser session
      await this.sessionManager.endSession(brainstormSessionId);

      // Generate summary
      const summary = await callSummarize(this.client, llmSessionId, request, context, answers, llmModel);

      // Clean up child session if we created one
      if (llmSessionId) {
        await this.client.session.delete({ path: { id: llmSessionId } }).catch(() => {});
      }

      return { answers, summary };
    } catch (e) {
      // Clean up sessions on error
      await this.sessionManager.endSession(brainstormSessionId).catch(() => {});
      if (llmSessionId) {
        await this.client.session.delete({ path: { id: llmSessionId } }).catch(() => {});
      }

      if (e instanceof BrainstormError) throw e;
      throw new BrainstormError("llm_error", `Brainstorming failed: ${e}`, e);
    }
  }
}
