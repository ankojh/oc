import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { REPO_ROOT } from "../src/env.ts";
import { startIntegrationServer } from "../src/server.ts";
import { startServer as startReviewServer } from "../../clip-review/src/server.ts";

const DEMO = { videoUrl: "https://www.youtube.com/watch?v=FXdemo00001", creatorGoal: "Turn recurring viewer questions into Shorts", mode: "fixture" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

async function waitFor<T>(fn: () => Promise<T>, predicate: (v: T) => boolean, timeout = 15000): Promise<T> {
  const end = Date.now() + timeout;
  let last: T;
  do {
    last = await fn();
    if (predicate(last)) return last;
    await sleep(100);
  } while (Date.now() < end);
  throw new Error(`Timed out; last result: ${JSON.stringify(last).slice(0, 600)}`);
}

async function post(base: string, path: string, data: unknown): Promise<any> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  const out = await res.json();
  assert.ok(res.ok, `${res.status}: ${JSON.stringify(out)}`);
  return out;
}
const get = async (base: string, id: string): Promise<any> => (await (await fetch(`${base}/api/integrations/${id}`)).json());
const close = (s: Server) => new Promise<void>((resolve) => s.close(() => resolve()));

test("real HTTP research -> Generate -> exported ReviewInput -> fixture reviewer -> verified report", { timeout: 90000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "integ-e2e-"));
  const port = await freePort();
  const researchBase = `http://127.0.0.1:${port}`;
  const research = spawn(join(REPO_ROOT, "audience-research/node_modules/.bin/tsx"), ["src/server.ts"], {
    cwd: join(REPO_ROOT, "audience-research"),
    env: { ...process.env, PORT: String(port), DATA_DIR: join(dir, "research"), YOUTUBE_API_KEY: "", OPUSCLIP_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let researchLog = "";
  research.stdout?.on("data", (b: Buffer) => (researchLog += b.toString()));
  research.stderr?.on("data", (b: Buffer) => (researchLog += b.toString()));
  const reviewer = startReviewServer({ port: 0, dataDir: join(dir, "review"), backend: "fixture", makeCodex: () => { throw new Error("Codex must never be constructed in fixture flow"); } });
  await new Promise<void>((resolve) => reviewer.once("listening", resolve));
  const reviewBase = `http://127.0.0.1:${(reviewer.address() as AddressInfo).port}`;
  let lostResponse = false;
  let reviewPostCount = 0;
  let triggerLostResponse = false;
  let triggerReviewFailure = false;
  let reviewFailureInjected = false;
  const interceptedFetch: typeof fetch = async (url, init) => {
    const str = String(url);
    if (str.startsWith(`${reviewBase}/reviews?`) && init?.method === "POST") {
      reviewPostCount++;
      const real = await fetch(url, init);
      if (triggerLostResponse && !lostResponse) {
        lostResponse = true;
        throw new Error("simulated lost review submission response after server accepted it");
      }
      return real;
    }
    if (str.startsWith(`${reviewBase}/reviews/`) && !str.includes("?backend") && triggerReviewFailure && !reviewFailureInjected) {
      reviewFailureInjected = true;
      return new Response(JSON.stringify({ status: "failed", reviewId: str.split("/").pop(), progress: [], errors: [{ code: "simulated_review_failure", path: "(test)", message: "first review failed", hint: "Retry review" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return fetch(url, init);
  };
  let integration = startIntegrationServer({ port: 0, dataDir: join(dir, "integration"), researchUrl: researchBase, reviewUrl: reviewBase, tickMs: 70, fetchImpl: interceptedFetch });
  let base = await integration.ready;
  t.after(async () => {
    await integration.coordinator.stop();
    await close(integration.server);
    await close(reviewer);
    research.kill("SIGTERM");
    await new Promise<void>((resolve) => research.once("exit", () => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(async () => fetch(`${researchBase}/health`).then((r) => r.ok).catch(() => false), Boolean, 12000).catch((e) => { throw new Error(`${e.message}\n${researchLog}`); });

  await t.test("localhost-only API refuses cross-origin and DNS-rebinding requests", async () => {
    const crossOrigin = await fetch(`${base}/api/integrations`, { method: "POST", headers: { "content-type": "application/json", origin: "https://other.example" }, body: "{}" });
    assert.equal(crossOrigin.status, 403);
    // Node fetch/undici replaces Host with the URL host; use an HTTP request
    // with an actual attacker-controlled Host header to exercise rebinding.
    const rebindingStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${base}/health`, { headers: { host: "attacker.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(rebindingStatus, 403);
    const directResearch = await fetch(`${researchBase}/research`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://other.example" },
      body: JSON.stringify(DEMO),
    });
    assert.equal(directResearch.status, 403);
    const directReview = await fetch(`${reviewBase}/reviews?backend=codex`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://other.example" },
      body: "{}",
    });
    assert.equal(directReview.status, 403);
  });

  await t.test("insufficient comments never generate", async () => {
    const { integrationId } = await post(base, "/api/integrations", { videoUrl: "https://youtu.be/FXnoqs00001", mode: "fixture" });
    const v = await waitFor(() => get(base, integrationId), (x) => x.status === "insufficient_evidence");
    assert.equal(v.generation.providerSubmitAttempts, 0);
    assert.equal(v.questions.length, 0);
    assert.equal(v.actions.generate, false);
  });

  let id: string;
  await t.test("fresh run ID, duplicate clicks, refresh, restart, lost review response", async () => {
    triggerLostResponse = true;
    ({ integrationId: id } = await post(base, "/api/integrations", DEMO));
    const ready = await waitFor(() => get(base, id), (x) => x.status === "research_ready");
    assert.equal(ready.questions.length, 3);
    assert.equal(ready.research.coverage.commentCount, 20);
    const click = () => post(base, `/api/integrations/${id}/generate`, { confirmCredits: true });
    const both = await Promise.all([click(), click()]);
    assert.deepEqual(both.map((x) => x.submitted).sort(), [false, true]);
    const observed = await get(base, id); // browser refresh only observes
    assert.equal(observed.generation.providerSubmitAttempts, 1);
    // Stop just this coordinator while generation/review proceeds upstream.
    await integration.coordinator.stop();
    await close(integration.server);
    integration = startIntegrationServer({ port: 0, dataDir: join(dir, "integration"), researchUrl: researchBase, reviewUrl: reviewBase, tickMs: 70, fetchImpl: interceptedFetch });
    base = await integration.ready;
    const done = await waitFor(() => get(base, id), (x) => x.status === "complete" || x.status === "failed", 20000);
    assert.equal(done.status, "complete", JSON.stringify(done.error));
    assert.equal(done.generation.providerSubmitAttempts, 1);
    assert.equal(done.review.submitAttempts, 2);
    assert.equal(reviewPostCount, 2);
    assert.equal(done.review.reused, true);
    assert.equal(done.questions.length, 3);
    assert.equal(done.clips.length, 4);
    assert.equal(done.clips[3].verifiable, false);
    assert.equal(done.questions[1].recommendations[0].match.answerPassages[1].clipOffsetMs, 28000);
    assert.equal(done.questions[2].unanswered.status, "not_found_in_generated_clips");
    assert.match(done.diagnostics.reviewer.fixtureResponse, /hand-authored synthetic/);
    assert.equal(done.handoff.sourceTranscript.coverage, "partial");
    const stored = JSON.parse(readFileSync(join(dir, "integration/integrations", id, "integration.json"), "utf8"));
    const snapshot = JSON.parse(readFileSync(join(dir, "integration/integrations", id, "review-input.json"), "utf8"));
    assert.equal(stored.handoff.hash.length, 64);
    assert.equal(snapshot.research.runId, stored.research.runId);
    assert.equal(snapshot.clips.length, 4);
    assert.notEqual(snapshot.research.runId, "run_fixture_demo");
    const reviewerFiles = readdirSync(join(dir, "review/reviews")).filter((f) => f.endsWith(".json"));
    assert.equal(reviewerFiles.length, 1, "identical retry must reuse the in-flight review");
  });

  await t.test("review failure and Retry review reuse the saved input, not OpusClip", async () => {
    triggerLostResponse = false;
    triggerReviewFailure = true;
    const { integrationId } = await post(base, "/api/integrations", DEMO);
    await waitFor(() => get(base, integrationId), (x) => x.status === "research_ready");
    await post(base, `/api/integrations/${integrationId}/generate`, { confirmCredits: true });
    const failed = await waitFor(() => get(base, integrationId), (x) => x.status === "failed", 20000);
    assert.equal(failed.failedStage, "review");
    assert.equal(failed.error.code, "simulated_review_failure");
    const oldHash = failed.handoff.hash;
    triggerReviewFailure = false;
    await post(base, `/api/integrations/${integrationId}/retry-review`, {});
    const done = await waitFor(() => get(base, integrationId), (x) => x.status === "complete" || x.status === "failed", 10000);
    assert.equal(done.status, "complete", JSON.stringify(done.error));
    assert.equal(done.handoff.hash, oldHash);
    assert.equal(done.generation.providerSubmitAttempts, 1);
    assert.equal(done.review.history.length, 2);
  });

  await t.test("fixture with unknown scenario fails reviewer without any Codex calls", async () => {
    const { integrationId } = await post(base, "/api/integrations", { ...DEMO, creatorGoal: "A goal not bound to a fixture judgment" });
    await waitFor(() => get(base, integrationId), (x) => x.status === "research_ready");
    await post(base, `/api/integrations/${integrationId}/generate`, { confirmCredits: true });
    const failed = await waitFor(() => get(base, integrationId), (x) => x.status === "failed", 20000);
    assert.equal(failed.failedStage, "review");
    assert.equal(failed.error.code, "reviewer_failed");
    assert.match(failed.error.message, /never falls back to a live model/);
    assert.equal(failed.generation.providerSubmitAttempts, 1);
  });
});
