// OpusClip MCP adapter (hosted server https://mcp.opus.pro/mcp, OAuth).
//
// We connect through `mcp-remote` over stdio, which performs the OAuth browser
// sign-in on first use and caches tokens under ~/.mcp-auth (never in this repo).
// Tool schemas are discovered live with tools/list before anything is called,
// and submission is refused unless opusclip_submit_project advertises
// `customPrompt`. MCP arguments are NOT assumed to match REST fields: the MCP
// tool takes flat `customPrompt`, `clipDurationsSec`, `aspectRatio`, `model`.
//
// Response shapes of MCP tools are not documented. We read structuredContent,
// else JSON text content, and only use time values whose unit is explicit in
// the field name (e.g. `start_ms`) or verifiable; otherwise they are reported
// unavailable.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Config } from "../config.js";
import { AppError } from "../errors.js";
import { log, redact } from "../log.js";
import type { RawRanges, RawTranscriptParagraph, TimeUnit } from "./normalize.js";
import { mapProjectStage } from "./rest.js";
import type { AccessCheck, OpusClipAdapter, ProjectStatus, ProviderClip, ProviderTranscript, RecentProject, SubmitRequest, SubmitResult } from "./types.js";

export const MCP_TOOLS = {
  whoami: "opusclip_whoami",
  submit: "opusclip_submit_project",
  listProjects: "opusclip_list_projects",
  listClips: "opusclip_list_clips",
  transcript: "opusclip_get_transcript",
} as const;

interface ToolInfo {
  name: string;
  inputSchema: { properties?: Record<string, unknown>; required?: string[] };
}

type Row = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function pick(row: Row, ...keys: string[]): unknown {
  for (const k of keys) if (row[k] !== undefined && row[k] !== null) return row[k];
  return undefined;
}

/** Finds the first array of objects in a tool payload (top level or under a common key). */
function rowsOf(payload: unknown, ...keys: string[]): Row[] {
  if (Array.isArray(payload)) return payload as Row[];
  if (payload && typeof payload === "object") {
    for (const k of [...keys, "data", "items", "list", "results"]) {
      const v = (payload as Row)[k];
      if (Array.isArray(v)) return v as Row[];
    }
  }
  return [];
}

export function buildMcpSubmitArgs(req: SubmitRequest, schemaProps: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = { videoUrl: req.videoUrl, customPrompt: req.customPrompt, model: "ClipAnything" };
  if ("clipDurationsSec" in schemaProps) args.clipDurationsSec = [[req.durationSec[0], req.durationSec[1]]];
  if ("aspectRatio" in schemaProps) args.aspectRatio = req.aspectRatio;
  if ("title" in schemaProps) args.title = req.title;
  for (const k of Object.keys(args)) if (!(k in schemaProps)) delete args[k];
  return args;
}

/** Extracts clip ranges only when the unit is explicit in the field name or verifiable. */
export function mcpClipRanges(row: Row): RawRanges {
  const durationMs = num(pick(row, "duration_ms", "durationMs"));
  const explicitMs = pick(row, "time_ranges_ms", "timeRangesMs", "source_ranges_ms", "sourceRangesMs");
  if (explicitMs !== undefined) return { values: explicitMs, declaredUnit: "ms", durationMs };
  const explicitS = pick(row, "time_ranges_sec", "timeRangesSec", "source_ranges_sec");
  if (explicitS !== undefined) return { values: explicitS, declaredUnit: "s", durationMs };
  return { values: pick(row, "timeRanges", "time_ranges"), declaredUnit: "conflicting", durationMs };
}

/** MCP transcripts: accepts explicitly unit-named fields; plain start/end follow the documented REST seconds. */
export function mcpTranscript(payload: unknown): { paragraphs: RawTranscriptParagraph[] | null; unit: TimeUnit } {
  const rows = rowsOf(payload, "paragraphs", "transcript", "segments");
  if (rows.length === 0) return { paragraphs: null, unit: "ms" };
  const msNamed = rows.every((r) => num(r.start_ms ?? r.startMs) !== null);
  if (msNamed)
    return {
      unit: "ms",
      paragraphs: rows.map((r, i) => ({
        id: (r.paragraph_id ?? r.id ?? i) as string | number,
        start: num(r.start_ms ?? r.startMs)!,
        end: num(r.end_ms ?? r.endMs)!,
        text: String(r.text ?? ""),
        words: rowsOf(r.words).map((w) => ({ word: String(w.word ?? w.text ?? ""), start: num(w.start_ms ?? w.startMs) ?? 0, end: num(w.end_ms ?? w.endMs) ?? 0 })),
      })),
    };
  const secNamed = rows.every((r) => num(r.start) !== null && num(r.end) !== null);
  if (secNamed) return { unit: "s", paragraphs: rows as unknown as RawTranscriptParagraph[] };
  throw new AppError("OPUS_UNSUPPORTED", "MCP transcript has no recognizable time fields; refusing to guess units.", "Use OPUSCLIP_TRANSPORT=rest.", 502);
}

