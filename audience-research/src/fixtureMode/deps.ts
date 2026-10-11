import path from "node:path";
import type { Config } from "../config.js";
import { FixtureOpusClipAdapter } from "../opusclip/fixture.js";
import { HeuristicResearchAnalyzer } from "../research/heuristicAnalyzer.js";
import type { ModeDeps } from "../runs.js";
import { FixtureYouTubeAdapter } from "../youtube/fixture.js";

export function fixtureModeDeps(config: Config, pollIntervalMs = 700): ModeDeps & { fixtureYouTube: FixtureYouTubeAdapter } {
  const fixtureYouTube = new FixtureYouTubeAdapter(path.join(config.fixturesDir, "youtube"));
  return {
    fixtureYouTube,
    youtube: () => fixtureYouTube,
    analyzer: () => new HeuristicResearchAnalyzer(),
    opus: () => new FixtureOpusClipAdapter(path.join(config.fixturesDir, "opusclip")),
    pollIntervalMs,
  };
}
