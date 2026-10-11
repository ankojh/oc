import { describe, expect, it } from "vitest";
import { ReviewInput } from "../src/contract.js";
import { AppError } from "../src/errors.js";
import { fixtureModeDeps } from "../src/fixtureMode/deps.js";
import { RestOpusClipAdapter, buildRestSubmitBody } from "../src/opusclip/rest.js";
import type { OpusClipAdapter, ProjectStatus, SubmitRequest } from "../src/opusclip/types.js";
import { RunManager, correlationTokenFor, overallStatus, projectTitle } from "../src/runs.js";
import { RunStore } from "../src/store.js";
import { LiveYouTubeAdapter } from "../src/youtube/live.js";
import { jsonResponse, testConfig } from "./helpers.js";

/** A paid-provider stand-in that counts submissions. */
class FakeOpus implements OpusClipAdapter {
  readonly transport = "rest" as const;
  readonly consumesCredits = true;
  submits: SubmitRequest[] = [];
  submitBehavior: "ok" | "timeout" | "reject" = "ok";
  createOnTimeout = true;
  stages = ["QUEUED", "CURATE", "COMPLETE"];
  statusCalls = 0;
  projects: { projectId: string; createdAt: string; sourceVideoId: string; stage: string; title: string | null }[] = [];
  /** Whether listed projects expose the submitted title (request correlation). */
  listTitles = true;
  private inner: OpusClipAdapter;

  constructor(inner: OpusClipAdapter) {
    this.inner = inner;
  }
  async checkAccess() {
    return { ok: true, transport: "rest" as const, detail: "", supportsCustomPrompt: true };
  }
  async submitProject(req: SubmitRequest) {
    this.submits.push(req);
    const projectId = `PRJ${this.submits.length}`;
    if (this.submitBehavior === "reject") throw new AppError("OPUS_AUTH", "bad key", null, 401, true);
    if (this.submitBehavior === "timeout") {
      if (this.createOnTimeout) this.projects.push({ projectId, createdAt: new Date().toISOString(), sourceVideoId: "FXdemo00001", stage: "QUEUED", title: req.title });
      throw new AppError("OPUS_AMBIGUOUS_SUBMIT", "timed out", null, 504, false);
    }
    this.projects.push({ projectId, createdAt: new Date().toISOString(), sourceVideoId: "FXdemo00001", stage: "QUEUED", title: req.title });
    return { projectId, sentRequest: req, raw: { id: projectId } };
  }
  async getProjectStatus(): Promise<ProjectStatus> {
    const stage = this.stages[Math.min(this.statusCalls++, this.stages.length - 1)];
    return { state: stage === "COMPLETE" ? "complete" : stage === "FAILED" ? "failed" : "processing", stage, error: null, raw: {} };
  }
  async listClips(projectId: string) {
    return this.inner.listClips(projectId);
  }
  async getTranscript(projectId: string) {
    return this.inner.getTranscript(projectId);
  }
  async listRecentProjects() {
    return this.projects.map((p) => ({ ...p, title: this.listTitles ? p.title : null }));
  }
}

function setup(dataDir?: string) {
  const config = testConfig();
  if (dataDir) config.dataDir = dataDir;
  const store = new RunStore(config.dataDir);
  const fixture = fixtureModeDeps(config, 1);
  const fake = new FakeOpus(fixture.opus());
  // "live" here = fixture YouTube + heuristic analyzer, but a credit-consuming OpusClip.
  const manager = new RunManager({ store, config, modes: { fixture, live: { ...fixture, opus: () => fake } }, sleep: async () => {} });
  return { config, store, manager, fake };
}

async function readyRun(m: RunManager) {
  const { runId, promise } = m.startResearch({ videoUrl: "https://www.youtube.com/watch?v=FXdemo00001", mode: "live" });
  await promise;
  return runId;
}

