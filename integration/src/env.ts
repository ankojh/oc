// Shared configuration for the three local processes.
//
// One explicit environment file (default: <repo>/.env) is read by the launcher
// and split per service. Precedence for every key, highest first:
//   1. a non-empty value already set in the launcher's own environment;
//   2. a non-empty value in the environment file;
//   3. the service's own defaults (audience-research additionally falls back to
//      audience-research/.env for keys still unset — its existing behaviour).
// Blank entries in the file are ignored, so an empty template line never masks
// a credential configured elsewhere.
//
// Each child receives only the keys it uses. The reviewer never receives the
// YouTube or OpusClip secrets, and the coordinator receives no secrets at all.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const RESEARCH_KEYS = [
  "PORT",
  "DATA_DIR",
  "YOUTUBE_API_KEY",
  "YOUTUBE_COMMENTS_PER_VIDEO",
  "YOUTUBE_MAX_RELATED_VIDEOS",
  "YOUTUBE_RECENT_UPLOADS_TO_CONSIDER",
  "CODEX_API_KEY",
  "CODEX_MODEL",
  "CODEX_REASONING_EFFORT",
  "CODEX_ISOLATE_MCP_SERVERS",
  "CODEX_TIMEOUT_MS",
  "OPUSCLIP_TRANSPORT",
  "OPUSCLIP_API_KEY",
  "OPUSCLIP_ORG_ID",
  "OPUSCLIP_API_BASE_URL",
  "OPUSCLIP_MCP_URL",
  "OPUSCLIP_MCP_COMMAND",
  "OPUSCLIP_CLIP_DURATION_SEC",
  "OPUSCLIP_ASPECT_RATIO",
  "OPUSCLIP_TIMERANGE_UNIT",
  "OPUSCLIP_POLL_INTERVAL_MS",
  "OPUSCLIP_MAX_POLL_MINUTES",
] as const;

export const REVIEW_KEYS = [
  "CLIP_REVIEW_PORT",
  "CLIP_REVIEW_DATA_DIR",
  "REVIEW_BACKEND",
  "CLIP_REVIEW_MODEL",
  "CLIP_REVIEW_REASONING_EFFORT",
  "CLIP_REVIEW_TIMEOUT_MS",
  "CLIP_REVIEW_CODEX_HOME",
  "CLIP_REVIEW_COPY_CODEX_LOGIN",
  "CODEX_API_KEY",
] as const;

export const INTEGRATION_KEYS = ["INTEGRATION_PORT", "INTEGRATION_DATA_DIR", "RESEARCH_SERVICE_URL", "REVIEW_SERVICE_URL"] as const;

/** Values that must never be printed. */
export const SECRET_KEYS = new Set(["YOUTUBE_API_KEY", "CODEX_API_KEY", "OPUSCLIP_API_KEY", "OPENAI_API_KEY"]);

const ALL_KEYS = new Set<string>([...RESEARCH_KEYS, ...REVIEW_KEYS, ...INTEGRATION_KEYS, "OPENAI_API_KEY"]);

/** Same syntax as audience-research's loader: KEY=value, quotes, `# comment` after unquoted values. */
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) value = value.slice(1, -1);
    else value = value.replace(/(^|\s+)#.*$/, "").trim();
    out.set(m[1], value);
  }
  return out;
}

export type Source = "process" | "file" | "unset";

export interface ResolvedEnv {
  file: string;
  fileFound: boolean;
  get(key: string): string | undefined;
  source(key: string): Source;
}

export function resolveEnv(file: string, processEnv: NodeJS.ProcessEnv = process.env): ResolvedEnv {
  const fileFound = existsSync(file);
  const fromFile = fileFound ? parseEnvFile(readFileSync(file, "utf8")) : new Map<string, string>();
  const source = (key: string): Source => (processEnv[key] ? "process" : fromFile.get(key) ? "file" : "unset");
  return {
    file,
    fileFound,
    source,
    get: (key) => {
      const s = source(key);
      return s === "process" ? processEnv[key] : s === "file" ? fromFile.get(key) : undefined;
    },
  };
}

export interface ServicePlan {
  research: { port: number; url: string; env: Record<string, string> };
  review: { port: number; url: string; env: Record<string, string> };
  integration: { port: number; env: Record<string, string> };
}

export interface Validation {
  errors: string[];
  warnings: string[];
  rows: { service: string; key: string; state: string }[];
}

function intIn(name: string, raw: string | undefined, fallback: number, errors: string[]): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    errors.push(`${name} must be a TCP port (1-65535), got "${raw}".`);
    return fallback;
  }
  return n;
}

function localUrl(name: string, raw: string, errors: string[]): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:") errors.push(`${name} must be an http:// URL.`);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) errors.push(`${name} must point at this machine (127.0.0.1); services are not exposed publicly.`);
    return u;
  } catch {
    errors.push(`${name} is not a valid URL: "${raw}".`);
    return null;
  }
}

