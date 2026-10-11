// Minimal local HTTP server for the Review Agent (default port 3102).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { CodexBackend, FixtureBackend, codexOptionsFromEnv, type ReviewerBackend } from "./agent/backends.ts";
import { REVIEWER_VERSION, hashInput, runReview } from "./review.ts";
import { ReviewStore, type ReviewRecord } from "./store.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_INPUTS = join(ROOT, "fixtures", "inputs");
const FIXTURE_RESPONSES = join(ROOT, "fixtures", "responses");
const MAX_BODY = 20 * 1024 * 1024;

type BackendChoice = "auto" | "fixture" | "codex";

export type ServerOptions = {
  port: number;
  dataDir: string;
  backend: BackendChoice;
  makeCodex?: () => ReviewerBackend;
  /** Directory of bound fixture judgments; defaults to fixtures/responses. */
  fixtureResponsesDir?: string;
};

/**
 * auto: fixture-mode research is always replayed from bound fixture judgments
 * (and fails clearly when none matches); only live research goes to Codex.
 * Fixture data therefore never silently reaches a paid model.
 */
export function chooseBackend(raw: any, choice: BackendChoice, makeCodex: () => ReviewerBackend, fixtureDir = FIXTURE_RESPONSES): ReviewerBackend {
  const fixture = new FixtureBackend(fixtureDir);
  if (choice === "fixture") return fixture;
  if (choice === "codex") return makeCodex();
  return raw?.research?.mode === "live" ? makeCodex() : fixture;
}