describe("generation: one paid job per action", () => {
  it("requires explicit credit confirmation for a credit-consuming provider", async () => {
    const { manager, fake } = setup();
    const runId = await readyRun(manager);
    await expect(manager.generate(runId, {})).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringMatching(/credits/) });
    expect(fake.submits).toHaveLength(0);
  });

  it("submits once, then returns the existing job on repeat or concurrent clicks", async () => {
    const { manager, fake } = setup();
    const runId = await readyRun(manager);
    const results = await Promise.all([manager.generate(runId, { confirmCredits: true }), manager.generate(runId, { confirmCredits: true })]);
    expect(results.filter((r) => r.submitted)).toHaveLength(1);
    await manager.ensurePoller(runId);
    const again = await manager.generate(runId, { confirmCredits: true });
    expect(again.submitted).toBe(false);
    expect(fake.submits).toHaveLength(1);
    expect(manager.get(runId).generation.status).toBe("completed");
    expect(fake.submits[0].customPrompt).toMatch(/viewer questions/);
  });

  it("an ambiguous timeout is reconciled to the created project instead of resubmitting", async () => {
    const { manager, fake } = setup();
    const runId = await readyRun(manager);
    fake.submitBehavior = "timeout";
    const r = await manager.generate(runId, { confirmCredits: true });
    expect(r.submitted).toBe(false);
    expect(manager.get(runId).generation).toMatchObject({ projectId: "PRJ1", status: "processing" });
    await manager.ensurePoller(runId);
    expect(manager.get(runId).generation.status).toBe("completed");
    expect(fake.submits).toHaveLength(1);
  });

  it("the project title carries the run's correlation token", async () => {
    const { manager, fake } = setup();
    const runId = await readyRun(manager);
    await manager.generate(runId, { confirmCredits: true });
    expect(fake.submits[0].title).toContain(correlationTokenFor(runId));
    expect(projectTitle("x".repeat(500), correlationTokenFor(runId))).toMatch(new RegExp(`\\[ar:${runId}\\]$`));
    expect(projectTitle("x".repeat(500), correlationTokenFor(runId)).length).toBeLessThanOrEqual(200);
  });

  it("without request correlation, a same-video project is listed for the user, not adopted", async () => {
    const { manager, fake } = setup();
    const runId = await readyRun(manager);
    fake.submitBehavior = "timeout";
    fake.listTitles = false;
    await manager.generate(runId, { confirmCredits: true });
    const g = manager.get(runId).generation;
    expect(g.status).toBe("needs_reconciliation");
    expect(g.reconciliation?.candidates.map((c) => c.projectId)).toEqual(["PRJ1"]);
    expect(g.reconciliation?.note).toMatch(/none could be matched to this exact request/);
    expect(() => manager.adoptProject(runId, "PUNLISTED")).toThrow(/not found among this run's bounded reconciliation candidates/);
    manager.adoptProject(runId, "PRJ1");
    await manager.ensurePoller(runId);
    expect(manager.get(runId).generation.status).toBe("completed");
    expect(fake.submits).toHaveLength(1);
  });

  it("repeated runs for one video never adopt each other's projects", async () => {
    const { manager, fake } = setup();
    const first = await readyRun(manager);
    await manager.generate(first, { confirmCredits: true });
    await manager.ensurePoller(first);
    expect(manager.get(first).generation.projectId).toBe("PRJ1");

    const second = await readyRun(manager);
    fake.submitBehavior = "timeout";
    fake.createOnTimeout = false;
    fake.listTitles = false;
    await manager.generate(second, { confirmCredits: true });
    const g = manager.get(second).generation;
    expect(g.status).toBe("needs_reconciliation");
    expect(g.reconciliation?.candidates).toEqual([]);
    expect(() => manager.adoptProject(second, "PRJ1")).toThrow(/another run/);
    expect(fake.submits).toHaveLength(2);
  });

  it("projects created outside the bounded window are not candidates", async () => {
    const { manager, fake } = setup();
    const runId = await readyRun(manager);
    fake.submitBehavior = "timeout";
    fake.createOnTimeout = false;
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    const later = new Date(Date.now() + 60 * 60_000).toISOString();
    fake.projects.push(
      { projectId: "POLD", createdAt: old, sourceVideoId: "FXdemo00001", stage: "COMPLETE", title: `x ${correlationTokenFor(runId)}` },
      { projectId: "PLATE", createdAt: later, sourceVideoId: "FXdemo00001", stage: "QUEUED", title: `x ${correlationTokenFor(runId)}` },
    );
    await manager.generate(runId, { confirmCredits: true });
    expect(manager.get(runId).generation).toMatchObject({ status: "needs_reconciliation", projectId: null });
    expect(manager.get(runId).generation.reconciliation?.candidates).toEqual([]);
  });

  it("an ambiguous timeout with no visible project blocks resubmission until the user forces it", async () => {
    const { manager, fake } = setup();
    const runId = await readyRun(manager);
    fake.submitBehavior = "timeout";
    fake.createOnTimeout = false;
    await manager.generate(runId, { confirmCredits: true });
    expect(manager.get(runId).generation.status).toBe("needs_reconciliation");
    expect(overallStatus(manager.get(runId))).toBe("needs_reconciliation");
    await expect(manager.generate(runId, { confirmCredits: true })).rejects.toMatchObject({ code: "OPUS_AMBIGUOUS_SUBMIT" });
    expect(fake.submits).toHaveLength(1);
    fake.submitBehavior = "ok";
    const forced = await manager.generate(runId, { confirmCredits: true, forceNewProject: true });
    expect(forced.submitted).toBe(true);
    expect(fake.submits).toHaveLength(2);
  });

  it("a definitive provider rejection (no job created) may be retried", async () => {
    const { manager, fake } = setup();
    const runId = await readyRun(manager);
    fake.submitBehavior = "reject";
    await manager.generate(runId, { confirmCredits: true });
    expect(manager.get(runId).generation).toMatchObject({ status: "failed", error: { code: "OPUS_AUTH", noJobCreated: true } });
    fake.submitBehavior = "ok";
    expect((await manager.generate(runId, { confirmCredits: true })).submitted).toBe(true);
    expect(fake.submits).toHaveLength(2);
  });

  it("a processing failure keeps the project and does not resubmit without force", async () => {
    const { manager, fake } = setup();
    const runId = await readyRun(manager);
    fake.stages = ["QUEUED", "STALLED"];
    fake.getProjectStatus = async () => ({ state: "failed", stage: "STALLED", error: null, raw: {} });
    await manager.generate(runId, { confirmCredits: true });
    await manager.ensurePoller(runId);
    expect(manager.get(runId).generation).toMatchObject({ status: "failed", projectId: "PRJ1", error: { code: "OPUS_PROCESSING_FAILED" } });
    await expect(manager.generate(runId, { confirmCredits: true })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fake.submits).toHaveLength(1);
  });
});

