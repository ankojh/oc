// One-command local launcher: validates the shared environment file, then starts
// audience-research (3101), clip-review (3102) and the integration server (3100)
// as child processes, each in its own directory with its own data directory.
//
// Usage (from the repository root):
//   npm start                         # uses ./.env
//   npm start -- --env-file /abs/.env # explicit file
//   npm run check:env                 # validate and print settings (values of secrets hidden)
// INTEGRATION_ENV_FILE may also name the file.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { REPO_ROOT, planServices, resolveEnv } from "./env.ts";

const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const envFile = resolve(flag("--env-file") ?? process.env.INTEGRATION_ENV_FILE ?? join(REPO_ROOT, ".env"));
const checkOnly = args.includes("--check");

const env = resolveEnv(envFile);
const { plan, validation } = planServices(env);

console.log(`Environment file: ${envFile}${env.fileFound ? "" : " (NOT FOUND — using the launcher environment and service defaults)"}`);
console.log("Precedence: non-empty launcher environment > non-empty env-file value > service default. Blank entries are ignored.");
if (checkOnly) {
  for (const r of validation.rows) console.log(`  ${r.service.padEnd(11)} ${r.key.padEnd(36)} ${r.state}`);
}
for (const w of validation.warnings) console.log(`warning: ${w}`);
for (const e of validation.errors) console.error(`error: ${e}`);
if (validation.errors.length) process.exit(1);
if (checkOnly) process.exit(0);

function portInUse(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = createConnection({ port, host: "127.0.0.1" });
    s.once("connect", () => {
      s.destroy();
      done(true);
    });
    s.once("error", () => done(false));
  });
}

const services = [
  { name: "research", dir: join(REPO_ROOT, "audience-research"), port: plan.research.port, env: plan.research.env, health: `${plan.research.url}/health` },
  { name: "review", dir: join(REPO_ROOT, "clip-review"), port: plan.review.port, env: plan.review.env, health: `${plan.review.url}/health` },
  { name: "integration", dir: join(REPO_ROOT, "integration"), port: plan.integration.port, env: plan.integration.env, health: `http://127.0.0.1:${plan.integration.port}/health` },
];

for (const s of services) {
  if (!existsSync(join(s.dir, "node_modules", ".bin", "tsx"))) {
    console.error(`error: ${s.name} dependencies are missing. Run \`npm run setup\` at the repository root.`);
    process.exit(1);
  }
  if (await portInUse(s.port)) {
    console.error(`error: port ${s.port} (${s.name}) is already in use. Stop the other process or change the port in ${envFile}.`);
    process.exit(1);
  }
}

const children: ChildProcess[] = [];
let stopping = false;

function stopAll(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 1500).unref();
  Promise.all(children.map((c) => (c.exitCode === null ? new Promise((r) => c.once("exit", r)) : null))).then(() => process.exit(code));
}

function pipe(name: string, stream: NodeJS.ReadableStream | null, out: NodeJS.WriteStream): void {
  let buf = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk: string) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) out.write(`[${name}] ${line}\n`);
  });
}

for (const s of services) {
  const child = spawn(join(s.dir, "node_modules", ".bin", "tsx"), ["src/server.ts"], { cwd: s.dir, env: s.env, stdio: ["ignore", "pipe", "pipe"] });
  pipe(s.name, child.stdout, process.stdout);
  pipe(s.name, child.stderr, process.stderr);
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`[launcher] ${s.name} exited (${signal ?? code}); stopping the other services.`);
    stopAll(code || 1);
  });
  children.push(child);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => stopAll(0));

const deadline = Date.now() + 60_000;
for (const s of services) {
  for (;;) {
    try {
      if ((await fetch(s.health, { signal: AbortSignal.timeout(2000) })).ok) break;
    } catch {
      /* not up yet */
    }
    if (stopping) process.exit(1);
    if (Date.now() > deadline) {
      console.error(`[launcher] ${s.name} did not become healthy at ${s.health}.`);
      stopAll(1);
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}
if (!stopping) console.log(`\n[launcher] All services are up. Open http://127.0.0.1:${plan.integration.port}\n`);
