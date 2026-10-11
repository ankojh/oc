import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReviewerBackend } from "../src/agent/backends.ts";
import type { Judgment } from "../src/agent/judgment.ts";
import { PROMPT_VERSION } from "../src/agent/instructions.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadInput(name: string): any {
  return JSON.parse(readFileSync(join(ROOT, "fixtures", "inputs", `${name}.json`), "utf8"));
}
export function loadExpected(name: string): any {
  return JSON.parse(readFileSync(join(ROOT, "fixtures", "expected", `${name}.json`), "utf8"));
}
export function loadRecorded(runId: string): Judgment {
  return JSON.parse(readFileSync(join(ROOT, "fixtures", "responses", `${runId}.json`), "utf8")).judgment;
}
export const clone = <T>(v: T): T => structuredClone(v);

/** Backend returning a scripted judgment — used to simulate sloppy or compromised reviewer output. */
export function stubBackend(judgment: unknown, calls: { n: number } = { n: 0 }): ReviewerBackend {
  return {
    kind: "fixture",
    versionKey: `stub:${PROMPT_VERSION}`,
    async judge() {
      calls.n++;
      return {
        output: judgment,
        meta: { backend: "fixture", model: null, reasoningEffort: null, promptVersion: PROMPT_VERSION, threadId: null, usage: null, durationMs: 0, toolActivity: [], fixtureResponse: "stub" },
      };
    },
  };
}

export const emptyJudgment = (): Judgment => ({ questionChecks: [], matches: [], recommendations: [], unansweredQuestions: [], limitations: [] });
