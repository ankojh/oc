import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Config, ROOT_DIR } from "../src/config.js";
import type { RetrievedComment } from "../src/youtube/types.js";

export function testConfig(overrides: Partial<Config["opus"]> = {}): Config {
  return {
    port: 0,
    dataDir: mkdtempSync(path.join(os.tmpdir(), "ar-test-")),
    fixturesDir: path.join(ROOT_DIR, "fixtures"),
    youtube: { apiKey: "test-youtube-key", commentsPerVideo: 100, maxRelatedVideos: 5, recentUploadsToConsider: 15 },
    codex: { model: null, reasoningEffort: null, isolateMcpServers: true, timeoutMs: 1000 },
    opus: {
      transport: "rest",
      apiKey: "test-opus-key",
      orgId: null,
      apiBaseUrl: "https://api.test.invalid/api",
      mcpUrl: "https://mcp.test.invalid/mcp",
      mcpCommand: "false",
      timeRangeUnit: "verify",
      pollIntervalMs: 1,
      maxPollMinutes: 1,
      defaultDurationSec: [0, 90],
      defaultAspectRatio: "portrait",
      ...overrides,
    },
  };
}

let n = 0;
export function comment(text: string, videoId = "VIDEOID0001", extra: Partial<RetrievedComment> = {}): RetrievedComment {
  n++;
  return {
    commentId: `c${String(n).padStart(4, "0")}`,
    videoId,
    authorChannelId: `UCa${n}`,
    text,
    publishedAt: "2026-09-01T00:00:00.000Z",
    likeCount: 0,
    ...extra,
  };
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
