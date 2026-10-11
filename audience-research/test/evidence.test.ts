import path from "node:path";
import { describe, expect, it } from "vitest";
import { ResearchBrief } from "../src/contract.js";
import type { AnalysisResult, ResearchAnalyzer } from "../src/research/analyzer.js";
import { buildResearchBrief } from "../src/research/brief.js";
import { HeuristicResearchAnalyzer } from "../src/research/heuristicAnalyzer.js";
import { runResearch } from "../src/research/pipeline.js";
import { isObviousSpam, prefilterComments } from "../src/research/prefilter.js";
import { buildClipAnythingPrompt } from "../src/research/prompt.js";
import { FixtureYouTubeAdapter } from "../src/youtube/fixture.js";
import { parseYouTubeVideoId } from "../src/youtube/types.js";
import { comment, testConfig } from "./helpers.js";

const base = {
  runId: "run_test",
  mode: "live" as const,
  video: { url: "https://www.youtube.com/watch?v=VIDEOID0001", videoId: "VIDEOID0001", channelId: "UCx", title: "T" },
  creatorGoal: null,
  generationDefaults: { durationSec: [0, 90] as [number, number], aspectRatio: "portrait" as const },
};
const coverage = (count: number) => ({ fetchedAt: "2026-09-01T00:00:00.000Z", videoIds: ["VIDEOID0001"], commentCount: count, samplingMethod: "test", limitations: [] });

function build(comments: ReturnType<typeof comment>[], analysis: AnalysisResult) {
  const { candidates } = prefilterComments(comments);
  return buildResearchBrief({ ...base, coverage: coverage(comments.length), candidates, analysis });
}

