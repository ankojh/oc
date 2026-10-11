import { readFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import path from "node:path";
import { ROOT_DIR, loadConfig } from "./config.js";
import { ReviewInput, formatIssues } from "./contract.js";
import { AppError, toErrorInfo } from "./errors.js";
import { log } from "./log.js";
import { FixtureOpusClipAdapter } from "./opusclip/fixture.js";
import { McpOpusClipAdapter } from "./opusclip/mcp.js";
import { RestOpusClipAdapter } from "./opusclip/rest.js";
import type { OpusClipAdapter } from "./opusclip/types.js";
import { CodexResearchAnalyzer } from "./research/codexAnalyzer.js";
import { RunManager, overallStatus } from "./runs.js";
import { RunStore } from "./store.js";
import { fixtureModeDeps } from "./fixtureMode/deps.js";
import { LiveYouTubeAdapter } from "./youtube/live.js";

const config = loadConfig();
const store = new RunStore(config.dataDir);
const fixture = fixtureModeDeps(config);
const fixtureYouTube = fixture.fixtureYouTube;

const manager = new RunManager({
  store,
  config,
  modes: {
    fixture,
    live: {
      youtube: () => {
        if (!config.youtube.apiKey) throw new AppError("CONFIG_MISSING", "YOUTUBE_API_KEY is not set.", "Add it to .env.", 400);
        return new LiveYouTubeAdapter(config.youtube.apiKey);
      },
      analyzer: () => new CodexResearchAnalyzer(config.codex),
      opus: () => (config.opus.transport === "rest" ? new RestOpusClipAdapter(config.opus) : new McpOpusClipAdapter(config.opus)),
      pollIntervalMs: config.opus.pollIntervalMs,
    },
  },
});

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body, null, 2));
}

function sendError(res: ServerResponse, err: unknown): void {
  const status = err instanceof AppError ? err.httpStatus : 500;
  if (status >= 500) log.error(err);
  send(res, status, { error: toErrorInfo(err) });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new AppError("INVALID_INPUT", "Request body too large.", null, 413);
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new AppError("INVALID_INPUT", "Body must be a JSON object.", null, 400);
  }
}

function runView(runId: string) {
  const run = manager.get(runId);
  const status = overallStatus(run);
  return {
    runId: run.runId,
    mode: run.mode,
    modeLabel: run.mode === "fixture" ? "FIXTURE DATA — not real audience comments" : "LIVE",
    status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    input: run.input,
    progress: [...run.research.progress, ...run.generation.events],
    error: run.research.error ?? run.generation.error ?? null,
    research: { status: run.research.status, startedAt: run.research.startedAt, finishedAt: run.research.finishedAt },
    result: run.brief,
    generation: {
      ...run.generation,
      consumesCredits: run.mode === "live",
      creditNotice:
        run.mode === "live"
          ? "Generate clips submits ONE OpusClip project and consumes the connected account's credits (API minimum 10 credits per project)."
          : "Fixture mode: no OpusClip account is used and no credits are consumed.",
    },
    reviewInputAvailable: run.generation.status === "completed",
    links: {
      self: `/runs/${run.runId}`,
      generate: `/runs/${run.runId}/generate`,
      reviewInput: `/runs/${run.runId}/review-input`,
      debug: `/runs/${run.runId}/debug`,
    },
  };
}

const UI = path.join(ROOT_DIR, "public", "index.html");

