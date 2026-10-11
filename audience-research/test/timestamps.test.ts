import { describe, expect, it } from "vitest";
import { Clip } from "../src/contract.js";
import { mcpClipRanges, mcpTranscript } from "../src/opusclip/mcp.js";
import { normalizeClipRanges, normalizeTranscript, sliceTranscriptForRanges, toMs, transcriptCoverage } from "../src/opusclip/normalize.js";
import { RestOpusClipAdapter } from "../src/opusclip/rest.js";
import { jsonResponse, testConfig } from "./helpers.js";

describe("unit conversion", () => {
  it("converts declared units to integer milliseconds", () => {
    expect(toMs(12.3456, "s")).toBe(12346);
    expect(toMs(1500.4, "ms")).toBe(1500);
    expect(() => toMs(-1, "s")).toThrow();
    expect(() => toMs(Number.NaN, "ms")).toThrow();
  });
});

describe("clip range normalization never guesses", () => {
  it("uses an explicitly declared unit", () => {
    expect(normalizeClipRanges({ values: [[10, 20]], declaredUnit: "s", durationMs: null }, "verify")).toMatchObject({ ok: true, ranges: [{ startMs: 10000, endMs: 20000 }] });
    expect(normalizeClipRanges({ values: [[10, 20]], declaredUnit: "ms", durationMs: null }, "verify")).toMatchObject({ ok: true, ranges: [{ startMs: 10, endMs: 20 }] });
  });

  it("verifies the documented REST example (described as seconds, values in ms) against durationMs", () => {
    const r = normalizeClipRanges({ values: [[192170, 211630]], declaredUnit: "conflicting", durationMs: 19478 }, "verify");
    expect(r).toMatchObject({ ok: true, unit: "ms", ranges: [{ startMs: 192170, endMs: 211630 }] });
  });

  it("verifies seconds when the span in seconds matches durationMs", () => {
    const r = normalizeClipRanges({ values: [[100.5, 130], [200, 215.25]], declaredUnit: "conflicting", durationMs: 44750 }, "verify");
    expect(r).toMatchObject({ ok: true, unit: "s", ranges: [{ startMs: 100500, endMs: 130000 }, { startMs: 200000, endMs: 215250 }] });
  });

  it("reports unavailable when neither unit, or no duration, is consistent", () => {
    expect(normalizeClipRanges({ values: [[0, 500]], declaredUnit: "conflicting", durationMs: 60000 }, "verify")).toMatchObject({ ok: false });
    expect(normalizeClipRanges({ values: [[0, 30]], declaredUnit: "conflicting", durationMs: null }, "verify")).toMatchObject({ ok: false });
    expect(normalizeClipRanges({ values: null, declaredUnit: "ms", durationMs: 1 }, "verify")).toMatchObject({ ok: false });
    expect(normalizeClipRanges({ values: [[20, 10]], declaredUnit: "ms", durationMs: 1 }, "verify")).toMatchObject({ ok: false });
  });

  it("reports ambiguity when both units fit within tolerance", () => {
    // span 1.5 -> 1.5ms or 1500ms; durationMs 1000 is within the 1500ms floor tolerance of both
    expect(normalizeClipRanges({ values: [[0, 1.5]], declaredUnit: "conflicting", durationMs: 1000 }, "verify")).toMatchObject({ ok: false, reason: expect.stringMatching(/ambiguous/) });
  });

  it("honours an explicit operator override", () => {
    expect(normalizeClipRanges({ values: [[1, 2]], declaredUnit: "conflicting", durationMs: null }, "s")).toMatchObject({ ok: true, unit: "s", ranges: [{ startMs: 1000, endMs: 2000 }] });
  });

  it("MCP: only explicitly unit-named range fields are trusted", () => {
    expect(mcpClipRanges({ time_ranges_ms: [[1, 2]], duration_ms: 1 }).declaredUnit).toBe("ms");
    expect(mcpClipRanges({ time_ranges_sec: [[1, 2]] }).declaredUnit).toBe("s");
    expect(mcpClipRanges({ timeRanges: [[1, 2]], durationMs: 1 }).declaredUnit).toBe("conflicting");
  });
});