describe("resumption after restart", () => {
  it("resumes polling a stored project without submitting again", async () => {
    const first = setup();
    const runId = await readyRun(first.manager);
    first.fake.getProjectStatus = async () => ({ state: "processing", stage: "CURATE", error: null, raw: {} });
    const r = await first.manager.generate(runId, { confirmCredits: true });
    expect(r.submitted).toBe(true);
    await first.manager.stop(); // "server stops" while the project is processing
    await first.manager.ensurePoller(runId);
    expect(first.store.load(runId)!.generation).toMatchObject({ status: "processing", projectId: "PRJ1" });

    const second = setup(first.config.dataDir);
    second.manager.recover();
    await second.manager.ensurePoller(runId);
    const run = second.store.load(runId)!;
    expect(run.generation.status).toBe("completed");
    expect(second.fake.submits).toHaveLength(0);
    const ri = ReviewInput.parse(second.store.loadReviewInput(runId));
    expect(ri.generation.projectId).toBe("PRJ1");
  });

  it("a crash during submission becomes needs_reconciliation, never a silent resubmit", async () => {
    const first = setup();
    const runId = await readyRun(first.manager);
    const run = first.store.load(runId)!;
    run.generation.status = "submitting";
    run.generation.submitStartedAt = new Date().toISOString();
    run.generation.submitAttempts = 1;
    first.store.save(run);

    const second = setup(first.config.dataDir);
    second.manager.recover();
    expect(second.store.load(runId)!.generation.status).toBe("needs_reconciliation");
    await expect(second.manager.generate(runId, { confirmCredits: true })).rejects.toMatchObject({ code: "OPUS_AMBIGUOUS_SUBMIT" });
    expect(second.fake.submits).toHaveLength(0);
  });

  it("interrupted research is marked failed with an actionable message", async () => {
    const first = setup();
    const { runId } = first.manager.startResearch({ videoUrl: "https://www.youtube.com/watch?v=FXdemo00001", mode: "fixture" });
    const run = first.store.load(runId)!;
    run.research.status = "running";
    first.store.save(run);
    const second = setup(first.config.dataDir);
    second.manager.recover();
    expect(second.store.load(runId)!.research).toMatchObject({ status: "failed", error: { code: "INTERRUPTED" } });
  });
});

