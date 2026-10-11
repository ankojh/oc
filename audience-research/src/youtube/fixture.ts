// Fixture adapter: serves recorded-shape YouTube data from fixtures/youtube/*.json
// through the same interface as the live adapter. No network, no credentials.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { AppError } from "../errors.js";
import type { CommentFetchResult, RetrievedComment, UploadItem, VideoInfo, YouTubeAdapter } from "./types.js";

interface FixtureFile {
  description: string;
  channels: Record<string, { uploadsPlaylistId: string }>;
  playlists: Record<string, UploadItem[]>;
  videos: Record<string, VideoInfo>;
  comments: Record<string, { status: CommentFetchResult["status"]; items: Omit<RetrievedComment, "videoId">[] }>;
}

/** Fixed retrieval time so fixture output is reproducible. */
export const FIXTURE_FETCHED_AT = "2026-10-01T12:00:00.000Z";

export class FixtureYouTubeAdapter implements YouTubeAdapter {
  readonly kind = "fixture" as const;
  private data: FixtureFile;

  constructor(dir: string) {
    const merged: FixtureFile = { description: "", channels: {}, playlists: {}, videos: {}, comments: {} };
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
      const d = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as FixtureFile;
      Object.assign(merged.channels, d.channels);
      Object.assign(merged.playlists, d.playlists);
      Object.assign(merged.videos, d.videos);
      Object.assign(merged.comments, d.comments);
    }
    this.data = merged;
  }

  /** Source videos that have fixtures, for the UI. */
  listFixtureVideos(): { videoId: string; title: string }[] {
    const sources = new Set(["FXdemo00001", "FXnoqs00001"]);
    return Object.values(this.data.videos)
      .filter((v) => sources.has(v.videoId))
      .map((v) => ({ videoId: v.videoId, title: v.title }));
  }

  async getVideo(videoId: string): Promise<VideoInfo> {
    const v = this.data.videos[videoId];
    if (!v)
      throw new AppError(
        "YOUTUBE_NOT_FOUND",
        `Fixture mode has no data for video ${videoId}.`,
        `Use a fixture URL (e.g. https://www.youtube.com/watch?v=FXdemo00001) or switch to live mode.`,
        404,
      );
    return v;
  }

  async getUploadsPlaylistId(channelId: string): Promise<string> {
    const c = this.data.channels[channelId];
    if (!c) throw new AppError("YOUTUBE_NOT_FOUND", `Fixture channel ${channelId} not found.`, null, 404);
    return c.uploadsPlaylistId;
  }

  async listRecentUploads(playlistId: string, max: number): Promise<UploadItem[]> {
    return (this.data.playlists[playlistId] ?? []).slice(0, max);
  }

  async listComments(videoId: string, max: number): Promise<CommentFetchResult> {
    const c = this.data.comments[videoId];
    const base = { videoId, order: "relevance" as const, requestedMax: max, fetchedAt: FIXTURE_FETCHED_AT };
    if (!c) return { ...base, status: "video_not_found", comments: [], hasMore: false, detail: "No fixture comments." };
    if (c.status !== "ok") return { ...base, status: c.status, comments: [], hasMore: false, detail: `Fixture status: ${c.status}` };
    const items = c.items.slice(0, max).map((i) => ({ ...i, videoId }));
    return { ...base, status: "ok", comments: items, hasMore: c.items.length > max, detail: null };
  }
}
