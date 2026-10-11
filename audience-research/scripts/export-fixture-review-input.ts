// Runs the full fixture pipeline (research -> generate -> collect) through the
// real RunManager and exports the validated artifacts for the review builder:
//   fixtures/exports/review-input.fixture.json
//   fixtures/exports/research-brief.fixture.json
//   fixtures/exports/research-brief.insufficient.fixture.json
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT_DIR, loadConfig } from "../src/config.js";
import { ResearchBrief, ReviewInput } from "../src/contract.js";
import { fixtureModeDeps } from "../src/fixtureMode/deps.js";
import { RunManager } from "../src/runs.js";
import { RunStore } from "../src/store.js";

const config = { ...loadConfig(), dataDir: mkdtempSync(path.join(os.tmpdir(), "ar-export-")) };
const store = new RunStore(config.dataDir);
const ids = ["run_fixture_demo", "run_fixture_insufficient"];
const fixture = fixtureModeDeps(config, 1);
const manager = new RunManager({
  store,
  config,
  modes: { fixture, live: { ...fixture, opus: () => { throw new Error("live disabled in export"); } } },
  sleep: async () => {},
  newRunId: () => ids.shift()!,
});

const demo = manager.startResearch({ videoUrl: "https://www.youtube.com/watch?v=FXdemo00001", creatorGoal: "Turn recurring viewer questions into Shorts", mode: "fixture" });
await demo.promise;
await manager.generate(demo.runId, {});
await manager.ensurePoller(demo.runId);
const reviewInput = ReviewInput.parse(store.loadReviewInput(demo.runId));

const quiet = manager.startResearch({ videoUrl: "https://youtu.be/FXnoqs00001", mode: "fixture" });
await quiet.promise;
const insufficient = ResearchBrief.parse(store.load(quiet.runId)!.brief);

const dir = path.join(ROOT_DIR, "fixtures", "exports");
mkdirSync(dir, { recursive: true });
const write = (name: string, v: unknown) => {
  writeFileSync(path.join(dir, name), `${JSON.stringify(v, null, 2)}\n`);
  console.log(`wrote fixtures/exports/${name}`);
};
write("review-input.fixture.json", reviewInput);
write("research-brief.fixture.json", reviewInput.research);
write("research-brief.insufficient.fixture.json", insufficient);
console.log(`questions: ${reviewInput.research.questions.map((q) => `${q.priority}. [${q.kind}] ${q.question} (${q.observedCommentCount})`).join(" | ")}`);
console.log(`clips: ${reviewInput.clips.map((c) => `${c.id} ranges=${c.sourceRanges.length} transcript=${c.transcriptStatus}`).join(" | ")}`);
