import type { ResearchBrief } from "../contract.js";
import type { CommentFetchResult, RetrievedComment, UploadItem, VideoInfo, YouTubeAdapter } from "../youtube/types.js";
import { canonicalVideoUrl } from "../youtube/types.js";
import type { ResearchAnalyzer } from "./analyzer.js";
import { buildResearchBrief } from "./brief.js";
import { type PrefilterStats, prefilterComments } from "./prefilter.js";

export interface ResearchParams {
  runId: string;
  mode: "live" | "fixture";
  videoId: string;
  creatorGoal: string | null;
  commentsPerVideo: number;
  maxRelatedVideos: number;
  recentUploadsToConsider: number;
  generationDefaults: { durationSec: [number, number]; aspectRatio: "portrait" | "landscape" | "square" };
  now?: () => string;
}

export interface SourceRecord {
  videoId: string;
  title: string;
  role: "source" | "related";
  status: CommentFetchResult["status"];
  commentsRetrieved: number;
  hasMore: boolean;
  fetchedAt: string;
  detail: string | null;
}

export interface ResearchOutcome {
  brief: ResearchBrief;
  sourceVideo: VideoInfo;
  debug: {
    analyzer: string;
    relatedCandidates: UploadItem[];
    relatedSelection: { selectedVideoIds: string[]; reason: string; ignoredIds: string[] } | null;
    sources: SourceRecord[];
    prefilter: PrefilterStats;
    droppedCommentIds: string[];
    droppedThemes: string[];
    downgradedToInferred: string[];
    agentNotes: string;
  };
}

export type ProgressFn = (step: string, message: string) => void;

