// Turns the reviewer's semantic judgment into a contract-valid ReviewReport.
// Deterministic rules here enforce references, quotes, ranges, and honest
// absence claims; anything unverifiable is downgraded and explained.
import type { Match, Recommendation, ReviewInput, ReviewReport, UnansweredQuestion, Verdict } from "./contract.ts";
import type { Judgment } from "./agent/judgment.ts";
import type { HandoffFacts, Issue } from "./validate-input.ts";
import { rangeContains } from "./validate-input.ts";
import { quoteMatches } from "./text.ts";

export type QuestionCheck = {
  questionId: string;
  support: "supported" | "weak" | "unsupported" | "unchecked";
  supportingEvidenceIds: string[];
  kindIssue: string | null;
  explanation: string;
};

export type Audit = {
  questionChecks: QuestionCheck[];
  /** Every place the deterministic layer overrode or discarded reviewer output. */
  corrections: string[];
};

type Ctx = { input: ReviewInput; facts: HandoffFacts; warnings: Issue[]; extraLimitations: string[] };

function baseLimitations({ input, facts, warnings, extraLimitations }: Ctx): string[] {
  const out: string[] = [];
  if (input.research.mode === "fixture") out.push("FIXTURE DATA: this review was produced from synthetic fixture research, not live audience data.");
  for (const l of input.limitations) out.push(`Handoff: ${l}`);
  for (const l of input.research.coverage.limitations) out.push(`Research coverage: ${l}`);
  out.push(
    `Research coverage: ${input.research.coverage.commentCount} comments via "${input.research.coverage.samplingMethod}"; questions reflect that sample, not the whole audience.`,
  );
  if (input.sourceTranscript.coverage !== "full" || !input.sourceTranscript.segments.length)
    out.push(`Source transcript coverage is ${input.sourceTranscript.segments.length ? input.sourceTranscript.coverage : "unavailable"}; absence of an answer in the source cannot be fully established.`);
  for (const l of input.sourceTranscript.limitations) out.push(`Source transcript: ${l}`);
  for (const w of warnings) out.push(`Validation: ${w.message}`);
  if (facts.suspectedInjection.length)
    out.push(`Instruction-like text found in untrusted content (${facts.suspectedInjection.map((s) => s.id).join(", ")}); it was treated as data and did not alter reviewer instructions.`);
  const requested = input.generation.requestedQuestionIds;
  if (requested.length)
    out.push(`Generation requested clips for ${requested.join(", ")}; that request was not treated as evidence that any clip answers those questions.`);
  out.push(...extraLimitations);
  return out;
}

function deterministicUnverifiableMatches(input: ReviewInput, facts: HandoffFacts, why: (clipId: string) => string): Match[] {
  return input.research.questions.flatMap((q) =>
    input.clips.map((c) => ({
      questionId: q.id,
      clipId: c.id,
      verdict: "unverifiable" as Verdict,
      explanation: why(c.id),
      commentEvidenceIds: facts.resolvedEvidence.get(q.id) ?? [],
      answerPassages: [],
      contextWarnings: [],
      limitations: [why(c.id)],
    })),
  );
}

/** Report for handoffs the reviewer model should not be asked to judge. */
export function assembleWithoutModel(ctx: Ctx): { report: ReviewReport; audit: Audit } | null {
  const { input, facts } = ctx;
  const r = input.research;
  const base = { schemaVersion: "audience-clips.v1" as const, runId: r.runId, mode: r.mode, recommendations: [] };
  const audit: Audit = { questionChecks: [], corrections: [] };

  if (r.researchStatus === "insufficient_evidence" || r.questions.length === 0) {
    return {
      audit,
      report: {
        ...base,
        status: "insufficient_evidence",
        matches: [],
        unansweredQuestions: r.questions.map((q) => ({
          questionId: q.id,
          status: "cannot_assess",
          explanation: "Research reported insufficient audience evidence, so clips were not matched to this question.",
        })),
        limitations: [
          ...baseLimitations(ctx),
          r.questions.length ? "Research status is insufficient_evidence; no recommendations were made." : "Research contained no audience questions; nothing to match.",
        ],
      },
    };
  }

  if (facts.clipsWithTranscript.size === 0) {
    const why = (clipId: string) => {
      const c = input.clips.find((x) => x.id === clipId)!;
      return c.transcriptStatus === "unavailable" || !c.transcript.length
        ? "Clip transcript is unavailable, so whether this clip answers the question cannot be verified."
        : "None of this clip's transcript segments fall inside its source ranges, so no passage can be verified.";
    };
    return {
      audit,
      report: {
        ...base,
        status: "unverifiable",
        matches: deterministicUnverifiableMatches(input, facts, why),
        unansweredQuestions: r.questions.map((q) => ({
          questionId: q.id,
          status: "cannot_assess",
          explanation: input.clips.length
            ? "No generated clip has a usable transcript, so answers could not be verified."
            : "No generated clips were supplied.",
        })),
        limitations: [...baseLimitations(ctx), "No clip transcripts were usable; the review could not verify any answer."],
      },
    };
  }
  return null;
}

