import { type Clip, type ResearchBrief, ReviewInput, SCHEMA_VERSION, formatIssues } from "../contract.js";
import type { TimeRangeUnitPolicy } from "../config.js";
import { AppError } from "../errors.js";
import { type NormalizedParagraph, normalizeClipRanges, normalizeTranscript, sliceTranscriptForRanges, transcriptCoverage } from "./normalize.js";
import type { ProviderClip, ProviderTranscript } from "./types.js";

export interface AssembleInput {
  research: ResearchBrief;
  projectId: string;
  requestedQuestionIds: string[];
  submittedPrompt: string;
  completedAt: string;
  clips: ProviderClip[];
  transcript: ProviderTranscript | null;
  transcriptError: string | null;
  videoDurationMs: number | null;
  timeRangeUnit: TimeRangeUnitPolicy;
  extraLimitations?: string[];
}

export function assembleReviewInput(a: AssembleInput): ReviewInput {
  const limitations: string[] = [
    "Clips were generated from a prompt derived from audience questions; a clip matching a prompt is not proof that it answers the question.",
    ...(a.extraLimitations ?? []),
  ];

  let paragraphs: NormalizedParagraph[] = [];
  const transcriptLimits: string[] = [];
  const excludedSource: string[] = [];
  if (a.transcriptError) transcriptLimits.push(`Transcript retrieval failed: ${a.transcriptError}`);
  else if (!a.transcript?.paragraphs) transcriptLimits.push("OpusClip reported no transcript for this project.");
  else paragraphs = normalizeTranscript(a.transcript.paragraphs, a.transcript.unit, excludedSource);
  const cov = transcriptCoverage(paragraphs, a.videoDurationMs, a.transcript?.declaredCoverage ?? null);
  if (cov.note && !transcriptLimits.length) transcriptLimits.push(cov.note);
  if (excludedSource.length)
    transcriptLimits.push(`Excluded ${excludedSource.length} provider transcript segment(s) without a positive duration after conversion to ms: ${excludedSource.join(", ")}.`);
  if (paragraphs.length > 0) transcriptLimits.push(`Provider transcript times were in ${a.transcript!.unit === "s" ? "seconds (documented)" : "milliseconds (explicit field names)"}; converted to integer ms.`);

  const clips: Clip[] = a.clips.map((pc) => {
    const norm = normalizeClipRanges(pc.ranges, a.timeRangeUnit);
    if (!norm.ok) limitations.push(`Clip ${pc.id}: source ranges unavailable (${norm.reason}).`);
    const excludedSlices: string[] = [];
    const transcript = norm.ok && paragraphs.length > 0 ? sliceTranscriptForRanges(paragraphs, norm.ranges, pc.id, excludedSlices) : [];
    if (excludedSlices.length) limitations.push(`Clip ${pc.id}: excluded ${excludedSlices.length} zero-length transcript slice(s): ${excludedSlices.join(", ")}.`);
    if (!norm.ok) limitations.push(`Clip ${pc.id}: kept without source ranges or transcript; it is shown as unverifiable, not dropped.`);
    if (norm.ok && paragraphs.length > 0 && transcript.length === 0) limitations.push(`Clip ${pc.id}: no transcript words fall inside its source ranges.`);
    if (pc.exportUrl === null) limitations.push(`Clip ${pc.id}: no export URL available yet.`);
    return {
      id: pc.id,
      title: pc.title,
      previewUrl: pc.previewUrl,
      exportUrl: pc.exportUrl,
      sourceRanges: norm.ranges,
      transcriptStatus: transcript.length > 0 ? "available" : "unavailable",
      transcript,
    };
  });
  const verified = a.clips.map((pc) => normalizeClipRanges(pc.ranges, a.timeRangeUnit)).filter((n) => n.ok);
  if (verified.length > 0 && verified[0].ok) limitations.push(`Clip source range unit: ${verified[0].unit} (${verified[0].basis}).`);
  if (clips.length === 0) limitations.push("OpusClip returned no clips for this project.");

  const reviewInput = {
    schemaVersion: SCHEMA_VERSION,
    research: a.research,
    generation: {
      provider: "opusclip" as const,
      projectId: a.projectId,
      requestedQuestionIds: a.requestedQuestionIds,
      submittedPrompt: a.submittedPrompt,
      completedAt: a.completedAt,
    },
    sourceTranscript: {
      coverage: cov.coverage,
      segments: paragraphs.map(({ id, startMs, endMs, text }) => ({ id, startMs, endMs, text })),
      limitations: transcriptLimits,
    },
    clips,
    limitations,
  };
  const parsed = ReviewInput.safeParse(reviewInput);
  if (!parsed.success) throw new AppError("CONTRACT_VIOLATION", `ReviewInput failed validation: ${formatIssues(parsed.error)}`, null, 500);
  return parsed.data;
}
