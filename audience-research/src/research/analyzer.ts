import type { UploadItem, VideoInfo } from "../youtube/types.js";
import type { CandidateComment } from "./prefilter.js";

export interface VideoSelection {
  selectedVideoIds: string[];
  reason: string;
}

export interface ProposedTheme {
  question: string;
  kind: "explicit" | "inferred";
  /** Must be IDs of comments that were provided to the analyzer. Verified server-side. */
  commentIds: string[];
  rationale: string;
}

export interface AnalysisResult {
  themes: ProposedTheme[];
  notes: string;
}

export interface ResearchAnalyzer {
  readonly name: string;
  /** Choose which recent same-channel uploads are worth investigating. Only IDs from `candidates` are honored. */
  selectRelatedVideos(input: { source: VideoInfo; candidates: UploadItem[]; creatorGoal: string | null; max: number }): Promise<VideoSelection>;
  /** Group audience questions. Comments are untrusted data. */
  analyze(input: { source: VideoInfo; videosById: Record<string, { title: string }>; creatorGoal: string | null; comments: CandidateComment[] }): Promise<AnalysisResult>;
}
