// src/state/manager.ts
import { StatePersistence } from "./persistence";
import type { BrainstormState, Branch, BranchQuestion, CreateBranchInput } from "./types";

export class StateManager {
  private persistence: StatePersistence;

  constructor(baseDir: string = ".brainstorm") {
    this.persistence = new StatePersistence(baseDir);
  }

  async createSession(
    sessionId: string,
    request: string,
    branches: CreateBranchInput[],
  ): Promise<BrainstormState> {
    console.log(`[StateManager.createSession] Creating session ${sessionId} with ${branches.length} branches`);
    const branchMap: Record<string, Branch> = {};
    const branchOrder: string[] = [];

    for (const b of branches) {
      branchMap[b.id] = {
        id: b.id,
        scope: b.scope,
        status: "exploring",
        questions: [],
        finding: null,
      };
      branchOrder.push(b.id);
    }

    const state: BrainstormState = {
      session_id: sessionId,
      browser_session_id: null,
      request,
      created_at: Date.now(),
      updated_at: Date.now(),
      branches: branchMap,
      branch_order: branchOrder,
    };

    await this.persistence.save(state);
    return state;
  }

  async getSession(sessionId: string): Promise<BrainstormState | null> {
    return this.persistence.load(sessionId);
  }

  async setBrowserSessionId(sessionId: string, browserSessionId: string): Promise<void> {
    const state = await this.persistence.load(sessionId);
    if (!state) throw new Error(`Session not found: ${sessionId}`);
    state.browser_session_id = browserSessionId;
    await this.persistence.save(state);
  }

  async addQuestionToBranch(
    sessionId: string,
    branchId: string,
    question: BranchQuestion,
  ): Promise<BranchQuestion> {
    const state = await this.persistence.load(sessionId);
    if (!state) throw new Error(`Session not found: ${sessionId}`);
    if (!state.branches[branchId]) throw new Error(`Branch not found: ${branchId}`);

    state.branches[branchId].questions.push(question);
    await this.persistence.save(state);
    return question;
  }

  async recordAnswer(sessionId: string, questionId: string, answer: unknown): Promise<void> {
    console.log(`[StateManager.recordAnswer] Recording answer for question ${questionId} in session ${sessionId}`);
    const state = await this.persistence.load(sessionId);
    if (!state) throw new Error(`Session not found: ${sessionId}`);

    for (const branch of Object.values(state.branches)) {
      const question = branch.questions.find((q) => q.id === questionId);
      if (question) {
        question.answer = answer;
        question.answeredAt = Date.now();
        await this.persistence.save(state);
        return;
      }
    }
    throw new Error(`Question not found: ${questionId}`);
  }

  async completeBranch(sessionId: string, branchId: string, finding: string): Promise<void> {
    const state = await this.persistence.load(sessionId);
    if (!state) throw new Error(`Session not found: ${sessionId}`);
    if (!state.branches[branchId]) throw new Error(`Branch not found: ${branchId}`);

    state.branches[branchId].status = "done";
    state.branches[branchId].finding = finding;
    await this.persistence.save(state);
  }

  async getNextExploringBranch(sessionId: string): Promise<Branch | null> {
    const state = await this.persistence.load(sessionId);
    if (!state) return null;

    for (const branchId of state.branch_order) {
      const branch = state.branches[branchId];
      if (branch.status === "exploring") {
        return branch;
      }
    }
    return null;
  }

  async isSessionComplete(sessionId: string): Promise<boolean> {
    const state = await this.persistence.load(sessionId);
    if (!state) return false;

    return Object.values(state.branches).every((b) => b.status === "done");
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.persistence.delete(sessionId);
  }
}
