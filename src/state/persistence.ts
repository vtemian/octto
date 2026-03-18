import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import * as v from "valibot";

import type { Answer, BaseConfig, QuestionType } from "@/session";
import { QUESTION_TYPES } from "@/session";

import type { BrainstormState } from "./types";

const BranchQuestionSchema = v.object({
  id: v.string(),
  type: v.pipe(
    v.string(),
    v.transform((input): QuestionType => {
      if (QUESTION_TYPES.includes(input as QuestionType)) return input as QuestionType;
      throw new Error(`Invalid question type: ${input}`);
    }),
  ),
  text: v.string(),
  config: v.pipe(
    v.looseObject({}),
    v.transform((input): BaseConfig => input),
  ),
  answer: v.optional(
    v.pipe(
      v.unknown(),
      v.transform((input): Answer => input as Answer),
    ),
  ),
  answeredAt: v.optional(v.number()),
});

const BranchSchema = v.object({
  id: v.string(),
  scope: v.string(),
  status: v.union([v.literal("exploring"), v.literal("done")]),
  questions: v.array(BranchQuestionSchema),
  finding: v.nullable(v.string()),
});

const BrainstormStateSchema = v.object({
  session_id: v.string(),
  browser_session_id: v.nullable(v.string()),
  request: v.string(),
  created_at: v.number(),
  updated_at: v.number(),
  branches: v.record(v.string(), BranchSchema),
  branch_order: v.array(v.string()),
});

export interface StatePersistence {
  save: (state: BrainstormState) => Promise<void>;
  load: (sessionId: string) => Promise<BrainstormState | null>;
  delete: (sessionId: string) => Promise<void>;
  list: () => Promise<string[]>;
}

function validateSessionId(sessionId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
}

function getFilePath(baseDir: string, sessionId: string): string {
  validateSessionId(sessionId);
  return join(baseDir, `${sessionId}.json`);
}

function ensureDir(baseDir: string): void {
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true });
  }
}

function parseBrainstormState(content: string, sessionId: string): BrainstormState | null {
  const raw: unknown = JSON.parse(content);
  const parseResult = v.safeParse(BrainstormStateSchema, raw);
  if (!parseResult.success) {
    console.error(`[octto] Invalid state file for session ${sessionId}:`, parseResult.issues);
    return null;
  }
  return parseResult.output;
}

export function createStatePersistence(baseDir = ".brainstorm"): StatePersistence {
  return {
    async save(state: BrainstormState): Promise<void> {
      ensureDir(baseDir);
      const filePath = getFilePath(baseDir, state.session_id);
      state.updated_at = Date.now();
      await Bun.write(filePath, JSON.stringify(state, null, 2));
    },

    async load(sessionId: string): Promise<BrainstormState | null> {
      const filePath = getFilePath(baseDir, sessionId);
      if (!existsSync(filePath)) {
        return null;
      }
      const content = await Bun.file(filePath).text();
      return parseBrainstormState(content, sessionId);
    },

    async delete(sessionId: string): Promise<void> {
      const filePath = getFilePath(baseDir, sessionId);
      if (existsSync(filePath)) {
        rmSync(filePath);
      }
    },

    async list(): Promise<string[]> {
      if (!existsSync(baseDir)) {
        return [];
      }
      const files = readdirSync(baseDir);
      return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""));
    },
  };
}
