// The coordinator: ordinary application code (not an agent) that moves one
// creator request through research -> Generate -> handoff -> review.
//
// Guarantees:
// - Work is advanced by a server-side loop, never by the browser. Reading an
//   integration (refresh) only observes; it cannot start or repeat work.
// - Every ID is persisted before the next step starts, and every step resumes
//   from the record after a coordinator restart.
// - OpusClip submission belongs to audience-research. The coordinator calls its
//   Generate endpoint once per explicit user action, never sets forceNewProject
//   on its own, and never retries Generate automatically.
// - Review submission is a persisted single-flight transition: `submitting` is
//   saved before the POST, and a lost response is retried with the identical
//   snapshot so the review service's input-hash cache returns the same review.
import { randomUUID } from "node:crypto";
import { checkHandoff, describeContractErrors, handoffHash } from "./contract.ts";
import { type ResearchClient, type ResearchRunView, type ReviewClient, ServiceError } from "./services.ts";
import { type IntegrationRecord, type IntegrationStatus, type IntegrationStore, type Stage, type StageError, TERMINAL } from "./store.ts";

export class CoordinatorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
    readonly action: string | null = null,
  ) {
    super(message);
  }
}

export interface CoordinatorOptions {
  store: IntegrationStore;
  research: ResearchClient;
  review: ReviewClient;
  /** Interval of the background advance loop. */
  tickMs?: number;
  /** Review POSTs without any response before giving up (each retry reuses the same snapshot). */
  maxReviewSubmitAttempts?: number;
}

const MAX_EVENTS = 200;
const MAX_PROGRESS = 60;

function stageError(stage: Stage, err: unknown): StageError {
  const at = new Date().toISOString();
  if (err instanceof ServiceError) return { stage, code: err.code, message: err.message, action: err.action, at };
  if (err instanceof CoordinatorError) return { stage, code: err.code, message: err.message, action: err.action, at };
  return { stage, code: "INTERNAL", message: err instanceof Error ? err.message : String(err), action: null, at };
}

export class Coordinator {
  private chains = new Map<string, Promise<unknown>>();
  private timer: NodeJS.Timeout | null = null;
  private readonly tickMs: number;
  private readonly maxReviewSubmitAttempts: number;

  constructor(private readonly opts: CoordinatorOptions) {
    this.tickMs = opts.tickMs ?? 1000;
    this.maxReviewSubmitAttempts = opts.maxReviewSubmitAttempts ?? 5;
  }

  // ------------------------------------------------------------ lifecycle

