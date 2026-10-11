// audience-clips.v1 shared contract. Field names are the integration contract
// with the audience-research / OpusClip adapter builder — do not rename.
import { z } from "zod";

export const SCHEMA_VERSION = "audience-clips.v1" as const;

const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
export const UtcTimestamp = z
  .string()
  .regex(UTC_ISO, "must be a UTC ISO-8601 timestamp ending in Z, e.g. 2026-10-01T12:00:00Z")
  .refine((s) => !Number.isNaN(Date.parse(s)), "must be a real calendar date/time");

/** Normalized video time: integer milliseconds, never seconds. */
export const Ms = z.number().int("must be integer milliseconds").nonnegative();
const Id = z.string().min(1, "must be a non-empty string");

const msRange = <T extends z.ZodRawShape>(shape: T, startKey: string, endKey: string) =>
  z.object(shape).refine((o: any) => o[endKey] > o[startKey], {
    message: `${endKey} must be greater than ${startKey}`,
    path: [endKey],
  });

// ---------- ResearchBrief ----------

export const Evidence = z.object({
  id: Id,
  commentId: Id,
  videoId: Id,
  url: z.string().url(),
  quote: z.string(),
  publishedAt: UtcTimestamp,
});

export const Question = z.object({
  id: Id,
  question: z.string().min(1),
  kind: z.enum(["explicit", "inferred"]),
  evidenceIds: z.array(Id),
  observedCommentCount: z.number().int().nonnegative(),
  priority: z.number(),
  rationale: z.string(),
});

export const GenerationBrief = z.object({
  targetQuestionIds: z.array(Id),
  customPrompt: z.string(),
  durationSec: z.tuple([z.number().nonnegative(), z.number().nonnegative()]),
  aspectRatio: z.enum(["portrait", "landscape", "square"]),
});

export const ResearchBrief = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  runId: Id,
  mode: z.enum(["live", "fixture"]),
  video: z.object({ url: z.string().url(), videoId: Id, channelId: Id, title: z.string() }),
  creatorGoal: z.string().nullable(),
  researchStatus: z.enum(["ready", "insufficient_evidence"]),
  coverage: z.object({
    fetchedAt: UtcTimestamp,
    videoIds: z.array(Id),
    commentCount: z.number().int().nonnegative(),
    samplingMethod: z.string(),
    limitations: z.array(z.string()),
  }),
  evidence: z.array(Evidence),
  questions: z.array(Question),
  generationBrief: GenerationBrief.nullable(),
});

// ---------- ReviewInput ----------

export const SourceSegment = msRange({ id: Id, startMs: Ms, endMs: Ms, text: z.string() }, "startMs", "endMs");
export const SourceRange = msRange({ startMs: Ms, endMs: Ms }, "startMs", "endMs");
export const ClipSegment = msRange(
  { id: Id, sourceStartMs: Ms, sourceEndMs: Ms, text: z.string() },
  "sourceStartMs",
  "sourceEndMs",
);

// A clip whose source ranges the producer could not verify keeps an empty range
// list (never invented ranges) and must then carry no transcript; it is reviewed
// as unverifiable rather than rejected, so the rest of the handoff stays usable.
export const Clip = z
  .object({
    id: Id,
    title: z.string(),
    previewUrl: z.string().url().nullable(),
    exportUrl: z.string().url().nullable(),
    sourceRanges: z.array(SourceRange),
    transcriptStatus: z.enum(["available", "unavailable"]),
    transcript: z.array(ClipSegment),
  })
  .refine((c) => c.sourceRanges.length > 0 || (c.transcriptStatus === "unavailable" && c.transcript.length === 0), {
    message: "a clip without source ranges must have transcriptStatus 'unavailable' and an empty transcript",
    path: ["sourceRanges"],
  });

export const ReviewInput = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  research: ResearchBrief,
  generation: z.object({
    provider: z.literal("opusclip"),
    projectId: Id,
    requestedQuestionIds: z.array(Id),
    submittedPrompt: z.string(),
    completedAt: UtcTimestamp,
  }),
  sourceTranscript: z.object({
    coverage: z.enum(["full", "partial", "unavailable"]),
    segments: z.array(SourceSegment),
    limitations: z.array(z.string()),
  }),
  clips: z.array(Clip),
  limitations: z.array(z.string()),
});

// ---------- ReviewReport ----------

export const Verdict = z.enum(["direct", "partial", "related_only", "no_match", "unverifiable"]);

export const AnswerPassage = z.object({
  clipTranscriptSegmentId: Id,
  quote: z.string().min(1),
  sourceStartMs: Ms,
  sourceEndMs: Ms,
});

export const ContextWarning = z.object({
  explanation: z.string().min(1),
  sourceSegmentIds: z.array(Id).min(1, "a context warning must cite supporting source segments"),
});

export const Match = z.object({
  questionId: Id,
  clipId: Id,
  verdict: Verdict,
  explanation: z.string(),
  commentEvidenceIds: z.array(Id),
  answerPassages: z.array(AnswerPassage),
  contextWarnings: z.array(ContextWarning),
  limitations: z.array(z.string()),
});

export const Recommendation = z.object({
  rank: z.number().int().min(1).max(3),
  clipId: Id,
  questionIds: z.array(Id).min(1),
  reason: z.string().min(1),
});

export const UnansweredQuestion = z.object({
  questionId: Id,
  status: z.enum(["not_found_in_generated_clips", "not_found_in_available_source", "cannot_assess"]),
  explanation: z.string(),
});

export const ReviewReport = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  runId: Id,
  mode: z.enum(["live", "fixture"]),
  status: z.enum(["complete", "insufficient_evidence", "unverifiable"]),
  matches: z.array(Match),
  recommendations: z.array(Recommendation).max(3),
  unansweredQuestions: z.array(UnansweredQuestion),
  limitations: z.array(z.string()),
});

export type ResearchBrief = z.infer<typeof ResearchBrief>;
export type ReviewInput = z.infer<typeof ReviewInput>;
export type ReviewReport = z.infer<typeof ReviewReport>;
export type Match = z.infer<typeof Match>;
export type Verdict = z.infer<typeof Verdict>;
export type Clip = z.infer<typeof Clip>;
export type Question = z.infer<typeof Question>;
export type Recommendation = z.infer<typeof Recommendation>;
export type UnansweredQuestion = z.infer<typeof UnansweredQuestion>;
