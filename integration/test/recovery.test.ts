import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../src/coordinator.ts";
import { IntegrationStore } from "../src/store.ts";
import { ServiceError, type ResearchClient, type ResearchRunView, type ReviewClient } from "../src/services.ts";
import { parseEnvFile, planServices, resolveEnv } from "../src/env.ts";

test("blank env-file entries never hide process credentials; each child receives only its keys", () => {
  assert.equal(parseEnvFile('YOUTUBE_API_KEY=   # blank\nOPUSCLIP_MCP_COMMAND="npx -y mcp-remote"').get("YOUTUBE_API_KEY"), "");
  assert.equal(parseEnvFile('OPUSCLIP_MCP_COMMAND="npx -y mcp-remote"').get("OPUSCLIP_MCP_COMMAND"), "npx -y mcp-remote");
  const dir = mkdtempSync(join(tmpdir(), "env-test-"));
  try {
    const file = join(dir, ".env");
    writeFileSync(file, "YOUTUBE_API_KEY=\nOPUSCLIP_API_KEY=\nOPUSCLIP_TRANSPORT=rest\nPORT=3101\nCLIP_REVIEW_PORT=3102\nINTEGRATION_PORT=3100\nCODEX_API_KEY=\n");
    const processEnv = { PATH: "/usr/bin", YOUTUBE_API_KEY: "process-youtube", OPUSCLIP_API_KEY: "process-opus", CODEX_API_KEY: "process-codex" };
    const resolved = resolveEnv(file, processEnv);
    assert.equal(resolved.get("YOUTUBE_API_KEY"), "process-youtube");
    assert.equal(resolved.source("YOUTUBE_API_KEY"), "process");
    const { plan, validation } = planServices(resolved, processEnv, join(dir, "no-codex-login"));
    assert.deepEqual(validation.errors, []);
    assert.equal(plan.research.env.OPUSCLIP_API_KEY, "process-opus");
    assert.equal(plan.research.env.YOUTUBE_API_KEY, "process-youtube");
    assert.equal(plan.review.env.CODEX_API_KEY, "process-codex");
    assert.equal(plan.review.env.YOUTUBE_API_KEY, undefined);
    assert.equal(plan.review.env.OPUSCLIP_API_KEY, undefined);
    assert.equal(plan.integration.env.YOUTUBE_API_KEY, undefined);
    assert.equal(plan.integration.env.CODEX_API_KEY, undefined);
    assert.equal(plan.review.env.REVIEW_BACKEND, "fixture");
    assert.ok(validation.rows.some((r) => r.key === "YOUTUBE_API_KEY" && r.state.includes("value hidden")));
    assert.ok(!validation.rows.some((r) => r.state.includes("process-youtube")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uncertain generation only reconciles/adopts an existing project; never automatically pays again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coordinator-reconcile-"));
  const store = new IntegrationStore(dir);
  let submits = 0;
  let state: ResearchRunView["status"] = "research_ready";
  let projectId: string | null = null;
  const view = (): ResearchRunView => ({
    runId: "run-uncertain",
    mode: "live",
    status: state,
    progress: [],
    error: null,
    result: { schemaVersion: "audience-clips.v1", researchStatus: "ready", questions: [{ id: "q" }] },
    generation: {
      status: state === "research_ready" ? "not_started" : state === "needs_reconciliation" ? "needs_reconciliation" : "processing",
      projectId,
      stage: "QUEUED",
      submitAttempts: submits,
      consumesCredits: true,
      creditNotice: "Credits used",
      reconciliation: state === "needs_reconciliation" ? { candidates: [{ projectId: "P-123", createdAt: new Date().toISOString(), title: null, correlated: false }], note: "Select the right project manually." } : null,
      error: state === "needs_reconciliation" ? { code: "OPUS_AMBIGUOUS_SUBMIT", message: "Provider response was lost", action: "Reconcile" } : null,
      events: [],
    },
    reviewInputAvailable: false,
  });
  const research = {
    start: async () => ({ runId: "run-uncertain" }),
    run: async () => view(),
    generate: async (_runId: string, opts: { forceNewProject?: boolean } = {}) => {
      if (opts.forceNewProject) throw new Error("coordinator must not force a new project");
      submits++;
      state = "needs_reconciliation";
      throw new ServiceError("research", 0, "SERVICE_UNREACHABLE", "response lost after provider submit");
    },
    reconcile: async () => view(),
    adoptProject: async (_runId: string, id: string) => {
      projectId = id;
      state = "generating";
      return view();
    },
    resumePolling: async () => view(),
  } as unknown as ResearchClient;
  const review = {} as ReviewClient; // never reached
  const coordinator = new Coordinator({ store, research, review, tickMs: 1000 });
  try {
    const rec = await coordinator.create({ videoUrl: "https://www.youtube.com/watch?v=abcde123456", mode: "live" });
    await coordinator.tick(rec.integrationId);
    await assert.rejects(coordinator.generate(rec.integrationId, { confirmCredits: true }), /response lost/);
    assert.equal(coordinator.get(rec.integrationId).status, "needs_reconciliation");
    for (let i = 0; i < 5; i++) await coordinator.tick(rec.integrationId);
    assert.equal(submits, 1);
    await coordinator.reconcile(rec.integrationId);
    assert.equal(coordinator.get(rec.integrationId).status, "needs_reconciliation");
    await coordinator.adoptProject(rec.integrationId, "P-123");
    assert.equal(coordinator.get(rec.integrationId).status, "generating");
    assert.equal(coordinator.get(rec.integrationId).generation.projectId, "P-123");
    await coordinator.tick(rec.integrationId);
    assert.equal(submits, 1);
    assert.equal(coordinator.get(rec.integrationId).generation.providerSubmitAttempts, 1);
  } finally {
    await coordinator.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