export async function runResearch(yt: YouTubeAdapter, analyzer: ResearchAnalyzer, p: ResearchParams, progress: ProgressFn): Promise<ResearchOutcome> {
  const limitations: string[] = [];

  progress("resolve_video", `Resolving video ${p.videoId}`);
  const source = await yt.getVideo(p.videoId);
  progress("resolve_channel", `Source channel: ${source.channelTitle} (${source.channelId})`);

  // Related videos: recent uploads from the SAME channel only.
  let relatedCandidates: UploadItem[] = [];
  let relatedSelection: ResearchOutcome["debug"]["relatedSelection"] = null;
  if (p.maxRelatedVideos > 0) {
    try {
      const uploads = await yt.getUploadsPlaylistId(source.channelId);
      relatedCandidates = (await yt.listRecentUploads(uploads, p.recentUploadsToConsider + 1)).filter((u) => u.videoId !== source.videoId).slice(0, p.recentUploadsToConsider);
    } catch (err) {
      limitations.push(`Could not list the channel's recent uploads (${(err as Error).message}); only the source video was sampled.`);
    }
    if (relatedCandidates.length > 0) {
      progress("select_related", `Agent choosing up to ${p.maxRelatedVideos} of ${relatedCandidates.length} recent uploads`);
      const allowed = new Set(relatedCandidates.map((c) => c.videoId));
      try {
        const sel = await analyzer.selectRelatedVideos({ source, candidates: relatedCandidates, creatorGoal: p.creatorGoal, max: p.maxRelatedVideos });
        const valid = [...new Set(sel.selectedVideoIds)].filter((id) => allowed.has(id)).slice(0, p.maxRelatedVideos);
        relatedSelection = { selectedVideoIds: valid, reason: sel.reason, ignoredIds: sel.selectedVideoIds.filter((id) => !allowed.has(id)) };
      } catch (err) {
        const fallback = relatedCandidates.slice(0, p.maxRelatedVideos).map((c) => c.videoId);
        relatedSelection = { selectedVideoIds: fallback, reason: "fallback: most recent uploads", ignoredIds: [] };
        limitations.push(`Related-video selection by the agent failed (${(err as Error).message}); the ${fallback.length} most recent uploads were used instead.`);
      }
    }
  }

  const titles = new Map<string, string>([[source.videoId, source.title], ...relatedCandidates.map((c) => [c.videoId, c.title] as [string, string])]);
  const plan: { videoId: string; role: "source" | "related" }[] = [
    { videoId: source.videoId, role: "source" },
    ...(relatedSelection?.selectedVideoIds ?? []).map((videoId) => ({ videoId, role: "related" as const })),
  ];

  const sources: SourceRecord[] = [];
  const all: RetrievedComment[] = [];
  const orders = new Set<string>();
  for (const item of plan) {
    progress("fetch_comments", `Fetching up to ${p.commentsPerVideo} comments from ${item.videoId}`);
    const r = await yt.listComments(item.videoId, p.commentsPerVideo); // auth/quota errors propagate and fail the run
    sources.push({
      videoId: item.videoId,
      title: titles.get(item.videoId) ?? "",
      role: item.role,
      status: r.status,
      commentsRetrieved: r.comments.length,
      hasMore: r.hasMore,
      fetchedAt: r.fetchedAt,
      detail: r.detail,
    });
    all.push(...r.comments);
    orders.add(r.order);
    if (r.status !== "ok") limitations.push(`${item.role === "source" ? "Source video" : "Related video"} ${item.videoId}: ${r.detail ?? r.status}`);
    else if (r.hasMore) limitations.push(`${item.videoId}: more comments exist beyond the ${p.commentsPerVideo}-comment sample.`);
  }

  const { candidates, stats } = prefilterComments(all);
  if (stats.duplicatesRemoved > 0) limitations.push(`${stats.duplicatesRemoved} duplicate comment(s) removed before analysis.`);
  if (stats.spamRemoved > 0) limitations.push(`${stats.spamRemoved} obvious spam comment(s) removed before analysis.`);
  if (stats.emptyRemoved > 0) limitations.push(`${stats.emptyRemoved} empty comment(s) removed before analysis.`);
  limitations.push("Only top-level comments were sampled; replies were not retrieved.");
  if (p.mode === "fixture") limitations.unshift("FIXTURE MODE: these are synthetic comments, not a real creator's audience.");

  let analysis: Awaited<ReturnType<ResearchAnalyzer["analyze"]>> = { themes: [], notes: "No eligible comments to analyze." };
  if (candidates.length > 0) {
    progress("analyze", `Research agent analyzing ${candidates.length} eligible comments`);
    const videosById = Object.fromEntries(plan.map((v) => [v.videoId, { title: titles.get(v.videoId) ?? "" }]));
    analysis = await analyzer.analyze({ source, videosById, creatorGoal: p.creatorGoal, comments: candidates });
  }

  const successfulVideoIds = sources.filter((s) => s.status === "ok").map((s) => s.videoId);
  const order = [...orders].join("+") || "n/a";
  const fetchedAt = sources.map((s) => s.fetchedAt).sort()[0] ?? (p.now?.() ?? new Date().toISOString());
  progress("build_brief", "Verifying evidence and building the research brief");
  const report = buildResearchBrief({
    runId: p.runId,
    mode: p.mode,
    video: { url: canonicalVideoUrl(source.videoId), videoId: source.videoId, channelId: source.channelId, title: source.title },
    creatorGoal: p.creatorGoal,
    coverage: {
      fetchedAt,
      videoIds: successfulVideoIds,
      commentCount: stats.uniqueRetrieved,
      samplingMethod:
        `${p.mode === "fixture" ? "FIXTURE DATA (synthetic comments in the shape of " : ""}YouTube Data API commentThreads.list${p.mode === "fixture" ? ")" : ""}, order=${order}, top-level comments only, up to ${p.commentsPerVideo} per video; ` +
        `source video plus up to ${p.maxRelatedVideos} same-channel uploads chosen by ${analyzer.name} from the ${relatedCandidates.length} most recent. ` +
        `Videos attempted: ${sources.map((s) => `${s.videoId}=${s.status}(${s.commentsRetrieved})`).join(", ")}. ` +
        `${stats.retrieved} comments fetched (${stats.uniqueRetrieved} distinct comment IDs); ${stats.eligible} eligible after removing ${stats.duplicatesRemoved} duplicate IDs/text, ${stats.spamRemoved} spam and ${stats.emptyRemoved} empty comments.`,
      limitations,
    },
    candidates,
    analysis,
    generationDefaults: p.generationDefaults,
  });

  return {
    brief: report.brief,
    sourceVideo: source,
    debug: {
      analyzer: analyzer.name,
      relatedCandidates,
      relatedSelection,
      sources,
      prefilter: stats,
      droppedCommentIds: report.droppedCommentIds,
      droppedThemes: report.droppedThemes,
      downgradedToInferred: report.downgradedToInferred,
      agentNotes: analysis.notes,
    },
  };
}