describe("provider error handling", () => {
  const req: SubmitRequest = { videoUrl: "https://www.youtube.com/watch?v=FXdemo00001", title: "t", customPrompt: "p", durationSec: [0, 90], aspectRatio: "portrait" };

  it("maps the brief to documented REST fields", () => {
    expect(buildRestSubmitBody(req)).toEqual({
      videoUrl: req.videoUrl,
      uploadedVideoAttr: { title: "t" },
      curationPref: { model: "ClipAnything", customPrompt: "p", clipDurations: [[0, 90]], genre: "Auto" },
      renderPref: { layoutAspectRatio: "portrait" },
    });
  });

  it.each([
    [401, {}, {}, "OPUS_AUTH", true],
    [403, { code: "API_MONTHLY_CAP_REACHED" }, {}, "OPUS_CREDITS_OR_CAP", true],
    [429, {}, { "x-cap-reason": "concurrent" }, "OPUS_CONCURRENCY", true],
    [500, {}, {}, "OPUS_AMBIGUOUS_SUBMIT", false],
  ])("REST submit HTTP %i -> %s", async (status, body, headers, code, notCreated) => {
    const rest = new RestOpusClipAdapter(testConfig().opus, (async () => jsonResponse(status, body, headers)) as unknown as typeof fetch);
    await expect(rest.submitProject(req)).rejects.toMatchObject({ code, definitelyNotCreated: notCreated });
  });

  it("a network timeout on submit is ambiguous, and the key never appears in the error", async () => {
    const rest = new RestOpusClipAdapter(testConfig().opus, (async () => {
      throw new Error("socket hang up Bearer test-opus-key");
    }) as unknown as typeof fetch);

    const err = await rest.submitProject(req).catch((e) => e);

    expect(err).toMatchObject({ code: "OPUS_AMBIGUOUS_SUBMIT", definitelyNotCreated: false });
    expect(err.message).not.toContain("test-opus-key");
  });

  it("YouTube: comments disabled is a recorded source status; quota and auth fail the run actionably", async () => {
    const yt = (status: number, reason: string) =>
      new LiveYouTubeAdapter("AIzaSecretKey123", "relevance", (async () => jsonResponse(status, { error: { code: status, message: `failed key=AIzaSecretKey123`, errors: [{ reason }] } })) as unknown as typeof fetch);
    await expect(yt(403, "commentsDisabled").listComments("abcdefghijk", 100)).resolves.toMatchObject({ status: "comments_disabled", comments: [] });
    await expect(yt(403, "quotaExceeded").listComments("abcdefghijk", 100)).rejects.toMatchObject({ code: "YOUTUBE_QUOTA" });
    const auth = await yt(400, "keyInvalid").getVideo("abcdefghijk").catch((e) => e);
    expect(auth).toMatchObject({ code: "YOUTUBE_AUTH" });
    const other = await yt(500, "backendError").getVideo("abcdefghijk").catch((e) => e);
    expect(other.message).not.toContain("AIzaSecretKey123");
  });
});
