// Provider timestamp normalization. Units are never guessed:
// - A value is converted only when its unit is declared (by documentation or by
//   an explicitly unit-named field) — see `TimeUnit`.
// - REST `timeRanges` documentation conflicts with itself (described as seconds,
//   example values are milliseconds). For such values the unit is *verified*
//   against the provider's own `durationMs` field; if exactly one unit is
//   consistent we use it, otherwise the ranges are reported unavailable.
import type { ClipTranscriptSegment, SourceTranscriptSegment, TimeRange } from "../contract.js";
import type { TimeRangeUnitPolicy } from "../config.js";

export type TimeUnit = "s" | "ms";

export function toMs(value: number, unit: TimeUnit): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid provider time value: ${value}`);
  return unit === "ms" ? Math.round(value) : Math.round(value * 1000);
}

export interface RawRanges {
  values: unknown;
  /** "conflicting" when the provider's documentation does not settle the unit. */
  declaredUnit: TimeUnit | "conflicting";
  /** Provider-reported clip length in ms (REST `durationMs`), used for verification. */
  durationMs: number | null;
}

export type RangeNormalization =
  | { ok: true; ranges: TimeRange[]; unit: TimeUnit; basis: string }
  | { ok: false; ranges: []; reason: string };

/** Tolerance when comparing summed range length to the provider's durationMs. */
function tolerance(durationMs: number): number {
  return Math.max(1500, durationMs * 0.1);
}

function parsePairs(values: unknown): [number, number][] | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  const out: [number, number][] = [];
  for (const v of values) {
    let pair: [unknown, unknown];
    if (Array.isArray(v) && v.length === 2) pair = [v[0], v[1]];
    else if (v && typeof v === "object" && "start" in v && "end" in v) pair = [(v as { start: unknown }).start, (v as { end: unknown }).end];
    else return null;
    if (typeof pair[0] !== "number" || typeof pair[1] !== "number" || !Number.isFinite(pair[0]) || !Number.isFinite(pair[1])) return null;
    if (pair[0] < 0 || pair[1] <= pair[0]) return null;
    out.push([pair[0], pair[1]]);
  }
  return out;
}

export function normalizeClipRanges(raw: RawRanges, policy: TimeRangeUnitPolicy): RangeNormalization {
  const pairs = parsePairs(raw.values);
  if (!pairs) return { ok: false, ranges: [], reason: "provider returned no parseable source time ranges" };
  const build = (unit: TimeUnit): TimeRange[] => pairs.map(([a, b]) => ({ startMs: toMs(a, unit), endMs: toMs(b, unit) }));

  if (raw.declaredUnit !== "conflicting") return { ok: true, ranges: build(raw.declaredUnit), unit: raw.declaredUnit, basis: "unit declared by provider field" };
  if (policy === "ms" || policy === "s")
    return { ok: true, ranges: build(policy), unit: policy, basis: `operator override OPUSCLIP_TIMERANGE_UNIT=${policy}` };

  if (raw.durationMs === null || !(raw.durationMs > 0))
    return { ok: false, ranges: [], reason: "time range unit is undocumented/conflicting and no durationMs is available to verify it" };
  const span = pairs.reduce((sum, [a, b]) => sum + (b - a), 0);
  const tol = tolerance(raw.durationMs);
  const msMatches = Math.abs(span - raw.durationMs) <= tol;
  const sMatches = Math.abs(span * 1000 - raw.durationMs) <= tol;
  if (msMatches && !sMatches) return { ok: true, ranges: build("ms"), unit: "ms", basis: `verified: ranges sum to ${span} which matches durationMs ${raw.durationMs} as milliseconds` };
  if (sMatches && !msMatches) return { ok: true, ranges: build("s"), unit: "s", basis: `verified: ranges sum to ${span}s which matches durationMs ${raw.durationMs}` };
  return {
    ok: false,
    ranges: [],
    reason: msMatches ? "time range unit is ambiguous (both seconds and milliseconds fit durationMs)" : `time ranges (span ${span}) are inconsistent with durationMs ${raw.durationMs} in both seconds and milliseconds`,
  };
}

export interface RawTranscriptParagraph {
  id: string | number;
  start: number;
  end: number;
  text: string;
  words?: { word: string; start: number; end: number }[];
}

export interface NormalizedParagraph extends SourceTranscriptSegment {
  words: { text: string; startMs: number; endMs: number }[];
}

/**
 * Converts declared-unit paragraphs to ms and sorts them into playback order.
 * Segments (and words) that are not strictly positive intervals after
 * conversion are excluded; their ids are pushed to `excluded` so the caller
 * can report them as a limitation instead of dropping them silently.
 */
export function normalizeTranscript(paragraphs: RawTranscriptParagraph[], unit: TimeUnit, excluded: string[] = []): NormalizedParagraph[] {
  return paragraphs
    .map((p) => ({
      id: `seg_${p.id}`,
      startMs: toMs(p.start, unit),
      endMs: toMs(p.end, unit),
      text: p.text.trim(),
      words: (p.words ?? [])
        .map((w) => ({ text: w.word, startMs: toMs(w.start, unit), endMs: toMs(w.end, unit) }))
        .filter((w) => w.endMs > w.startMs)
        .sort((a, b) => a.startMs - b.startMs),
    }))
    .filter((p) => {
      if (p.endMs > p.startMs) return true;
      excluded.push(p.id);
      return false;
    })
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

/**
 * Builds a clip's transcript from the source transcript: for each source range
 * (in clip playback order), the words that fall inside it, grouped by paragraph.
 * Paragraphs without word timings are included only when entirely inside the range.
 */
export function sliceTranscriptForRanges(paragraphs: NormalizedParagraph[], ranges: TimeRange[], clipId: string, excluded: string[] = []): ClipTranscriptSegment[] {
  const out: ClipTranscriptSegment[] = [];
  ranges.forEach((r, ri) => {
    for (const p of paragraphs) {
      if (p.endMs <= r.startMs || p.startMs >= r.endMs) continue;
      if (p.words.length > 0) {
        const words = p.words.filter((w) => w.startMs >= r.startMs && w.endMs <= r.endMs);
        if (words.length === 0) continue;
        if (words[words.length - 1].endMs <= words[0].startMs) {
          excluded.push(`${clipId}_r${ri}_${p.id}`);
          continue;
        }
        out.push({
          id: `${clipId}_r${ri}_${p.id}`,
          sourceStartMs: words[0].startMs,
          sourceEndMs: words[words.length - 1].endMs,
          text: words.map((w) => w.text.trim()).join(" ").replace(/\s+([,.!?;:])/g, "$1"),
        });
      } else if (p.startMs >= r.startMs && p.endMs <= r.endMs) {
        out.push({ id: `${clipId}_r${ri}_${p.id}`, sourceStartMs: p.startMs, sourceEndMs: p.endMs, text: p.text });
      }
    }
  });
  return out;
}

/** Provider-declared completeness, only when the provider states it explicitly. */
export interface DeclaredCoverage {
  complete: boolean;
  basis: string;
}

/**
 * "full" only when the provider explicitly declares the transcript complete.
 * Segment timing alone cannot establish completeness: a tail-only transcript
 * can end near the video end, and gaps may be silence. Without a declaration
 * coverage is reported "partial" (completeness unknown).
 */
export function transcriptCoverage(
  paragraphs: NormalizedParagraph[],
  videoDurationMs: number | null,
  declared: DeclaredCoverage | null = null,
): { coverage: "full" | "partial" | "unavailable"; note: string | null } {
  if (paragraphs.length === 0) return { coverage: "unavailable", note: "OpusClip returned no source transcript for this project." };
  const firstStart = Math.min(...paragraphs.map((p) => p.startMs));
  const lastEnd = Math.max(...paragraphs.map((p) => p.endMs));
  const span = `segments span ${Math.round(firstStart / 1000)}s–${Math.round(lastEnd / 1000)}s${videoDurationMs === null ? " of a video of unknown length" : ` of a ${Math.round(videoDurationMs / 1000)}s video`}`;
  if (declared?.complete) {
    if (videoDurationMs !== null && lastEnd < videoDurationMs * 0.5)
      return { coverage: "partial", note: `Provider declared the transcript complete (${declared.basis}), but ${span}; treated as partial.` };
    return { coverage: "full", note: null };
  }
  return {
    coverage: "partial",
    note: `Transcript completeness is unknown: the provider does not report transcript coverage and timing alone cannot prove it (${span}).`,
  };
}
