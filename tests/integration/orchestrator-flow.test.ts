// tests/integration/orchestrator-flow.test.ts
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { BrainstormOrchestrator } from "../../src/tools/brainstorm/orchestrator";
import { SessionManager } from "../../src/session/manager";

describe("Orchestrator Flow Integration", () => {
  let sessionManager: SessionManager;
  let orchestrator: BrainstormOrchestrator;

  beforeEach(() => {
    sessionManager = new SessionManager({ skipBrowser: true });
  });

  afterEach(async () => {
    await sessionManager.cleanup();
  });

  // Helper to simulate answering all pending questions in a session
  function answerAllPendingQuestions(answer: unknown): void {
    const sessions = sessionManager["sessions"];
    for (const [sid, session] of sessions) {
      for (const [qid, question] of session.questions) {
        if (question.status === "pending") {
          sessionManager.handleWsMessage(sid, {
            type: "response",
            id: qid,
            answer,
          });
        }
      }
    }
  }

  // Helper to wait for a condition with timeout
  async function waitFor(condition: () => boolean, timeoutMs: number = 2000, intervalMs: number = 50): Promise<void> {
    const start = Date.now();
    while (!condition()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error("waitFor timeout");
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  describe("happy path", () => {
    it("should complete flow: start -> answer -> probe done -> summary", async () => {
      let probeCallCount = 0;

      // Create mock client that returns "done" after first probe call
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
                    text: "## Summary\nTest summary content",
                  },
                ],
              },
            };
          }),
        },
      } as any;

      orchestrator = new BrainstormOrchestrator(sessionManager, mockClient, "test-opencode-session");

      // Start orchestrator in background
      const orchestratorPromise = orchestrator.run({
        context: "Test context",
        request: "Test request",
        initial_questions: [
          {
            type: "confirm",
            config: { question: "Ready to proceed?" },
          },
        ],
      });

      // Wait a bit for session to start
      await new Promise((r) => setTimeout(r, 100));

      // Verify questions were created
      const questions = sessionManager.listQuestions();
      expect(questions.questions.length).toBe(1);

      // Simulate user answering
      answerAllPendingQuestions({ choice: "yes" });

      // Wait for orchestrator to complete
      const result = await orchestratorPromise;

      expect(result.answers.length).toBe(1);
      expect(result.answers[0].answer).toEqual({ choice: "yes" });
      expect(result.summary).toContain("Summary");
    });

    it("should handle probe returning follow-up question", async () => {
      let probeCount = 0;
      const mockClient = {
        session: {
          create: mock(async () => ({ data: { id: "child-session-123" } })),
          delete: mock(async () => ({})),
          prompt: mock(async () => {
            probeCount++;
            if (probeCount === 1) {
              // First probe - return follow-up question
              return {
                data: {
                  parts: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        done: false,
                        reason: "Need more info",
                        questions: [
                          {
                            type: "ask_text",
                            config: { question: "What else?" },
                          },
                        ],
                      }),
                    },
                  ],
                },
              };
            }
            if (probeCount === 2) {
              // Second probe - done
              return {
                data: {
                  parts: [
                    {
                      type: "text",
                      text: JSON.stringify({ done: true, reason: "Complete" }),
                    },
                  ],
                },
              };
            }
            // Summary call
            return {
              data: {
                parts: [{ type: "text", text: "## Final Summary" }],
              },
            };
          }),
        },
      } as any;

      orchestrator = new BrainstormOrchestrator(sessionManager, mockClient, "test-session");

      const orchestratorPromise = orchestrator.run({
        context: "Test",
        request: "Test",
        initial_questions: [{ type: "confirm", config: { question: "Start?" } }],
      });

      // Wait for session to start
      await new Promise((r) => setTimeout(r, 100));

      // Answer first question
      answerAllPendingQuestions({ choice: "yes" });

      // Poll and answer any new pending questions until orchestrator completes
      // This handles the follow-up question flow
      let stopAnswerLoop = false;
      const answerLoop = async () => {
        while (!stopAnswerLoop) {
          await new Promise((r) => setTimeout(r, 50));
          const questions = sessionManager.listQuestions();
          const pendingQuestions = questions.questions.filter((q) => q.status === "pending");
          if (pendingQuestions.length > 0) {
            // Answer based on question type
            for (const q of pendingQuestions) {
              const sessions = sessionManager["sessions"];
              for (const [sid, session] of sessions) {
                const question = session.questions.get(q.id);
                if (question && question.status === "pending") {
                  const answer = q.type === "ask_text" ? { text: "More info" } : { choice: "yes" };
                  sessionManager.handleWsMessage(sid, {
                    type: "response",
                    id: q.id,
                    answer,
                  });
                }
              }
            }
          }
        }
      };

      // Run answer loop in background, but don't await it
      answerLoop();

      // Wait for orchestrator to complete (with timeout)
      try {
        const result = await Promise.race([
          orchestratorPromise,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Orchestrator timeout")), 5000)),
        ]);

        expect(result.answers.length).toBe(2);
        expect(result.summary).toContain("Final Summary");
      } finally {
        stopAnswerLoop = true;
        // Wait for the answer loop to stop
        await new Promise((r) => setTimeout(r, 100));
      }
    });
  });

  describe("error handling", () => {
    it("should throw on empty initial_questions", async () => {
      const mockClient = {} as any;
      orchestrator = new BrainstormOrchestrator(sessionManager, mockClient, "test-session");

      await expect(
        orchestrator.run({
          context: "Test",
          request: "Test",
          initial_questions: [],
        }),
      ).rejects.toThrow("At least one initial question is required");
    });

    it("should throw on undefined initial_questions", async () => {
      const mockClient = {} as any;
      orchestrator = new BrainstormOrchestrator(sessionManager, mockClient, "test-session");

      await expect(
        orchestrator.run({
          context: "Test",
          request: "Test",
          initial_questions: undefined as any,
        }),
      ).rejects.toThrow("At least one initial question is required");
    });
  });

  describe("multi-question batching", () => {
    it("should handle probe returning multiple questions at once", async () => {
      let probeCount = 0;
      const mockClient = {
        session: {
          create: mock(async () => ({ data: { id: "child-session-123" } })),
          delete: mock(async () => ({})),
          prompt: mock(async () => {
            probeCount++;
            if (probeCount === 1) {
              // First probe - return multiple questions
              return {
                data: {
                  parts: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        done: false,
                        reason: "Need multiple pieces of info",
                        questions: [
                          {
                            type: "ask_text",
                            config: { question: "First batch Q1?" },
                          },
                          {
                            type: "confirm",
                            config: { question: "First batch Q2?" },
                          },
                        ],
                      }),
                    },
                  ],
                },
              };
            }
            if (probeCount === 2) {
              // Second probe (after answering batch) - done
              return {
                data: {
                  parts: [
                    {
                      type: "text",
                      text: JSON.stringify({ done: true, reason: "Complete" }),
                    },
                  ],
                },
              };
            }
            // Summary call
            return {
              data: {
                parts: [{ type: "text", text: "## Multi-Q Summary" }],
              },
            };
          }),
        },
      } as any;

      orchestrator = new BrainstormOrchestrator(sessionManager, mockClient, "test-session");

      const orchestratorPromise = orchestrator.run({
        context: "Test",
        request: "Test",
        initial_questions: [{ type: "confirm", config: { question: "Start?" } }],
      });

      // Answer loop - keep answering any pending questions
      let stopAnswerLoop = false;
      const answerLoop = async () => {
        while (!stopAnswerLoop) {
          await new Promise((r) => setTimeout(r, 50));
          const questions = sessionManager.listQuestions();
          const pendingQuestions = questions.questions.filter((q) => q.status === "pending");
          for (const q of pendingQuestions) {
            const sessions = sessionManager["sessions"];
            for (const [sid, session] of sessions) {
              const question = session.questions.get(q.id);
              if (question && question.status === "pending") {
                const answer = q.type === "ask_text" ? { text: "Answer" } : { choice: "yes" };
                sessionManager.handleWsMessage(sid, { type: "response", id: q.id, answer });
              }
            }
          }
        }
      };

      answerLoop();

      try {
        const result = await Promise.race([
          orchestratorPromise,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Orchestrator timeout")), 5000)),
        ]);

        // Should have 2 answers: initial + first from batch (probe said done after that)
        expect(result.answers.length).toBe(2);
        expect(result.summary).toContain("Multi-Q Summary");
        // Verify prompt was called 3 times: probe after Q1, probe after Q2, summary
        expect(probeCount).toBe(3);
      } finally {
        stopAnswerLoop = true;
        await new Promise((r) => setTimeout(r, 100));
      }
    });
  });

  describe("session creation", () => {
    it("should create a session with initial questions", async () => {
      // This test verifies that the orchestrator creates a session with initial questions
      // and that the session can be completed successfully
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
                  parts: [{ type: "text", text: '{"done": true, "reason": "Complete"}' }],
                },
              };
            }
            // Second call is summary
            return {
              data: {
                parts: [{ type: "text", text: "## Summary\nTest summary" }],
              },
            };
          }),
        },
      } as any;

      orchestrator = new BrainstormOrchestrator(sessionManager, mockClient, "test-session");

      // Start the orchestrator
      const promise = orchestrator.run({
        context: "Test",
        request: "Test",
        initial_questions: [{ type: "confirm", config: { question: "Test?" } }],
      });

      // Wait for session to be created
      await new Promise((r) => setTimeout(r, 100));

      // Verify questions were created
      const questions = sessionManager.listQuestions();
      expect(questions.questions.length).toBe(1);
      expect(questions.questions[0].type).toBe("confirm");
      expect(questions.questions[0].status).toBe("pending");

      // Answer the question so the promise can complete
      answerAllPendingQuestions({ choice: "yes" });
      const result = await promise;

      expect(result.answers.length).toBe(1);
      expect(result.summary).toContain("Summary");
    });
  });
});
