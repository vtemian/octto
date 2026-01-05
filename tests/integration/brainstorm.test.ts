// tests/integration/brainstorm.test.ts
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { SessionManager } from "../../src/session/manager";
import { BrainstormOrchestrator } from "../../src/tools/brainstorm";
import type { BrainstormInput } from "../../src/tools/brainstorm/types";

describe("Brainstorm Integration", () => {
  let sessionManager: SessionManager;

  beforeEach(() => {
    sessionManager = new SessionManager({ skipBrowser: true });
  });

  afterEach(async () => {
    await sessionManager.cleanup();
  });

  describe("BrainstormOrchestrator with mocked LLM", () => {
    it("should complete a full brainstorming flow", async () => {
      // Create mock client that returns "done" after first probe call
      let probeCallCount = 0;
      const mockClient = {
        session: {
          create: mock(async () => ({ data: { id: "child-session-123" } })),
          delete: mock(async () => ({})),
          prompt: mock(async () => {
            probeCallCount++;
            if (probeCallCount === 1) {
              // First call is probe - return done
              return {
                data: {
                  parts: [
                    {
                      type: "text",
                      text: JSON.stringify({ done: true, reason: "Design complete" }),
                    },
                  ],
                },
              };
            }
            // Second call is summary
            return {
              data: {
                parts: [
                  {
                    type: "text",
                    text: "## Problem Statement\nTest problem\n\n## Requirements\n- Test requirement",
                  },
                ],
              },
            };
          }),
        },
      } as any;

      const orchestrator = new BrainstormOrchestrator(sessionManager, mockClient, "test-session");

      const input: BrainstormInput = {
        context: "Test context",
        request: "Build a test feature",
        initial_questions: [
          {
            type: "confirm",
            config: { question: "Ready to start?" },
          },
        ],
      };

      // Start the orchestrator in background
      const resultPromise = orchestrator.run(input);

      // Simulate user answering the question
      // Wait a bit for session to be created
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Find the session and simulate an answer
      const questions = sessionManager.listQuestions();
      expect(questions.questions.length).toBe(1);

      const questionId = questions.questions[0].id;
      const sessionId = questionId.replace(/q_/, "ses_").slice(0, 12); // Approximate session ID

      // Simulate WebSocket message
      const sessions = sessionManager["sessions"];
      for (const [sid, session] of sessions) {
        for (const [qid, question] of session.questions) {
          if (question.status === "pending") {
            // Simulate answer
            sessionManager.handleWsMessage(sid, {
              type: "response",
              id: qid,
              answer: { choice: "yes" },
            });
          }
        }
      }

      // Wait for result
      const result = await resultPromise;

      expect(result.answers.length).toBe(1);
      expect(result.answers[0].question).toBe("Ready to start?");
      expect(result.summary).toContain("Problem Statement");
    });
  });
});
