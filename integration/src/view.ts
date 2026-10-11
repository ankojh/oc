// Joins an integration record, its saved ReviewInput snapshot and the review
// result into one display model. Every reference in the report is resolved
// against the saved snapshot (never against fresh upstream data).

export interface Range {
  startMs: number;
  endMs: number;
}

/**
 * Maps a source-time passage to a playback offset in a clip stitched from
 * ordered source ranges: the preceding ranges' durations plus the offset inside
 * the containing range. Returns null when the passage is not inside exactly one
 * range (ambiguous or outside), so the UI links to the source instead of seeking
 * to a wrong moment. Provider edits that change clip timing are detected in the
 * browser by comparing the media duration to the summed range durations.
 */
export function clipOffsetMs(ranges: Range[], startMs: number, endMs: number): number | null {
  const containing = ranges.map((r, i) => ({ r, i })).filter(({ r }) => startMs >= r.startMs && endMs <= r.endMs);
  if (containing.length !== 1) return null;
  const { r, i } = containing[0];
  const before = ranges.slice(0, i).reduce((sum, x) => sum + (x.endMs - x.startMs), 0);
  return before + (startMs - r.startMs);
}

export function rangesDurationMs(ranges: Range[]): number {
  return ranges.reduce((sum, r) => sum + (r.endMs - r.startMs), 0);
}

/** Link to the original YouTube video at a source time (never a clip time). */
export function sourceLink(videoUrl: string, ms: number): string {
  const u = new URL(videoUrl);
  u.searchParams.set("t", `${Math.floor(ms / 1000)}s`);
  return u.toString();
}

const STATUS_TEXT: Record<string, string> = {
  researching: "Researching audience comments",
  research_ready: "Research ready — review the questions, then Generate",
  generating: "Generating clips in OpusClip",
  needs_reconciliation: "OpusClip submission uncertain — reconcile before continuing",
  reviewing: "Review agent is checking which clips answer the questions",
  complete: "Review complete",
  insufficient_evidence: "Insufficient audience evidence",
  unverifiable: "Clips could not be verified against the questions",
  failed: "Failed",
};

export function buildView(rec: any, snapshot: any | null, result: any | null) {
  const brief = snapshot?.research ?? rec.research.brief ?? null;
  const evidenceById = new Map<string, any>((brief?.evidence ?? []).map((e: any) => [e.id, e]));
  const clips: any[] = snapshot?.clips ?? [];
  const clipById = new Map<string, any>(clips.map((c) => [c.id, c]));
  const sourceById = new Map<string, any>((snapshot?.sourceTranscript?.segments ?? []).map((s: any) => [s.id, s]));
  const videoUrl: string = brief?.video?.url ?? rec.input.videoUrl;
  const report = result?.report ?? null;

  const clipView = (c: any) => ({
    id: c.id,
    title: c.title,
    previewUrl: c.previewUrl,
    exportUrl: c.exportUrl,
    sourceRanges: c.sourceRanges,
    rangesDurationMs: rangesDurationMs(c.sourceRanges),
    transcriptStatus: c.transcriptStatus,
    verifiable: c.sourceRanges.length > 0 && c.transcriptStatus === "available",
    sourceLink: c.sourceRanges.length ? sourceLink(videoUrl, c.sourceRanges[0].startMs) : null,
  });

  const matchView = (m: any) => {
    const clip = clipById.get(m.clipId);
    return {
      clipId: m.clipId,
      clipTitle: clip?.title ?? m.clipId,
      verdict: m.verdict,
      explanation: m.explanation,
      answerPassages: m.answerPassages.map((p: any) => ({
        ...p,
        clipOffsetMs: clip ? clipOffsetMs(clip.sourceRanges, p.sourceStartMs, p.sourceEndMs) : null,
        sourceLink: sourceLink(videoUrl, p.sourceStartMs),
      })),
      contextWarnings: m.contextWarnings.map((w: any) => ({
        explanation: w.explanation,
        sourceSegments: w.sourceSegmentIds.map((id: string) => {
          const s = sourceById.get(id);
          return s ? { id, startMs: s.startMs, endMs: s.endMs, text: s.text, sourceLink: sourceLink(videoUrl, s.startMs) } : { id, startMs: null, endMs: null, text: null, sourceLink: null };
        }),
      })),
      limitations: m.limitations,
    };
  };

  const questions = (brief?.questions ?? []).map((q: any) => {
    const matches = (report?.matches ?? []).filter((m: any) => m.questionId === q.id);
    const recs = (report?.recommendations ?? []).filter((r: any) => r.questionIds.includes(q.id));
    const unanswered = (report?.unansweredQuestions ?? []).find((u: any) => u.questionId === q.id) ?? null;
    return {
      id: q.id,
      question: q.question,
      kind: q.kind,
      priority: q.priority,
      observedCommentCount: q.observedCommentCount,
      rationale: q.rationale,
      evidence: q.evidenceIds.map((id: string) => evidenceById.get(id)).filter(Boolean),
      recommendations: recs.map((r: any) => {
        const clip = clipById.get(r.clipId);
        const match = matches.find((m: any) => m.clipId === r.clipId);
        return { rank: r.rank, reason: r.reason, clip: clip ? clipView(clip) : null, match: match ? matchView(match) : null };
      }),
      unanswered,
      checked: matches.map(matchView),
    };
  });

  return {
    integrationId: rec.integrationId,
    mode: rec.mode,
    modeLabel: rec.mode === "fixture" ? "FIXTURE DATA — synthetic comments, clips and reviewer judgment; not a live integration" : "LIVE",
    status: rec.status,
    statusText: STATUS_TEXT[rec.status] ?? rec.status,
    failedStage: rec.failedStage,
    error: rec.error,
    input: rec.input,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    events: rec.events,
    actions: {
      generate: rec.status === "research_ready" || (rec.status === "failed" && rec.failedStage === "generation" && !rec.generation.projectId),
      reconcile: rec.status === "needs_reconciliation",
      adoptProject: rec.status === "needs_reconciliation",
      resumePolling: rec.status === "failed" && rec.failedStage === "generation" && Boolean(rec.generation.projectId),
      forceNewProject: rec.status === "needs_reconciliation" || (rec.status === "failed" && rec.failedStage === "generation"),
      retryReview: rec.status === "failed" && rec.failedStage === "review",
      retryHandoff: rec.status === "failed" && rec.failedStage === "handoff",
    },
    research: {
      runId: rec.research.runId,
      upstreamStatus: rec.research.upstreamStatus,
      progress: rec.research.progress,
      video: brief?.video ?? null,
      creatorGoal: brief?.creatorGoal ?? rec.input.creatorGoal,
      researchStatus: brief?.researchStatus ?? null,
      coverage: brief?.coverage ?? null,
      generationBrief: brief?.generationBrief ?? null,
    },
    generation: rec.generation,
    handoff: {
      ...rec.handoff,
      projectId: snapshot?.generation?.projectId ?? null,
      limitations: snapshot?.limitations ?? [],
      sourceTranscript: snapshot ? { coverage: snapshot.sourceTranscript.coverage, segmentCount: snapshot.sourceTranscript.segments.length, limitations: snapshot.sourceTranscript.limitations } : null,
    },
    review: rec.review,
    questions,
    clips: clips.map(clipView),
    report: report ? { status: report.status, limitations: report.limitations, recommendationCount: report.recommendations.length } : null,
    diagnostics: result ? { reviewId: result.reviewId, reviewer: result.reviewer, warnings: result.warnings, audit: result.audit } : null,
  };
}
