// The model's raw output shape. It is NOT the ReviewReport: the deterministic
// assembler (src/assemble.ts) validates every reference, fills timestamps from the
// transcript, and downgrades anything it cannot verify.
import { z } from "zod";

export const Judgment = z.strictObject({
  questionChecks: z.array(
    z.strictObject({
      questionId: z.string(),
      support: z.enum(["supported", "weak", "unsupported"]),
      supportingEvidenceIds: z.array(z.string()),
      kindIssue: z.string().nullable(),
      explanation: z.string(),
    }),
  ),
  matches: z.array(
    z.strictObject({
      questionId: z.string(),
      clipId: z.string(),
      verdict: z.enum(["direct", "partial", "related_only", "no_match", "unverifiable"]),
      explanation: z.string(),
      answerPassages: z.array(z.strictObject({ clipTranscriptSegmentId: z.string(), quote: z.string() })),
      contextWarnings: z.array(z.strictObject({ explanation: z.string(), sourceSegmentIds: z.array(z.string()) })),
      limitations: z.array(z.string()),
    }),
  ),
  recommendations: z.array(
    z.strictObject({ rank: z.number().int(), clipId: z.string(), questionIds: z.array(z.string()), reason: z.string() }),
  ),
  unansweredQuestions: z.array(
    z.strictObject({
      questionId: z.string(),
      status: z.enum(["not_found_in_generated_clips", "not_found_in_available_source", "cannot_assess"]),
      explanation: z.string(),
    }),
  ),
  limitations: z.array(z.string()),
});
export type Judgment = z.infer<typeof Judgment>;

/** JSON Schema handed to Codex as the structured outputSchema. */
export function judgmentJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(Judgment) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}