export function assembleFromJudgment(ctx: Ctx, j: Judgment): { report: ReviewReport; audit: Audit } {
  const { input, facts } = ctx;
  const r = input.research;
  const corrections: string[] = [];
  const reviewerLimitations: string[] = [];
  const questionIds = new Set(r.questions.map((q) => q.id));
  const clipById = new Map(input.clips.map((c) => [c.id, c]));
  const sourceById = new Map(input.sourceTranscript.segments.map((s) => [s.id, s]));

  // ---- question support ----
  const checks = new Map<string, QuestionCheck>();
  for (const qc of j.questionChecks) {
    if (!questionIds.has(qc.questionId)) {
      corrections.push(`Discarded question check for unknown question "${qc.questionId}".`);
      continue;
    }
    if (checks.has(qc.questionId)) continue;
    const resolved = facts.resolvedEvidence.get(qc.questionId) ?? [];
    const bogus = qc.supportingEvidenceIds.filter((e) => !resolved.includes(e));
    if (bogus.length) corrections.push(`Removed evidence ids not cited by "${qc.questionId}": ${bogus.join(", ")}.`);
    checks.set(qc.questionId, { ...qc, supportingEvidenceIds: qc.supportingEvidenceIds.filter((e) => resolved.includes(e)) });
  }
  for (const q of r.questions) {
    const resolved = facts.resolvedEvidence.get(q.id) ?? [];
    let c = checks.get(q.id);
    if (!c) {
      c = { questionId: q.id, support: "unchecked", supportingEvidenceIds: resolved, kindIssue: null, explanation: "Reviewer did not report a support check." };
      corrections.push(`Reviewer returned no support check for "${q.id}".`);
    }
    if (!resolved.length && c.support !== "unsupported") {
      corrections.push(`"${q.id}" has no resolvable evidence; marked unsupported regardless of reviewer output.`);
      c = { ...c, support: "unsupported", supportingEvidenceIds: [], explanation: "None of the cited comment evidence exists in the handoff." };
    }
    if (c.support !== "unsupported" && !c.supportingEvidenceIds.length) c = { ...c, supportingEvidenceIds: resolved };
    checks.set(q.id, c);
  }
  const unsupported = new Set([...checks.values()].filter((c) => c.support === "unsupported").map((c) => c.questionId));

  // ---- matches ----
  const modelMatches = new Map<string, Judgment["matches"][number]>();
  for (const m of j.matches) {
    const key = `${m.questionId}|${m.clipId}`;
    if (!questionIds.has(m.questionId) || !clipById.has(m.clipId)) {
      corrections.push(`Discarded match referencing unknown ids (${key}).`);
      continue;
    }
    if (modelMatches.has(key)) corrections.push(`Discarded duplicate match for ${key}.`);
    else modelMatches.set(key, m);
  }

  const matches: Match[] = [];
  for (const q of r.questions) {
    const check = checks.get(q.id)!;
    for (const clip of input.clips) {
      const key = `${q.id}|${clip.id}`;
      const qLimits: string[] = [];
      if (unsupported.has(q.id)) qLimits.push(`The research question is not supported by its cited comments: ${check.explanation}`);
      else if (check.support === "weak") qLimits.push(`The cited comments only weakly support this question: ${check.explanation}`);
      if (q.kind === "inferred") qLimits.push("This is an inferred question, not one asked verbatim by commenters.");
      if (check.kindIssue) qLimits.push(`Question label issue: ${check.kindIssue}`);

      if (!facts.clipsWithTranscript.has(clip.id)) {
        const why = "Clip transcript is unavailable or outside its source ranges, so an answer cannot be verified.";
        if (modelMatches.has(key)) corrections.push(`Ignored reviewer verdict for ${key}: clip has no usable transcript.`);
        matches.push({ questionId: q.id, clipId: clip.id, verdict: "unverifiable", explanation: why, commentEvidenceIds: check.supportingEvidenceIds, answerPassages: [], contextWarnings: [], limitations: [why, ...qLimits] });
        continue;
      }
      const m = modelMatches.get(key);
      if (!m) {
        corrections.push(`Reviewer returned no verdict for ${key}; recorded as unverifiable.`);
        matches.push({ questionId: q.id, clipId: clip.id, verdict: "unverifiable", explanation: "The reviewer did not assess this pair.", commentEvidenceIds: check.supportingEvidenceIds, answerPassages: [], contextWarnings: [], limitations: ["Not assessed by the reviewer.", ...qLimits] });
        continue;
      }

      const citeable = facts.citeableSegments.get(clip.id)!;
      const passages: Match["answerPassages"] = [];
      const limits = [...m.limitations, ...qLimits];
      for (const a of m.verdict === "no_match" ? [] : m.answerPassages) {
        const seg = clip.transcript.find((s) => s.id === a.clipTranscriptSegmentId);
        if (!seg) {
          corrections.push(`${key}: dropped passage citing nonexistent segment "${a.clipTranscriptSegmentId}".`);
          continue;
        }
        if (!citeable.has(seg.id) || !rangeContains(clip.sourceRanges, seg.sourceStartMs, seg.sourceEndMs)) {
          corrections.push(`${key}: dropped passage "${seg.id}" because it lies outside the clip's source ranges.`);
          limits.push(`A cited passage (${seg.id}) lies outside the clip's source ranges and was not accepted.`);
          continue;
        }
        if (!quoteMatches(seg.text, a.quote)) {
          corrections.push(`${key}: dropped passage "${seg.id}" because the quote does not match the transcript.`);
          limits.push(`A cited quote did not match transcript segment ${seg.id} and was not accepted.`);
          continue;
        }
        if (passages.some((p) => p.clipTranscriptSegmentId === seg.id && p.quote === a.quote)) continue;
        passages.push({ clipTranscriptSegmentId: seg.id, quote: a.quote.trim(), sourceStartMs: seg.sourceStartMs, sourceEndMs: seg.sourceEndMs });
      }

      let verdict: Verdict = m.verdict;
      let explanation = m.explanation;
      if ((verdict === "direct" || verdict === "partial") && passages.length === 0) {
        corrections.push(`${key}: reviewer said "${verdict}" without a verifiable passage; downgraded to unverifiable.`);
        limits.push(`The reviewer judged this "${verdict}" but no cited passage could be verified against the clip transcript.`);
        verdict = "unverifiable";
        explanation = `Unverified: ${explanation}`;
      }

      const contextWarnings: Match["contextWarnings"] = [];
      for (const w of m.contextWarnings) {
        const ids = w.sourceSegmentIds.filter((id) => sourceById.has(id));
        if (ids.length !== w.sourceSegmentIds.length)
          corrections.push(`${key}: removed unknown source segment ids from a context warning.`);
        const outside = ids.filter((id) => {
          const s = sourceById.get(id)!;
          return !rangeContains(clip.sourceRanges, s.startMs, s.endMs);
        });
        if (!outside.length) {
          corrections.push(`${key}: dropped context warning without supporting source text outside the clip ("${w.explanation.slice(0, 80)}").`);
          limits.push(`Possible missing context was noted but no source passage outside the clip supports it: ${w.explanation}`);
          continue;
        }
        contextWarnings.push({ explanation: w.explanation, sourceSegmentIds: ids });
      }

      matches.push({ questionId: q.id, clipId: clip.id, verdict, explanation, commentEvidenceIds: check.supportingEvidenceIds, answerPassages: passages, contextWarnings, limitations: [...new Set(limits)] });
    }
  }
  const matchByKey = new Map(matches.map((m) => [`${m.questionId}|${m.clipId}`, m]));
  const strong = (q: string, c: string) => ["direct", "partial"].includes(matchByKey.get(`${q}|${c}`)?.verdict ?? "");

  // ---- recommendations ----
  const recs: Recommendation[] = [];
  const covered: { q: string; ranges: { s: number; e: number }[] }[] = [];
  for (const rec of [...j.recommendations].sort((a, b) => a.rank - b.rank)) {
    if (recs.length >= 3) {
      corrections.push(`Dropped recommendation of "${rec.clipId}": at most three recommendations.`);
      continue;
    }
    if (!clipById.has(rec.clipId) || recs.some((x) => x.clipId === rec.clipId)) {
      corrections.push(`Dropped recommendation of unknown or duplicate clip "${rec.clipId}".`);
      continue;
    }
    const qs = [...new Set(rec.questionIds)].filter((q) => {
      if (!questionIds.has(q)) return corrections.push(`Recommendation "${rec.clipId}": removed unknown question "${q}".`), false;
      if (unsupported.has(q)) return corrections.push(`Recommendation "${rec.clipId}": removed "${q}" because the question is unsupported by its comments.`), false;
      if (!strong(q, rec.clipId)) return corrections.push(`Recommendation "${rec.clipId}": removed "${q}" because there is no verified direct/partial answer.`), false;
      return true;
    });
    if (!qs.length) {
      corrections.push(`Dropped recommendation of "${rec.clipId}": no verified answer to a supported question.`);
      continue;
    }
    // Repetition guard: same questions answered from overlapping source footage adds no coverage.
    const spans = (q: string) => matchByKey.get(`${q}|${rec.clipId}`)!.answerPassages.map((p) => ({ s: p.sourceStartMs, e: p.sourceEndMs }));
    const repeats = qs.every((q) =>
      covered.some((c) => c.q === q && c.ranges.some((a) => spans(q).some((b) => b.s < a.e && a.s < b.e))),
    );
    if (repeats) {
      corrections.push(`Dropped recommendation of "${rec.clipId}": it repeats an answer from overlapping footage already recommended.`);
      continue;
    }
    for (const q of qs) covered.push({ q, ranges: spans(q) });
    recs.push({ rank: recs.length + 1, clipId: rec.clipId, questionIds: qs, reason: rec.reason });
  }

  // ---- unanswered ----
  const hasSource = input.sourceTranscript.segments.length > 0;
  const modelUnanswered = new Map(j.unansweredQuestions.filter((u) => questionIds.has(u.questionId)).map((u) => [u.questionId, u]));
  const unanswered: UnansweredQuestion[] = [];
  for (const q of r.questions) {
    const qMatches = matches.filter((m) => m.questionId === q.id);
    if (qMatches.some((m) => m.verdict === "direct" || m.verdict === "partial")) {
      if (modelUnanswered.has(q.id) && qMatches.some((m) => m.verdict === "direct"))
        corrections.push(`"${q.id}" was listed as unanswered but has a verified direct answer; removed from unanswered.`);
      continue;
    }
    const mu = modelUnanswered.get(q.id);
    let status: UnansweredQuestion["status"] = mu?.status ?? "not_found_in_generated_clips";
    let explanation = mu?.explanation ?? "No generated clip answers this question.";
    if (unsupported.has(q.id)) {
      status = "cannot_assess";
      explanation = `The cited comments do not support this question, so it was not treated as an audience question. ${mu?.explanation ?? ""}`.trim();
    } else if (qMatches.every((m) => m.verdict === "unverifiable")) {
      status = "cannot_assess";
      explanation = "No clip could be verified for this question (missing transcripts or unverifiable passages).";
    } else if (status === "not_found_in_available_source") {
      if (!hasSource || !ctx.facts.sourceSpan) {
        corrections.push(`"${q.id}": source-absence claim downgraded because no source transcript was available.`);
        status = "not_found_in_generated_clips";
        explanation = `${explanation} No source transcript was available, so the full video was not checked.`;
      } else if (ctx.extraLimitations.some((l) => l.includes("exceeds the reviewer packet budget"))) {
        corrections.push(`"${q.id}": source-absence claim downgraded because the reviewer only saw part of the source.`);
        status = "not_found_in_generated_clips";
      } else if (input.sourceTranscript.coverage !== "full") {
        explanation = `${explanation} Source transcript coverage is partial, so the answer may exist in untranscribed portions.`;
      }
    } else if (status === "cannot_assess" && !mu) {
      status = "not_found_in_generated_clips";
    }
    unanswered.push({ questionId: q.id, status, explanation });
  }

  for (const c of checks.values()) {
    if (c.support === "unsupported") reviewerLimitations.push(`Research claim flagged: question "${c.questionId}" is not supported by its cited comments. ${c.explanation}`);
    if (c.kindIssue) reviewerLimitations.push(`Research label flagged for "${c.questionId}": ${c.kindIssue}`);
  }
  reviewerLimitations.push(...j.limitations.map((l) => `Reviewer: ${l}`));
  if (corrections.length) reviewerLimitations.push(`Verification: ${corrections.length} reviewer claim(s) were corrected or discarded by deterministic checks (see audit).`);

  return {
    audit: { questionChecks: [...checks.values()], corrections },
    report: {
      schemaVersion: "audience-clips.v1",
      runId: r.runId,
      mode: r.mode,
      status: "complete",
      matches,
      recommendations: recs,
      unansweredQuestions: unanswered,
      limitations: [...baseLimitations(ctx), ...reviewerLimitations],
    },
  };
}
