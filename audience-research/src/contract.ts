// audience-clips.v1 — the integration contract shared with the review agent.
// Field names here are the contract. All timestamps are UTC ISO strings, all
// normalized video times are integer milliseconds.
import { z } from "zod";

export const SCHEMA_VERSION = "audience-clips.v1" as const;

const utcIso = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/, "must be a UTC ISO-8601 timestamp ending in Z");
const ms = z.number().int().nonnegative();

export const VideoRef = z.object({
  url: z.string().url(),
  videoId: z.string().min(1),
  channelId: z.string().min(1),
  title: z.string(),
});

export const Coverage = z.object({
  fetchedAt: utcIso,
  videoIds: z.array(z.string().min(1)),
  commentCount: z.number().int().nonnegative(),
  samplingMethod: z.string().min(1),
  limitations: z.array(z.string()),
});

export const Evidence = z.object({
  id: z.string().min(1),
  commentId: z.string().min(1),
  videoId: z.string().min(1),
  url: z.string().url(),
  quote: z.string().min(1),
  publishedAt: utcIso,
});

export const Question = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  kind: z.enum(["explicit", "inferred"]),
  evidenceIds: z.array(z.string().min(1)).min(1),
  observedCommentCount: z.number().int().positive(),
  priority: z.number().int().positive(),
  rationale: z.string().min(1),
});

export const GenerationBrief = z.object({
  targetQuestionIds: z.array(z.string().min(1)).min(1),
  customPrompt: z.string().min(1),
  durationSec: z.tuple([z.number().int().nonnegative(), z.number().int().positive()]),
  aspectRatio: z.enum(["portrait", "landscape", "square"]),
});

export const ResearchBrief = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    runId: z.string().min(1),
    mode: z.enum(["live", "fixture"]),
    video: VideoRef,
    creatorGoal: z.string().nullable(),
    researchStatus: z.enum(["ready", "insufficient_evidence"]),
    coverage: Coverage,
    evidence: z.array(Evidence),
    questions: z.array(Question).max(3),
    generationBrief: GenerationBrief.nullable(),
  })
  .superRefine((b, ctx) => {
    const evidenceIds = new Set<string>();
    for (const [i, e] of b.evidence.entries()) {
      if (evidenceIds.has(e.id)) ctx.addIssue({ code: "custom", path: ["evidence", i, "id"], message: `duplicate evidence id ${e.id}` });
      evidenceIds.add(e.id);
      if (!b.coverage.videoIds.includes(e.videoId))
        ctx.addIssue({ code: "custom", path: ["evidence", i, "videoId"], message: `evidence video ${e.videoId} is not in coverage.videoIds` });
    }
    const commentIds = b.evidence.map((e) => e.commentId);
    if (new Set(commentIds).size !== commentIds.length)
      ctx.addIssue({ code: "custom", path: ["evidence"], message: "the same comment appears as evidence more than once" });

    const questionIds = new Set<string>();
    const priorities = new Set<number>();
    for (const [i, q] of b.questions.entries()) {
      if (questionIds.has(q.id)) ctx.addIssue({ code: "custom", path: ["questions", i, "id"], message: `duplicate question id ${q.id}` });
      questionIds.add(q.id);
      if (priorities.has(q.priority)) ctx.addIssue({ code: "custom", path: ["questions", i, "priority"], message: "priorities must be unique" });
      priorities.add(q.priority);
      for (const id of q.evidenceIds)
        if (!evidenceIds.has(id))
          ctx.addIssue({ code: "custom", path: ["questions", i, "evidenceIds"], message: `evidence id ${id} does not resolve` });
      if (new Set(q.evidenceIds).size !== q.evidenceIds.length)
        ctx.addIssue({ code: "custom", path: ["questions", i, "evidenceIds"], message: "evidence ids must be unique" });
      if (q.observedCommentCount !== q.evidenceIds.length)
        ctx.addIssue({
          code: "custom",
          path: ["questions", i, "observedCommentCount"],
          message: "observedCommentCount must equal the number of unique supporting comments",
        });
    }

    if (b.researchStatus === "ready") {
      if (b.questions.length === 0) ctx.addIssue({ code: "custom", path: ["questions"], message: "ready research needs at least one question" });
      if (!b.generationBrief) ctx.addIssue({ code: "custom", path: ["generationBrief"], message: "ready research needs a generationBrief" });
    } else {
      if (b.questions.length > 0) ctx.addIssue({ code: "custom", path: ["questions"], message: "insufficient_evidence must not list questions" });
      if (b.generationBrief) ctx.addIssue({ code: "custom", path: ["generationBrief"], message: "insufficient_evidence must not have a generationBrief" });
    }
    if (b.generationBrief) {
      for (const id of b.generationBrief.targetQuestionIds)
        if (!questionIds.has(id))
          ctx.addIssue({ code: "custom", path: ["generationBrief", "targetQuestionIds"], message: `question id ${id} does not resolve` });
      const [min, max] = b.generationBrief.durationSec;
      if (min >= max) ctx.addIssue({ code: "custom", path: ["generationBrief", "durationSec"], message: "durationSec must be [min, max] with min < max" });
    }
  });

