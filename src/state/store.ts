// src/state/store.ts
import { createStatePersistence } from "./persistence";
import type { BrainstormState, Branch, BranchQuestion, CreateBranchInput } from "./types";

export interface StateStore {
  createSession: (sessionId: string, request: string, branches: CreateBranchInput[]) => Promise<BrainstormState>;
  getSession: (sessionId: string) => Promise<BrainstormState | null>;
  setBrowserSessionId: (sessionId: string, browserSessionId: string) => Promise<void>;
  addQuestionToBranch: (sessionId: string, branchId: string, question: BranchQuestion) => Promise<BranchQuestion>;
  recordAnswer: (sessionId: string, questionId: string, answer: unknown) => Promise<void>;
  completeBranch: (sessionId: string, branchId: string, finding: string) => Promise<void>;
  getNextExploringBranch: (sessionId: string) => Promise<Branch | null>;
  isSessionComplete: (sessionId: string) => Promise<boolean>;
  deleteSession: (sessionId: string) => Promise<void>;
}

export function createStateStore(baseDir = ".octto"): StateStore {
  const persistence = createStatePersistence(baseDir);

  return {
    async createSession(
      sessionId: string,
      request: string,
      branchInputs: CreateBranchInput[],
    ): Promise<BrainstormState> {
      const branches: Record<string, Branch> = {};
      const order: string[] = [];

      for (const input of branchInputs) {
        branches[input.id] = {
          id: input.id,
          scope: input.scope,
          status: "exploring",
          questions: [],
          finding: null,
        };
        order.push(input.id);
      }

      const state: BrainstormState = {
        session_id: sessionId,
        browser_session_id: null,
        request,
        created_at: Date.now(),
        updated_at: Date.now(),
        branches,
        branch_order: order,
      };

      await persistence.save(state);
      return state;
    },

    async getSession(sessionId: string): Promise<BrainstormState | null> {
      return persistence.load(sessionId);
    },

    async setBrowserSessionId(sessionId: string, browserSessionId: string): Promise<void> {
      const state = await persistence.load(sessionId);
      if (!state) throw new Error(`Session not found: ${sessionId}`);
      state.browser_session_id = browserSessionId;
      await persistence.save(state);
    },

    async addQuestionToBranch(sessionId: string, branchId: string, question: BranchQuestion): Promise<BranchQuestion> {
      const state = await persistence.load(sessionId);
      if (!state) throw new Error(`Session not found: ${sessionId}`);
      if (!state.branches[branchId]) throw new Error(`Branch not found: ${branchId}`);

      state.branches[branchId].questions.push(question);
      await persistence.save(state);
      return question;
    },

    async recordAnswer(sessionId: string, questionId: string, answer: unknown): Promise<void> {
      const state = await persistence.load(sessionId);
      if (!state) throw new Error(`Session not found: ${sessionId}`);

      for (const branch of Object.values(state.branches)) {
        const question = branch.questions.find((q) => q.id === questionId);
        if (question) {
          question.answer = answer;
          question.answeredAt = Date.now();
          await persistence.save(state);
          return;
        }
      }
      throw new Error(`Question not found: ${questionId}`);
    },

    async completeBranch(sessionId: string, branchId: string, finding: string): Promise<void> {
      const state = await persistence.load(sessionId);
      if (!state) throw new Error(`Session not found: ${sessionId}`);
      if (!state.branches[branchId]) throw new Error(`Branch not found: ${branchId}`);

      state.branches[branchId].status = "done";
      state.branches[branchId].finding = finding;
      await persistence.save(state);
    },

    async getNextExploringBranch(sessionId: string): Promise<Branch | null> {
      const state = await persistence.load(sessionId);
      if (!state) return null;

      for (const branchId of state.branch_order) {
        const branch = state.branches[branchId];
        if (branch.status === "exploring") {
          return branch;
        }
      }
      return null;
    },

    async isSessionComplete(sessionId: string): Promise<boolean> {
      const state = await persistence.load(sessionId);
      if (!state) return false;

      return Object.values(state.branches).every((b) => b.status === "done");
    },

    async deleteSession(sessionId: string): Promise<void> {
      await persistence.delete(sessionId);
    },
  };
}
