// Connects to the hosted OpusClip MCP server through mcp-remote (opens the
// OpusClip OAuth sign-in in a browser on first use; tokens are cached by
// mcp-remote under ~/.mcp-auth, not in this repo), lists the live tool
// schemas, and verifies that opusclip_submit_project accepts customPrompt.
// Read-only: it calls only opusclip_whoami. It never submits a project.
//   npm run opus:mcp-login
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { MCP_TOOLS, McpOpusClipAdapter } from "../src/opusclip/mcp.js";

const cfg = loadConfig();
const mcp = new McpOpusClipAdapter(cfg.opus);
console.log(`Connecting to ${cfg.opus.mcpUrl} via \`${cfg.opus.mcpCommand}\` (complete the OAuth sign-in if a browser opens)…`);
const tools = await mcp.listToolSchemas();
const out = path.join(cfg.dataDir, "opusclip-mcp-tools.json");
mkdirSync(cfg.dataDir, { recursive: true });
writeFileSync(out, JSON.stringify(tools, null, 2));
console.log(`${tools.length} tools; full schemas written to ${out}`);
for (const name of Object.values(MCP_TOOLS)) {
  const t = tools.find((x) => x.name === name);
  console.log(`${t ? "✔" : "✘"} ${name}${t ? `  args: ${Object.keys(t.inputSchema.properties ?? {}).join(", ")}` : "  (missing)"}`);
}
const access = await mcp.checkAccess();
console.log(`\ncustomPrompt supported by ${MCP_TOOLS.submit}: ${access.supportsCustomPrompt}`);
console.log(`access: ${access.ok ? "OK" : "NOT OK"} — ${access.detail}`);
console.log(`whoami: ${JSON.stringify((access.raw as { whoami?: unknown } | undefined)?.whoami ?? null).slice(0, 400)}`);
await mcp.close();
process.exit(0);
