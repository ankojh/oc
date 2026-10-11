// Runs every fixture through a reviewer backend and scores the final report
// against hand-labelled expectations. Synthetic fixtures check behaviour on
// known cases; they do not establish real-world quality.
//
// npm run eval -- --backend codex [--record] [--only 04] [--concurrency 3]
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexBackend, FixtureBackend, codexOptionsFromEnv, type BackendRun, type ReviewerBackend } from "../src/agent/backends.ts";
import type { Packet } from "../src/agent/packet.ts";
import { PROMPT_VERSION } from "../src/agent/instructions.ts";
import { REVIEWER_VERSION, runReview } from "../src/review.ts";
import { checkExpectations, type Expected } from "../src/eval-check.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const backendKind = flag("--backend") ?? "fixture";
const record = args.includes("--record");
const only = flag("--only");
const concurrency = Number(flag("--concurrency") ?? 3);

const base: ReviewerBackend =
  backendKind === "codex" ? new CodexBackend(codexOptionsFromEnv()) : new FixtureBackend(join(ROOT, "fixtures", "responses"));

// Wrap to capture raw judgments for --record.
const captured = new Map<string, BackendRun>();
const backend: ReviewerBackend = {
  kind: base.kind,
  versionKey: base.versionKey,
  async judge(packet: Packet, ctx) {
    const run = await base.judge(packet, ctx);
    captured.set(ctx.runId, run);
    return run;
  },
};

const files = readdirSync(join(ROOT, "fixtures", "inputs")).filter((f) => f.endsWith(".json") && (!only || f.startsWith(only))).sort();
const results: any[] = [];
const queue = [...files];
async function worker() {
  for (let f = queue.shift(); f; f = queue.shift()) {
    const raw = JSON.parse(readFileSync(join(ROOT, "fixtures", "inputs", f), "utf8"));
    const exp: Expected = JSON.parse(readFileSync(join(ROOT, "fixtures", "expected", f), "utf8"));
    const started = Date.now();
    const out = await runReview(raw, backend);
    const run = captured.get(exp.runId);
    if (!out.ok) {
      results.push({ fixture: f, scenario: exp.scenario, ok: false, stage: out.stage, errors: out.errors, durationMs: Date.now() - started });
      console.log(`✗ ${f}: failed at ${out.stage}: ${out.errors[0]?.message}`);
      continue;
    }
    const checks = checkExpectations(out.report, out.audit, exp);
    const passed = checks.filter((c) => c.pass).length;
    results.push({
      fixture: f,
      scenario: exp.scenario,
      ok: true,
      reviewer: out.reviewer,
      checks,
      passed,
      total: checks.length,
      corrections: out.audit.corrections,
      durationMs: Date.now() - started,
      report: out.report,
    });
    console.log(`${passed === checks.length ? "✓" : "△"} ${f}: ${passed}/${checks.length} checks, ${out.audit.corrections.length} deterministic corrections`);
    if (record && run && run.meta.backend === "codex") {
      mkdirSync(join(ROOT, "fixtures", "recorded-live"), { recursive: true });
      writeFileSync(
        join(ROOT, "fixtures", "recorded-live", `${exp.runId}.json`),
        JSON.stringify({ provenance: { source: "live Codex recording", model: run.meta.model, reasoningEffort: run.meta.reasoningEffort, promptVersion: run.meta.promptVersion, recordedAt: new Date().toISOString(), threadId: run.meta.threadId }, judgment: run.output }, null, 2) + "\n",
      );
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
results.sort((a, b) => a.fixture.localeCompare(b.fixture));

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const totalChecks = results.reduce((n, r) => n + (r.total ?? 0), 0);
const totalPassed = results.reduce((n, r) => n + (r.passed ?? 0), 0);
const summary = {
  reviewerVersion: REVIEWER_VERSION,
  promptVersion: PROMPT_VERSION,
  backend: backend.kind,
  backendVersionKey: backend.versionKey,
  ranAt: new Date().toISOString(),
  disclaimer: "Synthetic fixtures with hand-labelled expectations. Results show behaviour on known cases only and do not establish real-world quality.",
  totals: { fixtures: results.length, failedRuns: results.filter((r) => !r.ok).length, checks: totalChecks, passed: totalPassed },
  results,
};
mkdirSync(join(ROOT, "evals"), { recursive: true });
writeFileSync(join(ROOT, "evals", `${backend.kind}-${stamp}.json`), JSON.stringify(summary, null, 2) + "\n");

const md = [
  `# Eval: ${backend.kind} (${backend.versionKey})`,
  "",
  `- Ran at: ${summary.ranAt}`,
  `- Reviewer: ${REVIEWER_VERSION}, prompt: ${PROMPT_VERSION}`,
  `- ${summary.disclaimer}`,
  `- Total: ${totalPassed}/${totalChecks} checks passed across ${results.length} fixtures; ${summary.totals.failedRuns} run failures.`,
  "",
  "| Fixture | Scenario | Checks | Corrections | Time |",
  "|---|---|---|---|---|",
  ...results.map((r) => `| ${r.fixture} | ${r.scenario} | ${r.ok ? `${r.passed}/${r.total}` : `run failed (${r.stage})`} | ${r.corrections?.length ?? "-"} | ${(r.durationMs / 1000).toFixed(1)}s |`),
  "",
  "## Failed checks",
  "",
  ...results.flatMap((r) => (r.checks ?? []).filter((c: any) => !c.pass).map((c: any) => `- ${r.fixture} — ${c.name}: ${c.detail}`)),
  "",
  "## Deterministic corrections applied to reviewer output",
  "",
  ...results.flatMap((r) => (r.corrections ?? []).map((c: string) => `- ${r.fixture}: ${c}`)),
  "",
].join("\n");
writeFileSync(join(ROOT, "evals", `${backend.kind}-${stamp}.md`), md);
writeFileSync(join(ROOT, "evals", `latest-${backend.kind}.md`), md);
console.log(`\n${totalPassed}/${totalChecks} checks passed. Wrote evals/${backend.kind}-${stamp}.{json,md}`);
