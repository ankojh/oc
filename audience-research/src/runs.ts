// Run lifecycle: research (free, retryable) and generation (paid, never
// resubmitted implicitly).
//
// Duplicate-job protection for "Generate clips":
// 1. A per-run in-process lock rejects concurrent clicks.
// 2. The run is persisted as `submitting` (fsync'd) BEFORE the provider call.
//    If we crash mid-call, startup recovery moves it to `needs_reconciliation`,
//    never back to `not_started`.
// 3. Any state other than `not_started`, or `failed` with a provider rejection
//    proving no job exists, returns the existing state instead of submitting.
// 4. Ambiguous outcomes (timeout, network loss, 5xx, missing project ID) become
//    `needs_reconciliation`: we search the account's recent projects. A project
//    is adopted automatically only when its title carries this run's
//    correlation token; other same-video projects inside a bounded time window
//    are listed for the user to choose. Projects already owned by another run
//    are never candidates. A new paid submit requires explicit `forceNewProject`.
// 5. Polling resumes from the stored projectId after refresh or restart.
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { AppError, toErrorInfo } from "./errors.js";
import { log } from "./log.js";
import { assembleReviewInput } from "./opusclip/review.js";
import type { OpusClipAdapter, ProviderTranscript } from "./opusclip/types.js";
import type { ResearchAnalyzer } from "./research/analyzer.js";
import { runResearch } from "./research/pipeline.js";
import { type GenerationState, type RunRecord, type RunStore, emptyGeneration } from "./store.js";
import { type YouTubeAdapter, canonicalVideoUrl, parseYouTubeVideoId } from "./youtube/types.js";

export interface ModeDeps {
  youtube: () => YouTubeAdapter;
  analyzer: () => ResearchAnalyzer;
  opus: () => OpusClipAdapter;
  pollIntervalMs: number;
}

export interface RunManagerDeps {
  store: RunStore;
  config: Config;
  modes: { live: ModeDeps; fixture: ModeDeps };
  /** Injected for tests and reproducible fixture exports. */
  sleep?: (ms: number) => Promise<void>;
  newRunId?: () => string;
}

export type OverallStatus =
  | "researching"
  | "research_failed"
  | "insufficient_evidence"
  | "research_ready"
  | "generating"
  | "needs_reconciliation"
  | "generation_failed"
  | "completed";

export function overallStatus(run: RunRecord): OverallStatus {
  const r = run.research.status;
  if (r === "queued" || r === "running") return "researching";
  if (r === "failed") return "research_failed";
  if (r === "insufficient_evidence") return "insufficient_evidence";
  switch (run.generation.status) {
    case "not_started":
      return "research_ready";
    case "submitting":
    case "processing":
    case "collecting":
      return "generating";
    case "needs_reconciliation":
      return "needs_reconciliation";
    case "failed":
      return "generation_failed";
    case "completed":
      return "completed";
  }
}

/** Allowed clock skew before the submit started. */
const RECONCILE_SKEW_MS = 2 * 60_000;
/** A project created this long after the submit started is not attributed to it. */
const RECONCILE_MAX_DELAY_MS = 15 * 60_000;

export function correlationTokenFor(runId: string): string {
  return `[ar:${runId}]`;
}

/** Provider title for a run's project; the correlation token is never truncated away. */
export function projectTitle(videoTitle: string, token: string): string {
  return `${`Audience questions: ${videoTitle}`.slice(0, 200 - token.length - 1)} ${token}`;
}

export class RunManager {
  private locks = new Set<string>();
  private pollers = new Map<string, Promise<void>>();
  private adapters = new Map<string, OpusClipAdapter>();
  private sleep: (ms: number) => Promise<void>;
  private stopped = false;

