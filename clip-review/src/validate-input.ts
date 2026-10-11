// Deterministic validation of the incoming audience-clips.v1 handoff.
// Fatal errors reject the handoff; warnings are carried into the review so that
// affected questions/passages are downgraded instead of silently trusted.
import { ReviewInput, type ReviewInput as ReviewInputT } from "./contract.ts";

export type Issue = { severity: "error" | "warning"; code: string; path: string; message: string };

export type HandoffFacts = {
  /** question id -> evidence ids that exist in research.evidence */
  resolvedEvidence: Map<string, string[]>;
  /** question id -> evidence ids that do not exist */
  danglingEvidence: Map<string, string[]>;
  /** clip id -> clip transcript segment ids whose source span lies inside the clip's sourceRanges */
  citeableSegments: Map<string, Set<string>>;
  /** clip ids whose transcript can be used for judgment */
  clipsWithTranscript: Set<string>;
  /** ids of evidence / transcript segments containing instruction-like text */
  suspectedInjection: { kind: "evidence" | "source_segment" | "clip_segment"; id: string; clipId?: string }[];
  /** [min,max] span covered by the source transcript, if any */
  sourceSpan: { startMs: number; endMs: number } | null;
};

export type HandoffResult =
  | { ok: true; input: ReviewInputT; warnings: Issue[]; facts: HandoffFacts }
  | { ok: false; errors: Issue[] };

const INJECTION =
  /\b(ignore|disregard|forget|override)\b.{0,40}\b(instruction|instructions|prompt|rules|above|previous|prior)\b|\b(system|developer)\s+(prompt|message|instruction)|\byou are now\b|<\/?\s*(system|instructions?|assistant)\s*>|\b(run|execute)\b.{0,20}\b(command|shell|script|tool)\b|\brm\s+-rf\b|\bcurl\s+https?:/i;

export function looksLikeInjection(text: string): boolean {
  return INJECTION.test(text);
}

export function rangeContains(ranges: { startMs: number; endMs: number }[], startMs: number, endMs: number) {
  return ranges.some((r) => startMs >= r.startMs && endMs <= r.endMs);
}

function dupes(ids: string[]): string[] {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const id of ids) (seen.has(id) ? out : seen).add(id);
  return [...out];
}