/** Builds each child's environment and validates the combined configuration. */
export function planServices(env: ResolvedEnv, processEnv: NodeJS.ProcessEnv = process.env, codexAuthFile = join(homedir(), ".codex", "auth.json")): { plan: ServicePlan; validation: Validation } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const rows: Validation["rows"] = [];

  const researchPort = intIn("PORT", env.get("PORT"), 3101, errors);
  const reviewPort = intIn("CLIP_REVIEW_PORT", env.get("CLIP_REVIEW_PORT"), 3102, errors);
  const integrationPort = intIn("INTEGRATION_PORT", env.get("INTEGRATION_PORT"), 3100, errors);
  if (new Set([researchPort, reviewPort, integrationPort]).size !== 3) errors.push(`Ports must differ: research ${researchPort}, review ${reviewPort}, integration ${integrationPort}.`);

  const researchUrl = env.get("RESEARCH_SERVICE_URL") ?? `http://127.0.0.1:${researchPort}`;
  const reviewUrl = env.get("REVIEW_SERVICE_URL") ?? `http://127.0.0.1:${reviewPort}`;
  const ru = localUrl("RESEARCH_SERVICE_URL", researchUrl, errors);
  const vu = localUrl("REVIEW_SERVICE_URL", reviewUrl, errors);
  if (ru && Number(ru.port || 80) !== researchPort) errors.push(`RESEARCH_SERVICE_URL (${researchUrl}) does not use the research PORT ${researchPort}.`);
  if (vu && Number(vu.port || 80) !== reviewPort) errors.push(`REVIEW_SERVICE_URL (${reviewUrl}) does not use CLIP_REVIEW_PORT ${reviewPort}.`);

  const backend = env.get("REVIEW_BACKEND");
  if (backend && !["auto", "fixture", "codex"].includes(backend)) errors.push(`REVIEW_BACKEND must be auto, fixture or codex, got "${backend}".`);
  const transport = env.get("OPUSCLIP_TRANSPORT") ?? "mcp";
  if (!["mcp", "rest"].includes(transport)) errors.push(`OPUSCLIP_TRANSPORT must be mcp or rest, got "${transport}".`);

  // Children inherit the launcher environment minus every managed key; each then
  // receives only its own resolved keys.
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(processEnv)) if (v !== undefined && !ALL_KEYS.has(k)) base[k] = v;
  const pick = (service: string, keys: readonly string[]) => {
    const out: Record<string, string> = { ...base };
    for (const key of keys) {
      const value = env.get(key);
      const src = env.source(key);
      rows.push({ service, key, state: src === "unset" ? "unset (service default)" : SECRET_KEYS.has(key) ? `set (${src}, value hidden)` : `${value} (${src})` });
      if (value !== undefined) out[key] = value;
    }
    return out;
  };

  const researchEnv = pick("research", RESEARCH_KEYS);
  researchEnv.PORT = String(researchPort);
  const reviewEnv = pick("review", REVIEW_KEYS);
  reviewEnv.CLIP_REVIEW_PORT = String(reviewPort);
  // The coordinator always selects the backend per request; the service default
  // only matters for direct use, and must never be live by accident.
  if (!reviewEnv.REVIEW_BACKEND) reviewEnv.REVIEW_BACKEND = "fixture";
  const integrationEnv = pick("integration", INTEGRATION_KEYS);
  Object.assign(integrationEnv, { INTEGRATION_PORT: String(integrationPort), RESEARCH_SERVICE_URL: researchUrl, REVIEW_SERVICE_URL: reviewUrl });

  // Live readiness (warnings: fixture mode works without any of these).
  if (!env.get("YOUTUBE_API_KEY")) warnings.push("YOUTUBE_API_KEY is not set in the launcher environment or env file: live research will be refused (audience-research/.env may still supply it).");
  if (transport === "rest" && !env.get("OPUSCLIP_API_KEY"))
    warnings.push("OPUSCLIP_TRANSPORT=rest but OPUSCLIP_API_KEY is not set here: live generation will fail unless audience-research/.env supplies it.");
  if (transport === "mcp") warnings.push("OPUSCLIP_TRANSPORT=mcp: complete the browser sign-in once with `npm --prefix audience-research run opus:mcp-login` before live generation.");
  if (!env.get("CODEX_API_KEY") && !existsSync(codexAuthFile))
    warnings.push(`Neither CODEX_API_KEY nor ${codexAuthFile} is present: live Codex research and review will fail (run \`codex login\`).`);
  if (!env.get("CODEX_API_KEY") && existsSync(codexAuthFile) && reviewEnv.CLIP_REVIEW_COPY_CODEX_LOGIN === "0")
    warnings.push("CLIP_REVIEW_COPY_CODEX_LOGIN=0 and no CODEX_API_KEY: the isolated reviewer has no credentials unless its Codex home already holds a login.");

  return {
    plan: {
      research: { port: researchPort, url: researchUrl, env: researchEnv },
      review: { port: reviewPort, url: reviewUrl, env: reviewEnv },
      integration: { port: integrationPort, env: integrationEnv },
    },
    validation: { errors, warnings, rows },
  };
}