describe("evidence integrity", () => {
  it("quotes are copied verbatim from retrieved comments and every evidence ID resolves", () => {
    const a = comment("What mic do you use?? 🎙️  (asking for a friend)");
    const b = comment("which MIC is that? sounds great");
    const { brief } = build([a, b], {
      themes: [{ question: "What microphone do you use?", kind: "explicit", commentIds: [a.commentId, b.commentId], rationale: "Two viewers ask about the mic." }],
      notes: "",
    });
    expect(brief.researchStatus).toBe("ready");
    expect(brief.evidence.map((e) => e.quote)).toEqual([a.text, b.text]);
    expect(brief.evidence.map((e) => e.commentId)).toEqual([a.commentId, b.commentId]);
    expect(brief.evidence[0].url).toBe(`https://www.youtube.com/watch?v=VIDEOID0001&lc=${a.commentId}`);
    const ids = new Set(brief.evidence.map((e) => e.id));
    for (const q of brief.questions) for (const id of q.evidenceIds) expect(ids.has(id)).toBe(true);
    expect(brief.questions[0].observedCommentCount).toBe(2);
  });

  it("discards comment IDs the agent invented and drops themes left without evidence", () => {
    const a = comment("How do you light your desk setup?");
    const r = build([a], {
      themes: [
        { question: "How do you light your desk?", kind: "explicit", commentIds: [a.commentId, "invented-1"], rationale: "x" },
        { question: "Are you quitting YouTube?", kind: "explicit", commentIds: ["invented-2", "invented-3"], rationale: "x" },
      ],
      notes: "",
    });
    expect(r.droppedCommentIds).toEqual(["invented-1", "invented-2", "invented-3"]);
    expect(r.droppedThemes).toEqual(["Are you quitting YouTube?"]);
    expect(r.brief.questions).toHaveLength(1);
    expect(r.brief.evidence).toHaveLength(1);
    expect(r.brief.coverage.limitations.join(" ")).toMatch(/cited 3 comment ID/);
  });

  it("treats a single comment as a single signal and never double counts a comment across themes", () => {
    const a = comment("What camera is this?");
    const b = comment("What lens and camera do you shoot on?");
    const { brief } = build([a, b], {
      themes: [
        { question: "What camera do you use?", kind: "explicit", commentIds: [a.commentId, b.commentId, a.commentId], rationale: "Camera asks." },
        { question: "What lens do you use?", kind: "explicit", commentIds: [b.commentId], rationale: "Lens ask." },
      ],
      notes: "",
    });
    expect(brief.questions).toHaveLength(1); // b already supports theme 1, so theme 2 has no evidence left
    expect(brief.questions[0].observedCommentCount).toBe(2);
    const single = build([comment("Do you use a teleprompter?")], {
      themes: [{ question: "Do you use a teleprompter?", kind: "explicit", commentIds: [], rationale: "One viewer asks." }],
      notes: "",
    });
    expect(single.brief.researchStatus).toBe("insufficient_evidence");
    const c = comment("Do you use a teleprompter?");
    const one = build([c], { themes: [{ question: "Do you use a teleprompter?", kind: "explicit", commentIds: [c.commentId], rationale: "One viewer asks." }], notes: "" });
    expect(one.brief.questions[0].observedCommentCount).toBe(1);
    expect(one.brief.questions[0].rationale).toMatch(/single signal/i);
  });

  it("relabels 'explicit' as 'inferred' when no supporting comment asks a question", () => {
    const a = comment("Please make a video on your editing PC build.");
    const { brief, downgradedToInferred } = build([a], {
      themes: [{ question: "What PC do you edit on?", kind: "explicit", commentIds: [a.commentId], rationale: "Request." }],
      notes: "",
    });
    expect(brief.questions[0].kind).toBe("inferred");
    expect(downgradedToInferred).toHaveLength(1);
  });

  it("removes duplicates and obvious spam before they can become evidence", () => {
    const real = comment("How do you plan your scripts?");
    const dupId = { ...real }; // same comment fetched twice
    const dupText = comment("How do you plan your scripts?", "VIDEOID0002");
    const spam = comment("check out my channel for more!! https://spam.example");
    const { candidates, stats } = prefilterComments([real, dupId, dupText, spam]);
    expect(candidates.map((c) => c.commentId)).toEqual([real.commentId]);
    expect(stats).toMatchObject({ retrieved: 4, uniqueRetrieved: 3, duplicatesRemoved: 2, spamRemoved: 1 });
    const { brief } = buildResearchBrief({
      ...base,
      coverage: coverage(3),
      candidates,
      analysis: { themes: [{ question: "How do you plan scripts?", kind: "explicit", commentIds: [real.commentId, dupText.commentId, spam.commentId], rationale: "x" }], notes: "" },
    });
    expect(brief.questions[0].observedCommentCount).toBe(1);
    expect(isObviousSpam("sub4sub?")).toBe(true);
    expect(isObviousSpam("What software do you use?")).toBe(false);
  });

  it("counts empty comments separately so fetched-minus-removals equals eligible", () => {
    const real = comment("Which microphone do you use?");
    const sameText = comment("Which microphone do you use?", "VIDEOID0002");
    const empty = comment("   ");
    const spam = comment("check out my channel for more!! https://spam.example");
    const { stats } = prefilterComments([real, sameText, empty, spam]);
    expect(stats).toMatchObject({ retrieved: 4, uniqueRetrieved: 4, eligible: 1, duplicatesRemoved: 1, spamRemoved: 1, emptyRemoved: 1 });
    expect(stats.retrieved - stats.duplicatesRemoved - stats.spamRemoved - stats.emptyRemoved).toBe(stats.eligible);
  });

  it("returns insufficient_evidence with no questions and no generation brief when nothing qualifies", () => {
    const { brief } = build([comment("great video"), comment("love it")], { themes: [], notes: "Only praise." });
    expect(brief.researchStatus).toBe("insufficient_evidence");
    expect(brief.questions).toEqual([]);
    expect(brief.evidence).toEqual([]);
    expect(brief.generationBrief).toBeNull();
    expect(brief.coverage.limitations.join(" ")).toMatch(/Insufficient evidence/);
    const empty = build([], { themes: [], notes: "" });
    expect(empty.brief.coverage.limitations.join(" ")).toMatch(/no comments could be retrieved/);
  });

  it("keeps at most three themes, ranked by distinct supporting comments", () => {
    const cs = Array.from({ length: 10 }, (_, i) => comment(`Question number ${i} about topic ${i}?`));
    const t = (q: string, ids: number[]) => ({ question: q, kind: "explicit" as const, commentIds: ids.map((i) => cs[i].commentId), rationale: "r" });
    const { brief } = build(cs, { themes: [t("A?", [0]), t("B?", [1, 2, 3]), t("C?", [4, 5]), t("D?", [6, 7, 8, 9])], notes: "" });
    expect(brief.questions.map((q) => q.question)).toEqual(["D?", "B?", "C?"]);
    expect(brief.questions.map((q) => q.priority)).toEqual([1, 2, 3]);
  });

  it("the contract rejects unresolvable evidence IDs and invented counts", () => {
    const a = comment("What mic is that?");
    const { brief } = build([a], { themes: [{ question: "Mic?", kind: "explicit", commentIds: [a.commentId], rationale: "r" }], notes: "" });
    expect(ResearchBrief.safeParse({ ...brief, questions: [{ ...brief.questions[0], evidenceIds: ["ev_404"] }] }).success).toBe(false);
    expect(ResearchBrief.safeParse({ ...brief, questions: [{ ...brief.questions[0], observedCommentCount: 40 }] }).success).toBe(false);
    expect(ResearchBrief.safeParse({ ...brief, coverage: { ...brief.coverage, fetchedAt: "2026-09-01 10:00" } }).success).toBe(false);
  });

  it("the generation prompt asks for matching moments and does not assert answers", () => {
    const p = buildClipAnythingPrompt([{ question: "What mic do you use?", priority: 1 }], "grow Shorts");
    expect(p).toMatch(/What mic do you use\?/);
    expect(p).toMatch(/Skip a question if the video never addresses it/);
    expect(p.length).toBeLessThanOrEqual(900);
  });
});

