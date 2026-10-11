# audience-clips.v1 schemas

`ResearchBrief.schema.json` and `ReviewInput.schema.json` are generated from the
runtime validators in `src/contract.ts` (`npm run schemas:build`). JSON Schema
cannot express cross-field rules, so these are enforced at runtime by
`ResearchBrief.parse()` / `ReviewInput.parse()` and should be enforced by any consumer:

ResearchBrief
- every `questions[].evidenceIds[]` resolves to an `evidence[].id`; evidence IDs are unique
- each comment appears as evidence at most once (no double counting across questions)
- `observedCommentCount` equals the number of unique supporting comments (no invented counts or percentages)
- `evidence[].videoId` is one of `coverage.videoIds` (videos whose comments were retrieved successfully)
- at most 3 questions; `priority` values are unique (1 = highest)
- `researchStatus: "ready"` ⇒ ≥1 question and a `generationBrief`;
  `"insufficient_evidence"` ⇒ no questions, no evidence and `generationBrief: null`
- `generationBrief.targetQuestionIds` resolve; `durationSec` is `[min, max]` with `min < max`
- timestamps are UTC ISO-8601 ending in `Z`

ReviewInput
- `generation.requestedQuestionIds` resolve against `research.questions`
- all video times are integer milliseconds in source-video time
- `sourceTranscript.segments` are in playback order; `coverage: "unavailable"` ⇒ no segments
- `clips[].sourceRanges` are in clip playback order (a clip may splice non-ascending source ranges)
- `clips[].transcript` segments fall inside a source range and follow range order, then time
- `transcriptStatus: "unavailable"` ⇒ empty `transcript`; `"available"` ⇒ non-empty.
  Clip titles are never used as transcript text.
- clip IDs are unique
