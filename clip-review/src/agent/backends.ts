// Reviewer backends share one interface so live Codex and recorded fixture
// responses flow through identical validation and assembly.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { packetFingerprint, type Packet } from "./packet.ts";
import { PROMPT_VERSION, REVIEWER_INSTRUCTIONS, buildPrompt } from "./instructions.ts";
import { judgmentJsonSchema } from "./judgment.ts";

export type BackendRun = {
  /** Unparsed model output; validated by the caller. */
  output: unknown;
  meta: {
    backend: "codex" | "fixture";
    model: string | null;
    reasoningEffort: string | null;
    promptVersion: string;
    threadId: string | null;
    usage: unknown;
    durationMs: number;
    toolActivity: string[];
    fixtureResponse: string | null;
  };
};

export type JudgeContext = { runId: string; mode?: "live" | "fixture"; inputHash: string; signal?: AbortSignal; onProgress?: (msg: string) => void };

export interface ReviewerBackend {
  readonly kind: "codex" | "fixture";
  /** Stable id included in the cache key so a model/prompt change triggers a new review. */
  readonly versionKey: string;
  judge(packet: Packet, ctx: JudgeContext): Promise<BackendRun>;
}

// ---------------- Fixture backend ----------------

/**
 * Replays a judgment from fixtures/responses/*.json whose `binding.packetHash`
 * equals the fingerprint of the reviewer packet being judged. Files are
 * { provenance, binding, judgment }; provenance says whether the judgment was
 * recorded from a live model or hand-authored. Used for offline development and
 * deterministic tests; never presented as live output, never applied to live
 * research, and never falls back to a live model when nothing matches.
 */
export class FixtureBackend implements ReviewerBackend {
  readonly kind = "fixture" as const;
  readonly versionKey: string;
  constructor(private dir: string) {
    this.versionKey = `fixture:${PROMPT_VERSION}`;
  }

  private index(): Map<string, { file: string; recorded: any }> {
    const out = new Map<string, { file: string; recorded: any }>();
    if (!existsSync(this.dir)) return out;
    for (const file of readdirSync(this.dir).filter((f) => f.endsWith(".json")).sort()) {
      const recorded = JSON.parse(readFileSync(join(this.dir, file), "utf8"));
      const hash = recorded?.binding?.packetHash;
      if (typeof hash === "string" && !out.has(hash)) out.set(hash, { file, recorded });
    }
    return out;
  }

  async judge(packet: Packet, ctx: JudgeContext): Promise<BackendRun> {
    if (ctx.mode === "live")
      throw new ActionableError(
        "The fixture reviewer backend only replays fixture judgments and refuses live research input. Use backend=codex for a live review.",
      );
    const hash = packetFingerprint(packet);
    const hit = this.index().get(hash);
    if (!hit) {
      const sameRunId = /^[\w.-]+$/.test(ctx.runId) && existsSync(join(this.dir, `${ctx.runId}.json`));
      throw new ActionableError(
        sameRunId
          ? `fixtures/responses/${ctx.runId}.json exists but was bound to different content than this handoff (packet ${hash.slice(0, 12)}); refusing to replay it. Fixture review never falls back to a live model.`
          : `No fixture reviewer response is bound to this content (packet ${hash.slice(0, 12)}, runId "${ctx.runId}"). Fixture review never falls back to a live model: use backend=codex for live review, or add a response bound with scripts/bind-fixture-responses.ts.`,
      );
    }
    const { file, recorded } = hit;
    ctx.onProgress?.(`Replaying fixture response ${file} (bound to packet ${hash.slice(0, 12)})`);
    return {
      output: recorded.judgment,
      meta: {
        backend: "fixture",
        model: null,
        reasoningEffort: null,
        promptVersion: PROMPT_VERSION,
        threadId: null,
        usage: null,
        durationMs: 0,
        toolActivity: [],
        fixtureResponse: `fixtures/responses/${file} (${recorded.provenance?.source ?? "unknown provenance"})`,
      },
    };
  }
}

// ---------------- Codex backend ----------------

// Every tool surface the reviewer does not need. The reviewer reads untrusted
// comments, so it gets no shell, no patching, no browser, no plugins, no web.
const DISABLED_FEATURES = [
  "shell_tool", "unified_exec", "unified_exec_tty", "apps", "plugins", "remote_plugin", "browser_use",
  "browser_use_external", "in_app_browser", "computer_use", "image_generation", "multi_agent", "hooks",
  "view_image", "goals", "memories", "skill_search", "tool_suggest", "code_mode_host", "sleep_tool",
  "workspace_dependencies", "worktrees", "realtime_conversation", "in_app_local_automation", "shell_snapshot",
];

export type CodexBackendOptions = {
  model: string;
  reasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Isolated CODEX_HOME so the reviewer inherits no user AGENTS.md, memories, plugins, or MCP servers. */
  codexHome: string;
  /** Copy ChatGPT login from ~/.codex/auth.json into the isolated home when no API key is set. */
  copyLogin: boolean;
  apiKey?: string;
  timeoutMs: number;
};

