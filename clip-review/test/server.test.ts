// HTTP interface: POST /reviews, GET /reviews/:id, persistence, reuse, rerun.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { startServer } from "../src/server.ts";
import { loadInput } from "./helpers.ts";

const dataDir = mkdtempSync(join(tmpdir(), "clip-review-test-"));
let codexCalls = 0;
const server = startServer({
  port: 0,
  dataDir,
  backend: "auto",
  makeCodex: () => ({
    kind: "codex",
    versionKey: "codex:test",
    judge: async () => {
      codexCalls++;
      throw new Error("Codex is not authenticated (test stub)");
    },
  }),
});
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const post = (body: unknown, q = "") =>
  fetch(`${base}/reviews${q}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
async function waitDone(id: string) {
  for (let i = 0; i < 100; i++) {
    const r = await (await fetch(`${base}/reviews/${id}`)).json();
    if (r.status === "succeeded" || r.status === "failed") return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error("timeout");
}

test("POST returns reviewId; GET returns status, progress and report", async () => {
  const res = await post(loadInput("01-direct-answer"));
  assert.equal(res.status, 202);
  const { reviewId } = await res.json();
  const r = await waitDone(reviewId);
  assert.equal(r.status, "succeeded");
  assert.equal(r.report.schemaVersion, "audience-clips.v1");
  assert.ok(r.progress.length >= 3);
  assert.equal(r.reviewer.backend, "fixture");
  assert.match(r.reviewer.fixtureResponse, /live Codex recording/);
  const exported = await fetch(`${base}/reviews/${reviewId}/report.json`);
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get("content-disposition") ?? "", /attachment/);
});

test("identical input reuses the prior review; key order does not matter; rerun forces a new one", async () => {
  const raw = loadInput("03-partial-answer");
  const first = await (await post(raw)).json();
  await waitDone(first.reviewId);
  const reordered = Object.fromEntries(Object.entries(raw).reverse());
  const second = await (await post(reordered)).json();
  assert.equal(second.reviewId, first.reviewId);
  assert.equal(second.reused, true);
  const third = await (await post(raw, "?rerun=true")).json();
  assert.notEqual(third.reviewId, first.reviewId);
  assert.equal(third.reused, false);
});

test("invalid handoff produces a failed review with actionable errors", async () => {
  const raw = loadInput("01-direct-answer");
  raw.clips[0].sourceRanges[0].endMs = 1.5;
  const { reviewId } = await (await post(raw)).json();
  const r = await waitDone(reviewId);
  assert.equal(r.status, "failed");
  assert.ok(r.errors.some((e: any) => e.path === "clips.0.sourceRanges.0.endMs" && e.hint));
  assert.equal(r.report, null);
});

test("live research without a recording goes to Codex; failures are actionable and not cached", async () => {
  const raw = loadInput("01-direct-answer");
  raw.research.mode = "live";
  raw.research.runId = "live-run-1";
  const { reviewId } = await (await post(raw)).json();
  const r = await waitDone(reviewId);
  assert.equal(r.status, "failed");
  assert.equal(r.errors[0].code, "reviewer_failed");
  assert.match(r.errors[0].hint, /codex login/);
  const again = await (await post(raw)).json();
  assert.notEqual(again.reviewId, reviewId, "failed reviews are not reused");
  assert.equal(codexCalls, 2);
});

test("fixture-mode research without a bound response fails clearly and never calls Codex, even in auto", async () => {
  const before = codexCalls;
  const raw = loadInput("01-direct-answer");
  raw.research.questions[0].question = "A question nobody recorded a judgment for?";
  const { reviewId } = await (await post(raw)).json();
  const r = await waitDone(reviewId);
  assert.equal(r.status, "failed");
  assert.equal(r.errors[0].code, "reviewer_failed");
  assert.match(r.errors[0].message, /never falls back to a live model/);
  assert.equal(codexCalls, before);
  const explicit = await waitDone((await (await post(raw, "?backend=fixture")).json()).reviewId);
  assert.equal(explicit.status, "failed");
  assert.equal(codexCalls, before);
});

test("a fresh runId of a bound scenario replays the same judgment", async () => {
  const raw = loadInput("01-direct-answer");
  raw.research.runId = "run_fresh_0001";
  const { reviewId } = await (await post(raw, "?backend=fixture")).json();
  const r = await waitDone(reviewId);
  assert.equal(r.status, "succeeded", JSON.stringify(r.errors));
  assert.equal(r.report.runId, "run_fresh_0001");
  assert.match(r.reviewer.fixtureResponse, /fx-direct-answer\.json/);
});

test("the fixture backend refuses live research input", async () => {
  const before = codexCalls;
  const raw = loadInput("01-direct-answer");
  raw.research.mode = "live";
  const r = await waitDone((await (await post(raw, "?backend=fixture")).json()).reviewId);
  assert.equal(r.status, "failed");
  assert.match(r.errors[0].message, /refuses live research input/);
  assert.equal(codexCalls, before);
});

test("cross-origin browser POSTs to the direct review service are refused", async () => {
  const before = codexCalls;
  const res = await fetch(`${base}/reviews?backend=codex`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://other.example" },
    body: JSON.stringify(loadInput("01-direct-answer")),
  });
  assert.equal(res.status, 403);
  assert.equal(codexCalls, before);
});

test("bad JSON and unknown reviews return clear errors", async () => {
  assert.equal((await post("{not json")).status, 400);
  assert.equal((await fetch(`${base}/reviews/doesnotexist`)).status, 404);
  assert.equal((await fetch(`${base}/reviews/..%2F..%2Fetc`)).status, 404);
});

test("review page and fixtures are served", async () => {
  const page = await fetch(`${base}/`);
  assert.match(await page.text(), /Audience-to-Clip Review/);
  const list = await (await fetch(`${base}/fixtures`)).json();
  assert.ok(list.includes("04-misleading-omission.json"));
});
