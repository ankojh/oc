// Logging that never prints secrets. Every message passes through redact().

const SECRET_ENV_NAMES = ["YOUTUBE_API_KEY", "OPUSCLIP_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY"];

export function redact(text: string, extraSecrets: (string | null | undefined)[] = []): string {
  let out = text;
  for (const secret of extraSecrets) if (secret && secret.length >= 6) out = out.split(secret).join("<redacted>");
  for (const name of SECRET_ENV_NAMES) {
    const value = process.env[name];
    if (value && value.length >= 6) out = out.split(value).join(`<${name}>`);
  }
  return out
    .replace(/([?&]key=)[^&\s"']+/gi, "$1<redacted>")
    .replace(/(authorization["']?\s*[:=]\s*["']?(bearer\s+)?)[^\s"',}]+/gi, "$1<redacted>")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "<redacted-key>")
    .replace(/\bAIza[0-9A-Za-z_-]{10,}/g, "<redacted-key>");
}

function fmt(args: unknown[]): string {
  return redact(
    args
      .map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a)))
      .join(" "),
  );
}

export const log = {
  info: (...args: unknown[]) => console.log(`[${new Date().toISOString()}] ${fmt(args)}`),
  warn: (...args: unknown[]) => console.warn(`[${new Date().toISOString()}] WARN ${fmt(args)}`),
  error: (...args: unknown[]) => console.error(`[${new Date().toISOString()}] ERROR ${fmt(args)}`),
};