describe("research pipeline (fixture adapters)", () => {
  const cfg = testConfig();
  const yt = new FixtureYouTubeAdapter(path.join(cfg.fixturesDir, "youtube"));
  const params = (videoId: string) => ({
    runId: "run_t",
    mode: "fixture" as const,
    videoId,
    creatorGoal: null,
    commentsPerVideo: 100,
    maxRelatedVideos: 5,
    recentUploadsToConsider: 15,
    generationDefaults: { durationSec: [0, 90] as [number, number], aspectRatio: "portrait" as const },
  });

  it("samples the source plus at most five same-channel videos and records failures", async () => {
    const out = await runResearch(yt, new HeuristicResearchAnalyzer(), params("FXdemo00001"), () => {});
    expect(out.debug.sources[0]).toMatchObject({ videoId: "FXdemo00001", role: "source" });
    expect(out.debug.sources.length).toBeLessThanOrEqual(6);
    expect(out.debug.sources.find((s) => s.videoId === "FXrel000003")?.status).toBe("comments_disabled");
    expect(out.brief.coverage.videoIds).not.toContain("FXrel000003");
    expect(out.brief.researchStatus).toBe("ready");
    // Every evidence quote is a real retrieved fixture comment.
    const all = (await Promise.all(out.debug.sources.map((s) => yt.listComments(s.videoId, 100)))).flatMap((r) => r.comments);
    for (const e of out.brief.evidence) expect(all.find((c) => c.commentId === e.commentId)?.text).toBe(e.quote);
  });

  it("ignores agent-selected videos that are not recent uploads of the same channel", async () => {
    const analyzer: ResearchAnalyzer = {
      name: "rogue",
      selectRelatedVideos: async () => ({ selectedVideoIds: ["FXnoqs00003", "FXrel000001"], reason: "x" }),
      analyze: async () => ({ themes: [], notes: "" }),
    };
    const out = await runResearch(yt, analyzer, params("FXdemo00001"), () => {});
    expect(out.debug.relatedSelection?.ignoredIds).toEqual(["FXnoqs00003"]);
    expect(out.debug.sources.map((s) => s.videoId)).toEqual(["FXdemo00001", "FXrel000001"]);
  });

  it("yields insufficient_evidence for a channel whose comments contain no questions", async () => {
    const out = await runResearch(yt, new HeuristicResearchAnalyzer(), params("FXnoqs00001"), () => {});
    expect(out.brief.researchStatus).toBe("insufficient_evidence");
    expect(out.brief.coverage.limitations.join(" ")).toMatch(/comments_disabled/);
  });
});

describe("video URL parsing", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?si=abc", "dQw4w9WgXcQ"],
    ["https://m.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ])("%s", (url, id) => expect(parseYouTubeVideoId(url)).toBe(id));
  it("rejects channel URLs", () => expect(() => parseYouTubeVideoId("https://www.youtube.com/@creator")).toThrow());
});
