// Integration server (default 127.0.0.1:3100): one page plus a same-origin JSON
// API. The browser only talks to this server; this server talks to the two
// services server-to-server. No CORS headers are sent, and cross-origin POSTs
// are refused, so other websites cannot drive local Codex or paid OpusClip work.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Coordinator, CoordinatorError } from "./coordinator.ts";
import { ResearchClient, ReviewClient, ServiceError, type FetchLike } from "./services.ts";
import { IntegrationStore } from "./store.ts";
import { buildView } from "./view.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};

export interface IntegrationServerOptions {
  port: number;
  dataDir: string;
  researchUrl: string;
  reviewUrl: string;
  tickMs?: number;
  /** Injected in tests to simulate lost responses. */
  fetchImpl?: FetchLike;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body, null, 2));
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof CoordinatorError) return send(res, err.httpStatus, { error: { code: err.code, message: err.message, action: err.action } });
  if (err instanceof ServiceError)
    return send(res, err.status >= 400 && err.status < 500 ? err.status : 502, { error: { code: err.code, message: err.message, action: err.action, service: err.service } });
  console.error(err);
  return send(res, 500, { error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err), action: null } });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = req.headers["content-type"] ?? "";
  if (!type.startsWith("application/json")) throw new CoordinatorError("INVALID_INPUT", "Send JSON with Content-Type: application/json.", 415);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new CoordinatorError("INVALID_INPUT", "Request body too large.", 413);
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new CoordinatorError("INVALID_INPUT", "Body must be a JSON object.");
  }
}

export function startIntegrationServer(opts: IntegrationServerOptions): { server: Server; coordinator: Coordinator; ready: Promise<string> } {
  const store = new IntegrationStore(opts.dataDir);
  const research = new ResearchClient(opts.researchUrl, opts.fetchImpl);
  const review = new ReviewClient(opts.reviewUrl, opts.fetchImpl);
  const coordinator = new Coordinator({ store, research, review, tickMs: opts.tickMs });

  const view = (id: string) => {
    const rec = coordinator.get(id);
    return buildView(rec, store.loadSnapshot(id), store.loadResult(id));
  };

  const server = createServer(async (req, res) => {
    try {
      // Bind-to-loopback is not enough against DNS rebinding. Only allow
      // loopback Host headers, and require a same-origin Origin on browser POSTs.
      const host = req.headers.host ?? "";
      if (!/^(?:127\.0\.0\.1|localhost):\d+$/.test(host))
        return send(res, 403, { error: { code: "FORBIDDEN", message: "Only loopback Host headers are accepted.", action: null } });
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean);
      if (req.method === "GET" && PUBLIC[url.pathname]) {
        const [file, type] = PUBLIC[url.pathname];
        res.writeHead(200, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
        return res.end(readFileSync(join(ROOT, "public", file)));
      }
      if (req.method === "POST") {
        const origin = req.headers.origin;
        if (origin && origin !== `http://${host}`) return send(res, 403, { error: { code: "FORBIDDEN", message: "Cross-origin requests are not accepted.", action: null } });
      }
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
      if (req.method === "GET" && url.pathname === "/api/services") {
        const [r, v] = await Promise.allSettled([research.health(), review.health()]);
        return send(res, 200, {
          research: r.status === "fulfilled" ? { ok: true, url: opts.researchUrl, ...r.value } : { ok: false, url: opts.researchUrl, error: (r.reason as Error).message },
          review: v.status === "fulfilled" ? { ok: true, url: opts.reviewUrl, ...v.value } : { ok: false, url: opts.reviewUrl, error: (v.reason as Error).message },
        });
      }
      if (parts[0] === "api" && parts[1] === "integrations") {
        const id = parts[2];
        const action = parts[3];
        if (!id && req.method === "GET")
          return send(
            res,
            200,
            coordinator.list().map((r) => ({ integrationId: r.integrationId, mode: r.mode, status: r.status, failedStage: r.failedStage, videoUrl: r.input.videoUrl, createdAt: r.createdAt })),
          );
        if (!id && req.method === "POST") {
          const rec = await coordinator.create(await readJson(req));
          return send(res, 201, { integrationId: rec.integrationId, integration: view(rec.integrationId) });
        }
        if (id && !action && req.method === "GET") return send(res, 200, view(id));
        if (id && req.method === "POST") {
          const body = await readJson(req);
          switch (action) {
            case "generate": {
              const out = await coordinator.generate(id, body);
              return send(res, 200, { submitted: out.submitted, integration: view(id) });
            }
            case "reconcile":
              await coordinator.reconcile(id);
              return send(res, 200, view(id));
            case "adopt-project":
              await coordinator.adoptProject(id, body.projectId);
              return send(res, 200, view(id));
            case "resume-polling":
              await coordinator.resumePolling(id);
              return send(res, 200, view(id));
            case "force-new-project":
              await coordinator.forceNewProject(id, body);
              return send(res, 200, view(id));
            case "retry-review":
              await coordinator.retryReview(id);
              return send(res, 200, view(id));
            case "retry-handoff":
              await coordinator.retryHandoff(id);
              return send(res, 200, view(id));
          }
        }
      }
      return send(res, 404, { error: { code: "NOT_FOUND", message: `No route for ${req.method} ${url.pathname}`, action: null } });
    } catch (err) {
      sendError(res, err);
    }
  });

  const ready = new Promise<string>((resolve) =>
    server.listen(opts.port, "127.0.0.1", () => {
      coordinator.start();
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    }),
  );
  server.on("close", () => void coordinator.stop());
  return { server, coordinator, ready };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.INTEGRATION_PORT || 3100);
  const { server, coordinator, ready } = startIntegrationServer({
    port,
    dataDir: process.env.INTEGRATION_DATA_DIR || join(ROOT, "data"),
    researchUrl: process.env.RESEARCH_SERVICE_URL || "http://127.0.0.1:3101",
    reviewUrl: process.env.REVIEW_SERVICE_URL || "http://127.0.0.1:3102",
  });
  void ready.then((u) => console.log(`integration listening on ${u}`));
  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.on(sig, async () => {
      await coordinator.stop();
      server.close();
      process.exit(0);
    });
}
