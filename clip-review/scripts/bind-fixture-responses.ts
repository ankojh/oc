// Binds fixture reviewer responses to the content they judge.
//
// Each fixtures/responses/<name>.json gets `binding.packetHash`: the fingerprint
// of the reviewer packet built from the handoff it was recorded or authored
// for. FixtureBackend replays a response only for a packet with that exact
// fingerprint, so a fresh runId of the same scenario still matches and
// different content never does. Judgments and provenance are not modified.
//
// Usage:
//   npm run fixtures:bind                      # bind fixtures/inputs/* by research.runId
//   npm run fixtures:bind -- --bind <handoff.json> <response-name>   # bind an external handoff
//   npm run fixtures:bind -- --check           # exit 1 if any binding is stale
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPacket, packetFingerprint } from "../src/agent/packet.ts";
import { assembleWithoutModel } from "../src/assemble.ts";
import { validateHandoff } from "../src/validate-input.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RESPONSES = join(ROOT, "fixtures", "responses");
const INPUTS = join(ROOT, "fixtures", "inputs");
const args = process.argv.slice(2);
const check = args.includes("--check");

const pairs: { input: string; response: string }[] = [];
for (const f of readdirSync(INPUTS).filter((f) => f.endsWith(".json")).sort()) {
  const runId = JSON.parse(readFileSync(join(INPUTS, f), "utf8"))?.research?.runId;
  if (typeof runId === "string" && existsSync(join(RESPONSES, `${runId}.json`))) pairs.push({ input: join(INPUTS, f), response: `${runId}.json` });
}
for (let i = args.indexOf("--bind"); i !== -1; i = args.indexOf("--bind", i + 1)) {
  const [input, response] = [args[i + 1], args[i + 2]];
  if (!input || !response) throw new Error("--bind needs <handoff.json> <response-name>");
  pairs.push({ input, response: response.endsWith(".json") ? basename(response) : `${response}.json` });
}

let stale = 0;
for (const { input, response } of pairs) {
  const v = validateHandoff(JSON.parse(readFileSync(input, "utf8")));
  if (!v.ok) throw new Error(`${input} is not a valid handoff: ${JSON.stringify(v.errors)}`);
  const ctx = { input: v.input, facts: v.facts, warnings: v.warnings, extraLimitations: [] };
  if (assembleWithoutModel(ctx)) {
    console.log(`skip ${response}: ${basename(input)} never reaches the reviewer model`);
    continue;
  }
  const packetHash = packetFingerprint(buildPacket(v.input, v.facts).packet);
  const file = join(RESPONSES, response);
  const recorded = JSON.parse(readFileSync(file, "utf8"));
  if (recorded.binding?.packetHash === packetHash) {
    console.log(`ok   ${response}`);
    continue;
  }
  stale++;
  if (check) {
    console.error(`STALE ${response}: bound ${recorded.binding?.packetHash?.slice(0, 12) ?? "(none)"}, content is ${packetHash.slice(0, 12)}`);
    continue;
  }
  const { provenance, judgment, ...rest } = recorded;
  delete rest.binding;
  const binding = { packetHash, handoff: relative(ROOT, input), boundAt: new Date().toISOString() };
  writeFileSync(file, JSON.stringify({ provenance, binding, ...rest, judgment }, null, 2) + "\n");
  console.log(`bound ${response} -> ${packetHash.slice(0, 12)} (${relative(ROOT, input)})`);
}
if (check && stale) process.exit(1);
