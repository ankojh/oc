// Fixture OpusClip adapter: no network, no credits. Responses mirror the
// documented REST shapes (exportable-clips, transcripts) so they flow through
// the same normalization as live data. Project progress advances one stage per
// poll to exercise the asynchronous path.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AppError } from "../errors.js";
import type { RawTranscriptParagraph } from "./normalize.js";
import { mapProjectStage } from "./rest.js";
import type { AccessCheck, OpusClipAdapter, ProjectStatus, ProviderClip, ProviderTranscript, RecentProject, SubmitRequest, SubmitResult } from "./types.js";

const STAGES = ["QUEUED", "IMPORT", "CURATE", "RENDER", "COMPLETE"];

interface FixtureProject {
  sourceVideoId: string;
  clips: Record<string, unknown>[];
  transcript: { data: (RawTranscriptParagraph[] | null)[] };
}

export class FixtureOpusClipAdapter implements OpusClipAdapter {
  readonly transport = "fixture" as const;
  readonly consumesCredits = false;
  private polls = new Map<string, number>();
  private submissions: RecentProject[] = [];
  private fixtures: Record<string, FixtureProject>;

  constructor(dir: string) {
    this.fixtures = JSON.parse(readFileSync(path.join(dir, "projects.json"), "utf8"));
  }

  private videoIdOf(url: string): string | null {
    return new URL(url).searchParams.get("v");
  }

  async checkAccess(): Promise<AccessCheck> {
    return {
      ok: true,
      transport: "fixture",
      detail: "Fixture OpusClip adapter (no account, no credits).",
      supportsCustomPrompt: true,
      checks: { serverReachable: true, toolsDiscovered: true, authenticated: null, entitlementVerified: null },
    };
  }

  async submitProject(req: SubmitRequest): Promise<SubmitResult> {
    const vid = this.videoIdOf(req.videoUrl);
    if (!vid || !this.fixtures[vid]) throw new AppError("OPUS_BAD_REQUEST", `No OpusClip fixture for video ${vid}.`, null, 400, true);
    const projectId = `PFX${createHash("sha256").update(`${req.videoUrl}|${req.customPrompt}`).digest("hex").slice(0, 9)}`;
    this.submissions.push({ projectId, createdAt: new Date().toISOString(), sourceVideoId: vid, stage: "QUEUED", title: req.title });
    return { projectId, sentRequest: { fixture: true, ...req }, raw: { projectId, stage: "QUEUED", fixture: true } };
  }

  async listRecentProjects(): Promise<RecentProject[]> {
    return [...this.submissions];
  }

  private fixtureFor(projectId: string): FixtureProject {
    const sub = this.submissions.find((s) => s.projectId === projectId);
    const vid = sub?.sourceVideoId ?? Object.keys(this.fixtures)[0]; // after a restart, fall back to the demo fixture
    return this.fixtures[vid];
  }

  async getProjectStatus(projectId: string): Promise<ProjectStatus> {
    const n = (this.polls.get(projectId) ?? 0) + 1;
    this.polls.set(projectId, n);
    const stage = STAGES[Math.min(n, STAGES.length - 1)];
    return { state: mapProjectStage(stage), stage, error: null, raw: { projectId, stage, fixture: true } };
  }

  async listClips(projectId: string): Promise<{ clips: ProviderClip[]; raw: unknown }> {
    const raw: Record<string, unknown>[] = this.fixtureFor(projectId).clips.map((c) => ({ ...c, id: `${projectId}.${c.curationId}`, projectId }));
    const clips = raw.map(
      (c): ProviderClip => ({
        id: c.id as string,
        title: (c.title as string) ?? "",
        previewUrl: (c.uriForPreview as string) ?? null,
        exportUrl: (c.uriForExport as string) ?? null,
        ranges: { values: c.timeRanges, declaredUnit: "conflicting", durationMs: (c.durationMs as number) ?? null },
        renderPending: false,
        raw: c,
      }),
    );
    return { clips, raw };
  }

  async getTranscript(projectId: string): Promise<ProviderTranscript> {
    const raw = this.fixtureFor(projectId).transcript;
    const first = raw.data[0] ?? null;
    return { paragraphs: first, unit: "s", raw };
  }
}
