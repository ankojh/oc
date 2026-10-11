// Compares a ReviewReport with a fixture's hand-labelled expectations.
// Used by tests (recorded responses) and by scripts/eval.ts (live Codex).
import type { ReviewReport } from "./contract.ts";
import type { Audit } from "./assemble.ts";

export type Expected = {
  runId: string;
  scenario: string;
  description: string;
  status: ReviewReport["status"];
  verdicts: Record<string, string[]>;
  contextWarningRequired?: { pair: string; anyOfSourceIds: string[] }[];
  contextWarningForbidden?: string[];
  contextWarningMustNotCite?: { pair: string; ids: string[] }[];
  unansweredExplanationIncludes?: Record<string, string>;
  unsupportedQuestions?: string[];
  unanswered?: Record<string, string[]>;
  answered?: string[];
  recommendations?: { mustInclude?: string[]; mustExclude?: string[]; atMostOneOf?: string[][]; maxCount?: number };
};

export type CheckResult = { name: string; pass: boolean; detail: string };

export function checkExpectations(report: ReviewReport, audit: Audit | null, exp: Expected): CheckResult[] {
  const out: CheckResult[] = [];
  const add = (name: string, pass: boolean, detail: string) => out.push({ name, pass, detail });
  const match = (pair: string) => report.matches.find((m) => `${m.questionId}|${m.clipId}` === pair);

  add("status", report.status === exp.status, `got ${report.status}, expected ${exp.status}`);
  for (const [pair, allowed] of Object.entries(exp.verdicts)) {
    const m = match(pair);
    add(`verdict ${pair}`, !!m && allowed.includes(m.verdict), `got ${m?.verdict ?? "missing"}, allowed ${allowed.join("/")}`);
  }
  for (const req of exp.contextWarningRequired ?? []) {
    const ws = match(req.pair)?.contextWarnings ?? [];
    const ok = ws.some((w) => w.sourceSegmentIds.some((id) => req.anyOfSourceIds.includes(id)));
    add(`context warning ${req.pair}`, ok, ok ? "present with supporting source" : `missing (warnings: ${JSON.stringify(ws)})`);
  }
  for (const pair of exp.contextWarningForbidden ?? []) {
    const ws = match(pair)?.contextWarnings ?? [];
    add(`no unsupported context warning ${pair}`, ws.length === 0, ws.length ? JSON.stringify(ws) : "none");
  }
  for (const { pair, ids } of exp.contextWarningMustNotCite ?? []) {
    const cited = (match(pair)?.contextWarnings ?? []).flatMap((w) => w.sourceSegmentIds).filter((id) => ids.includes(id));
    add(`context warning ${pair} cites only available source`, cited.length === 0, cited.length ? `cites ${cited.join(", ")}` : "ok");
  }
  for (const [q, text] of Object.entries(exp.unansweredExplanationIncludes ?? {})) {
    const u = report.unansweredQuestions.find((x) => x.questionId === q);
    add(`unanswered ${q} explanation mentions "${text}"`, !u || u.explanation.toLowerCase().includes(text), u?.explanation ?? "not listed");
  }
  for (const q of exp.unsupportedQuestions ?? []) {
    const flaggedInAudit = audit ? audit.questionChecks.some((c) => c.questionId === q && c.support === "unsupported") : true;
    const flaggedInReport = report.limitations.some((l) => l.includes(`"${q}"`) && /not supported/i.test(l));
    const notRecommended = report.recommendations.every((r) => !r.questionIds.includes(q));
    add(`unsupported ${q}`, flaggedInAudit && flaggedInReport && notRecommended, `audit=${flaggedInAudit} report=${flaggedInReport} notRecommended=${notRecommended}`);
  }
  for (const [q, allowed] of Object.entries(exp.unanswered ?? {})) {
    const u = report.unansweredQuestions.find((x) => x.questionId === q);
    add(`unanswered ${q}`, !!u && allowed.includes(u.status), `got ${u?.status ?? "not listed"}, allowed ${allowed.join("/")}`);
  }
  for (const q of exp.answered ?? []) {
    const u = report.unansweredQuestions.find((x) => x.questionId === q);
    add(`answered ${q}`, !u, u ? `listed as ${u.status}` : "not in unanswered");
  }
  const recs = report.recommendations.map((r) => r.clipId);
  const r = exp.recommendations ?? {};
  for (const c of r.mustInclude ?? []) add(`recommends ${c}`, recs.includes(c), `recommended: [${recs.join(", ")}]`);
  for (const c of r.mustExclude ?? []) add(`does not recommend ${c}`, !recs.includes(c), `recommended: [${recs.join(", ")}]`);
  for (const group of r.atMostOneOf ?? []) {
    const n = recs.filter((c) => group.includes(c)).length;
    add(`at most one of ${group.join("/")}`, n <= 1, `${n} recommended: [${recs.join(", ")}]`);
  }
  if (r.maxCount !== undefined) add(`at most ${r.maxCount} recommendations`, recs.length <= r.maxCount, `got ${recs.length}`);
  return out;
}