  constructor(private readonly deps: RunManagerDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private opus(mode: "live" | "fixture"): OpusClipAdapter {
    let a = this.adapters.get(mode);
    if (!a) {
      a = this.deps.modes[mode].opus();
      this.adapters.set(mode, a);
    }
    return a;
  }

  get(runId: string): RunRecord {
    const run = this.deps.store.load(runId);
    if (!run) throw new AppError("NOT_FOUND", `Run ${runId} not found.`, null, 404);
    return run;
  }

  // ---------------------------------------------------------------- research

  startResearch(body: { videoUrl?: unknown; creatorGoal?: unknown; mode?: unknown }): { runId: string; promise: Promise<void> } {
    if (body.mode !== "live" && body.mode !== "fixture") throw new AppError("INVALID_INPUT", 'mode must be "live" or "fixture".', null, 400);
    if (typeof body.videoUrl !== "string" || !body.videoUrl.trim()) throw new AppError("INVALID_INPUT", "videoUrl is required.", null, 400);
    if (body.creatorGoal !== undefined && body.creatorGoal !== null && typeof body.creatorGoal !== "string")
      throw new AppError("INVALID_INPUT", "creatorGoal must be a string.", null, 400);
    const videoId = parseYouTubeVideoId(body.videoUrl);
    const goal = typeof body.creatorGoal === "string" && body.creatorGoal.trim() ? body.creatorGoal.trim().slice(0, 500) : null;
    if (body.mode === "live" && !this.deps.config.youtube.apiKey)
      throw new AppError("CONFIG_MISSING", "Live mode needs YOUTUBE_API_KEY.", "Add YOUTUBE_API_KEY to .env (YouTube Data API v3) or use fixture mode.", 400);

    const now = new Date().toISOString();
    const runId = this.deps.newRunId?.() ?? `run_${now.slice(0, 10).replace(/-/g, "")}_${randomUUID().slice(0, 8)}`;
    const run: RunRecord = {
      runId,
      mode: body.mode,
      createdAt: now,
      updatedAt: now,
      input: { videoUrl: canonicalVideoUrl(videoId), videoId, creatorGoal: goal },
      research: { status: "queued", progress: [], error: null, startedAt: null, finishedAt: null, sourceVideoDurationMs: null },
      brief: null,
      generation: emptyGeneration(),
    };
    this.deps.store.save(run);
    const promise = this.executeResearch(runId);
    return { runId, promise };
  }

  private async executeResearch(runId: string): Promise<void> {
    const store = this.deps.store;
    const run = this.get(runId);
    const mode = this.deps.modes[run.mode];
    const cfg = this.deps.config;
    run.research.status = "running";
    run.research.startedAt = new Date().toISOString();
    store.save(run);
    const progress = (step: string, message: string) => {
      run.research.progress.push({ at: new Date().toISOString(), step, message });
      store.save(run);
    };
    try {
      const outcome = await runResearch(
        mode.youtube(),
        mode.analyzer(),
        {
          runId,
          mode: run.mode,
          videoId: run.input.videoId,
          creatorGoal: run.input.creatorGoal,
          commentsPerVideo: cfg.youtube.commentsPerVideo,
          maxRelatedVideos: cfg.youtube.maxRelatedVideos,
          recentUploadsToConsider: cfg.youtube.recentUploadsToConsider,
          generationDefaults: { durationSec: cfg.opus.defaultDurationSec, aspectRatio: cfg.opus.defaultAspectRatio },
        },
        progress,
      );
      store.writeJson(runId, "research-debug.json", outcome.debug);
      run.brief = outcome.brief;
      run.research.sourceVideoDurationMs = outcome.sourceVideo.durationMs;
      run.research.status = outcome.brief.researchStatus === "ready" ? "ready" : "insufficient_evidence";
      progress("done", run.research.status === "ready" ? `Research ready: ${outcome.brief.questions.length} question theme(s).` : "Insufficient evidence: no usable audience questions found.");
    } catch (err) {
      run.research.status = "failed";
      run.research.error = toErrorInfo(err);
      log.error(`research ${runId} failed:`, err);
      progress("failed", run.research.error.message);
    } finally {
      run.research.finishedAt = new Date().toISOString();
      store.save(run);
    }
  }

  // -------------------------------------------------------------- generation

  /**
   * The single "Generate clips" action. Returns the generation state; never
   * submits a second paid job unless `forceNewProject` is explicitly set.
   */
  async generate(runId: string, body: { confirmCredits?: unknown; forceNewProject?: unknown }): Promise<{ submitted: boolean; generation: GenerationState }> {
    if (this.locks.has(runId)) return { submitted: false, generation: this.get(runId).generation };
    this.locks.add(runId);
    try {
      const run = this.get(runId);
      if (run.research.status !== "ready" || !run.brief?.generationBrief)
        throw new AppError("CONFLICT", `Research is not ready (status: ${run.research.status}).`, "Generation is only available after research finds evidence-backed questions.", 409);
      const g = run.generation;
      const adapter = this.opus(run.mode);
      const force = body.forceNewProject === true;

      if (g.status === "submitting" || g.status === "processing" || g.status === "collecting" || g.status === "completed") {
        if (g.status !== "completed" && g.status !== "submitting") this.ensurePoller(runId);
        return { submitted: false, generation: g };
      }
      if (g.status === "needs_reconciliation" && !force)
        throw new AppError(
          "OPUS_AMBIGUOUS_SUBMIT",
          "A previous submission may have created a project. Reconcile first.",
          "POST /runs/:runId/reconcile to search OpusClip for it. Only if you are sure no project exists, resend with forceNewProject: true (consumes credits again).",
          409,
        );
      if (g.status === "failed" && g.projectId && !force)
        throw new AppError(
          "CONFLICT",
          `OpusClip project ${g.projectId} already exists for this run (it failed or stalled).`,
          "Resume polling with POST /runs/:runId/poll, or resend with forceNewProject: true to pay for a new project.",
          409,
        );
      if (g.status === "failed" && !g.projectId && g.error && !g.error.noJobCreated && !force)
        throw new AppError("OPUS_AMBIGUOUS_SUBMIT", "The last submission outcome is unknown.", "Reconcile first, or resend with forceNewProject: true.", 409);
      if (adapter.consumesCredits && body.confirmCredits !== true)
        throw new AppError(
          "INVALID_INPUT",
          "Generating clips submits one OpusClip project and consumes the connected account's credits (API projects have a 10-credit minimum).",
          "Resend with confirmCredits: true to proceed.",
          400,
        );

      const brief = run.brief.generationBrief;
      const token = correlationTokenFor(runId);
      const req = {
        videoUrl: run.brief.video.url,
        title: projectTitle(run.brief.video.title, token),
        customPrompt: brief.customPrompt,
        durationSec: brief.durationSec,
        aspectRatio: brief.aspectRatio,
      };
      // Persist intent before calling the provider.
      const next: GenerationState = {
        ...emptyGeneration(),
        status: "submitting",
        transport: adapter.transport,
        submitAttempts: g.submitAttempts + 1,
        submitStartedAt: new Date().toISOString(),
        correlationToken: token,
        creditsAcknowledgedAt: adapter.consumesCredits ? new Date().toISOString() : null,
        request: { customPrompt: brief.customPrompt, requestedQuestionIds: brief.targetQuestionIds, durationSec: brief.durationSec, aspectRatio: brief.aspectRatio },
        events: [...g.events, { at: new Date().toISOString(), step: "submit", message: `Submitting OpusClip project (attempt ${g.submitAttempts + 1}, via ${adapter.transport})${force ? " — forced by user" : ""}` }],
      };
      run.generation = next;
      this.deps.store.save(run);

      try {
        const res = await adapter.submitProject(req);
        this.deps.store.saveProviderRaw(runId, "submit", { sentRequest: res.sentRequest, response: res.raw });
        next.projectId = res.projectId;
        next.sentRequest = res.sentRequest;
        next.status = "processing";
        next.events.push({ at: new Date().toISOString(), step: "submitted", message: `OpusClip project ${res.projectId} created` });
        this.deps.store.save(run);
        this.ensurePoller(runId);
        return { submitted: true, generation: next };
      } catch (err) {
        const info = toErrorInfo(err);
        const noJob = err instanceof AppError && err.definitelyNotCreated;
        next.status = noJob ? "failed" : "needs_reconciliation";
        next.error = { ...info, noJobCreated: noJob };
        next.events.push({ at: new Date().toISOString(), step: noJob ? "rejected" : "ambiguous", message: info.message });
        this.deps.store.save(run);
        if (!noJob) await this.reconcile(runId).catch((e) => log.warn(`auto-reconcile ${runId} failed:`, e));
        return { submitted: false, generation: this.get(runId).generation };
      }
    } finally {
      this.locks.delete(runId);
    }
  }

  /** Project IDs already attached to other runs; never candidates for this one. */
  private ownedProjectIds(exceptRunId: string): Set<string> {
    return new Set(
      this.deps.store
        .list()
        .filter((r) => r.runId !== exceptRunId && r.generation.projectId)
        .map((r) => r.generation.projectId!),
    );
  }

  /**
   * Looks for a project created by an ambiguous submission. Adopts automatically
   * only when exactly one candidate carries this run's correlation token;
   * otherwise records bounded candidates for the user to choose from.
   */
  async reconcile(runId: string): Promise<GenerationState> {
    const run = this.get(runId);
    const g = run.generation;
    if (g.status !== "needs_reconciliation") return g;
    const adapter = this.opus(run.mode);
    const started = g.submitStartedAt ? Date.parse(g.submitStartedAt) : null;
    const from = started === null ? null : started - RECONCILE_SKEW_MS;
    const to = started === null ? null : started + RECONCILE_MAX_DELAY_MS;
    const owned = this.ownedProjectIds(runId);
    const token = g.correlationToken ?? null;
    const recent = await adapter.listRecentProjects();
    this.deps.store.saveProviderRaw(runId, "reconcile-list-projects", recent);
    const inWindow = (createdAt: string | null) => {
      if (createdAt === null || from === null || to === null) return createdAt === null;
      const t = Date.parse(createdAt);
      return Number.isFinite(t) && t >= from && t <= to;
    };
    const candidates = recent
      .filter((p) => p.projectId && !owned.has(p.projectId))
      .filter((p) => p.sourceVideoId === null || p.sourceVideoId === run.input.videoId)
      .filter((p) => inWindow(p.createdAt))
      // A title token alone cannot time-bound a project with no creation time.
      // Those projects remain manual candidates, never auto-adopted.
      .map((p) => ({ ...p, correlated: Boolean(token && p.createdAt && p.title?.includes(token)) }));
    const correlated = candidates.filter((p) => p.correlated);
    const fresh = this.get(runId);
    const listed = candidates.map(({ projectId, createdAt, stage, title, correlated }) => ({ projectId, createdAt, stage, title, correlated }));
    if (correlated.length === 1) {
      fresh.generation.projectId = correlated[0].projectId;
      fresh.generation.status = "processing";
      fresh.generation.error = null;
      fresh.generation.reconciliation = { checkedAt: new Date().toISOString(), candidates: listed, note: `Adopted the project whose title carries this run's token ${token}.` };
      fresh.generation.events.push({ at: new Date().toISOString(), step: "reconciled", message: `Found project ${correlated[0].projectId} by request correlation; resuming polling.` });
      this.deps.store.save(fresh);
      this.ensurePoller(runId);
    } else {
      fresh.generation.reconciliation = {
        checkedAt: new Date().toISOString(),
        candidates: listed,
        note:
          candidates.length === 0
            ? "No matching project found yet. It may still appear; check again or look in the OpusClip dashboard before forcing a new submission."
            : correlated.length > 1
              ? "Several projects carry this run's token; choose the right one with POST /runs/:runId/adopt-project."
              : "Possible projects found for this video and time window, but none could be matched to this exact request. Choose one with POST /runs/:runId/adopt-project, or check again.",
      };
      this.deps.store.save(fresh);
    }
    return this.get(runId).generation;
  }

  adoptProject(runId: string, projectId: unknown): GenerationState {
    if (typeof projectId !== "string" || !/^[A-Za-z0-9._-]{3,64}$/.test(projectId)) throw new AppError("INVALID_INPUT", "projectId is required.", null, 400);
    const run = this.get(runId);
    if (run.generation.status !== "needs_reconciliation")
      throw new AppError("CONFLICT", "Only an ambiguous submission can adopt a project.", null, 409);
    if (this.ownedProjectIds(runId).has(projectId))
      throw new AppError("CONFLICT", `Project ${projectId} already belongs to another run.`, "Choose a project that no other run has adopted.", 409);
    if (!run.generation.reconciliation?.candidates.some((c) => c.projectId === projectId))
      throw new AppError("CONFLICT", `Project ${projectId} was not found among this run's bounded reconciliation candidates.`, "Reconcile again and select a listed project; do not adopt a guessed or unrelated project ID.", 409);
    run.generation.projectId = projectId;
    run.generation.status = "processing";
    run.generation.error = null;
    run.generation.events.push({ at: new Date().toISOString(), step: "adopted", message: `User adopted project ${projectId}` });
    this.deps.store.save(run);
    this.ensurePoller(runId);
    return run.generation;
  }

  /** Resume polling an existing project (never submits). */
  resumePolling(runId: string): GenerationState {
    const run = this.get(runId);
    const g = run.generation;
    if (!g.projectId) throw new AppError("CONFLICT", "This run has no OpusClip project to poll.", null, 409);
    if (g.status === "failed" || g.status === "processing" || g.status === "collecting") {
      g.status = g.status === "failed" ? "processing" : g.status;
      g.error = null;
      this.deps.store.save(run);
      this.ensurePoller(runId);
    }
    return run.generation;
  }

  ensurePoller(runId: string): Promise<void> {
    const existing = this.pollers.get(runId);
    if (existing) return existing;
    const p = this.poll(runId).finally(() => this.pollers.delete(runId));
    this.pollers.set(runId, p);
    return p;
  }

  private async poll(runId: string): Promise<void> {
    const run0 = this.get(runId);
    const mode = this.deps.modes[run0.mode];
    const adapter = this.opus(run0.mode);
    const deadline = Date.now() + this.deps.config.opus.maxPollMinutes * 60_000;
    let unknownStreak = 0;
    let backoff = mode.pollIntervalMs;
    while (!this.stopped) {
      const run = this.get(runId);
      const g = run.generation;
      if (!g.projectId || (g.status !== "processing" && g.status !== "collecting")) return;
      try {
        if (g.status === "processing") {
          const st = await adapter.getProjectStatus(g.projectId);
          g.pollCount++;
          g.lastPolledAt = new Date().toISOString();
          g.error = null;
          if (st.stage !== g.stage) {
            g.events.push({ at: g.lastPolledAt, step: "stage", message: `OpusClip stage: ${st.stage ?? "unknown"}` });
            this.deps.store.saveProviderRaw(runId, "project-status", st.raw);
          }
          g.stage = st.stage;
          if (st.state === "failed") {
            g.status = "failed";
            g.error = { code: "OPUS_PROCESSING_FAILED", message: `OpusClip processing failed at stage ${st.stage}${st.error ? `: ${st.error}` : ""}.`, action: "Check the project in the OpusClip dashboard (failed projects may be refunded).", noJobCreated: false };
            this.deps.store.save(run);
            return;
          }
          unknownStreak = st.state === "unknown" ? unknownStreak + 1 : 0;
          let done = st.state === "complete";
          if (!done && unknownStreak >= 3) {
            // Stage unavailable: accept completion only if clips exist and none are still rendering.
            const { clips } = await adapter.listClips(g.projectId);
            done = clips.length > 0 && clips.every((c) => c.renderPending === false);
          }
          if (done) g.status = "collecting";
          this.deps.store.save(run);
        }
        if (g.status === "collecting") {
          await this.collect(runId);
          return;
        }
        backoff = mode.pollIntervalMs;
      } catch (err) {
        const info = toErrorInfo(err);
        const fresh = this.get(runId);
        fresh.generation.error = { ...info, noJobCreated: false };
        fresh.generation.events.push({ at: new Date().toISOString(), step: "poll_error", message: `${info.message} (will retry)` });
        this.deps.store.save(fresh);
        backoff = Math.min(backoff * 2, 5 * 60_000);
      }
      if (Date.now() > deadline) {
        const fresh = this.get(runId);
        fresh.generation.status = "failed";
        fresh.generation.error = { code: "OPUS_PROCESSING_FAILED", message: `Stopped polling after ${this.deps.config.opus.maxPollMinutes} minutes; project ${fresh.generation.projectId} may still finish.`, action: "POST /runs/:runId/poll to resume polling (no new submission).", noJobCreated: false };
        this.deps.store.save(fresh);
        return;
      }
      await this.sleep(backoff);
    }
  }

  private async collect(runId: string): Promise<void> {
    const run = this.get(runId);
    const g = run.generation;
    const adapter = this.opus(run.mode);
    const { clips, raw } = await adapter.listClips(g.projectId!);
    this.deps.store.saveProviderRaw(runId, "clips", raw);
    let transcript: ProviderTranscript | null = null;
    let transcriptError: string | null = null;
    try {
      transcript = await adapter.getTranscript(g.projectId!);
      this.deps.store.saveProviderRaw(runId, "transcript", transcript.raw);
    } catch (err) {
      transcriptError = (err as Error).message;
    }
    const completedAt = new Date().toISOString();
    const reviewInput = assembleReviewInput({
      research: run.brief!,
      projectId: g.projectId!,
      requestedQuestionIds: g.request!.requestedQuestionIds,
      submittedPrompt: g.request!.customPrompt,
      completedAt,
      clips,
      transcript,
      transcriptError,
      videoDurationMs: run.research.sourceVideoDurationMs,
      timeRangeUnit: this.deps.config.opus.timeRangeUnit,
      extraLimitations: run.mode === "fixture" ? ["FIXTURE DATA: clips and transcript are synthetic fixtures, not OpusClip output."] : [],
    });
    this.deps.store.saveReviewInput(runId, reviewInput);
    const fresh = this.get(runId);
    fresh.generation.status = "completed";
    fresh.generation.completedAt = completedAt;
    fresh.generation.error = null;
    fresh.generation.events.push({ at: completedAt, step: "completed", message: `Collected ${clips.length} clip(s); ReviewInput validated.` });
    this.deps.store.save(fresh);
  }

  // ---------------------------------------------------------------- recovery

  /** Called on startup: never resubmits, only resumes or flags. */
  recover(): void {
    for (const run of this.deps.store.list()) {
      let changed = false;
      if (run.research.status === "queued" || run.research.status === "running") {
        run.research.status = "failed";
        run.research.error = { code: "INTERRUPTED", message: "The server restarted while research was running.", action: "Start the research again (it does not consume OpusClip credits)." };
        changed = true;
      }
      const g = run.generation;
      if (g.status === "submitting") {
        g.status = "needs_reconciliation";
        g.error = { code: "OPUS_AMBIGUOUS_SUBMIT", message: "The server stopped during submission; the project may or may not exist.", action: "Reconcile before submitting again.", noJobCreated: false };
        g.events.push({ at: new Date().toISOString(), step: "recovered", message: "Interrupted submission flagged for reconciliation" });
        changed = true;
      }
      if (changed) this.deps.store.save(run);
      if ((g.status === "processing" || g.status === "collecting") && g.projectId) {
        log.info(`resuming polling for ${run.runId} (project ${g.projectId})`);
        void this.ensurePoller(run.runId);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const a of this.adapters.values()) await a.close?.();
  }
}
