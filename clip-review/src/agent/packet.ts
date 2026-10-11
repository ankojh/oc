// Builds the reviewer's view of the handoff. Generation targeting (requested
// question ids / submitted prompt) is withheld on purpose so the reviewer cannot
// assume a clip answers a question just because it was asked for.
import type { ReviewInput } from "../contract.ts";
import type { HandoffFacts } from "../validate-input.ts";
import { canonicalJson, sha256 } from "../canonical.ts";

export const NEARBY_CONTEXT_MS = 45_000;
export const MAX_SOURCE_CHARS = 120_000;

export type Packet = ReturnType<typeof buildPacket>["packet"];

export function buildPacket(input: ReviewInput, facts: HandoffFacts) {
  const { research, sourceTranscript } = input;
  const evidenceById = new Map(research.evidence.map((e) => [e.id, e]));
  const limitations: string[] = [];

  const sourceSegments = sourceTranscript.segments;
  const sourceChars = sourceSegments.reduce((n, s) => n + s.text.length, 0);
  const includeFullSource = sourceChars <= MAX_SOURCE_CHARS;
  if (!includeFullSource)
    limitations.push(
      `Source transcript (${sourceChars} chars) exceeds the reviewer packet budget; only context near each clip was shown to the reviewer, so source-wide absence claims were not possible.`,
    );

  const clips = input.clips
    .filter((c) => facts.clipsWithTranscript.has(c.id))
    .map((c) => {
      const citeable = facts.citeableSegments.get(c.id)!;
      const nearby = sourceSegments.filter(
        (s) =>
          c.sourceRanges.some((r) => s.endMs > r.startMs - NEARBY_CONTEXT_MS && s.startMs < r.endMs + NEARBY_CONTEXT_MS) &&
          !c.sourceRanges.some((r) => s.startMs >= r.startMs && s.endMs <= r.endMs),
      );
      return {
        id: c.id,
        title: c.title,
        sourceRanges: c.sourceRanges,
        transcript: c.transcript.map((s) => ({ ...s, citeable: citeable.has(s.id) })),
        nearbySourceContext: nearby.map((s) => ({ id: s.id, startMs: s.startMs, endMs: s.endMs, text: s.text })),
      };
    });

  const packet = {
    creatorGoal: research.creatorGoal,
    video: { title: research.video.title },
    researchCoverage: {
      commentCount: research.coverage.commentCount,
      samplingMethod: research.coverage.samplingMethod,
      limitations: research.coverage.limitations,
    },
    questions: research.questions.map((q) => ({
      id: q.id,
      question: q.question,
      kind: q.kind,
      priority: q.priority,
      researcherClaims: { observedCommentCount: q.observedCommentCount, rationale: q.rationale },
      evidence: (facts.resolvedEvidence.get(q.id) ?? []).map((id) => {
        const e = evidenceById.get(id)!;
        return { id: e.id, quote: e.quote, url: e.url };
      }),
      missingEvidenceIds: facts.danglingEvidence.get(q.id) ?? [],
    })),
    clips,
    clipsWithoutTranscript: input.clips.filter((c) => !facts.clipsWithTranscript.has(c.id)).map((c) => c.id),
    sourceTranscript: {
      coverage: sourceSegments.length ? sourceTranscript.coverage : "unavailable",
      limitations: sourceTranscript.limitations,
      segments: includeFullSource ? sourceSegments : [],
      omittedForSize: !includeFullSource,
    },
  };
  return { packet, limitations, includeFullSource };
}

/**
 * Content identity of exactly what the reviewer sees. Recorded or authored
 * fixture judgments are bound to this, not to a run ID, so a fresh run of the
 * same scenario replays the right judgment and different content never does.
 */
export function packetFingerprint(packet: Packet): string {
  return sha256(canonicalJson(packet));
}
