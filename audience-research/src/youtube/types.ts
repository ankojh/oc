import { AppError } from "../errors.js";

export interface VideoInfo {
  videoId: string;
  channelId: string;
  channelTitle: string;
  title: string;
  publishedAt: string;
  /** Parsed from contentDetails.duration (ISO-8601); null when YouTube omits it. */
  durationMs: number | null;
}

export interface UploadItem {
  videoId: string;
  title: string;
  publishedAt: string;
}

export interface RetrievedComment {
  commentId: string;
  videoId: string;
  authorChannelId: string | null;
  /** Exact text as returned by YouTube (textFormat=plainText). Never edited. */
  text: string;
  publishedAt: string;
  likeCount: number;
}

export type CommentFetchStatus = "ok" | "comments_disabled" | "forbidden" | "video_not_found";

export interface CommentFetchResult {
  videoId: string;
  status: CommentFetchStatus;
  comments: RetrievedComment[];
  /** The `order` parameter used, recorded for the sampling description. */
  order: "relevance" | "time";
  requestedMax: number;
  hasMore: boolean;
  fetchedAt: string;
  detail: string | null;
}

export interface YouTubeAdapter {
  readonly kind: "live" | "fixture";
  getVideo(videoId: string): Promise<VideoInfo>;
  getUploadsPlaylistId(channelId: string): Promise<string>;
  listRecentUploads(playlistId: string, max: number): Promise<UploadItem[]>;
  listComments(videoId: string, max: number): Promise<CommentFetchResult>;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Accepts watch, youtu.be, shorts, embed and live URLs. Rejects everything else. */
export function parseYouTubeVideoId(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new AppError("INVALID_INPUT", "videoUrl is not a valid URL", "Paste a public YouTube video URL such as https://www.youtube.com/watch?v=…", 400);
  }
  const host = url.hostname.replace(/^www\.|^m\.|^music\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = url.pathname.split("/")[1] ?? null;
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else {
      const m = url.pathname.match(/^\/(shorts|embed|live|v)\/([^/?#]+)/);
      if (m) id = m[2];
    }
  }
  if (!id || !VIDEO_ID.test(id))
    throw new AppError("INVALID_INPUT", "Could not find a YouTube video ID in videoUrl", "Use a single-video URL, not a channel or playlist URL.", 400);
  return id;
}

export function canonicalVideoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function commentUrl(videoId: string, commentId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}&lc=${encodeURIComponent(commentId)}`;
}

/** ISO-8601 duration (PT1H2M3S) to integer milliseconds. */
export function parseIsoDurationMs(iso: string | undefined | null): number | null {
  if (!iso) return null;
  const m = iso.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m) return null;
  const [d, h, min, s] = [m[1], m[2], m[3], m[4]].map((v) => (v ? Number(v) : 0));
  return Math.round(((d * 24 + h) * 60 + min) * 60_000 + s * 1000);
}

/** Normalizes any parseable timestamp to UTC ISO with milliseconds. */
export function toUtcIso(value: string): string {
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`unparseable timestamp: ${value}`);
  return new Date(t).toISOString();
}