export class McpOpusClipAdapter implements OpusClipAdapter {
  readonly transport = "mcp" as const;
  readonly consumesCredits = true;
  private client: Client | null = null;
  private tools = new Map<string, ToolInfo>();
  private connecting: Promise<void> | null = null;

  constructor(private readonly cfg: Config["opus"]) {}

  private async connect(): Promise<void> {
    if (this.client) return;
    if (!this.connecting)
      this.connecting = (async () => {
        const [command, ...args] = this.cfg.mcpCommand.split(/\s+/).filter(Boolean);
        const transport = new StdioClientTransport({ command, args: [...args, this.cfg.mcpUrl], stderr: "pipe" });
        const client = new Client({ name: "audience-research", version: "0.1.0" });
        try {
          await client.connect(transport);
          const { tools } = await client.listTools();
          this.tools = new Map(tools.map((t) => [t.name, t as unknown as ToolInfo]));
          this.client = client;
        } catch (err) {
          await client.close().catch(() => {});
          throw new AppError(
            "OPUS_AUTH",
            redact(`Could not connect to the OpusClip MCP server: ${(err as Error).message}`),
            "Run `npm run opus:mcp-login` once to complete the OpusClip OAuth sign-in, then retry.",
            502,
            true,
          );
        } finally {
          this.connecting = null;
        }
      })();
    return this.connecting;
  }

  async listToolSchemas(): Promise<ToolInfo[]> {
    await this.connect();
    return [...this.tools.values()];
  }

  private requireTool(name: string): ToolInfo {
    const t = this.tools.get(name);
    if (!t) throw new AppError("OPUS_UNSUPPORTED", `OpusClip MCP server does not expose ${name}.`, "Use OPUSCLIP_TRANSPORT=rest.", 502, true);
    return t;
  }

  private async call(name: string, args: Record<string, unknown>, opts: { timeoutMs?: number } = {}): Promise<unknown> {
    await this.connect();
    this.requireTool(name);
    const result = await this.client!.callTool({ name, arguments: args }, undefined, { timeout: opts.timeoutMs ?? 120_000 });
    const content = (result.content ?? []) as { type: string; text?: string }[];
    const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    if (result.isError) throw mapMcpError(name, text);
    if (result.structuredContent !== undefined) return result.structuredContent;
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }

  /**
   * Reports reachability, tool discovery and authentication separately. A
   * whoami failure means "not authenticated", whatever the tool list says, and
   * entitlement is never claimed: only a real submission proves it.
   */
  async checkAccess(): Promise<AccessCheck> {
    try {
      await this.connect();
    } catch (err) {
      return {
        ok: false,
        transport: "mcp",
        detail: (err as Error).message,
        supportsCustomPrompt: null,
        checks: { serverReachable: false, toolsDiscovered: false, authenticated: null, entitlementVerified: null },
      };
    }
    const submit = this.tools.get(MCP_TOOLS.submit);
    const props = submit?.inputSchema?.properties ?? {};
    const supportsCustomPrompt = submit ? "customPrompt" in props : null;
    let who: unknown;
    let authenticated: boolean | null = null;
    if (!this.tools.has(MCP_TOOLS.whoami)) who = { error: `${MCP_TOOLS.whoami} not exposed; authentication not verified` };
    else
      try {
        who = await this.call(MCP_TOOLS.whoami, {});
        authenticated = true;
      } catch (e) {
        who = { error: (e as Error).message };
        authenticated = false;
      }
    const problems = [
      !submit && `${MCP_TOOLS.submit} not exposed`,
      submit && !supportsCustomPrompt && "submit tool has no customPrompt argument — use REST",
      authenticated === false && `${MCP_TOOLS.whoami} failed — sign in again with npm run opus:mcp-login`,
      authenticated === null && "account authentication could not be verified",
    ].filter(Boolean);
    return {
      ok: Boolean(submit) && supportsCustomPrompt === true && authenticated === true,
      transport: "mcp",
      detail: problems.length
        ? `Connected, but: ${problems.join("; ")}.`
        : "Connected and authenticated; submit tool supports customPrompt. Entitlement/credits are not verified until a real submission.",
      supportsCustomPrompt,
      checks: { serverReachable: true, toolsDiscovered: Boolean(submit), authenticated, entitlementVerified: null },
      raw: { whoami: who, submitSchema: submit?.inputSchema ?? null, tools: [...this.tools.keys()] },
    };
  }

