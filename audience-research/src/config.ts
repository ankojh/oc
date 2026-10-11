import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Minimal .env loader so secrets stay in a git-ignored file, never in code. */
export function loadDotEnv(file = path.join(ROOT_DIR, ".env")): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    // Unquoted values may carry an inline comment: `KEY=value   # note`.
    else value = value.replace(/(^|\s+)#.*$/, "").trim();
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

export type OpusTransport = "mcp" | "rest";
export type TimeRangeUnitPolicy = "verify" | "ms" | "s";

export interface Config {
  port: number;
  dataDir: string;
  fixturesDir: string;
  youtube: {
    apiKey: string | null;
    commentsPerVideo: number;
    maxRelatedVideos: number;
    recentUploadsToConsider: number;
  };
  codex: {
    model: string | null;
    reasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh" | null;
    isolateMcpServers: boolean;
    timeoutMs: number;
  };
  opus: {
    transport: OpusTransport;
    apiKey: string | null;
    orgId: string | null;
    apiBaseUrl: string;
    mcpUrl: string;
    mcpCommand: string;
    timeRangeUnit: TimeRangeUnitPolicy;
    pollIntervalMs: number;
    maxPollMinutes: number;
    defaultDurationSec: [number, number];
    defaultAspectRatio: "portrait" | "landscape" | "square";
  };
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  return raw as T;
}

export function loadConfig(): Config {
  loadDotEnv();
  const durRaw = process.env.OPUSCLIP_CLIP_DURATION_SEC ?? "0,90";
  const dur = durRaw.split(",").map((s) => Number(s.trim()));
  if (dur.length !== 2 || dur.some((n) => !Number.isInteger(n) || n < 0) || dur[0] >= dur[1])
    throw new Error("OPUSCLIP_CLIP_DURATION_SEC must be 'min,max' integer seconds");
  return {
    port: int("PORT", 3101),
    dataDir: path.resolve(ROOT_DIR, process.env.DATA_DIR ?? "data"),
    fixturesDir: path.join(ROOT_DIR, "fixtures"),
    youtube: {
      apiKey: process.env.YOUTUBE_API_KEY || null,
      commentsPerVideo: Math.min(int("YOUTUBE_COMMENTS_PER_VIDEO", 100), 100),
      maxRelatedVideos: Math.min(int("YOUTUBE_MAX_RELATED_VIDEOS", 5), 5),
      recentUploadsToConsider: Math.min(int("YOUTUBE_RECENT_UPLOADS_TO_CONSIDER", 15), 50),
    },
    codex: {
      model: process.env.CODEX_MODEL || null,
      reasoningEffort: (process.env.CODEX_REASONING_EFFORT as Config["codex"]["reasoningEffort"]) || null,
      isolateMcpServers: process.env.CODEX_ISOLATE_MCP_SERVERS !== "false",
      timeoutMs: int("CODEX_TIMEOUT_MS", 240_000),
    },
    opus: {
      transport: oneOf("OPUSCLIP_TRANSPORT", ["mcp", "rest"] as const, "mcp"),
      apiKey: process.env.OPUSCLIP_API_KEY || null,
      orgId: process.env.OPUSCLIP_ORG_ID || null,
      apiBaseUrl: (process.env.OPUSCLIP_API_BASE_URL ?? "https://api.opus.pro/api").replace(/\/+$/, ""),
      mcpUrl: process.env.OPUSCLIP_MCP_URL ?? "https://mcp.opus.pro/mcp",
      mcpCommand: process.env.OPUSCLIP_MCP_COMMAND ?? "npx -y mcp-remote",
      timeRangeUnit: oneOf("OPUSCLIP_TIMERANGE_UNIT", ["verify", "ms", "s"] as const, "verify"),
      pollIntervalMs: int("OPUSCLIP_POLL_INTERVAL_MS", 20_000),
      maxPollMinutes: int("OPUSCLIP_MAX_POLL_MINUTES", 180),
      defaultDurationSec: [dur[0], dur[1]],
      defaultAspectRatio: oneOf("OPUSCLIP_ASPECT_RATIO", ["portrait", "landscape", "square"] as const, "portrait"),
    },
  };
}