export const TimeRange = z.object({ startMs: ms, endMs: ms }).refine((r) => r.endMs > r.startMs, "endMs must be after startMs");

export const SourceTranscriptSegment = z.object({
  id: z.string().min(1),
  startMs: ms,
  endMs: ms,
  text: z.string(),
});

export const ClipTranscriptSegment = z.object({
  id: z.string().min(1),
  sourceStartMs: ms,
  sourceEndMs: ms,
  text: z.string(),
});

export const Clip = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    previewUrl: z.string().url().nullable(),
    exportUrl: z.string().url().nullable(),
    sourceRanges: z.array(TimeRange),
    transcriptStatus: z.enum(["available", "unavailable"]),
    transcript: z.array(ClipTranscriptSegment),
  })
  .superRefine((c, ctx) => {
    if (c.transcriptStatus === "unavailable" && c.transcript.length > 0)
      ctx.addIssue({ code: "custom", path: ["transcript"], message: "unavailable transcript must be empty" });
    if (c.transcriptStatus === "available" && c.transcript.length === 0)
      ctx.addIssue({ code: "custom", path: ["transcript"], message: "available transcript must not be empty" });
    if (c.sourceRanges.length === 0 && c.transcriptStatus !== "unavailable")
      ctx.addIssue({ code: "custom", path: ["sourceRanges"], message: "a clip without source ranges must have an unavailable, empty transcript" });
    for (const [i, s] of c.transcript.entries()) {
      if (s.sourceEndMs <= s.sourceStartMs)
        ctx.addIssue({ code: "custom", path: ["transcript", i], message: "segment must end after it starts" });
      // Each segment must fall within one of the clip's source ranges.
      if (!c.sourceRanges.some((r) => s.sourceStartMs >= r.startMs && s.sourceEndMs <= r.endMs))
        ctx.addIssue({ code: "custom", path: ["transcript", i], message: "segment is outside the clip source ranges" });
    }
    if (!isPlaybackOrdered(c.transcript.map((s) => [s.sourceStartMs, s.sourceEndMs]), c.sourceRanges))
      ctx.addIssue({ code: "custom", path: ["transcript"], message: "transcript segments must follow playback order" });
  });

export const ReviewInput = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    research: ResearchBrief,
    generation: z.object({
      provider: z.literal("opusclip"),
      projectId: z.string().min(1),
      requestedQuestionIds: z.array(z.string().min(1)),
      submittedPrompt: z.string().min(1),
      completedAt: utcIso,
    }),
    sourceTranscript: z
      .object({
        coverage: z.enum(["full", "partial", "unavailable"]),
        segments: z.array(SourceTranscriptSegment),
        limitations: z.array(z.string()),
      })
      .superRefine((t, ctx) => {
        if (t.coverage === "unavailable" && t.segments.length > 0)
          ctx.addIssue({ code: "custom", path: ["segments"], message: "unavailable transcript must be empty" });
        for (let i = 0; i < t.segments.length; i++) {
          const s = t.segments[i];
          if (s.endMs <= s.startMs) ctx.addIssue({ code: "custom", path: ["segments", i], message: "segment must end after it starts" });
          if (i > 0 && s.startMs < t.segments[i - 1].startMs)
            ctx.addIssue({ code: "custom", path: ["segments", i], message: "source transcript must be in playback order" });
        }
      }),
    clips: z.array(Clip),
    limitations: z.array(z.string()),
  })
  .superRefine((r, ctx) => {
    const ids = new Set(r.research.questions.map((q) => q.id));
    for (const id of r.generation.requestedQuestionIds)
      if (!ids.has(id)) ctx.addIssue({ code: "custom", path: ["generation", "requestedQuestionIds"], message: `question id ${id} does not resolve` });
    const clipIds = r.clips.map((c) => c.id);
    if (new Set(clipIds).size !== clipIds.length) ctx.addIssue({ code: "custom", path: ["clips"], message: "duplicate clip ids" });
  });

/**
 * A clip may be stitched from several source ranges; the ranges are in clip
 * playback order (not necessarily ascending source time). Segments must appear
 * range by range, and in ascending source time within a range.
 */
function isPlaybackOrdered(segments: [number, number][], ranges: { startMs: number; endMs: number }[]): boolean {
  let rangeIdx = 0;
  let lastStart = -1;
  for (const [start, end] of segments) {
    while (rangeIdx < ranges.length && !(start >= ranges[rangeIdx].startMs && end <= ranges[rangeIdx].endMs)) {
      rangeIdx++;
      lastStart = -1;
    }
    if (rangeIdx >= ranges.length) return false;
    if (start < lastStart) return false;
    lastStart = start;
  }
  return true;
}

export type ResearchBrief = z.infer<typeof ResearchBrief>;
export type Evidence = z.infer<typeof Evidence>;
export type Question = z.infer<typeof Question>;
export type GenerationBrief = z.infer<typeof GenerationBrief>;
export type ReviewInput = z.infer<typeof ReviewInput>;
export type Clip = z.infer<typeof Clip>;
export type TimeRange = z.infer<typeof TimeRange>;
export type SourceTranscriptSegment = z.infer<typeof SourceTranscriptSegment>;
export type ClipTranscriptSegment = z.infer<typeof ClipTranscriptSegment>;

export function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}
