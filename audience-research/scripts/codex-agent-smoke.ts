// Live smoke test of the Codex research agent on FIXTURE comments (no YouTube
// key needed). Uses the local Codex login and a small amount of model usage.
//   npm run smoke:codex-agent
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { CodexResearchAnalyzer } from "../src/research/codexAnalyzer.js";
import { runResearch } from "../src/research/pipeline.js";
import { FixtureYouTubeAdapter } from "../src/youtube/fixture.js";

const cfg = loadConfig();
const yt = new FixtureYouTubeAdapter(path.join(cfg.fixturesDir, "youtube"));
const analyzer = new CodexResearchAnalyzer(cfg.codex);
const videoId = process.argv[2] ?? "FXdemo00001";
const started = Date.now();
const out = await runResearch(
  yt,
  analyzer,
  {
    runId: "run_codex_smoke",
    mode: "fixture",
    videoId,
    creatorGoal: "Turn recurring viewer questions into Shorts",
    commentsPerVideo: 100,
    maxRelatedVideos: 5,
    recentUploadsToConsider: 15,
    generationDefaults: { durationSec: cfg.opus.defaultDurationSec, aspectRatio: cfg.opus.defaultAspectRatio },
  },
  (step, msg) => console.log(`[${step}] ${msg}`),
);
console.log(`\nanalyzer=${out.debug.analyzer} status=${out.brief.researchStatus} in ${Math.round((Date.now() - started) / 1000)}s`);
console.log(`related selection: ${JSON.stringify(out.debug.relatedSelection)}`);
console.log(`dropped comment ids: ${JSON.stringify(out.debug.droppedCommentIds)}; downgraded: ${JSON.stringify(out.debug.downgradedToInferred)}`);
for (const q of out.brief.questions) {
  console.log(`\n#${q.priority} [${q.kind}] ${q.question}  (${q.observedCommentCount} comments)\n   ${q.rationale}`);
  for (const id of q.evidenceIds) console.log(`   - "${out.brief.evidence.find((e) => e.id === id)!.quote}"`);
}
console.log(`\nprompt: ${out.brief.generationBrief?.customPrompt ?? "(none)"}`);
console.log(`agent notes: ${out.debug.agentNotes}`);