describe("transcripts", () => {
  const paras = normalizeTranscript(
    [
      { id: 2, start: 30, end: 40, text: "third", words: [{ word: "third", start: 30, end: 40 }] },
      { id: 0, start: 0, end: 10.0004, text: "first", words: [{ word: "first", start: 0, end: 10.0004 }] },
      { id: 1, start: 10.5, end: 20, text: "second one", words: [{ word: "second", start: 10.5, end: 15 }, { word: "one", start: 15, end: 20 }] },
    ],
    "s",
  );

  it("normalizes seconds to integer ms and sorts into playback order", () => {
    expect(paras.map((p) => [p.id, p.startMs, p.endMs])).toEqual([["seg_0", 0, 10000], ["seg_1", 10500, 20000], ["seg_2", 30000, 40000]]);
  });

  it("slices clip transcripts in clip playback order across non-ascending source ranges", () => {
    const ranges = [{ startMs: 30000, endMs: 40000 }, { startMs: 10000, endMs: 16000 }];
    const t = sliceTranscriptForRanges(paras, ranges, "clip1");
    expect(t.map((s) => [s.text, s.sourceStartMs, s.sourceEndMs])).toEqual([["third", 30000, 40000], ["second", 10500, 15000]]);
    expect(Clip.safeParse({ id: "clip1", title: "", previewUrl: null, exportUrl: null, sourceRanges: ranges, transcriptStatus: "available", transcript: t }).success).toBe(true);
    // The same segments in ascending source order violate playback order for these ranges.
    expect(Clip.safeParse({ id: "clip1", title: "", previewUrl: null, exportUrl: null, sourceRanges: ranges, transcriptStatus: "available", transcript: [...t].reverse() }).success).toBe(false);
  });

  it("marks clips without transcript as unavailable rather than substituting the title", () => {
    expect(Clip.safeParse({ id: "c", title: "Great title", previewUrl: null, exportUrl: null, sourceRanges: [], transcriptStatus: "available", transcript: [] }).success).toBe(false);
  });

  it("reports coverage honestly: full only when the provider declares it", () => {
    expect(transcriptCoverage(paras, 41000).coverage).toBe("partial");
    expect(transcriptCoverage(paras, 41000).note).toMatch(/completeness is unknown/);
    expect(transcriptCoverage(paras, 41000, { complete: true, basis: "test" }).coverage).toBe("full");
    expect(transcriptCoverage(paras, 600000).coverage).toBe("partial");
    expect(transcriptCoverage(paras, null).coverage).toBe("partial");
    expect(transcriptCoverage([], 1000).coverage).toBe("unavailable");
  });

  it("a tail-only transcript reaching the video end is not full coverage", () => {
    const tail = normalizeTranscript([{ id: 9, start: 590, end: 600, text: "thanks for watching" }], "s");
    expect(transcriptCoverage(tail, 600000)).toMatchObject({ coverage: "partial", note: expect.stringMatching(/590s–600s/) });
    // A completeness declaration contradicted by the timing is not trusted either.
    const head = normalizeTranscript([{ id: 0, start: 0, end: 60, text: "intro" }], "s");
    expect(transcriptCoverage(head, 600000, { complete: true, basis: "test" }).coverage).toBe("partial");
  });

  it("excludes provider segments and slices without a strictly positive duration", () => {
    const excluded: string[] = [];
    const p = normalizeTranscript(
      [
        { id: 0, start: 1, end: 1, text: "zero" },
        { id: 1, start: 2, end: 2.0001, text: "rounds to zero" },
        { id: 2, start: 3, end: 5, text: "ok tick", words: [{ word: "ok", start: 3, end: 4 }, { word: "tick", start: 4.5, end: 4.5 }] },
        { id: 3, start: 6, end: 8, text: "point", words: [{ word: "point", start: 6, end: 6 }] },
      ],
      "s",
      excluded,
    );
    expect(excluded).toEqual(["seg_0", "seg_1"]);
    expect(p.map((x) => x.id)).toEqual(["seg_2", "seg_3"]);
    expect(p[0].words.map((w) => w.text)).toEqual(["ok"]);
    const sliceExcluded: string[] = [];
    const t = sliceTranscriptForRanges(p, [{ startMs: 0, endMs: 10000 }], "c", sliceExcluded);
    // seg_3 lost its only (zero-length) word, so it falls back to its whole positive paragraph span.
    expect(t.map((s) => [s.text, s.sourceStartMs, s.sourceEndMs])).toEqual([["ok", 3000, 4000], ["point", 6000, 8000]]);
    expect(sliceExcluded).toEqual([]);
  });

  it("the contract rejects zero-length segments and ranged clips with no transcript ranges mismatch", () => {
    const base = { id: "c", title: "", previewUrl: null, exportUrl: null };
    expect(Clip.safeParse({ ...base, sourceRanges: [], transcriptStatus: "unavailable", transcript: [] }).success).toBe(true);
    expect(
      Clip.safeParse({ ...base, sourceRanges: [{ startMs: 0, endMs: 10 }], transcriptStatus: "available", transcript: [{ id: "s", sourceStartMs: 5, sourceEndMs: 5, text: "x" }] }).success,
    ).toBe(false);
  });

  it("MCP transcripts use explicit _ms fields and refuse unknown shapes", () => {
    const ms = mcpTranscript({ paragraphs: [{ paragraph_id: 0, start_ms: 1200, end_ms: 3400, text: "hi", words: [{ word: "hi", start_ms: 1200, end_ms: 3400 }] }] });
    expect(ms.unit).toBe("ms");
    expect(normalizeTranscript(ms.paragraphs!, ms.unit)[0]).toMatchObject({ startMs: 1200, endMs: 3400 });
    expect(() => mcpTranscript({ paragraphs: [{ t0: 1, t1: 2, text: "?" }] })).toThrow(/refusing to guess/);
  });

  it("REST transcript and clips flow through documented units", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes("/transcripts")) return jsonResponse(200, { data: [[{ id: 0, start: 1.25, end: 2.5, text: "hello", words: [] }]] });
      return jsonResponse(200, { data: [{ id: "P1.CU1", title: "t", durationMs: 19478, timeRanges: [[192170, 211630]], uriForPreview: "https://x.invalid/p.mp4", uriForExport: null }] });
    }) as unknown as typeof fetch;
    const rest = new RestOpusClipAdapter(testConfig().opus, fetchImpl);
    const t = await rest.getTranscript("P1");
    expect(t.unit).toBe("s");
    expect(normalizeTranscript(t.paragraphs!, t.unit)[0]).toMatchObject({ startMs: 1250, endMs: 2500 });
    const { clips } = await rest.listClips("P1");
    expect(clips[0].ranges.declaredUnit).toBe("conflicting");
    expect(normalizeClipRanges(clips[0].ranges, "verify")).toMatchObject({ ok: true, unit: "ms" });
  });
});
