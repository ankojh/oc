// Reports which live integrations are usable. Never prints secret values.
//   npm run check:env                 # config + YouTube + OpusClip REST (if configured)
//   npm run check:env -- --codex      # also runs one tiny Codex structured-output turn
//   npm run check:env -- --opus-mcp   # also connects to the OpusClip MCP server (may open OAuth in a browser)
import { spawnSync } from "node:child_process";
import { Codex } from "@openai/codex-sdk";
import { loadConfig } from "../src/config.js";
import { McpOpusClipAdapter } from "../src/opusclip/mcp.js";
import { RestOpusClipAdapter } from "../src/opusclip/rest.js";
import { LiveYouTubeAdapter } from "../src/youtube/live.js";

const cfg = loadConfig();
const flags = new Set(process.argv.slice(2));
const line = (ok: boolean | null, name: string, detail: string) => console.log(`${ok === null ? "–" : ok ? "✔" : "✘"} ${name.padEnd(22)} ${detail}`);

try {
  const r = spawnSync("codex", ["login", "status"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || "failed").trim());
  const status = `${r.stdout}${r.stderr}`.trim();
  line(true, "codex login", status);
} catch (e) {
  line(false, "codex login", `codex CLI not logged in or not found (${(e as Error).message.split("\n")[0]})`);
}

if (flags.has("--codex")) {
  try {
    const codex = new Codex(cfg.codex.isolateMcpServers ? { configOverrides: ["mcp_servers={}"] } : {});
    const thread = codex.startThread({ ...(cfg.codex.model ? { model: cfg.codex.model } : {}), sandboxMode: "read-only", skipGitRepoCheck: true, webSearchMode: "disabled", approvalPolicy: "never" });
    const turn = await thread.run("Reply with JSON {\"ok\": true}.", {
      outputSchema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } },
    });
    line(JSON.parse(turn.finalResponse).ok === true, "codex sdk", `structured output OK (${turn.usage?.input_tokens ?? "?"} input tokens)`);
  } catch (e) {
    line(false, "codex sdk", (e as Error).message.slice(0, 300));
  }
} else line(null, "codex sdk", "skipped (pass --codex)");

if (cfg.youtube.apiKey) {
  try {
    const v = await new LiveYouTubeAdapter(cfg.youtube.apiKey).getVideo("jNQXAC9IVRw");
    line(true, "youtube api", `key works (resolved "${v.title}")`);
  } catch (e) {
    line(false, "youtube api", (e as Error).message);
  }
} else line(false, "youtube api", "YOUTUBE_API_KEY not set — live research unavailable");

if (cfg.opus.apiKey) {
  const r = await new RestOpusClipAdapter(cfg.opus).checkAccess();
  line(r.ok, "opusclip rest", r.detail);
} else line(cfg.opus.transport === "rest" ? false : null, "opusclip rest", "OPUSCLIP_API_KEY not set");

if (flags.has("--opus-mcp")) {
  const mcp = new McpOpusClipAdapter(cfg.opus);
  const r = await mcp.checkAccess();
  line(r.ok, "opusclip mcp", r.detail);
  await mcp.close();
} else line(null, "opusclip mcp", `skipped (pass --opus-mcp); transport=${cfg.opus.transport}`);
process.exit(0);