function send(res: ServerResponse, code: number, body: unknown, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(type === "application/json" ? JSON.stringify(body, null, 2) : (body as string | Buffer));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function view(rec: ReviewRecord) {
  const result = rec.result as any;
  return {
    reviewId: rec.reviewId,
    status: rec.status,
    progress: rec.progress,
    reusedFrom: rec.reusedFrom ?? null,
    reviewerVersion: rec.reviewerVersion,
    backendVersionKey: rec.backendVersionKey,
    reviewer: result?.reviewer ?? null,
    report: result?.report ?? null,
    audit: result?.audit ?? null,
    warnings: result?.warnings ?? [],
    errors: rec.errors ?? [],
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

const HINTS: Record<string, string> = {
  schema: "Fix the field at `path` so the handoff matches schemas/audience-clips.v1/review-input.schema.json.",
  duplicate_id: "Make ids unique within the listed collection.",
  reviewer_failed: "For live review check Codex login (`codex login`) or CODEX_API_KEY; for fixture review add a bound fixture response. Then POST again with ?rerun=true.",
  reviewer_output_invalid: "The reviewer returned malformed output; POST again with ?rerun=true.",
  report_invalid: "Internal verification failed; this is a reviewer bug. Please report with the reviewId.",
};

export function startServer(opts: ServerOptions) {
  const store = new ReviewStore(opts.dataDir);
  store.failInterrupted();
  const makeCodex = opts.makeCodex ?? (() => new CodexBackend(codexOptionsFromEnv()));
  const now = () => new Date().toISOString();

  async function execute(rec: ReviewRecord, backend: ReviewerBackend) {
    const step = (s: string) => {
      rec.progress.push({ step: s, at: now() });
      store.save(rec);
    };
    rec.status = "running";
    step(`Reviewer backend: ${backend.kind}`);
    try {
      const out = await runReview(rec.input, backend, { onProgress: step });
      if (out.ok) {
        rec.status = "succeeded";
        rec.result = { report: out.report, audit: out.audit, warnings: out.warnings, reviewer: out.reviewer };
      } else {
        rec.status = "failed";
        rec.errors = out.errors.map((e) => ({ code: e.code, path: e.path, message: e.message, hint: HINTS[e.code] }));
      }
    } catch (e: any) {
      rec.status = "failed";
      rec.errors = [{ code: "internal", path: "(server)", message: e?.message ?? String(e) }];
    }
    store.save(rec);
  }

  const server = createServer(async (req, res) => {
    try {
      // Direct browser POSTs to the review service must not bypass the
      // coordinator's same-origin guard and start local Codex work. Reject
      // cross-origin requests and DNS-rebinding Host headers here as well.
      const host = req.headers.host ?? "";
      if (!/^(?:127\.0\.0\.1|localhost):\d+$/.test(host)) return send(res, 403, { error: "Only loopback Host headers are accepted." });
      const origin = req.headers.origin;
      if (req.method === "POST" && origin && origin !== `http://${host}`) return send(res, 403, { error: "Cross-origin requests are not accepted." });
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);

      if (req.method === "POST" && url.pathname === "/reviews") {
        let raw: unknown;
        try {
          raw = JSON.parse(await readBody(req));
        } catch (e: any) {
          if (e?.status === 413) return send(res, 413, { error: "Handoff exceeds 20 MB." });
          return send(res, 400, { error: "Request body must be a ReviewInput JSON document.", hint: "Send Content-Type: application/json with the handoff as the body." });
        }
        const choice = (url.searchParams.get("backend") as BackendChoice) || opts.backend;
        if (!["auto", "fixture", "codex"].includes(choice)) return send(res, 400, { error: `backend must be auto, fixture, or codex` });
        const backend = chooseBackend(raw, choice, makeCodex, opts.fixtureResponsesDir);
        const inputHash = hashInput(raw);
        const cacheKey = `${inputHash}:${REVIEWER_VERSION}:${backend.versionKey}`;
        const rerun = ["1", "true"].includes(url.searchParams.get("rerun") ?? "");
        const prior = rerun ? null : store.findByCacheKey(cacheKey);
        if (prior) return send(res, 200, { reviewId: prior.reviewId, reused: true });

        const rec: ReviewRecord = {
          reviewId: randomUUID().replace(/-/g, "").slice(0, 16),
          cacheKey,
          inputHash,
          reviewerVersion: REVIEWER_VERSION,
          backendVersionKey: backend.versionKey,
          status: "queued",
          progress: [{ step: "Queued", at: now() }],
          createdAt: now(),
          updatedAt: now(),
          input: raw,
        };
        store.save(rec);
        void execute(rec, backend);
        return send(res, 202, { reviewId: rec.reviewId, reused: false });
      }

      if (req.method === "GET" && parts[0] === "reviews" && parts.length >= 2) {
        const rec = store.get(parts[1]);
        if (!rec) return send(res, 404, { error: `No review "${parts[1]}".` });
        if (parts[2] === "report.json") {
          const report = (rec.result as any)?.report;
          if (!report) return send(res, 409, { error: `Review is ${rec.status}; no report to export.`, errors: rec.errors ?? [] });
          res.setHeader("content-disposition", `attachment; filename="review-${rec.reviewId}.json"`);
          return send(res, 200, report);
        }
        if (parts[2] === "input") return send(res, 200, rec.input);
        return send(res, 200, view(rec));
      }

      if (req.method === "GET" && url.pathname === "/fixtures")
        return send(res, 200, readdirSync(FIXTURE_INPUTS).filter((f) => f.endsWith(".json")).sort());
      if (req.method === "GET" && parts[0] === "fixtures" && parts.length === 2 && /^[\w.-]+\.json$/.test(parts[1])) {
        const f = join(FIXTURE_INPUTS, parts[1]);
        return existsSync(f) ? send(res, 200, readFileSync(f, "utf8"), "application/json") : send(res, 404, { error: "no such fixture" });
      }
      if (req.method === "GET" && parts[0] === "schemas" && parts.length === 2 && /^[\w.-]+\.json$/.test(parts[1])) {
        const f = join(ROOT, "schemas", "audience-clips.v1", parts[1]);
        return existsSync(f) ? send(res, 200, readFileSync(f, "utf8"), "application/json") : send(res, 404, { error: "no such schema" });
      }
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html"))
        return send(res, 200, readFileSync(join(ROOT, "public", "index.html")), "text/html; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/app.js")
        return send(res, 200, readFileSync(join(ROOT, "public", "app.js")), "text/javascript; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/health")
        return send(res, 200, { ok: true, reviewerVersion: REVIEWER_VERSION, defaultBackend: opts.backend });
      return send(res, 404, { error: "Not found" });
    } catch (e: any) {
      return send(res, 500, { error: e?.message ?? String(e) });
    }
  });
  server.listen(opts.port, "127.0.0.1");
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // Deliberately not reading generic PORT: audience-research uses PORT=3101.
  const port = Number(process.env.CLIP_REVIEW_PORT || 3102);
  const backend = (process.env.REVIEW_BACKEND as BackendChoice) || "auto";
  startServer({ port, dataDir: process.env.CLIP_REVIEW_DATA_DIR || join(ROOT, "data"), backend });
  console.log(`clip-review listening on http://127.0.0.1:${port} (backend: ${backend})`);
}
