// Server-to-server clients for the two existing services. Only their public
// HTTP APIs are used; the coordinator never talks to OpusClip, YouTube or Codex.

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** An upstream failure with the service's own error code and action preserved. */
export class ServiceError extends Error {
  constructor(
    readonly service: "research" | "review",
    /** HTTP status, or 0 when no response arrived (the request may still have been processed). */
    readonly status: number,
    readonly code: string,
    message: string,
    readonly action: string | null = null,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "ServiceError";
  }
  get noResponse(): boolean {
    return this.status === 0;
  }
}

async function request(service: "research" | "review", fetchImpl: FetchLike, base: string, method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 30_000) {
  let res: Response;
  try {
    res = await fetchImpl(`${base}${path}`, {
      method,
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ServiceError(service, 0, "SERVICE_UNREACHABLE", `${service} service did not respond to ${method} ${path}: ${(err as Error).message}`, `Check that the ${service} service is running (npm start at the repository root starts all services).`);
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new ServiceError(service, res.status, "BAD_RESPONSE", `${service} service returned non-JSON for ${method} ${path} (HTTP ${res.status}).`);
  }
  if (!res.ok) {
    // research: { error: { code, message, action } }; review: { error: "text", hint? }
    const e = json?.error;
    const code = typeof e === "object" && e?.code ? String(e.code) : `HTTP_${res.status}`;
    const message = typeof e === "object" && e?.message ? String(e.message) : typeof e === "string" ? e : `HTTP ${res.status}`;
    const action = typeof e === "object" ? (e?.action ?? null) : (json?.hint ?? null);
    throw new ServiceError(service, res.status, code, message, action, json);
  }
  return { status: res.status, json };
}

export interface ResearchRunView {
  runId: string;
  mode: "live" | "fixture";
  status: "researching" | "research_failed" | "insufficient_evidence" | "research_ready" | "generating" | "needs_reconciliation" | "generation_failed" | "completed";
  progress: { at: string; step: string; message: string }[];
  error: { code: string; message: string; action: string | null } | null;
  result: any;
  generation: {
    status: string;
    projectId: string | null;
    stage: string | null;
    submitAttempts: number;
    consumesCredits: boolean;
    creditNotice: string;
    reconciliation: any;
    error: { code: string; message: string; action: string | null } | null;
    events: { at: string; step: string; message: string }[];
  };
  reviewInputAvailable: boolean;
}

export class ResearchClient {
  constructor(
    readonly base: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}
  private call(method: "GET" | "POST", path: string, body?: unknown, timeoutMs?: number) {
    return request("research", this.fetchImpl, this.base, method, path, body, timeoutMs);
  }
  async health(): Promise<any> {
    return (await this.call("GET", "/health")).json;
  }
  async start(input: { videoUrl: string; creatorGoal: string | null; mode: "live" | "fixture" }): Promise<{ runId: string }> {
    return (await this.call("POST", "/research", input)).json;
  }
  async run(runId: string): Promise<ResearchRunView> {
    return (await this.call("GET", `/runs/${encodeURIComponent(runId)}`)).json;
  }
  /** Never sets forceNewProject unless the user explicitly asked for a new paid project. */
  async generate(runId: string, opts: { forceNewProject?: boolean } = {}): Promise<{ submitted: boolean; run: ResearchRunView }> {
    const body = opts.forceNewProject ? { confirmCredits: true, forceNewProject: true } : { confirmCredits: true };
    return (await this.call("POST", `/runs/${encodeURIComponent(runId)}/generate`, body, 240_000)).json;
  }
  async reconcile(runId: string): Promise<ResearchRunView> {
    return (await this.call("POST", `/runs/${encodeURIComponent(runId)}/reconcile`, {}, 120_000)).json;
  }
  async adoptProject(runId: string, projectId: string): Promise<ResearchRunView> {
    return (await this.call("POST", `/runs/${encodeURIComponent(runId)}/adopt-project`, { projectId })).json;
  }
  async resumePolling(runId: string): Promise<ResearchRunView> {
    return (await this.call("POST", `/runs/${encodeURIComponent(runId)}/poll`, {})).json;
  }
  async reviewInput(runId: string): Promise<unknown> {
    return (await this.call("GET", `/runs/${encodeURIComponent(runId)}/review-input`)).json;
  }
}

export interface ReviewView {
  reviewId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  progress: { step: string; at: string }[];
  reviewer: any;
  report: any;
  audit: any;
  warnings: any[];
  errors: { code: string; path: string; message: string; hint?: string }[];
}

export class ReviewClient {
  constructor(
    readonly base: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}
  async health(): Promise<any> {
    return (await request("review", this.fetchImpl, this.base, "GET", "/health")).json;
  }
  /** 202 = new review, 200 = identical input already reviewed (or in progress) and reused. */
  async submit(input: unknown, backend: "fixture" | "codex"): Promise<{ reviewId: string; reused: boolean; httpStatus: number }> {
    const r = await request("review", this.fetchImpl, this.base, "POST", `/reviews?backend=${backend}`, input, 60_000);
    return { ...r.json, httpStatus: r.status };
  }
  async get(reviewId: string): Promise<ReviewView> {
    return (await request("review", this.fetchImpl, this.base, "GET", `/reviews/${encodeURIComponent(reviewId)}`)).json;
  }
}
