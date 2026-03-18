import { readFile } from "node:fs/promises";
import { join } from "node:path";

import * as v from "valibot";

import { AGENTS, isAgentName } from "@/agents";

type FragmentsRecord = Record<string, string[]> | undefined;

const VALID_AGENT_NAMES = Object.values(AGENTS);
const MAX_SUGGESTION_DISTANCE = 3;

const ProjectFragmentsSchema = v.record(v.string(), v.array(v.string()));

/**
 * Format fragments array as an XML block to prepend to agent prompts.
 */
export function formatFragmentsBlock(fragments: string[] | undefined): string {
  if (!fragments || fragments.length === 0) {
    return "";
  }

  const bulletPoints = fragments.map((f) => `- ${f}`).join("\n");
  return `<user-instructions>\n${bulletPoints}\n</user-instructions>\n\n`;
}

/**
 * Merge global and project fragments.
 * Global fragments come first, project fragments append.
 */
export function mergeFragments(global: FragmentsRecord, project: FragmentsRecord): Record<string, string[]> {
  const merged: Record<string, string[]> = {};

  for (const [agent, frags] of Object.entries(global ?? {})) {
    merged[agent] = [...frags];
  }

  for (const [agent, frags] of Object.entries(project ?? {})) {
    merged[agent] = [...(merged[agent] ?? []), ...frags];
  }

  return merged;
}

export async function loadProjectFragments(projectDir: string): Promise<Record<string, string[]> | undefined> {
  const fragmentsPath = join(projectDir, ".octto", "fragments.json");

  try {
    const content = await readFile(fragmentsPath, "utf-8");
    const parsed: unknown = JSON.parse(content);

    const fragmentsValidation = v.safeParse(ProjectFragmentsSchema, parsed);
    if (!fragmentsValidation.success) {
      console.warn(`[octto] Invalid fragments.json schema in ${fragmentsPath}`);
      return undefined;
    }

    return fragmentsValidation.output;
  } catch (_error: unknown) {
    /* missing fragments.json is expected for projects without custom fragments */
    return undefined;
  }
}

/* Used for suggesting similar agent names on typos */
/* eslint-disable max-depth, sonarjs/cognitive-complexity */
export function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
      }
    }
  }

  return matrix[b.length][a.length];
}
/* eslint-enable max-depth, sonarjs/cognitive-complexity */

function findClosestAgent(name: string): string | undefined {
  let closest: string | undefined;
  let minDistance = Infinity;

  for (const validName of VALID_AGENT_NAMES) {
    const distance = levenshteinDistance(name, validName);
    if (distance < minDistance && distance <= MAX_SUGGESTION_DISTANCE) {
      minDistance = distance;
      closest = validName;
    }
  }

  return closest;
}

export function warnUnknownAgents(fragments: Record<string, string[]> | undefined): void {
  if (!fragments) return;

  for (const agentName of Object.keys(fragments)) {
    if (isAgentName(agentName)) {
      continue;
    }

    const closest = findClosestAgent(agentName);
    let message = `[octto] Unknown agent "${agentName}" in fragments config.`;
    if (closest) {
      message += ` Did you mean "${closest}"?`;
    }
    message += ` Valid agents: ${VALID_AGENT_NAMES.join(", ")}`;

    console.warn(message);
  }
}

export interface FragmentInjectorContext {
  projectDir: string;
}

export async function createFragmentInjector(
  ctx: FragmentInjectorContext,
  globalFragments: FragmentsRecord,
): Promise<Record<string, string[]>> {
  const projectFragments = await loadProjectFragments(ctx.projectDir);
  const merged = mergeFragments(globalFragments, projectFragments);

  warnUnknownAgents(globalFragments);
  warnUnknownAgents(projectFragments);

  return merged;
}

export function getAgentSystemPromptPrefix(fragments: Record<string, string[]>, agentName: string): string {
  return formatFragmentsBlock(fragments[agentName]);
}
