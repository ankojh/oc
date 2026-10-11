import type { DeclaredCoverage, RawRanges, RawTranscriptParagraph, TimeUnit } from "./normalize.js";

export interface SubmitRequest {
  videoUrl: string;
  title: string;
  customPrompt: string;
  durationSec: [number, number];
  aspectRatio: "portrait" | "landscape" | "square";
}

export interface SubmitResult {
  projectId: string;
  /** The exact request sent to the provider (no secrets), for the audit trail. */
  sentRequest: unknown;
  raw: unknown;
}

export interface ProjectStatus {
  state: "processing" | "complete" | "failed" | "unknown";
  stage: string | null;
  error: string | null;
  raw: unknown;
}

export interface ProviderClip {
  id: string;
  title: string;
  previewUrl: string | null;
  exportUrl: string | null;
  ranges: RawRanges;
  renderPending: boolean | null;
  raw: unknown;
}

export interface ProviderTranscript {
  /** null when the provider reports no transcript for the project yet. */
  paragraphs: RawTranscriptParagraph[] | null;
  unit: TimeUnit;
  /** Set only when the provider explicitly reports transcript completeness; never inferred. */
  declaredCoverage?: DeclaredCoverage | null;
  raw: unknown;
}

export interface RecentProject {
  projectId: string;
  createdAt: string | null;
  sourceVideoId: string | null;
  stage: string | null;
  /** Project title as listed by the provider; carries the run correlation token when supported. */
  title: string | null;
}

export interface AccessCheck {
  ok: boolean;
  transport: "mcp" | "rest" | "fixture";
  detail: string;
  supportsCustomPrompt: boolean | null;
  /**
   * Separate facts, each established independently. `entitlementVerified` stays
   * null: neither a tool listing nor an authenticated read proves that a paid
   * submission will be accepted.
   */
  checks?: {
    serverReachable: boolean;
    toolsDiscovered: boolean | null;
    authenticated: boolean | null;
    entitlementVerified: boolean | null;
  };
  raw?: unknown;
}

/** Same contract for fixture, REST and MCP so the run manager is transport-agnostic. */
export interface OpusClipAdapter {
  readonly transport: "mcp" | "rest" | "fixture";
  /** Whether a submission consumes credits on a real account. */
  readonly consumesCredits: boolean;
  checkAccess(): Promise<AccessCheck>;
  /**
   * Submits exactly one project. Throws AppError; `definitelyNotCreated=true`
   * only when the provider definitively rejected the request (4xx).
   */
  submitProject(req: SubmitRequest): Promise<SubmitResult>;
  getProjectStatus(projectId: string): Promise<ProjectStatus>;
  listClips(projectId: string): Promise<{ clips: ProviderClip[]; raw: unknown }>;
  getTranscript(projectId: string): Promise<ProviderTranscript>;
  /** Used to reconcile an ambiguous submit: find projects created after a point in time. */
  listRecentProjects(): Promise<RecentProject[]>;
  close?(): Promise<void>;
}
