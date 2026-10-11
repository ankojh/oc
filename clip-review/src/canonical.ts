import { createHash } from "node:crypto";

/** Canonical JSON so key order does not defeat hashing. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
