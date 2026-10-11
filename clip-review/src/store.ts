// Simple local persistence: one JSON file per review plus a cache index keyed by
// (input hash, reviewer version, backend version key).
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ReviewRecord = {
  reviewId: string;
  cacheKey: string;
  inputHash: string;
  reviewerVersion: string;
  backendVersionKey: string;
  status: "queued" | "running" | "succeeded" | "failed";
  progress: { step: string; at: string }[];
  createdAt: string;
  updatedAt: string;
  reusedFrom?: string;
  input: unknown;
  result?: unknown;
  errors?: { code: string; path: string; message: string; hint?: string }[];
};

export class ReviewStore {
  constructor(private dir: string) {
    mkdirSync(join(dir, "reviews"), { recursive: true });
  }
  private file(id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("invalid review id");
    return join(this.dir, "reviews", `${id}.json`);
  }
  get(id: string): ReviewRecord | null {
    try {
      const f = this.file(id);
      return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as ReviewRecord) : null;
    } catch {
      return null;
    }
  }
  save(rec: ReviewRecord) {
    rec.updatedAt = new Date().toISOString();
    const f = this.file(rec.reviewId);
    writeFileSync(`${f}.tmp`, JSON.stringify(rec, null, 2));
    renameSync(`${f}.tmp`, f);
  }
  /** Most recent non-failed review for this cache key. */
  findByCacheKey(cacheKey: string): ReviewRecord | null {
    let best: ReviewRecord | null = null;
    for (const f of readdirSync(join(this.dir, "reviews"))) {
      if (!f.endsWith(".json")) continue;
      const rec = this.get(f.slice(0, -5));
      if (rec && rec.cacheKey === cacheKey && rec.status !== "failed" && (!best || rec.createdAt > best.createdAt)) best = rec;
    }
    return best;
  }
  /** Reviews interrupted by a server restart can never finish; mark them failed. */
  failInterrupted() {
    for (const f of readdirSync(join(this.dir, "reviews"))) {
      if (!f.endsWith(".json")) continue;
      const rec = this.get(f.slice(0, -5));
      if (rec && (rec.status === "queued" || rec.status === "running")) {
        rec.status = "failed";
        rec.errors = [{ code: "interrupted", path: "(server)", message: "Server restarted during this review.", hint: "POST the handoff again with ?rerun=true." }];
        this.save(rec);
      }
    }
  }
}
