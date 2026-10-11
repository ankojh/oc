// Review pipeline: validate handoff -> build reviewer packet -> backend judgment
// -> deterministic assembly -> independent report verification.
import { ReviewReport, type ReviewReport as ReviewReportT } from "./contract.ts";
import { validateHandoff, type Issue } from "./validate-input.ts";
import { buildPacket } from "./agent/packet.ts";
import { Judgment } from "./agent/judgment.ts";
import type { BackendRun, ReviewerBackend } from "./agent/backends.ts";
import { assembleFromJudgment, assembleWithoutModel, type Audit } from "./assemble.ts";
import { verifyReport } from "./verify-report.ts";
import { canonicalJson, sha256 } from "./canonical.ts";

export const REVIEWER_VERSION = "clip-review@0.1.0";

export type ReviewOutcome =
  | { ok: true; report: ReviewReportT; audit: Audit; warnings: Issue[]; reviewer: BackendRun["meta"] | { backend: "none"; reason: string } }
  | { ok: false; stage: "validation" | "reviewer" | "verification"; errors: Issue[] };

export { canonicalJson };

export function hashInput(raw: unknown): string {
  return sha256(canonicalJson(raw));
}

export async function runReview(
  raw: unknown,
  backend: ReviewerBackend,
  opts: { signal?: AbortSignal; onProgress?: (msg: string) => void } = {},
): Promise<ReviewOutcome> {
  const progress = opts.onProgress ?? (() => {});
  progress("Validating handoff");
  const v = validateHandoff(raw);
  if (!v.ok) return { ok: false, stage: "validation", errors: v.errors };
  const { input, warnings, facts } = v;

  const { packet, limitations } = buildPacket(input, facts);
  const ctx = { input, facts, warnings, extraLimitations: limitations };

  const early = assembleWithoutModel(ctx);
  let assembled: { report: ReviewReportT; audit: Audit };
  let reviewer: Extract<ReviewOutcome, { ok: true }>["reviewer"];
  if (early) {
    progress("Handoff cannot support semantic review; producing deterministic report");
    assembled = early;
    reviewer = { backend: "none", reason: `status ${early.report.status}: reviewer model not invoked` };
  } else {
    let run: BackendRun;
    try {
      run = await backend.judge(packet, { runId: input.research.runId, mode: input.research.mode, inputHash: hashInput(raw), signal: opts.signal, onProgress: progress });
    } catch (e: any) {
      return { ok: false, stage: "reviewer", errors: [{ severity: "error", code: "reviewer_failed", path: "(reviewer)", message: e?.message ?? String(e) }] };
    }
    const parsed = Judgment.safeParse(run.output);
    if (!parsed.success)
      return {
        ok: false,
        stage: "reviewer",
        errors: parsed.error.issues.map((i) => ({ severity: "error", code: "reviewer_output_invalid", path: i.path.join("."), message: i.message })),
      };
    progress("Verifying reviewer claims against transcripts and comments");
    assembled = assembleFromJudgment(ctx, parsed.data);
    if (run.meta.toolActivity.length)
      assembled.report.limitations.push(`Reviewer attempted tool activity, which is not needed and was sandboxed: ${run.meta.toolActivity.join("; ")}`);
    reviewer = run.meta;
  }

  const report = ReviewReport.parse(assembled.report);
  const violations = verifyReport(input, report);
  if (violations.length)
    return { ok: false, stage: "verification", errors: violations.map((m) => ({ severity: "error", code: "report_invalid", path: "(report)", message: m })) };
  progress("Review complete");
  return { ok: true, report, audit: assembled.audit, warnings, reviewer };
}