export function validateHandoff(raw: unknown): HandoffResult {
  const parsed = ReviewInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({
        severity: "error",
        code: "schema",
        path: i.path.join(".") || "(root)",
        message: i.message,
      })),
    };
  }
  const input = parsed.data;
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (code: string, path: string, message: string) => errors.push({ severity: "error", code, path, message });
  const warn = (code: string, path: string, message: string) =>
    warnings.push({ severity: "warning", code, path, message });

  const { research, sourceTranscript, clips } = input;

  // Duplicate IDs make every downstream reference ambiguous: reject.
  const dupChecks: [string, string[]][] = [
    ["research.evidence", research.evidence.map((e) => e.id)],
    ["research.questions", research.questions.map((q) => q.id)],
    ["clips", clips.map((c) => c.id)],
    ["sourceTranscript.segments", sourceTranscript.segments.map((s) => s.id)],
    ...clips.map((c, i) => [`clips[${i}].transcript`, c.transcript.map((s) => s.id)] as [string, string[]]),
  ];
  for (const [path, ids] of dupChecks) {
    for (const d of dupes(ids)) err("duplicate_id", path, `duplicate id "${d}"; ids must be unique`);
  }
  if (errors.length) return { ok: false, errors };

  const evidenceIds = new Set(research.evidence.map((e) => e.id));
  const questionIds = new Set(research.questions.map((q) => q.id));

  // Question -> evidence references.
  const resolvedEvidence = new Map<string, string[]>();
  const danglingEvidence = new Map<string, string[]>();
  research.questions.forEach((q, i) => {
    const ok = q.evidenceIds.filter((id) => evidenceIds.has(id));
    const bad = q.evidenceIds.filter((id) => !evidenceIds.has(id));
    resolvedEvidence.set(q.id, ok);
    danglingEvidence.set(q.id, bad);
    if (bad.length)
      warn("dangling_evidence", `research.questions[${i}].evidenceIds`, `question "${q.id}" cites nonexistent evidence: ${bad.join(", ")}`);
    if (!ok.length)
      warn("question_without_evidence", `research.questions[${i}]`, `question "${q.id}" has no resolvable comment evidence; it cannot be assessed as audience-backed`);
  });

  const coverageVideos = new Set(research.coverage.videoIds);
  research.evidence.forEach((e, i) => {
    if (coverageVideos.size && !coverageVideos.has(e.videoId))
      warn("evidence_outside_coverage", `research.evidence[${i}].videoId`, `evidence "${e.id}" comes from video "${e.videoId}" which is not listed in coverage.videoIds`);
  });

  input.generation.requestedQuestionIds.forEach((id, i) => {
    if (!questionIds.has(id))
      warn("dangling_question", `generation.requestedQuestionIds[${i}]`, `requested question "${id}" does not exist in research.questions`);
  });
  research.generationBrief?.targetQuestionIds.forEach((id, i) => {
    if (!questionIds.has(id))
      warn("dangling_question", `research.generationBrief.targetQuestionIds[${i}]`, `target question "${id}" does not exist in research.questions`);
  });

  // Source transcript sanity.
  const segs = sourceTranscript.segments;
  for (let i = 1; i < segs.length; i++) {
    if (segs[i].startMs < segs[i - 1].startMs)
      warn("source_out_of_order", `sourceTranscript.segments[${i}]`, `segment "${segs[i].id}" starts before the previous segment; source segments should be in playback order`);
  }
  if (sourceTranscript.coverage === "unavailable" && segs.length)
    warn("coverage_mismatch", "sourceTranscript.coverage", "coverage is 'unavailable' but segments were supplied; they will be treated as partial coverage");
  if (sourceTranscript.coverage !== "unavailable" && !segs.length)
    warn("coverage_mismatch", "sourceTranscript.segments", `coverage is '${sourceTranscript.coverage}' but no segments were supplied; treated as unavailable`);
  const sourceSpan = segs.length
    ? { startMs: Math.min(...segs.map((s) => s.startMs)), endMs: Math.max(...segs.map((s) => s.endMs)) }
    : null;

  // Clips: ranges, transcript availability, segment containment.
  const citeableSegments = new Map<string, Set<string>>();
  const clipsWithTranscript = new Set<string>();
  clips.forEach((c, ci) => {
    if (!c.sourceRanges.length)
      warn("missing_source_ranges", `clips[${ci}].sourceRanges`, `clip "${c.id}" has no verified source ranges; it is kept and reported as unverifiable`);
    c.sourceRanges.forEach((r, ri) => {
      if (r.endMs - r.startMs < 1000)
        warn("suspicious_range", `clips[${ci}].sourceRanges[${ri}]`, `clip "${c.id}" range is shorter than 1 second (${r.endMs - r.startMs} ms). Values must be milliseconds; they were not reinterpreted as seconds`);
      if (sourceTranscript.coverage === "full" && sourceSpan && r.endMs > sourceSpan.endMs + 1000)
        warn("range_beyond_source", `clips[${ci}].sourceRanges[${ri}]`, `clip "${c.id}" range ends at ${r.endMs} ms, after the full source transcript ends (${sourceSpan.endMs} ms)`);
    });
    if (c.transcriptStatus === "available" && !c.transcript.length)
      warn("empty_transcript", `clips[${ci}].transcript`, `clip "${c.id}" says transcript is available but it is empty; treated as unavailable`);
    if (c.transcriptStatus === "unavailable" && c.transcript.length)
      warn("transcript_status_mismatch", `clips[${ci}].transcriptStatus`, `clip "${c.id}" is marked unavailable but includes transcript segments; they will not be used`);

    const citeable = new Set<string>();
    if (c.transcriptStatus === "available") {
      c.transcript.forEach((s, si) => {
        if (rangeContains(c.sourceRanges, s.sourceStartMs, s.sourceEndMs)) citeable.add(s.id);
        else
          warn("segment_out_of_range", `clips[${ci}].transcript[${si}]`, `clip "${c.id}" segment "${s.id}" (${s.sourceStartMs}-${s.sourceEndMs} ms) is outside the clip's source ranges; it cannot be cited as an answer`);
      });
      if (citeable.size) clipsWithTranscript.add(c.id);
    }
    citeableSegments.set(c.id, citeable);
  });

  const suspectedInjection: HandoffFacts["suspectedInjection"] = [];
  for (const e of research.evidence) if (looksLikeInjection(e.quote)) suspectedInjection.push({ kind: "evidence", id: e.id });
  for (const s of segs) if (looksLikeInjection(s.text)) suspectedInjection.push({ kind: "source_segment", id: s.id });
  for (const c of clips)
    for (const s of c.transcript)
      if (looksLikeInjection(s.text)) suspectedInjection.push({ kind: "clip_segment", id: s.id, clipId: c.id });
  for (const s of suspectedInjection)
    warn("instruction_like_text", s.kind === "evidence" ? "research.evidence" : s.kind === "source_segment" ? "sourceTranscript.segments" : `clips(${s.clipId}).transcript`, `"${s.id}" contains instruction-like text; it is treated strictly as untrusted data`);

  return {
    ok: true,
    input,
    warnings,
    facts: { resolvedEvidence, danglingEvidence, citeableSegments, clipsWithTranscript, suspectedInjection, sourceSpan },
  };
}
