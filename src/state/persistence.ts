// src/state/persistence.ts
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import type { BrainstormState } from "./types";

export class StatePersistence {
  private baseDir: string;

  constructor(baseDir: string = ".brainstorm") {
    this.baseDir = baseDir;
  }

  private validateSessionId(sessionId: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }
  }

  private getFilePath(sessionId: string): string {
    this.validateSessionId(sessionId);
    return join(this.baseDir, `${sessionId}.json`);
  }

  private ensureDir(): void {
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }
  }

  async save(state: BrainstormState): Promise<void> {
    console.log(`[StatePersistence.save] Saving session ${state.session_id}`);
    console.log(`[StatePersistence.save] Base dir: ${this.baseDir}, cwd: ${process.cwd()}`);
    this.ensureDir();
    const filePath = this.getFilePath(state.session_id);
    console.log(`[StatePersistence.save] File path: ${filePath}`);
    state.updated_at = Date.now();
    await Bun.write(filePath, JSON.stringify(state, null, 2));
    console.log(`[StatePersistence.save] Write complete`);
  }

  async load(sessionId: string): Promise<BrainstormState | null> {
    const filePath = this.getFilePath(sessionId);
    if (!existsSync(filePath)) {
      return null;
    }
    const content = await Bun.file(filePath).text();
    return JSON.parse(content) as BrainstormState;
  }

  async delete(sessionId: string): Promise<void> {
    const filePath = this.getFilePath(sessionId);
    if (existsSync(filePath)) {
      rmSync(filePath);
    }
  }

  async list(): Promise<string[]> {
    if (!existsSync(this.baseDir)) {
      return [];
    }
    const files = readdirSync(this.baseDir);
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(".json", ""));
  }
}
