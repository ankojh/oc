// One directory per integration under DATA_DIR/integrations/<id>/:
//   integration.json   the record (atomic temp + fsync + rename)
//   review-input.json  the exact ReviewInput snapshot sent for review (write-once)
//   review-result.json the reviewer's report, audit, warnings and metadata
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";

export type IntegrationStatus =
  | "researching"
  | "research_ready"
  | "generating"
  | "needs_reconciliation"
  | "reviewing"
  | "complete"
  | "insufficient_evidence"
  | "unverifiable"
  | "failed";

export type Stage = "research" | "generation" | "handoff" | "review";

export const TERMINAL: ReadonlySet<IntegrationStatus> = new Set(["complete", "insufficient_evidence", "unverifiable", "failed"]);

export interface StageError {
  stage: Stage;
  /** Upstream code preserved verbatim (e.g. OPUS_AMBIGUOUS_SUBMIT, reviewer_failed). */
  code: string;
  message: string;
  action: string | null;
  at: string;
}

export interface IntegrationRecord {
  integrationId: string;
  mode: "live" | "fixture";
  input: { videoUrl: string; creatorGoal: string | null };
  status: IntegrationStatus;
  failedStage: Stage | null;
  error: StageError | null;
  research: {
    runId: string | null;
    /** Last observed audience-research overall status. */
    upstreamStatus: string | null;
    progress: { at: string; step: string; message: string }[];
    /** The ResearchBrief, saved once research has finished. */
    brief: unknown;
  };
  generation: {
    /** Set (and saved) before the Generate request is sent; one per user action. */
    requestedAt: string | null;
    requestCount: number;
    forceNewProjectRequestedAt: string | null;
    upstreamStatus: string | null;
    projectId: string | null;
    stage: string | null;
    /** Provider submissions recorded by audience-research for this run. */
    providerSubmitAttempts: number;
    consumesCredits: boolean | null;
    creditNotice: string | null;
    reconciliation: unknown;
    events: { at: string; step: string; message: string }[];
    completedObservedAt: string | null;
  };
  handoff: {
    hash: string | null;
    savedAt: string | null;
    warnings: { code: string; path: string; message: string }[];
  };
  review: {
    backend: "fixture" | "codex" | null;
    reviewId: string | null;
    /** "submitting" is saved before POST; a lost response is retried with the identical snapshot. */
    submitState: "idle" | "submitting" | "submitted";
    submitAttempts: number;
    lastSubmitAt: string | null;
    reused: boolean | null;
    upstreamStatus: string | null;
    reportStatus: "complete" | "insufficient_evidence" | "unverifiable" | null;
    progress: { step: string; at: string }[];
    history: { reviewId: string; outcome: string; at: string }[];
  };
  events: { at: string; stage: Stage | "coordinator"; message: string }[];
  createdAt: string;
  updatedAt: string;
}

function atomicWrite(file: string, data: string): void {
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

export class IntegrationStore {
  readonly dir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, "integrations");
    mkdirSync(this.dir, { recursive: true });
  }

  private folder(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("invalid integration id");
    return join(this.dir, id);
  }

  save(rec: IntegrationRecord): void {
    rec.updatedAt = new Date().toISOString();
    mkdirSync(this.folder(rec.integrationId), { recursive: true });
    atomicWrite(join(this.folder(rec.integrationId), "integration.json"), JSON.stringify(rec, null, 2));
  }

  load(id: string): IntegrationRecord | null {
    let file: string;
    try {
      file = join(this.folder(id), "integration.json");
    } catch {
      return null;
    }
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as IntegrationRecord) : null;
  }

  list(): IntegrationRecord[] {
    return readdirSync(this.dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => this.load(d.name))
      .filter((r): r is IntegrationRecord => r !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Saves the ReviewInput snapshot exactly once. A second call with different
   * content is refused: the snapshot that was (or may have been) sent for
   * review must never change underneath its review.
   */
  saveSnapshot(id: string, input: unknown, hash: string, hashOf: (v: unknown) => string): void {
    const file = join(this.folder(id), "review-input.json");
    if (existsSync(file)) {
      const existing = JSON.parse(readFileSync(file, "utf8"));
      if (hashOf(existing) !== hash) throw new Error(`review-input snapshot for ${id} already exists with different content`);
      return;
    }
    mkdirSync(this.folder(id), { recursive: true });
    atomicWrite(file, JSON.stringify(input, null, 2));
  }

  loadSnapshot(id: string): unknown | null {
    const file = join(this.folder(id), "review-input.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  }

  saveResult(id: string, result: unknown): void {
    atomicWrite(join(this.folder(id), "review-result.json"), JSON.stringify(result, null, 2));
  }

  loadResult(id: string): any | null {
    const file = join(this.folder(id), "review-result.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  }
}