  /** Resumes every unfinished integration and keeps advancing them. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tickAll(), this.tickMs);
    void this.tickAll();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.chains.values()]);
  }

  /** Per-integration mutual exclusion: actions queue, background ticks skip when busy. */
  private exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(id) ?? Promise.resolve();
    const p = prev.catch(() => {}).then(fn);
    const tail = p.catch(() => {});
    this.chains.set(id, tail);
    void tail.then(() => {
      if (this.chains.get(id) === tail) this.chains.delete(id);
    });
    return p;
  }

  async tickAll(): Promise<void> {
    const active = this.opts.store.list().filter((r) => !TERMINAL.has(r.status));
    await Promise.allSettled(active.filter((r) => !this.chains.has(r.integrationId)).map((r) => this.tick(r.integrationId)));
  }

  // --------------------------------------------------------------- reads

  get(id: string): IntegrationRecord {
    const rec = this.opts.store.load(id);
    if (!rec) throw new CoordinatorError("NOT_FOUND", `Integration ${id} not found.`, 404);
    return rec;
  }

  list(): IntegrationRecord[] {
    return this.opts.store.list();
  }

  // ------------------------------------------------------------- helpers

  private save(rec: IntegrationRecord): void {
    if (rec.events.length > MAX_EVENTS) rec.events = rec.events.slice(-MAX_EVENTS);
    this.opts.store.save(rec);
  }

  private event(rec: IntegrationRecord, stage: Stage | "coordinator", message: string): void {
    rec.events.push({ at: new Date().toISOString(), stage, message });
  }

  private setStatus(rec: IntegrationRecord, status: IntegrationStatus, message?: string): void {
    if (rec.status === status) return;
    if (rec.status === "failed") {
      rec.failedStage = null;
      rec.error = null;
    }
    rec.status = status;
    this.event(rec, "coordinator", message ?? `Status: ${status}`);
  }

  private fail(rec: IntegrationRecord, stage: Stage, err: unknown): void {
    rec.error = stageError(stage, err);
    rec.failedStage = stage;
    rec.status = "failed";
    this.event(rec, stage, `Failed (${rec.error.code}): ${rec.error.message}`);
  }

  // -------------------------------------------------------------- create

  async create(body: { videoUrl?: unknown; creatorGoal?: unknown; mode?: unknown }): Promise<IntegrationRecord> {
    if (body.mode !== "live" && body.mode !== "fixture") throw new CoordinatorError("INVALID_INPUT", 'Choose a mode: "fixture" or "live".');
    if (typeof body.videoUrl !== "string" || !body.videoUrl.trim()) throw new CoordinatorError("INVALID_INPUT", "A public YouTube video URL is required.");
    if (body.creatorGoal !== undefined && body.creatorGoal !== null && typeof body.creatorGoal !== "string") throw new CoordinatorError("INVALID_INPUT", "creatorGoal must be text.");
    const creatorGoal = typeof body.creatorGoal === "string" && body.creatorGoal.trim() ? body.creatorGoal.trim() : null;
    const videoUrl = body.videoUrl.trim();
    // Research is free and creates the first ID; the record is saved as soon as it exists.
    const { runId } = await this.opts.research.start({ videoUrl, creatorGoal, mode: body.mode });
    const now = new Date().toISOString();
    const rec: IntegrationRecord = {
      integrationId: `int_${now.slice(0, 10).replace(/-/g, "")}_${randomUUID().slice(0, 8)}`,
      mode: body.mode,
      input: { videoUrl, creatorGoal },
      status: "researching",
      failedStage: null,
      error: null,
      research: { runId, upstreamStatus: "researching", progress: [], brief: null },
      generation: {
        requestedAt: null,
        requestCount: 0,
        forceNewProjectRequestedAt: null,
        upstreamStatus: null,
        projectId: null,
        stage: null,
        providerSubmitAttempts: 0,
        consumesCredits: null,
        creditNotice: null,
        reconciliation: null,
        events: [],
        completedObservedAt: null,
      },
      handoff: { hash: null, savedAt: null, warnings: [] },
      review: {
        backend: null,
        reviewId: null,
        submitState: "idle",
        submitAttempts: 0,
        lastSubmitAt: null,
        reused: null,
        upstreamStatus: null,
        reportStatus: null,
        progress: [],
        history: [],
      },
      events: [{ at: now, stage: "research", message: `Research run ${runId} started (${body.mode}).` }],
      createdAt: now,
      updatedAt: now,
    };
    this.save(rec);
    return rec;
  }

  // ------------------------------------------------------- research sync

  /** Mirrors audience-research's run into the record; maps its status to ours. */
  private applyResearch(rec: IntegrationRecord, view: ResearchRunView): void {
    rec.research.upstreamStatus = view.status;
    rec.research.progress = view.progress.slice(-MAX_PROGRESS);
    if (view.result && view.status !== "researching") rec.research.brief ??= view.result;
    const g = view.generation;
    Object.assign(rec.generation, {
      upstreamStatus: g.status,
      projectId: g.projectId,
      stage: g.stage,
      providerSubmitAttempts: g.submitAttempts,
      consumesCredits: g.consumesCredits,
      creditNotice: g.creditNotice,
      reconciliation: g.reconciliation,
      events: g.events.slice(-MAX_PROGRESS),
    });
    switch (view.status) {
      case "researching":
        return this.setStatus(rec, "researching");
      case "research_failed":
        if (rec.status !== "failed") this.fail(rec, "research", new CoordinatorError(view.error?.code ?? "RESEARCH_FAILED", view.error?.message ?? "Research failed.", 502, view.error?.action ?? null));
        return;
      case "insufficient_evidence":
        return this.setStatus(rec, "insufficient_evidence", "Research found too little audience evidence; nothing to generate.");
      case "research_ready":
        return this.setStatus(rec, "research_ready", "Research ready: review the questions, then Generate.");
      case "generating":
        return this.setStatus(rec, "generating", `Generating clips (OpusClip project ${g.projectId ?? "pending"}).`);
      case "needs_reconciliation":
        return this.setStatus(rec, "needs_reconciliation", "The OpusClip submission outcome is uncertain; reconcile before anything else.");
      case "generation_failed": {
        const e = g.error ?? view.error;
        if (rec.status !== "failed" || rec.failedStage !== "generation")
          this.fail(rec, "generation", new CoordinatorError(e?.code ?? "GENERATION_FAILED", e?.message ?? "Generation failed.", 502, e?.action ?? null));
        return;
      }
      case "completed":
        if (!rec.generation.completedObservedAt) {
          rec.generation.completedObservedAt = new Date().toISOString();
          this.event(rec, "generation", "Generation complete; the review has not started yet. Collecting the handoff.");
        }
        return;
    }
  }

  // ---------------------------------------------------------------- tick

  /** Advances one integration by at most one step. Safe to call repeatedly. */
  tick(id: string): Promise<void> {
    return this.exclusive(id, async () => {
      const rec = this.get(id);
      if (TERMINAL.has(rec.status)) return;
      try {
        if (rec.status === "reviewing") await this.advanceReview(rec);
        else await this.advanceResearch(rec);
      } catch (err) {
        // Unreachable services are observed again on the next tick. All other
        // errors must surface as a persisted failure rather than disappearing
        // inside tickAll's Promise.allSettled and stalling the job forever.
        if (err instanceof ServiceError && err.noResponse) {
          const last = rec.events.at(-1)?.message;
          const msg = `Waiting for ${err.service} service: ${err.message}`;
          if (last !== msg) this.event(rec, "coordinator", msg);
          this.save(rec);
          return;
        }
        const stage: Stage = rec.status === "reviewing" ? "review" : rec.generation.completedObservedAt ? "handoff" : rec.generation.requestedAt ? "generation" : "research";
        this.fail(rec, stage, err);
        this.save(rec);
      }
    });
  }

  private async advanceResearch(rec: IntegrationRecord): Promise<void> {
    const view = await this.opts.research.run(rec.research.runId!);
    this.applyResearch(rec, view);
    if (view.status === "completed" && rec.status !== "failed") await this.collectHandoff(rec);
    this.save(rec);
  }

  private async collectHandoff(rec: IntegrationRecord): Promise<void> {
    const id = rec.integrationId;
    let input = this.opts.store.loadSnapshot(id);
    if (!input) {
      try {
        input = await this.opts.research.reviewInput(rec.research.runId!);
      } catch (err) {
        if (err instanceof ServiceError && (err.status === 404 || err.noResponse)) return; // not ready yet
        return this.fail(rec, "handoff", err);
      }
      const check = checkHandoff(input);
      if (!check.ok)
        return this.fail(
          rec,
          "handoff",
          new CoordinatorError("CONTRACT_VIOLATION", `The ReviewInput from audience-research failed the shared contract: ${describeContractErrors(check.errors)}`, 502, "This is an integration bug; the clips are safe in OpusClip. Fix the contract mismatch, then Retry handoff."),
        );
      const r = (input as any).research;
      if (r.runId !== rec.research.runId || r.mode !== rec.mode)
        return this.fail(rec, "handoff", new CoordinatorError("CONTRACT_VIOLATION", `ReviewInput belongs to run ${r.runId} (${r.mode}), expected ${rec.research.runId} (${rec.mode}).`, 502));
      this.opts.store.saveSnapshot(id, input, check.hash, handoffHash);
      rec.handoff = { hash: check.hash, savedAt: new Date().toISOString(), warnings: check.warnings.map(({ code, path, message }) => ({ code, path, message })) };
      this.event(rec, "handoff", `Saved ReviewInput snapshot ${check.hash.slice(0, 12)} (${(input as any).clips.length} clip(s)).`);
    } else if (!rec.handoff.hash) {
      // Restarted between saving the snapshot and saving the record.
      const check = checkHandoff(input);
      if (!check.ok) return this.fail(rec, "handoff", new CoordinatorError("CONTRACT_VIOLATION", describeContractErrors(check.errors), 502));
      rec.handoff = { hash: check.hash, savedAt: new Date().toISOString(), warnings: check.warnings.map(({ code, path, message }) => ({ code, path, message })) };
    }
    rec.review.backend = rec.mode === "fixture" ? "fixture" : "codex";
    this.setStatus(rec, "reviewing", `Submitting the snapshot to the review agent (${rec.review.backend} backend).`);
  }

  private async advanceReview(rec: IntegrationRecord): Promise<void> {
    const id = rec.integrationId;
    const review = this.opts.review;
    if (!rec.review.reviewId) {
      if (rec.review.submitAttempts >= this.maxReviewSubmitAttempts) {
        this.fail(rec, "review", new CoordinatorError("SERVICE_UNREACHABLE", `The review service did not answer ${rec.review.submitAttempts} submission attempts.`, 502, "Start the review service, then Retry review."));
        return this.save(rec);
      }
      const input = this.opts.store.loadSnapshot(id);
      if (!input || handoffHash(input) !== rec.handoff.hash) {
        this.fail(rec, "handoff", new CoordinatorError("SNAPSHOT_MISMATCH", "The saved ReviewInput snapshot is missing or changed.", 500, "Retry handoff."));
        return this.save(rec);
      }
      const retryingLost = rec.review.submitState === "submitting";
      rec.review.submitState = "submitting";
      rec.review.submitAttempts++;
      rec.review.lastSubmitAt = new Date().toISOString();
      this.save(rec); // persisted before the POST
      try {
        const r = await review.submit(input, rec.review.backend!);
        rec.review.reviewId = r.reviewId;
        rec.review.reused = r.reused;
        rec.review.submitState = "submitted";
        this.event(rec, "review", `${r.reused ? "Reusing" : "Started"} review ${r.reviewId}${retryingLost ? " after a lost response" : ""} (HTTP ${r.httpStatus}).`);
      } catch (err) {
        if (err instanceof ServiceError && err.noResponse) {
          this.event(rec, "review", `No response to review submission ${rec.review.submitAttempts}; will resend the identical snapshot (the review service reuses an identical review).`);
        } else this.fail(rec, "review", err);
      }
      return this.save(rec);
    }

    let v;
    try {
      v = await review.get(rec.review.reviewId);
    } catch (err) {
      if (err instanceof ServiceError && err.status === 404) {
        this.fail(rec, "review", new CoordinatorError("REVIEW_NOT_FOUND", `The review service has no review ${rec.review.reviewId}.`, 502, "Retry review (the saved snapshot is resubmitted; clips are not regenerated)."));
        return this.save(rec);
      }
      throw err;
    }
    rec.review.upstreamStatus = v.status;
    rec.review.progress = v.progress.slice(-MAX_PROGRESS);
    if (v.status === "succeeded") {
      this.opts.store.saveResult(id, { reviewId: v.reviewId, savedAt: new Date().toISOString(), report: v.report, audit: v.audit, warnings: v.warnings, reviewer: v.reviewer });
      rec.review.reportStatus = v.report.status;
      rec.review.history.push({ reviewId: v.reviewId, outcome: `succeeded (${v.report.status})`, at: new Date().toISOString() });
      const outcome: IntegrationStatus = v.report.status === "complete" ? "complete" : v.report.status;
      this.setStatus(rec, outcome, `Review ${v.reviewId} finished: ${v.report.status}.`);
    } else if (v.status === "failed") {
      const first = v.errors[0];
      rec.review.history.push({ reviewId: v.reviewId, outcome: `failed (${first?.code ?? "unknown"})`, at: new Date().toISOString() });
      this.fail(rec, "review", new CoordinatorError(first?.code ?? "review_failed", v.errors.map((e) => `${e.path}: ${e.message}`).join("; ") || "Review failed.", 502, first?.hint ?? "Retry review."));
    }
    this.save(rec);
  }

  // ------------------------------------------------------------- actions

  /**
   * The single Generate action. Requires the user's credit acknowledgement,
   * persists the request before calling audience-research, and never retries.
   * Repeated clicks after the first return the current state.
   */
  generate(id: string, body: { confirmCredits?: unknown }): Promise<{ submitted: boolean; record: IntegrationRecord }> {
    return this.exclusive(id, async () => {
      const rec = this.get(id);
      const retryAfterRejection = rec.status === "failed" && rec.failedStage === "generation" && !rec.generation.projectId;
      if (rec.status !== "research_ready" && !retryAfterRejection) {
        if (["generating", "needs_reconciliation", "reviewing", "complete", "unverifiable"].includes(rec.status) || (rec.status === "failed" && rec.failedStage !== "research"))
          return { submitted: false, record: rec };
        throw new CoordinatorError("CONFLICT", `Generate is not available while the integration is ${rec.status}.`, 409);
      }
      if (body.confirmCredits !== true)
        throw new CoordinatorError(
          "CREDITS_NOT_CONFIRMED",
          rec.mode === "live" ? "Generating submits one OpusClip project and consumes credits. Confirm to continue." : "Confirm the Generate action.",
          400,
        );
      rec.generation.requestedAt = new Date().toISOString();
      rec.generation.requestCount++;
      this.setStatus(rec, "generating", "Generate requested by the user.");
      this.save(rec);
      try {
        const out = await this.opts.research.generate(rec.research.runId!);
        this.event(rec, "generation", out.submitted ? "audience-research submitted one OpusClip project." : "audience-research reported an existing generation; nothing new was submitted.");
        this.applyResearch(rec, out.run);
        this.save(rec);
        return { submitted: out.submitted, record: rec };
      } catch (err) {
        // Never retried here: re-read the authoritative state and report the error.
        this.event(rec, "generation", `Generate request failed: ${(err as Error).message}`);
        try {
          this.applyResearch(rec, await this.opts.research.run(rec.research.runId!));
        } catch {
          /* state stays "generating"; the background loop re-syncs */
        }
        this.save(rec);
        throw err;
      }
    });
  }

  /** Explicit, separately confirmed request for a NEW paid project after an uncertain or failed one. */
  forceNewProject(id: string, body: { confirmCredits?: unknown; confirmNewProject?: unknown }): Promise<IntegrationRecord> {
    return this.exclusive(id, async () => {
      const rec = this.get(id);
      if (!(rec.status === "needs_reconciliation" || (rec.status === "failed" && rec.failedStage === "generation")))
        throw new CoordinatorError("CONFLICT", "A new project can only be forced after an uncertain or failed generation.", 409);
      if (body.confirmCredits !== true || body.confirmNewProject !== true)
        throw new CoordinatorError("CREDITS_NOT_CONFIRMED", "Forcing a new project may pay for a second OpusClip project. Confirm both checkboxes to continue.", 400);
      rec.generation.forceNewProjectRequestedAt = new Date().toISOString();
      rec.generation.requestCount++;
      this.event(rec, "generation", "User explicitly requested a NEW paid project (forceNewProject).");
      this.save(rec);
      try {
        const out = await this.opts.research.generate(rec.research.runId!, { forceNewProject: true });
        this.applyResearch(rec, out.run);
      } finally {
        this.save(rec);
      }
      return rec;
    });
  }

  private researchAction(id: string, label: string, fn: (runId: string) => Promise<ResearchRunView>): Promise<IntegrationRecord> {
    return this.exclusive(id, async () => {
      const rec = this.get(id);
      if (!rec.research.runId || !["needs_reconciliation", "generating", "failed"].includes(rec.status) || (rec.status === "failed" && rec.failedStage !== "generation"))
        throw new CoordinatorError("CONFLICT", `${label} is only available during or after a generation problem.`, 409);
      this.event(rec, "generation", `${label} requested by the user.`);
      const view = await fn(rec.research.runId);
      if (rec.status === "failed" && view.status !== "generation_failed") {
        rec.status = "generating"; // leave failed; applyResearch maps the real state
        rec.failedStage = null;
        rec.error = null;
      }
      this.applyResearch(rec, view);
      this.save(rec);
      return rec;
    });
  }

  reconcile(id: string): Promise<IntegrationRecord> {
    return this.researchAction(id, "Reconcile", (runId) => this.opts.research.reconcile(runId));
  }

  adoptProject(id: string, projectId: unknown): Promise<IntegrationRecord> {
    if (typeof projectId !== "string" || !projectId.trim()) return Promise.reject(new CoordinatorError("INVALID_INPUT", "projectId is required."));
    return this.researchAction(id, `Adopt project ${projectId}`, (runId) => this.opts.research.adoptProject(runId, projectId.trim()));
  }

  resumePolling(id: string): Promise<IntegrationRecord> {
    return this.researchAction(id, "Resume polling", (runId) => this.opts.research.resumePolling(runId));
  }

  /** Resubmits the saved snapshot after a failed review. Clips are never regenerated. */
  retryReview(id: string): Promise<IntegrationRecord> {
    return this.exclusive(id, async () => {
      const rec = this.get(id);
      if (!(rec.status === "failed" && rec.failedStage === "review")) throw new CoordinatorError("CONFLICT", "Retry review is only available after a failed review.", 409);
      rec.review.reviewId = null;
      rec.review.submitState = "idle";
      rec.review.submitAttempts = 0;
      rec.review.upstreamStatus = null;
      this.setStatus(rec, "reviewing", "Retrying the review from the saved snapshot (no regeneration).");
      this.save(rec);
      return rec;
    });
  }

  retryHandoff(id: string): Promise<IntegrationRecord> {
    return this.exclusive(id, async () => {
      const rec = this.get(id);
      if (!(rec.status === "failed" && rec.failedStage === "handoff")) throw new CoordinatorError("CONFLICT", "Retry handoff is only available after a failed handoff.", 409);
      this.setStatus(rec, "generating", "Retrying the handoff from the completed generation.");
      this.save(rec);
      return rec;
    });
  }
}