const server = createServer(async (req, res) => {
  // Loopback binding alone does not prevent a malicious website from sending a
  // simple cross-origin POST to this local service (including a Codex research
  // request). Also reject DNS-rebinding Host headers.
  const host = req.headers.host ?? "";
  if (!/^(?:127\.0\.0\.1|localhost):\d+$/.test(host)) return send(res, 403, { error: { code: "FORBIDDEN", message: "Only loopback Host headers are accepted.", action: null } });
  const origin = req.headers.origin;
  if (req.method === "POST" && origin && origin !== `http://${host}`)
    return send(res, 403, { error: { code: "FORBIDDEN", message: "Cross-origin requests are not accepted.", action: null } });
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync(UI));
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, {
        ok: true,
        live: {
          youtubeApiKey: Boolean(config.youtube.apiKey),
          opusTransport: config.opus.transport,
          opusApiKey: Boolean(config.opus.apiKey),
          codexModel: config.codex.model ?? "(codex default)",
        },
        fixtureVideos: fixtureYouTube.listFixtureVideos(),
      });
    }
    if (req.method === "GET" && url.pathname === "/opusclip/access") {
      const mode = url.searchParams.get("mode") === "fixture" ? "fixture" : "live";
      const adapter: OpusClipAdapter = mode === "fixture" ? new FixtureOpusClipAdapter(path.join(config.fixturesDir, "opusclip")) : config.opus.transport === "rest" ? new RestOpusClipAdapter(config.opus) : new McpOpusClipAdapter(config.opus);
      const check = await adapter.checkAccess();
      await adapter.close?.();
      return send(res, 200, check);
    }
    if (req.method === "POST" && url.pathname === "/research") {
      const body = await readJson(req);
      const { runId } = manager.startResearch(body);
      return send(res, 202, { runId });
    }
    if (req.method === "GET" && url.pathname === "/runs") {
      return send(res, 200, store.list().map((r) => ({ runId: r.runId, mode: r.mode, status: overallStatus(r), videoId: r.input.videoId, createdAt: r.createdAt })));
    }
    if (parts[0] === "runs" && parts[1]) {
      const runId = parts[1];
      const action = parts[2];
      if (req.method === "GET" && !action) return send(res, 200, runView(runId));
      if (req.method === "POST" && action === "generate") {
        const body = await readJson(req);
        const out = await manager.generate(runId, body);
        return send(res, out.submitted ? 202 : 200, { submitted: out.submitted, run: runView(runId) });
      }
      if (req.method === "POST" && action === "reconcile") {
        await manager.reconcile(runId);
        return send(res, 200, runView(runId));
      }
      if (req.method === "POST" && action === "adopt-project") {
        const body = await readJson(req);
        manager.adoptProject(runId, body.projectId);
        return send(res, 200, runView(runId));
      }
      if (req.method === "POST" && action === "poll") {
        manager.resumePolling(runId);
        return send(res, 200, runView(runId));
      }
      if (req.method === "GET" && action === "review-input") {
        manager.get(runId);
        const ri = store.loadReviewInput(runId);
        if (!ri) throw new AppError("NOT_FOUND", "ReviewInput is not available yet.", "Generate clips and wait for the OpusClip project to complete.", 404);
        const parsed = ReviewInput.safeParse(ri);
        if (!parsed.success) throw new AppError("CONTRACT_VIOLATION", `Stored ReviewInput is invalid: ${formatIssues(parsed.error)}`, null, 500);
        return send(res, 200, parsed.data);
      }
      if (req.method === "GET" && action === "debug") {
        manager.get(runId);
        return send(res, 200, { research: store.readJson(runId, "research-debug.json"), providerRawFiles: store.listProviderRaw(runId) });
      }
    }
    throw new AppError("NOT_FOUND", `No route for ${req.method} ${url.pathname}`, null, 404);
  } catch (err) {
    sendError(res, err);
  }
});

manager.recover();
server.listen(config.port, "127.0.0.1", () => {
  log.info(`audience-research listening on http://localhost:${config.port}`);
  log.info(
    `live config: YOUTUBE_API_KEY=${config.youtube.apiKey ? "set" : "missing"}, OpusClip transport=${config.opus.transport}` +
      `${config.opus.transport === "rest" ? ` (OPUSCLIP_API_KEY ${config.opus.apiKey ? "set" : "missing"})` : ""}, Codex model=${config.codex.model ?? "default"}`,
  );
});

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, async () => {
    await manager.stop();
    server.close();
    process.exit(0);
  });