export function codexOptionsFromEnv(env = process.env): CodexBackendOptions {
  return {
    model: env.CLIP_REVIEW_MODEL || "gpt-6-astra",
    reasoningEffort: (env.CLIP_REVIEW_REASONING_EFFORT as CodexBackendOptions["reasoningEffort"]) || "medium",
    codexHome: env.CLIP_REVIEW_CODEX_HOME || join(homedir(), ".cache", "clip-review", "codex-home"),
    copyLogin: env.CLIP_REVIEW_COPY_CODEX_LOGIN !== "0",
    apiKey: env.CODEX_API_KEY || env.OPENAI_API_KEY || undefined,
    timeoutMs: Number(env.CLIP_REVIEW_TIMEOUT_MS || 300_000),
  };
}

export class CodexBackend implements ReviewerBackend {
  readonly kind = "codex" as const;
  readonly versionKey: string;
  constructor(private opts: CodexBackendOptions) {
    this.versionKey = `codex:${opts.model}:${opts.reasoningEffort}:${PROMPT_VERSION}`;
  }

  private prepareHome() {
    const home = this.opts.codexHome;
    mkdirSync(home, { recursive: true, mode: 0o700 });
    // Minimal config: no user instructions, plugins, MCP servers, or notify hooks.
    writeFileSync(join(home, "config.toml"), `# Managed by clip-review. Isolated reviewer home.\n`);
    if (!this.opts.apiKey) {
      const src = join(homedir(), ".codex", "auth.json");
      if (this.opts.copyLogin && existsSync(src)) {
        copyFileSync(src, join(home, "auth.json"));
        chmodSync(join(home, "auth.json"), 0o600);
      } else if (!existsSync(join(home, "auth.json"))) {
        throw new ActionableError(
          "Codex is not authenticated for the reviewer. Run `codex login`, or set CODEX_API_KEY, or use REVIEW_BACKEND=fixture.",
        );
      }
    }
  }

  async judge(packet: Packet, ctx: JudgeContext): Promise<BackendRun> {
    const { Codex } = await import("@openai/codex-sdk");
    this.prepareHome();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env.CODEX_HOME = this.opts.codexHome;

    const codex = new Codex({
      env,
      apiKey: this.opts.apiKey,
      config: {
        developer_instructions: REVIEWER_INSTRUCTIONS,
        project_doc_max_bytes: 0,
        features: Object.fromEntries(DISABLED_FEATURES.map((f) => [f, false])),
      },
    });
    // Fresh empty working directory per review: nothing to read, nothing to inherit.
    const workdir = mkdtempSync(join(tmpdir(), "clip-review-"));
    const thread = codex.startThread({
      model: this.opts.model,
      modelReasoningEffort: this.opts.reasoningEffort,
      workingDirectory: workdir,
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
    });

    const timeout = AbortSignal.timeout(this.opts.timeoutMs);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
    const started = Date.now();
    const toolActivity: string[] = [];
    let finalText = "";
    let usage: unknown = null;
    try {
      ctx.onProgress?.(`Starting isolated Codex reviewer thread (${this.opts.model}, effort ${this.opts.reasoningEffort})`);
      const { events } = await thread.runStreamed(buildPrompt(packet), { outputSchema: judgmentJsonSchema(), signal });
      for await (const ev of events) {
        if (ev.type === "item.completed") {
          const it = ev.item;
          if (it.type === "agent_message") finalText = it.text;
          else if (it.type === "command_execution") toolActivity.push(`command: ${it.command} (${it.status})`);
          else if (it.type === "mcp_tool_call") toolActivity.push(`mcp: ${it.server}.${it.tool} (${it.status})`);
          else if (it.type === "file_change") toolActivity.push(`file_change (${it.status})`);
          else if (it.type === "web_search") toolActivity.push(`web_search: ${it.query}`);
        } else if (ev.type === "turn.started") ctx.onProgress?.("Reviewer is reading the handoff");
        else if (ev.type === "turn.completed") usage = ev.usage;
        else if (ev.type === "turn.failed") throw new Error(`Codex turn failed: ${ev.error.message}`);
        else if (ev.type === "error") throw new Error(`Codex stream error: ${ev.message}`);
      }
    } catch (e: any) {
      if (timeout.aborted) throw new ActionableError(`Codex reviewer timed out after ${this.opts.timeoutMs} ms. Raise CLIP_REVIEW_TIMEOUT_MS or retry with rerun=true.`);
      throw e;
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
    let output: unknown;
    try {
      output = JSON.parse(finalText);
    } catch {
      throw new ActionableError(`Codex reviewer returned non-JSON output: ${finalText.slice(0, 300)}`);
    }
    return {
      output,
      meta: {
        backend: "codex",
        model: this.opts.model,
        reasoningEffort: this.opts.reasoningEffort,
        promptVersion: PROMPT_VERSION,
        threadId: thread.id,
        usage,
        durationMs: Date.now() - started,
        toolActivity,
        fixtureResponse: null,
      },
    };
  }
}

export class ActionableError extends Error {}
