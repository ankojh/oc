// OpusClip REST adapter (https://help.opus.pro/api-reference). Field mapping
// confirmed against the documented OpenAPI for POST /api/clip-projects,
// GET /api/exportable-clips and GET /api/transcripts:
//   brief.customPrompt  -> curationPref.customPrompt (ClipAnything only)
//   brief.durationSec   -> curationPref.clipDurations [[min, max]] (seconds)
//   brief.aspectRatio   -> renderPref.layoutAspectRatio
//   model               -> curationPref.model = "ClipAnything"
// Project stage polling uses GET /api/clip-projects (list), the same call the
// official OpusClip skill CLI uses; there is no documented single-project GET.
import type { Config } from "../config.js";
import { AppError } from "../errors.js";
import { redact } from "../log.js";
import type { AccessCheck, OpusClipAdapter, ProjectStatus, ProviderClip, ProviderTranscript, RecentProject, SubmitRequest, SubmitResult } from "./types.js";
import type { RawTranscriptParagraph } from "./normalize.js";

const TERMINAL_FAILED = new Set(["STALLED", "FAILED", "ERROR"]);

export function buildRestSubmitBody(req: SubmitRequest) {
  return {
    videoUrl: req.videoUrl,
    uploadedVideoAttr: { title: req.title },
    curationPref: {
      model: "ClipAnything",
      customPrompt: req.customPrompt,
      clipDurations: [[req.durationSec[0], req.durationSec[1]]],
      genre: "Auto",
    },
    renderPref: { layoutAspectRatio: req.aspectRatio },
  };
}

export function mapProjectStage(stage: string | null | undefined, error?: string | null): ProjectStatus["state"] {
  if (error) return "failed";
  if (!stage) return "unknown";
  if (stage === "COMPLETE") return "complete";
  if (TERMINAL_FAILED.has(stage)) return "failed";
  return "processing";
}

/** Maps an HTTP failure to an actionable error. All 4xx mean the request was rejected (no job). */
export function mapOpusHttpError(status: number, bodyText: string, headers: Headers | null, op: string): AppError {
  const text = redact(bodyText).slice(0, 300);
  const rejected = status >= 400 && status < 500;
  if (status === 401) return new AppError("OPUS_AUTH", `OpusClip rejected the credentials (${op}).`, "Check OPUSCLIP_API_KEY (dashboard → API Access).", 401, rejected);
  if (status === 403) {
    if (/API_MONTHLY_CAP_REACHED/.test(bodyText))
      return new AppError("OPUS_CREDITS_OR_CAP", `OpusClip monthly API cap reached (${op}). ${text}`, "Wait for the cap reset on the 1st (UTC) or contact OpusClip sales.", 403, rejected);
    if (/not enabled|entitlement|upgrade/i.test(bodyText))
      return new AppError("OPUS_NO_API_ACCESS", `OpusClip API access is not enabled for this org (${op}).`, "API access requires a Pro (Beta), Max or Business plan.", 403, rejected);
    return new AppError("OPUS_CREDITS_OR_CAP", `OpusClip refused the request (${op}): ${text}`, "Check remaining credits and plan limits in the OpusClip dashboard.", 403, rejected);
  }
  if (status === 429) {
    if (headers?.get("x-cap-reason") === "concurrent")
      return new AppError("OPUS_CONCURRENCY", "OpusClip concurrent-project limit reached.", "Wait for an in-flight project to finish, then submit again.", 429, rejected);
    return new AppError("OPUS_RATE_LIMIT", "OpusClip rate limit reached (30 requests/minute).", "Wait a minute and retry.", 429, rejected);
  }
  if (status === 402) return new AppError("OPUS_CREDITS_OR_CAP", `Insufficient OpusClip credits (${op}).`, "Add credits in the OpusClip dashboard.", 402, rejected);
  if (rejected) return new AppError("OPUS_BAD_REQUEST", `OpusClip rejected the request (${op}, HTTP ${status}): ${text}`, null, 400, rejected);
  return new AppError("OPUS_ERROR", `OpusClip server error (${op}, HTTP ${status}): ${text}`, "Retry later.", 502, false);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function unwrapArray(raw: unknown, op: string): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  const r = raw as { data?: unknown; list?: unknown };
  if (Array.isArray(r?.data)) return r.data as Record<string, unknown>[];
  if (Array.isArray(r?.list)) return r.list as Record<string, unknown>[];
  throw new AppError("OPUS_ERROR", `Unexpected response shape from ${op}`, null, 502);
}

export class RestOpusClipAdapter implements OpusClipAdapter {
  readonly transport = "rest" as const;
  readonly consumesCredits = true;

