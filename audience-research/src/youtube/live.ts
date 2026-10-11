// YouTube Data API v3 adapter. The API key is only ever sent to googleapis.com
// and is redacted from every error message.
import { AppError } from "../errors.js";
import { redact } from "../log.js";
import {
  type CommentFetchResult,
  type RetrievedComment,
  type UploadItem,
  type VideoInfo,
  type YouTubeAdapter,
  parseIsoDurationMs,
  toUtcIso,
} from "./types.js";

const BASE = "https://www.googleapis.com/youtube/v3";

interface ApiErrorBody {
  error?: { code?: number; message?: string; errors?: { reason?: string; message?: string }[] };
}

class YouTubeHttpError extends Error {
  constructor(
    public status: number,
    public reason: string | null,
    message: string,
  ) {
    super(message);
  }
}

export class LiveYouTubeAdapter implements YouTubeAdapter {
  readonly kind = "live" as const;

  constructor(
    private readonly apiKey: string,
    private readonly commentOrder: "relevance" | "time" = "relevance",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async get<T>(resource: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${BASE}/${resource}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("key", this.apiKey);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new AppError("YOUTUBE_ERROR", redact(`YouTube request failed: ${(err as Error).message}`, [this.apiKey]), "Check your network connection and retry.", 502);
    }
    const body = (await res.json().catch(() => ({}))) as T & ApiErrorBody;
    if (!res.ok) {
      const reason = body.error?.errors?.[0]?.reason ?? null;
      throw new YouTubeHttpError(res.status, reason, redact(body.error?.message ?? `HTTP ${res.status}`, [this.apiKey]));
    }
    return body;
  }

  /** Maps errors that apply to every call (auth/quota) to actionable AppErrors. */
  private mapCommon(err: unknown): never {
    if (err instanceof YouTubeHttpError) {
      if (err.reason === "quotaExceeded" || err.reason === "dailyLimitExceeded" || err.reason === "rateLimitExceeded")
        throw new AppError("YOUTUBE_QUOTA", `YouTube API quota exhausted (${err.reason}).`, "Wait for the daily quota reset (midnight Pacific) or use a key from another Google Cloud project.", 429);
      if (err.status === 400 && (err.reason === "keyInvalid" || /API key/i.test(err.message)))
        throw new AppError("YOUTUBE_AUTH", "The YouTube API key was rejected.", "Set a valid YOUTUBE_API_KEY with the YouTube Data API v3 enabled.", 401);
      if (err.status === 403 && (err.reason === "accessNotConfigured" || err.reason === "forbidden" || err.reason === "ipRefererBlocked"))
        throw new AppError("YOUTUBE_AUTH", `YouTube API access denied (${err.reason}).`, "Enable YouTube Data API v3 for this key's project and check key restrictions.", 403);
      throw new AppError("YOUTUBE_ERROR", `YouTube API error ${err.status}${err.reason ? ` (${err.reason})` : ""}: ${err.message}`, null, 502);
    }
    throw err;
  }

  async getVideo(videoId: string): Promise<VideoInfo> {
    type R = { items?: { id: string; snippet: { channelId: string; channelTitle: string; title: string; publishedAt: string }; contentDetails?: { duration?: string } }[] };
    const r = await this.get<R>("videos", { part: "snippet,contentDetails", id: videoId }).catch((e) => this.mapCommon(e));
    const item = r.items?.[0];
    if (!item) throw new AppError("YOUTUBE_NOT_FOUND", `Video ${videoId} was not found or is not public.`, "Check that the video is public (not private or deleted).", 404);
    return {
      videoId: item.id,
      channelId: item.snippet.channelId,
      channelTitle: item.snippet.channelTitle,
      title: item.snippet.title,
      publishedAt: toUtcIso(item.snippet.publishedAt),
      durationMs: parseIsoDurationMs(item.contentDetails?.duration),
    };
  }

  async getUploadsPlaylistId(channelId: string): Promise<string> {
    type R = { items?: { contentDetails?: { relatedPlaylists?: { uploads?: string } } }[] };
    const r = await this.get<R>("channels", { part: "contentDetails", id: channelId }).catch((e) => this.mapCommon(e));
    const uploads = r.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) throw new AppError("YOUTUBE_NOT_FOUND", `Channel ${channelId} has no visible uploads playlist.`, null, 404);
    return uploads;
  }

  async listRecentUploads(playlistId: string, max: number): Promise<UploadItem[]> {
    type R = { items?: { snippet: { title: string; resourceId: { videoId: string } }; contentDetails?: { videoPublishedAt?: string } }[] };
    const r = await this.get<R>("playlistItems", { part: "snippet,contentDetails", playlistId, maxResults: String(Math.min(max, 50)) }).catch((e) => {
      if (e instanceof YouTubeHttpError && e.status === 404) return { items: [] } as R;
      return this.mapCommon(e);
    });
    return (r.items ?? [])
      .filter((i) => i.contentDetails?.videoPublishedAt) // private/deleted entries have no publish time
      .map((i) => ({ videoId: i.snippet.resourceId.videoId, title: i.snippet.title, publishedAt: toUtcIso(i.contentDetails!.videoPublishedAt!) }));
  }

  async listComments(videoId: string, max: number): Promise<CommentFetchResult> {
    type Thread = {
      snippet: {
        topLevelComment: {
          id: string;
          snippet: { textDisplay: string; publishedAt: string; likeCount?: number; authorChannelId?: { value?: string } };
        };
      };
    };
    type R = { items?: Thread[]; nextPageToken?: string };
    const fetchedAt = new Date().toISOString();
    const base = { videoId, order: this.commentOrder, requestedMax: max, fetchedAt };
    try {
      const r = await this.get<R>("commentThreads", {
        part: "snippet",
        videoId,
        maxResults: String(Math.min(max, 100)),
        order: this.commentOrder,
        textFormat: "plainText",
      });
      const comments: RetrievedComment[] = (r.items ?? []).slice(0, max).map((t) => {
        const c = t.snippet.topLevelComment;
        return {
          commentId: c.id,
          videoId,
          authorChannelId: c.snippet.authorChannelId?.value ?? null,
          text: c.snippet.textDisplay,
          publishedAt: toUtcIso(c.snippet.publishedAt),
          likeCount: c.snippet.likeCount ?? 0,
        };
      });
      return { ...base, status: "ok", comments, hasMore: Boolean(r.nextPageToken), detail: null };
    } catch (err) {
      if (err instanceof YouTubeHttpError) {
        if (err.reason === "commentsDisabled")
          return { ...base, status: "comments_disabled", comments: [], hasMore: false, detail: "Comments are disabled for this video." };
        if (err.reason === "videoNotFound" || err.status === 404)
          return { ...base, status: "video_not_found", comments: [], hasMore: false, detail: "Video not found." };
        if (err.status === 403 && err.reason === "forbidden")
          return { ...base, status: "forbidden", comments: [], hasMore: false, detail: "Comments are not accessible for this video." };
      }
      return this.mapCommon(err);
    }
  }
}