  async submitProject(req: SubmitRequest): Promise<SubmitResult> {
    await this.connect();
    const props = this.requireTool(MCP_TOOLS.submit).inputSchema.properties ?? {};
    if (!("customPrompt" in props))
      throw new AppError("OPUS_UNSUPPORTED", "The OpusClip MCP submit tool does not accept customPrompt.", "Set OPUSCLIP_TRANSPORT=rest with OPUSCLIP_API_KEY.", 400, true);
    const args = buildMcpSubmitArgs(req, props);
    let payload: unknown;
    try {
      payload = await this.call(MCP_TOOLS.submit, args, { timeoutMs: 180_000 });
    } catch (err) {
      if (err instanceof AppError && err.definitelyNotCreated) throw err;
      throw new AppError("OPUS_AMBIGUOUS_SUBMIT", redact(`MCP submit did not complete cleanly: ${(err as Error).message}`), "Do not resubmit blindly: use Reconcile to look for the project first.", 504, false);
    }
    const row = (payload ?? {}) as Row;
    const projectId = str(pick(row, "project_id", "projectId", "id")) ?? str((row.text as string | undefined)?.match(/\bP[0-9A-Za-z]{8,}\b/)?.[0]);
    if (!projectId)
      throw new AppError("OPUS_AMBIGUOUS_SUBMIT", "MCP submit returned no recognizable project ID.", "Use Reconcile to look for the project before resubmitting.", 502, false);
    return { projectId, sentRequest: { tool: MCP_TOOLS.submit, arguments: args }, raw: payload };
  }

  async listRecentProjects(): Promise<RecentProject[]> {
    const payload = await this.call(MCP_TOOLS.listProjects, {});
    return rowsOf(payload, "projects").map((p) => ({
      projectId: str(pick(p, "project_id", "projectId", "id")) ?? "",
      createdAt: str(pick(p, "created_at", "createdAt")),
      sourceVideoId: str(pick(p, "source_video_id", "sourceVideoId")),
      stage: str(p.stage),
      title: str(pick(p, "title", "name")),
    }));
  }

  async getProjectStatus(projectId: string): Promise<ProjectStatus> {
    const payload = await this.call(MCP_TOOLS.listProjects, {});
    const row = rowsOf(payload, "projects").find((p) => pick(p, "project_id", "projectId", "id") === projectId);
    if (!row) return { state: "unknown", stage: null, error: null, raw: { note: "project not in list_projects output" } };
    const stage = str(row.stage);
    const error = str(row.error);
    return { state: mapProjectStage(stage, error), stage, error, raw: row };
  }

  async listClips(projectId: string): Promise<{ clips: ProviderClip[]; raw: unknown }> {
    const payload = await this.call(MCP_TOOLS.listClips, { projectId });
    const clips = rowsOf(payload, "clips").map((c): ProviderClip => {
      const clipId = str(pick(c, "clip_id", "clipId", "id")) ?? "unknown";
      return {
        id: clipId.includes(".") ? clipId : `${projectId}.${clipId}`,
        title: str(c.title) ?? "",
        previewUrl: str(pick(c, "preview_url", "previewUrl", "uriForPreview")),
        // list_clips returns preview URLs only; HD URLs need an export tool whose
        // schema has not been verified live, so export is not called here and
        // exportUrl stays null unless the row itself carries one. A preview URL
        // is never presented as an HD download.
        exportUrl: str(pick(c, "export_url", "exportUrl", "uriForExport")),
        ranges: mcpClipRanges(c),
        renderPending: typeof c.render_pending === "boolean" ? c.render_pending : null,
        raw: c,
      };
    });
    return { clips, raw: payload };
  }

  async getTranscript(projectId: string): Promise<ProviderTranscript> {
    const payload = await this.call(MCP_TOOLS.transcript, { projectId });
    const t = mcpTranscript(payload);
    return { ...t, raw: payload };
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => {});
    this.client = null;
  }
}

function mapMcpError(tool: string, text: string): AppError {
  const t = redact(text).slice(0, 300);
  if (/monthly|cap reached|API_MONTHLY_CAP|\b403\b/i.test(text)) return new AppError("OPUS_CREDITS_OR_CAP", `OpusClip refused ${tool}: ${t}`, "Check credits / monthly API cap in the OpusClip dashboard.", 403, true);
  if (/not enabled|upgrade|entitlement/i.test(text)) return new AppError("OPUS_NO_API_ACCESS", `OpusClip API access not enabled: ${t}`, "API/MCP tools require a Pro (Beta), Max or Business plan.", 403, true);
  if (/\b401\b|unauthori[sz]ed|oauth/i.test(text)) return new AppError("OPUS_AUTH", `OpusClip MCP auth failed: ${t}`, "Run `npm run opus:mcp-login` again.", 401, true);
  if (/concurren|\b429\b/i.test(text)) return new AppError("OPUS_CONCURRENCY", `OpusClip is busy: ${t}`, "Wait for in-flight projects to finish, then retry.", 429, true);
  log.warn(`MCP tool ${tool} error: ${t}`);
  // Unknown tool errors are not proof the job was rejected.
  return new AppError("OPUS_ERROR", `OpusClip ${tool} failed: ${t}`, null, 502, false);
}