  constructor(
    private readonly cfg: Config["opus"],
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!cfg.apiKey) throw new AppError("CONFIG_MISSING", "OPUSCLIP_API_KEY is not set.", "Set OPUSCLIP_API_KEY in .env or use OPUSCLIP_TRANSPORT=mcp.", 400);
  }

  private async request(method: "GET" | "POST", path: string, body: unknown, op: string, timeoutMs = 30_000): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.cfg.apiKey}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.cfg.orgId) headers["x-opus-org-id"] = this.cfg.orgId;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.apiBaseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      // Network failure or timeout: for a POST we cannot know whether the server acted.
      throw new AppError("OPUS_ERROR", redact(`OpusClip ${op} did not complete: ${(err as Error).message}`, [this.cfg.apiKey]), null, 504, false);
    }
    const text = await res.text();
    if (!res.ok) throw mapOpusHttpError(res.status, redact(text, [this.cfg.apiKey]), res.headers, op);
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new AppError("OPUS_ERROR", `OpusClip ${op} returned non-JSON`, null, 502, false);
    }
  }

  async checkAccess(): Promise<AccessCheck> {
    try {
      const raw = await this.request("GET", "/api-usage?q=mine", undefined, "usage");
      return {
        ok: true,
        transport: "rest",
        detail: "OpusClip REST API key accepted for a read. This does not prove a paid project submission will be accepted.",
        supportsCustomPrompt: true,
        checks: { serverReachable: true, toolsDiscovered: null, authenticated: true, entitlementVerified: null },
        raw,
      };
    } catch (err) {
      const reachable = !(err instanceof AppError && err.httpStatus === 504);
      const authFailed = err instanceof AppError && err.code === "OPUS_AUTH";
      return {
        ok: false,
        transport: "rest",
        detail: (err as Error).message,
        supportsCustomPrompt: true,
        checks: { serverReachable: reachable, toolsDiscovered: null, authenticated: authFailed ? false : null, entitlementVerified: null },
      };
    }
  }

  async submitProject(req: SubmitRequest): Promise<SubmitResult> {
    const body = buildRestSubmitBody(req);
    let raw: unknown;
    try {
      raw = await this.request("POST", "/clip-projects", body, "submit project", 60_000);
    } catch (err) {
      if (err instanceof AppError && !err.definitelyNotCreated)
        throw new AppError("OPUS_AMBIGUOUS_SUBMIT", `${err.message} — the project may or may not have been created.`, "Do not resubmit blindly: use Reconcile to look for the project first.", 504, false);
      throw err;
    }
    const data = (raw as { data?: unknown })?.data ?? raw;
    const projectId = str((data as Record<string, unknown>)?.id) ?? str((data as Record<string, unknown>)?.projectId);
    if (!projectId)
      throw new AppError("OPUS_AMBIGUOUS_SUBMIT", "OpusClip accepted the request but returned no project ID.", "Use Reconcile to look for the project before resubmitting.", 502, false);
    return { projectId, sentRequest: body, raw };
  }

  async listRecentProjects(): Promise<RecentProject[]> {
    const raw = await this.request("GET", "/clip-projects?page=0&pageSize=50", undefined, "list projects");
    return unwrapArray(raw, "list projects").map((p) => {
      const sourceInfo = p.sourceInfo as { videoId?: string } | undefined;
      const sourceId = str(p.sourceId);
      return {
        projectId: str(p.projectId) ?? str(p.id) ?? "",
        createdAt: str(p.createdAt),
        sourceVideoId: str(sourceInfo?.videoId) ?? (sourceId?.startsWith("YT_") ? sourceId.slice(3) : null),
        stage: str(p.stage),
        // Not documented for the list response; used for correlation only when present.
        title: str(p.title) ?? str((p.uploadedVideoAttr as { title?: unknown } | undefined)?.title) ?? str((p.videoInfo as { title?: unknown } | undefined)?.title),
      };
    });
  }

  async getProjectStatus(projectId: string): Promise<ProjectStatus> {
    const raw = await this.request("GET", "/clip-projects?page=0&pageSize=50", undefined, "project status");
    const row = unwrapArray(raw, "project status").find((p) => p.projectId === projectId || p.id === projectId);
    if (!row) return { state: "unknown", stage: null, error: null, raw: { note: "project not in the 50 most recent projects" } };
    const stage = str(row.stage);
    const error = str(row.error);
    return { state: mapProjectStage(stage, error), stage, error, raw: row };
  }

  async listClips(projectId: string): Promise<{ clips: ProviderClip[]; raw: unknown }> {
    const raw = await this.request("GET", `/exportable-clips?q=findByProjectId&projectId=${encodeURIComponent(projectId)}&pageNum=1&pageSize=100`, undefined, "list clips");
    const clips = unwrapArray(raw, "list clips").map((c): ProviderClip => {
      const pending = (c.renderAsVideoFile as { pending?: boolean } | undefined)?.pending;
      return {
        id: str(c.id) ?? `${projectId}.${str(c.curationId) ?? "unknown"}`,
        title: str(c.title) ?? "",
        previewUrl: str(c.uriForPreview),
        exportUrl: str(c.uriForExport),
        // Documented as "(in seconds)" while the documented example is in ms: verify, don't guess.
        ranges: { values: c.timeRanges, declaredUnit: "conflicting", durationMs: typeof c.durationMs === "number" ? c.durationMs : null },
        renderPending: typeof pending === "boolean" ? pending : null,
        raw: c,
      };
    });
    return { clips, raw };
  }

  async getTranscript(projectId: string): Promise<ProviderTranscript> {
    const raw = await this.request("GET", `/transcripts?q=findByProjectId&projectId=${encodeURIComponent(projectId)}`, undefined, "get transcript");
    const data = (raw as { data?: unknown }).data;
    if (!Array.isArray(data) || data.length === 0 || data[0] === null) return { paragraphs: null, unit: "s", raw };
    // Documented: paragraph and word start/end are in seconds.
    return { paragraphs: data[0] as RawTranscriptParagraph[], unit: "s", raw };
  }
}
