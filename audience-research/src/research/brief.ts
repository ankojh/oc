// Turns analyzer proposals into a validated ResearchBrief. This is where
// evidence integrity is enforced: the analyzer only proposes comment IDs; every
// quote, URL, timestamp and count comes from the retrieved YouTube data.
import { type Evidence, type GenerationBrief, type Question, ResearchBrief, SCHEMA_VERSION, formatIssues } from "../contract.js";
import { AppError } from "../errors.js";
import { commentUrl } from "../youtube/types.js";
import type { AnalysisResult } from "./analyzer.js";
import { type CandidateComment, looksLikeQuestion } from "./prefilter.js";
import { buildClipAnythingPrompt } from "./prompt.js";

export interface BriefInput {
  runId: string;
  mode: "live" | "fixture";
  video: { url: string; videoId: string; channelId: string; title: string };
  creatorGoal: string | null;
  coverage: { fetchedAt: string; videoIds: string[]; commentCount: number; samplingMethod: string; limitations: string[] };
  candidates: CandidateComment[];
  analysis: AnalysisResult;
  generationDefaults: { durationSec: [number, number]; aspectRatio: "portrait" | "landscape" | "square" };
}

export interface BriefBuildReport {
  brief: ResearchBrief;
  droppedCommentIds: string[];
  droppedThemes: string[];
  downgradedToInferred: string[];
}

export function buildResearchBrief(input: BriefInput): BriefBuildReport {
  const byId = new Map(input.candidates.map((c) => [c.commentId, c]));
  const limitations = [...input.coverage.limitations];
  const droppedCommentIds: string[] = [];
  const droppedThemes: string[] = [];
  const downgraded: string[] = [];
  const usedCommentIds = new Set<string>();

  type Draft = { question: string; kind: "explicit" | "inferred"; comments: CandidateComment[]; rationale: string; order: number };
  const drafts: Draft[] = [];
  input.analysis.themes.forEach((t, order) => {
    const comments: CandidateComment[] = [];
    for (const id of t.commentIds) {
      const c = byId.get(id);
      if (!c) {
        droppedCommentIds.push(id); // not retrieved, filtered as spam/duplicate, or invented
        continue;
      }
      // A comment supports at most one theme so counts are never double-counted.
      if (usedCommentIds.has(id)) continue;
      usedCommentIds.add(id);
      comments.push(c);
    }
    const question = t.question.trim();
    if (comments.length === 0 || !question) {
      droppedThemes.push(question || "(empty question)");
      return;
    }
    let kind = t.kind;
    // "explicit" must be backed by at least one comment that actually asks a question.
    if (kind === "explicit" && !comments.some((c) => looksLikeQuestion(c.text))) {
      kind = "inferred";
      downgraded.push(question);
    }
    drafts.push({ question, kind, comments, rationale: t.rationale.trim(), order });
  });

  if (droppedCommentIds.length > 0)
    limitations.push(`The research agent cited ${droppedCommentIds.length} comment ID(s) that were not in the eligible retrieved set; they were discarded.`);
  if (downgraded.length > 0)
    limitations.push(`${downgraded.length} theme(s) were relabelled "inferred" because no supporting comment contained an explicit question.`);

  // Rank by distinct supporting comments, then the analyzer's own order.
  const ranked = drafts.sort((a, b) => b.comments.length - a.comments.length || a.order - b.order).slice(0, 3);

  const evidence: Evidence[] = [];
  const questions: Question[] = [];
  ranked.forEach((d, qi) => {
    const evidenceIds: string[] = [];
    for (const c of d.comments) {
      const id = `ev_${evidence.length + 1}`;
      evidence.push({ id, commentId: c.commentId, videoId: c.videoId, url: commentUrl(c.videoId, c.commentId), quote: c.text, publishedAt: c.publishedAt });
      evidenceIds.push(id);
    }
    const n = evidenceIds.length;
    let rationale = d.rationale || `${n} distinct comment${n === 1 ? "" : "s"} support this.`;
    if (n === 1 && !/single signal/i.test(rationale)) rationale += " (Single comment: a single signal, not evidence of recurring demand.)";
    questions.push({ id: `q_${qi + 1}`, question: d.question, kind: d.kind, evidenceIds, observedCommentCount: n, priority: qi + 1, rationale });
  });

  let researchStatus: "ready" | "insufficient_evidence" = questions.length > 0 ? "ready" : "insufficient_evidence";
  let generationBrief: GenerationBrief | null = null;
  if (researchStatus === "ready") {
    generationBrief = {
      targetQuestionIds: questions.map((q) => q.id),
      customPrompt: buildClipAnythingPrompt(questions, input.creatorGoal),
      durationSec: input.generationDefaults.durationSec,
      aspectRatio: input.generationDefaults.aspectRatio,
    };
  } else {
    limitations.push(
      input.coverage.commentCount === 0
        ? "Insufficient evidence: no comments could be retrieved from the sampled videos."
        : `Insufficient evidence: none of the ${input.coverage.commentCount} retrieved comments contained a usable audience question or request.${input.analysis.notes ? ` Agent notes: ${input.analysis.notes}` : ""}`,
    );
  }

  const brief = {
    schemaVersion: SCHEMA_VERSION,
    runId: input.runId,
    mode: input.mode,
    video: input.video,
    creatorGoal: input.creatorGoal,
    researchStatus,
    coverage: { ...input.coverage, limitations },
    evidence: researchStatus === "ready" ? evidence : [],
    questions,
    generationBrief,
  };
  const parsed = ResearchBrief.safeParse(brief);
  if (!parsed.success) throw new AppError("CONTRACT_VIOLATION", `ResearchBrief failed validation: ${formatIssues(parsed.error)}`, null, 500);
  return { brief: parsed.data, droppedCommentIds, droppedThemes, downgradedToInferred: downgraded };
}
