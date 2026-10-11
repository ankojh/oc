// Run one review from a handoff file without the server.
// Usage: npm run review -- <handoff.json> [--backend auto|fixture|codex] [--out report.json]
import { readFileSync, writeFileSync } from "node:fs";
import { CodexBackend, codexOptionsFromEnv } from "./agent/backends.ts";
import { runReview } from "./review.ts";
import { chooseBackend } from "./server.ts";

const args = process.argv.slice(2);
const file = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (!file) {
  console.error("usage: npm run review -- <handoff.json> [--backend auto|fixture|codex] [--out report.json]");
  process.exit(2);
}
const raw = JSON.parse(readFileSync(file, "utf8"));
const choice = (flag("--backend") ?? process.env.REVIEW_BACKEND ?? "auto") as "auto" | "fixture" | "codex";
const backend = chooseBackend(raw, choice, () => new CodexBackend(codexOptionsFromEnv()));
const out = await runReview(raw, backend, { onProgress: (m) => console.error(`· ${m}`) });
if (!out.ok) {
  console.error(`Review failed at ${out.stage}:`);
  for (const e of out.errors) console.error(`  [${e.code}] ${e.path}: ${e.message}`);
  process.exit(1);
}
console.error(`reviewer: ${JSON.stringify(out.reviewer)}`);
for (const c of out.audit.corrections) console.error(`  correction: ${c}`);
const json = JSON.stringify(out.report, null, 2);
const dest = flag("--out");
if (dest) writeFileSync(dest, json + "\n");
else console.log(json);
