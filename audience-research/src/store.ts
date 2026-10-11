// Simple local persistence: one directory per run under DATA_DIR/runs.
// Writes are atomic (temp file + fsync + rename) so a crash never leaves a
// half-written run.json — important because run.json is what prevents a paid
// OpusClip job from being submitted twice.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeSync } from "node:fs";
import path from "node:path";
import type { ResearchBrief, ReviewInput } from "./contract.js";
import type { ErrorCode } from "./errors.js";

export interface ErrorInfo {
  code: ErrorCode;
  message: string;
  action: string | null;
}

export interface ProgressEntry {
  at: string;
  step: string;
  message: string;
}

export type ResearchStatus = "queued" | "running" | "ready" | "insufficient_evidence" | "failed";
export type GenerationStatus = "not_started" | "submitting" | "processing" | "collecting" | "completed" | "failed" | "needs_reconciliation";

export interface GenerationState {
  status: GenerationStatus;
  transport: "mcp" | "rest" | "fixture" | null;
  /** Number of submit requests actually sent to the provider for this run. */
  submitAttempts: number;
  submitStartedAt: string | null;
  /** Token embedded in the provider project title so reconciliation can match this exact request. */
  correlationToken?: string | null;
  creditsAcknowledgedAt: string | null;
  request: { customPrompt: string; requestedQuestionIds: string[]; durationSec: [number, number]; aspectRatio: string } | null;
  sentRequest: unknown;
  projectId: string | null;
  stage: string | null;
  pollCount: number;
  lastPolledAt: string | null;
  error: (ErrorInfo & { noJobCreated: boolean }) | null;
  reconciliation: {
    checkedAt: string;
    candidates: { projectId: string; createdAt: string | null; stage: string | null; title?: string | null; correlated?: boolean }[];
    note: string;
  } | null;
  completedAt: string | null;
  events: ProgressEntry[];
}

export interface RunRecord {
  runId: string;
  mode: "live" | "fixture";
  createdAt: string;
  updatedAt: string;
  input: { videoUrl: string; videoId: string; creatorGoal: string | null };
  research: {
    status: ResearchStatus;
    progress: ProgressEntry[];
    error: ErrorInfo | null;
    startedAt: string | null;
    finishedAt: string | null;
    sourceVideoDurationMs: number | null;
  };
  brief: ResearchBrief | null;
  generation: GenerationState;
}

export function emptyGeneration(): GenerationState {
  return {
    status: "not_started",
    transport: null,
    submitAttempts: 0,
    submitStartedAt: null,
    correlationToken: null,
    creditsAcknowledgedAt: null,
    request: null,
    sentRequest: null,
    projectId: null,
    stage: null,
    pollCount: 0,
    lastPolledAt: null,
    error: null,
    reconciliation: null,
    completedAt: null,
    events: [],
  };
}

function atomicWrite(file: string, data: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

export class RunStore {
  readonly runsDir: string;

  constructor(dataDir: string) {
    this.runsDir = path.join(dataDir, "runs");
    mkdirSync(this.runsDir, { recursive: true });
  }

  private dir(runId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error("invalid runId");
    return path.join(this.runsDir, runId);
  }

  save(run: RunRecord): void {
    run.updatedAt = new Date().toISOString();
    atomicWrite(path.join(this.dir(run.runId), "run.json"), JSON.stringify(run, null, 2));
  }

  load(runId: string): RunRecord | null {
    let file: string;
    try {
      file = path.join(this.dir(runId), "run.json");
    } catch {
      return null;
    }
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as RunRecord;
  }

  list(): RunRecord[] {
    return readdirSync(this.runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => this.load(d.name))
      .filter((r): r is RunRecord => r !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  writeJson(runId: string, name: string, value: unknown): void {
    atomicWrite(path.join(this.dir(runId), name), JSON.stringify(value, null, 2));
  }

  readJson<T>(runId: string, name: string): T | null {
    const file = path.join(this.dir(runId), name);
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null;
  }

  /** Raw provider responses, kept separately from the normalized contract for debugging. */
  saveProviderRaw(runId: string, op: string, value: unknown): void {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    this.writeJson(runId, path.join("provider", `${ts}-${op}.json`), value);
  }

  listProviderRaw(runId: string): string[] {
    const dir = path.join(this.dir(runId), "provider");
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  }

  saveReviewInput(runId: string, r: ReviewInput): void {
    this.writeJson(runId, "review-input.json", r);
  }

  loadReviewInput(runId: string): ReviewInput | null {
    return this.readJson<ReviewInput>(runId, "review-input.json");
  }
}
