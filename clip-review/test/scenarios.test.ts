// Every acceptance scenario, replaying recorded reviewer responses through the
// full pipeline (validation -> assembly -> verification) and the labelled expectations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { FixtureBackend } from "../src/agent/backends.ts";
import { runReview } from "../src/review.ts";
import { checkExpectations } from "../src/eval-check.ts";
import { verifyReport } from "../src/verify-report.ts";
import { ReviewInput } from "../src/contract.ts";
import { ROOT, loadExpected, loadInput } from "./helpers.ts";

const backend = new FixtureBackend(join(ROOT, "fixtures", "responses"));
const names = readdirSync(join(ROOT, "fixtures", "inputs")).map((f) => f.replace(/\.json$/, "")).sort();

for (const name of names) {
  test(`scenario ${name}`, async () => {
    const raw = loadInput(name);
    const out = await runReview(raw, backend);
    assert.ok(out.ok, !out.ok ? JSON.stringify(out.errors) : "");
    if (!out.ok) return;
    assert.deepEqual(verifyReport(ReviewInput.parse(raw), out.report), []);
    assert.equal(out.report.runId, raw.research.runId);
    assert.equal(out.report.mode, "fixture");
    assert.ok(out.report.limitations[0].startsWith("FIXTURE DATA"), "fixture label must lead the limitations");
    const failed = checkExpectations(out.report, out.audit, loadExpected(name)).filter((c) => !c.pass);
    assert.deepEqual(failed, []);
  });
}

test("reports never contain numeric confidence or view predictions", async () => {
  for (const name of names) {
    const out = await runReview(loadInput(name), backend);
    assert.ok(out.ok);
    const text = JSON.stringify(out.ok && out.report);
    assert.ok(!/"(confidence|score|probability|predictedViews|viralityScore)"/i.test(text), name);
  }
});

test("insufficient evidence and unverifiable handoffs do not invoke the reviewer model", async () => {
  for (const name of ["06-all-transcripts-unavailable", "12-insufficient-evidence"]) {
    const out = await runReview(loadInput(name), {
      kind: "fixture",
      versionKey: "x",
      judge: () => {
        throw new Error("model must not be called");
      },
    });
    assert.ok(out.ok);
    assert.equal(out.ok && out.reviewer.backend, "none");
  }
});

test("partial source transcript: source-absence claims carry a partial-coverage caveat", async () => {
  const out = await runReview(loadInput("05-missing-transcripts"), backend);
  assert.ok(out.ok);
  if (!out.ok) return;
  for (const u of out.report.unansweredQuestions.filter((u) => u.status === "not_found_in_available_source"))
    assert.match(u.explanation, /partial/i);
  assert.ok(out.report.limitations.some((l) => /Source transcript coverage is partial/.test(l)));
});

test("inferred questions are never presented as explicit", async () => {
  const out = await runReview(loadInput("07-unsupported-question"), backend);
  assert.ok(out.ok);
  if (!out.ok) return;
  for (const m of out.report.matches.filter((m) => m.questionId === "q-window"))
    assert.ok(m.limitations.some((l) => /inferred question/.test(l)));
});

test("generation targeting is never treated as evidence", async () => {
  const out = await runReview(loadInput("02-related-only"), backend);
  assert.ok(out.ok);
  if (!out.ok) return;
  // q-break-fast was requested from OpusClip, but no clip answers it.
  assert.ok(out.report.limitations.some((l) => /not treated as evidence/.test(l)));
  assert.equal(out.report.recommendations.length, 0);
});
