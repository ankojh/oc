// Independent deterministic gate for any ReviewReport against its ReviewInput.
// The assembler should never produce violations; this catches bugs and lets
// other builders check reports they receive.
import { ReviewReport, type ReviewInput } from "./contract.ts";
import { rangeContains } from "./validate-input.ts";
import { quoteMatches } from "./text.ts";

export function verifyReport(input: ReviewInput, raw: unknown): string[] {
  const parsed = ReviewReport.safeParse(raw);
  if (!parsed.success) return parsed.error.issues.map((i) => `schema: ${i.path.join(".")}: ${i.message}`);
  const report = parsed.data;
  const v: string[] = [];
  const { research } = input;

  if (report.runId !== research.runId) v.push(`runId "${report.runId}" does not match research runId "${research.runId}"`);
  if (report.mode !== research.mode) v.push(`mode "${report.mode}" does not match research mode "${research.mode}"`);

  const questions = new Map(research.questions.map((q) => [q.id, q]));
  const clips = new Map(input.clips.map((c) => [c.id, c]));
  const sourceIds = new Set(input.sourceTranscript.segments.map((s) => s.id));
  const strong = new Set<string>(); // `${q}|${clip}` with direct/partial
  const direct = new Set<string>();
  const seenPairs = new Set<string>();

  report.matches.forEach((m, i) => {
    const p = `matches[${i}]`;
    const q = questions.get(m.questionId);
    const c = clips.get(m.clipId);
    if (!q) v.push(`${p}: unknown questionId "${m.questionId}"`);
    if (!c) v.push(`${p}: unknown clipId "${m.clipId}"`);
    const key = `${m.questionId}|${m.clipId}`;
    if (seenPairs.has(key)) v.push(`${p}: duplicate match for ${key}`);
    seenPairs.add(key);
    if (q) for (const e of m.commentEvidenceIds) if (!q.evidenceIds.includes(e) || !research.evidence.some((x) => x.id === e))
      v.push(`${p}: commentEvidenceId "${e}" is not existing evidence cited by question "${q.id}"`);
    if ((m.verdict === "direct" || m.verdict === "partial") && m.answerPassages.length === 0)
      v.push(`${p}: verdict "${m.verdict}" requires at least one answer passage`);
    if (m.verdict === "direct" || m.verdict === "partial") strong.add(key);
    if (m.verdict === "direct") direct.add(m.questionId);
    if (c) {
      m.answerPassages.forEach((a, j) => {
        const pp = `${p}.answerPassages[${j}]`;
        if (c.transcriptStatus !== "available") return void v.push(`${pp}: clip "${c.id}" has no available transcript`);
        const seg = c.transcript.find((s) => s.id === a.clipTranscriptSegmentId);
        if (!seg) return void v.push(`${pp}: segment "${a.clipTranscriptSegmentId}" not in clip "${c.id}" transcript`);
        if (!quoteMatches(seg.text, a.quote)) v.push(`${pp}: quote does not match segment "${seg.id}" text`);
        if (a.sourceStartMs < seg.sourceStartMs || a.sourceEndMs > seg.sourceEndMs || a.sourceEndMs <= a.sourceStartMs)
          v.push(`${pp}: times ${a.sourceStartMs}-${a.sourceEndMs} ms are outside segment "${seg.id}" (${seg.sourceStartMs}-${seg.sourceEndMs} ms)`);
        if (!rangeContains(c.sourceRanges, a.sourceStartMs, a.sourceEndMs))
          v.push(`${pp}: passage ${a.sourceStartMs}-${a.sourceEndMs} ms is not inside clip "${c.id}" source ranges`);
      });
    }
    m.contextWarnings.forEach((w, j) => {
      for (const id of w.sourceSegmentIds) if (!sourceIds.has(id)) v.push(`${p}.contextWarnings[${j}]: unknown source segment "${id}"`);
    });
  });

  const ranks = report.recommendations.map((r) => r.rank);
  if (ranks.some((r, i) => r !== i + 1)) v.push(`recommendations: ranks must be 1..n in order, got ${ranks.join(",")}`);
  const recClips = new Set<string>();
  report.recommendations.forEach((r, i) => {
    if (!clips.has(r.clipId)) v.push(`recommendations[${i}]: unknown clipId "${r.clipId}"`);
    if (recClips.has(r.clipId)) v.push(`recommendations[${i}]: clip "${r.clipId}" recommended twice`);
    recClips.add(r.clipId);
    for (const q of r.questionIds) {
      if (!questions.has(q)) v.push(`recommendations[${i}]: unknown questionId "${q}"`);
      else if (!strong.has(`${q}|${r.clipId}`)) v.push(`recommendations[${i}]: clip "${r.clipId}" has no direct/partial match for "${q}"`);
    }
  });

  const seenUnanswered = new Set<string>();
  report.unansweredQuestions.forEach((u, i) => {
    if (!questions.has(u.questionId)) v.push(`unansweredQuestions[${i}]: unknown questionId "${u.questionId}"`);
    if (seenUnanswered.has(u.questionId)) v.push(`unansweredQuestions[${i}]: duplicate questionId "${u.questionId}"`);
    seenUnanswered.add(u.questionId);
    if (direct.has(u.questionId)) v.push(`unansweredQuestions[${i}]: "${u.questionId}" has a direct match`);
    if (u.status === "not_found_in_available_source" && input.sourceTranscript.segments.length === 0)
      v.push(`unansweredQuestions[${i}]: cannot claim not_found_in_available_source without source transcript segments`);
  });
  return v;
}
