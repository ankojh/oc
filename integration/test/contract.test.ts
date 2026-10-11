import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../src/env.ts";
import { checkHandoff } from "../src/contract.ts";
import { clipOffsetMs, rangesDurationMs } from "../src/view.ts";
import { assembleReviewInput } from "../../audience-research/src/opusclip/review.ts";
import { runReview } from "../../clip-review/src/review.ts";
import { FixtureBackend } from "../../clip-review/src/agent/backends.ts";

const source = JSON.parse(readFileSync(join(REPO_ROOT, "audience-research/fixtures/exports/review-input.fixture.json"), "utf8"));
const clone = <T>(v: T): T => structuredClone(v);
const responses = join(REPO_ROOT, "clip-review/fixtures/responses");

test("actual producer export is valid for both services; mixed rangeless clip is kept", async () => {
  const input = clone(source);
  const check = checkHandoff(input);
  assert.ok(check.ok, check.ok ? "" : JSON.stringify(check.errors));
  if (!check.ok) return;
  assert.equal(input.clips.length, 4);
  assert.deepEqual(input.clips[3].sourceRanges, []);
  assert.ok(check.warnings.some((w) => w.code === "missing_source_ranges"));
  const result = await runReview(input, new FixtureBackend(responses));
  assert.ok(result.ok, result.ok ? "" : JSON.stringify(result.errors));
  if (!result.ok) return;
  assert.equal(result.report.status, "complete");
  assert.equal(result.report.recommendations.length, 2);
  assert.equal(result.report.matches.filter((m) => m.clipId === input.clips[3].id).length, 3);
  assert.ok(result.report.matches.filter((m) => m.clipId === input.clips[3].id).every((m) => m.verdict === "unverifiable"));
  assert.equal(result.reviewer.backend, "fixture");
  assert.match((result.reviewer as any).fixtureResponse, /hand-authored synthetic/);
});

test("new run ID has the same bound reviewer packet; unknown content never calls a model in fixture mode", async () => {
  const input = clone(source);
  input.research.runId = "run_fresh_123";
  input.generation.completedAt = new Date().toISOString();
  input.research.coverage.fetchedAt = new Date().toISOString();
  const result = await runReview(input, new FixtureBackend(responses));
  assert.ok(result.ok, result.ok ? "" : JSON.stringify(result.errors));
  if (result.ok) assert.equal(result.report.runId, "run_fresh_123");
  input.research.questions[0].question = "Unknown fixture question";
  const unknown = await runReview(input, new FixtureBackend(responses));
  assert.ok(!unknown.ok);
  if (!unknown.ok) assert.match(unknown.errors[0].message, /never falls back to a live model/);
});

test("missing transcript and zero clips are unverifiable without a model; partial coverage cannot claim full verification", async () => {
  const noTranscript = clone(source);
  noTranscript.clips = noTranscript.clips.map((c: any) => ({ ...c, transcriptStatus: "unavailable", transcript: [] }));
  noTranscript.sourceTranscript = { coverage: "unavailable", segments: [], limitations: ["Not provided"] };
  assert.equal(checkHandoff(noTranscript).ok, true);
  const noModel = { kind: "fixture" as const, versionKey: "never", async judge(): Promise<any> { throw new Error("model was called"); } };
  const result = await runReview(noTranscript, noModel);
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.report.status, "unverifiable");
    assert.ok(result.report.matches.every((m) => m.verdict === "unverifiable"));
  }
  const noClips = clone(source);
  noClips.clips = [];
  assert.equal(checkHandoff(noClips).ok, true);
  const empty = await runReview(noClips, noModel);
  assert.ok(empty.ok);
  if (empty.ok) assert.equal(empty.report.status, "unverifiable");
  const reviewed = await runReview(source, new FixtureBackend(responses));
  assert.ok(reviewed.ok);
  if (reviewed.ok) assert.match(reviewed.report.limitations.join(" "), /Source transcript coverage is partial/);
});

test("producer drops invalid provider intervals with limitations; tail-only coverage remains partial", () => {
  const input = assembleReviewInput({
    research: source.research,
    projectId: "PTEST",
    requestedQuestionIds: source.generation.requestedQuestionIds,
    submittedPrompt: source.generation.submittedPrompt,
    completedAt: new Date().toISOString(),
    clips: [{ id: "c", title: "Clip", previewUrl: null, exportUrl: null, renderPending: false, raw: {}, ranges: { values: [[590_000, 600_000]], declaredUnit: "ms", durationMs: 10_000 } }],
    transcript: { paragraphs: [{ id: 1, start: 590, end: 590, text: "invalid" }, { id: 2, start: 590, end: 600, text: "valid" }], unit: "s", raw: {} },
    transcriptError: null,
    videoDurationMs: 600_000,
    timeRangeUnit: "verify",
  });
  assert.equal(input.sourceTranscript.coverage, "partial");
  assert.equal(input.sourceTranscript.segments.length, 1);
  assert.match(input.sourceTranscript.limitations.join(" "), /Excluded 1 provider transcript segment/);
  assert.ok(checkHandoff(input).ok);
});

test("seeking accumulates prior ranges; ambiguous and out-of-range passages never seek", () => {
  const ranges = [{ startMs: 512000, endMs: 540000 }, { startMs: 575500, endMs: 601000 }];
  assert.equal(rangesDurationMs(ranges), 53500);
  assert.equal(clipOffsetMs(ranges, 575500, 601000), 28000);
  assert.equal(clipOffsetMs(ranges, 560000, 580000), null);
  assert.equal(clipOffsetMs([{ startMs: 0, endMs: 10000 }, { startMs: 0, endMs: 10000 }], 1000, 2000), null);
});
