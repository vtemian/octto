// src/state/store.ts
import type { Answer } from "@/session";

import { createStatePersistence } from "./persistence";
import {
  BRANCH_STATUSES,
  type BrainstormState,
  type Branch,
  type BranchQuestion,
  type CreateBranchInput,
} from "./types";

export interface StateStore {
  createSession: (sessionId: string, request: string, branches: CreateBranchInput[]) => Promise<BrainstormState>;
  getSession: (sessionId: string) => Promise<BrainstormState | null>;
  setBrowserSessionId: (sessionId: string, browserSessionId: string) => Promise<void>;
  addQuestionToBranch: (sessionId: string, branchId: string, question: BranchQuestion) => Promise<BranchQuestion>;
  recordAnswer: (sessionId: string, questionId: string, answer: Answer) => Promise<void>;
  completeBranch: (sessionId: string, branchId: string, finding: string) => Promise<void>;
  getNextExploringBranch: (sessionId: string) => Promise<Branch | null>;
  isSessionComplete: (sessionId: string) => Promise<boolean>;
  deleteSession: (sessionId: string) => Promise<void>;
}

type Persistence = ReturnType<typeof createStatePersistence>;
type SessionLock = <T>(sessionId: string, operation: () => Promise<T>) => Promise<T>;

function createSessionLock(): SessionLock {
  const operationQueues = new Map<string, Promise<void>>();

  return <T>(sessionId: string, operation: () => Promise<T>): Promise<T> => {
    const currentQueue = operationQueues.get(sessionId) ?? Promise.resolve();
    const newOperation = currentQueue.then(operation, operation);
    operationQueues.set(
      sessionId,
      newOperation.then(
        () => {},
        () => {},
      ),
    );
    return newOperation;
  };
}

async function loadSessionOrThrow(persistence: Persistence, sessionId: string): Promise<BrainstormState> {
  const state = await persistence.load(sessionId);
  if (!state) throw new Error(`Session not found: ${sessionId}`);
  return state;
}

async function createSession(
  persistence: Persistence,
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
      status: BRANCH_STATUSES.EXPLORING,
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
}

async function setBrowserSessionId(
  persistence: Persistence,
  lock: SessionLock,
  sessionId: string,
  browserSessionId: string,
): Promise<void> {
  return lock(sessionId, async () => {
    const state = await loadSessionOrThrow(persistence, sessionId);
    state.browser_session_id = browserSessionId;
    await persistence.save(state);
  });
}

async function addQuestionToBranch(
  persistence: Persistence,
  lock: SessionLock,
  sessionId: string,
  branchId: string,
  question: BranchQuestion,
): Promise<BranchQuestion> {
  return lock(sessionId, async () => {
    const state = await loadSessionOrThrow(persistence, sessionId);
    if (!state.branches[branchId]) throw new Error(`Branch not found: ${branchId}`);
    state.branches[branchId].questions.push(question);
    await persistence.save(state);
    return question;
  });
}

async function recordAnswer(
  persistence: Persistence,
  lock: SessionLock,
  sessionId: string,
  questionId: string,
  answer: Answer,
): Promise<void> {
  return lock(sessionId, async () => {
    const state = await loadSessionOrThrow(persistence, sessionId);
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
  });
}

async function completeBranch(
  persistence: Persistence,
  lock: SessionLock,
  sessionId: string,
  branchId: string,
  finding: string,
): Promise<void> {
  return lock(sessionId, async () => {
    const state = await loadSessionOrThrow(persistence, sessionId);
    if (!state.branches[branchId]) throw new Error(`Branch not found: ${branchId}`);
    state.branches[branchId].status = BRANCH_STATUSES.DONE;
    state.branches[branchId].finding = finding;
    await persistence.save(state);
  });
}

async function getNextExploringBranch(persistence: Persistence, sessionId: string): Promise<Branch | null> {
  const state = await persistence.load(sessionId);
  if (!state) return null;

  for (const branchId of state.branch_order) {
    const branch = state.branches[branchId];
    if (branch.status === BRANCH_STATUSES.EXPLORING) {
      return branch;
    }
  }
  return null;
}

async function isSessionComplete(persistence: Persistence, sessionId: string): Promise<boolean> {
  const state = await persistence.load(sessionId);
  if (!state) return false;
  return Object.values(state.branches).every((b) => b.status === BRANCH_STATUSES.DONE);
}

export function createStateStore(baseDir = ".octto"): StateStore {
  const persistence = createStatePersistence(baseDir);
  const lock = createSessionLock();

  return {
    createSession: (sid, req, branches) => createSession(persistence, sid, req, branches),
    getSession: (sid) => persistence.load(sid),
    setBrowserSessionId: (sid, bsid) => setBrowserSessionId(persistence, lock, sid, bsid),
    addQuestionToBranch: (sid, bid, q) => addQuestionToBranch(persistence, lock, sid, bid, q),
    recordAnswer: (sid, qid, ans) => recordAnswer(persistence, lock, sid, qid, ans),
    completeBranch: (sid, bid, finding) => completeBranch(persistence, lock, sid, bid, finding),
    getNextExploringBranch: (sid) => getNextExploringBranch(persistence, sid),
    isSessionComplete: (sid) => isSessionComplete(persistence, sid),
    deleteSession: (sid) => persistence.delete(sid),
  };
}
