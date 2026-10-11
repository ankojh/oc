// verifyReport is the independent gate other builders can run on any report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FixtureBackend } from "../src/agent/backends.ts";
import { runReview } from "../src/review.ts";
import { verifyReport } from "../src/verify-report.ts";
import { ReviewInput, type ReviewReport } from "../src/contract.ts";
import { join } from "node:path";
import { ROOT, clone, loadInput } from "./helpers.ts";

async function baseline(): Promise<{ input: any; report: ReviewReport }> {
  const raw = loadInput("09-repeated-answer");
  const out = await runReview(raw, new FixtureBackend(join(ROOT, "fixtures", "responses")));
  assert.ok(out.ok);
  return { input: ReviewInput.parse(raw), report: (out as any).report };
}
const direct = (r: ReviewReport) => r.matches.find((m) => m.verdict === "direct")!;

test("tampered quote is detected", async () => {
  const { input, report } = await baseline();
  const r = clone(report);
  direct(r).answerPassages[0].quote = "a quote that is not in the transcript";
  assert.ok(verifyReport(input, r).some((v) => /quote does not match/.test(v)));
});

test("passage times outside the clip range are detected", async () => {
  const { input, report } = await baseline();
  const r = clone(report);
  const p = direct(r).answerPassages[0];
  p.sourceStartMs = 900_000;
  p.sourceEndMs = 901_000;
  const v = verifyReport(input, r);
  assert.ok(v.some((x) => /outside segment/.test(x)));
  assert.ok(v.some((x) => /not inside clip/.test(x)));
});

test("seconds mistaken for milliseconds are detected", async () => {
  const { input, report } = await baseline();
  const r = clone(report);
  const p = direct(r).answerPassages[0];
  p.sourceStartMs = Math.round(p.sourceStartMs / 1000);
  p.sourceEndMs = Math.round(p.sourceEndMs / 1000);
  assert.ok(verifyReport(input, r).length > 0);
});

test("nonexistent ids are detected", async () => {
  const { input, report } = await baseline();
  const r = clone(report);
  r.matches[0].clipId = "clip-ghost";
  r.matches[1].commentEvidenceIds = ["e-ghost"];
  r.unansweredQuestions.push({ questionId: "q-ghost", status: "cannot_assess", explanation: "" });
  const v = verifyReport(input, r);
  assert.ok(v.some((x) => /unknown clipId "clip-ghost"/.test(x)));
  assert.ok(v.some((x) => /e-ghost/.test(x)));
  assert.ok(v.some((x) => /unknown questionId "q-ghost"/.test(x)));
});

test("recommendation without a direct/partial match is detected", async () => {
  const { input, report } = await baseline();
  const r = clone(report);
  r.recommendations = [{ rank: 1, clipId: "clip-weight", questionIds: ["q-hunger"], reason: "x" }];
  assert.ok(verifyReport(input, r).some((v) => /no direct\/partial match/.test(v)));
});

test("runId/mode mismatch and schema violations are detected", async () => {
  const { input, report } = await baseline();
  assert.ok(verifyReport(input, { ...report, runId: "other" }).some((v) => /runId/.test(v)));
  assert.ok(verifyReport(input, { ...report, mode: "live" }).some((v) => /mode/.test(v)));
  assert.ok(verifyReport(input, { ...report, recommendations: [1, 2, 3, 4] }).some((v) => v.startsWith("schema")));
});
