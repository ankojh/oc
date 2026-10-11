# Audience Research Agent + OpusClip adapter (Build 1)

A creator pastes a public YouTube video URL (plus an optional goal). The service:

1. resolves the video's channel and samples comments from the video and up to five
   recent uploads from **the same channel** (the agent chooses which ones);
2. runs an **Audience Research Agent** (server-side `@openai/codex-sdk`) that groups
   real audience questions into at most three themes, each backed by exact quotes;
3. turns those questions into a focused OpusClip **ClipAnything** prompt;
4. on one explicit **Generate clips** action, submits one OpusClip project, polls it,
   and produces a validated **`ReviewInput`** (`audience-clips.v1`) for the review agent.

Hypothesis under test: real audience questions can guide useful clip selection.
Nothing here validates that hypothesis or claims OpusClip lacks similar capabilities.
The review agent, homepage, publishing and advanced editing are out of scope.

## Quick start (fixture mode — no credentials)

```bash
cd audience-research
npm install
npm test                     # 46 focused tests
npm start                    # http://localhost:3101
```

Open http://localhost:3101, leave **Fixture** selected, click the `FXdemo00001`
fixture link, then **Research audience questions** → **Generate clips**. Fixture runs
are labeled "FIXTURE DATA — not real audience comments" everywhere (UI banner,
`modeLabel`, `mode: "fixture"`, coverage limitations, ReviewInput limitations).
`FXnoqs00001` demonstrates the insufficient-evidence path.

**Fixture export for the review builder:** `fixtures/exports/review-input.fixture.json`
(plus `research-brief.fixture.json` and `research-brief.insufficient.fixture.json`).
Regenerate with `npm run fixtures:export-review-input`; it runs the real pipeline
(RunManager → research → generate → poll → collect) on fixture adapters.

## Live setup

```bash
cp .env.example .env         # then fill in the values below
npm run check:env -- --codex # verifies codex login + SDK, YouTube key, OpusClip REST
```

| Integration | What you need | Notes |
|---|---|---|
| Research agent | `codex login` (ChatGPT) or `CODEX_API_KEY` | Model via `CODEX_MODEL` (empty = Codex default). |
| YouTube | `YOUTUBE_API_KEY` (YouTube Data API v3 enabled) | ~4 + N quota units per run (videos, channels, playlistItems, N × commentThreads). |
| OpusClip via MCP (default) | OpusClip **Pro (Beta) / Max / Business** plan; run `npm run opus:mcp-login` once | Opens the OpusClip OAuth sign-in in a browser through `mcp-remote`; tokens cached in `~/.mcp-auth`. Prints live tool schemas and checks `customPrompt` support. |
| OpusClip via REST (alternative) | `OPUSCLIP_TRANSPORT=rest`, `OPUSCLIP_API_KEY` | Same plan requirement. Returns `uriForExport` and clip time ranges directly. |

Then `npm start` and choose **Live**.

**Credits.** Generating clips submits exactly one OpusClip project and consumes the
connected account's credits. The OpusClip API charges a 10-credit minimum per project
and has a monthly cap of 900 credits on Pro Beta/Max. The UI requires a confirmation
checkbox, and the API requires `confirmCredits: true`. Fixture mode never contacts
OpusClip.

## HTTP API (port `3101` by default, bound to 127.0.0.1)

| Method & path | Purpose |
|---|---|
| `POST /research` `{ videoUrl, creatorGoal?, mode: "live"\|"fixture" }` | Starts research asynchronously → `202 { runId }` |
| `GET /runs/:runId` | `status`, `progress`, `result` (ResearchBrief), `generation`, actionable `error {code,message,action}` |
| `POST /runs/:runId/generate` `{ confirmCredits: true, forceNewProject? }` | The single OpusClip submission (see below) |
| `GET /runs/:runId/review-input` | Validated `ReviewInput` once generation completes (404 before) |
| `POST /runs/:runId/reconcile` | After an ambiguous submit: search recent OpusClip projects for this video |
| `POST /runs/:runId/adopt-project` `{ projectId }` | Adopt a project found during reconciliation |
| `POST /runs/:runId/poll` | Resume polling an existing project (never submits) |
| `GET /runs`, `GET /runs/:runId/debug`, `GET /health`, `GET /opusclip/access?mode=live` | Inspection helpers |

Overall `status`: `researching → research_ready | insufficient_evidence | research_failed`,
then `generating → completed | generation_failed | needs_reconciliation`.

## Research behavior

- **Sampling:** `commentThreads.list` with `order=relevance`, `textFormat=plainText`,
  top-level comments only, ≤100 per video. Sources are the source video plus ≤5 same-channel
  uploads, which the agent picks from the 15 most recent; IDs outside that list are ignored.
  Coverage records the sampling method, the retrieval time, which videos succeeded,
  per-video failures (comments disabled, not found, inaccessible), and the limits that applied.
- **Hygiene before the model:** duplicate IDs and identical text are removed, and so is
  obvious spam (promo links, sub4sub, Telegram/WhatsApp, and similar). Comment text is
  never edited.
- **Agent:** two structured-output turns: one chooses related videos, one groups
  questions. Comments are passed as JSON inside `<untrusted_comments>` with explicit
  instructions to treat them as data. The Codex thread runs read-only, with no network,
  no web search, `approval_policy=never`, an empty temp working directory, and the user's
  MCP servers disabled (`mcp_servers={}`). Any tool use invalidates the turn.
- **Evidence integrity (enforced in code, not trusted to the model):** the agent returns only
  comment IDs. Quotes, URLs (`watch?v=…&lc=commentId`), timestamps and counts are copied
  from the retrieved data. Invented or filtered IDs are dropped and recorded as a
  limitation. A comment supports at most one theme. `observedCommentCount` is the number
  of unique supporting comments, never a percentage. A theme backed by a single comment
  is described as "a single signal, not recurring demand". A theme labeled "explicit"
  whose comments contain no question is relabeled "inferred".
- **Insufficient evidence:** when no comments can be retrieved, or none contain usable
  questions or requests, the brief is `researchStatus: "insufficient_evidence"` with no
  questions and no generation brief. Questions are never fabricated.
- **Errors:** YouTube quota (`YOUTUBE_QUOTA`), a bad or disabled key (`YOUTUBE_AUTH`), a
  missing video, and Codex auth failures each fail the run with an actionable message.
  Comments disabled on one video is recorded and the run continues.

## OpusClip generation

**Transport choice.** MCP is preferred and is the default. I couldn't discover the live
MCP tool schemas: listing tools requires the OpusClip OAuth sign-in, and the endpoint
returns `401` with AuthKit metadata until you sign in. So the adapter checks at runtime,
using `tools/list`, that `opusclip_submit_project` exposes `customPrompt`, and refuses to
submit if it doesn't. The official OpusClip Skill's contract for that tool does list
`customPrompt`, `clipDurationsSec`, `aspectRatio` and `model`. MCP arguments are flat and
are **not** assumed to match REST fields.

**REST mapping** (confirmed against the documented OpenAPI for `POST /api/clip-projects`):

| Brief | REST field |
|---|---|
| `customPrompt` | `curationPref.customPrompt` (ClipAnything only) |
| — | `curationPref.model = "ClipAnything"`, `genre = "Auto"` |
| `durationSec [min,max]` | `curationPref.clipDurations [[min,max]]` (seconds) |
| `aspectRatio` | `renderPref.layoutAspectRatio` |
| video title | `uploadedVideoAttr.title` |

Polling uses `GET /api/clip-projects` (project `stage`: `QUEUED…COMPLETE | STALLED`), which
is the same call OpusClip's skill CLI makes; there is no documented single-project GET.
Clips come from `GET /api/exportable-clips` and the source transcript from `GET /api/transcripts`.

**No duplicate paid jobs.**
1. A per-run lock rejects concurrent clicks.
2. The run is fsync'd as `submitting` *before* the provider call.
3. Repeat calls return the existing job.
4. A definite rejection (4xx) means no job was created, so a retry is allowed.
5. A timeout, network loss, 5xx or missing project ID is *ambiguous*. It becomes
   `needs_reconciliation`, and the service searches recent projects in a bounded window
   around the submission. The exact request has a correlation token in its title. Only
   one unclaimed, time-bounded project with that token is auto-adopted; other same-video
   projects remain manual candidates. A new paid submission requires an explicit
   `forceNewProject: true` and a fresh credit acknowledgement.
6. If the server restarts during `submitting`, the run also becomes `needs_reconciliation`.
7. Runs in `processing` or `collecting` resume polling from the stored project ID.

The project ID, every event, the exact request sent, and every raw provider response are
persisted under `data/runs/<runId>/` (`run.json`, `provider/*.json`).

**Timestamp units.** Everything is normalized to integer ms in source-video time. The
transcript is converted from seconds, as documented. REST `timeRanges` documentation
contradicts itself: it says "in seconds", but its example `[[192170, 211630]]` with
`durationMs: 19478` is milliseconds. So the unit is **verified** against the clip's own
`durationMs`. If exactly one unit fits, it is used, and the basis is recorded in
`limitations`. Otherwise the ranges are reported as unavailable. Set
`OPUSCLIP_TIMERANGE_UNIT=ms|s` only after confirming the unit with real data. MCP values
are trusted only when the unit is in the field name (e.g. `start_ms`).

**Clip transcripts.** Each clip's transcript is built from word timings in the project
transcript that fall inside the clip's source ranges, ordered range by range. If ranges or
the transcript are missing, the clip is marked `transcriptStatus: "unavailable"`. Clip
titles are never used as a substitute. Clips with unknown ranges remain in the handoff
with empty ranges and empty transcripts, and the reviewer reports them as unverifiable.
Zero-length provider transcript intervals are excluded with an explicit limitation.

**Source transcript completeness.** Transcript timing alone cannot establish full
coverage (a tail-only transcript might reach the video's end; gaps might be silence).
Unless the provider explicitly declares completeness, the handoff marks it `partial`
and says completeness is unknown. This includes the synthetic demo transcript.

**MCP access and exports.** `/opusclip/access` reports server reachability, submit-tool
discovery, whoami authentication and entitlement separately. Neither discovery nor an
authenticated read proves a paid submission will succeed. The MCP list-clips adapter
returns preview links where available, but does not call the HD export tool: its live
schema and response have not yet been verified. An absent export URL is not a preview
URL and should not be labelled as an HD download.

## Contract

`src/contract.ts` holds the runtime validators (zod).
`schemas/audience-clips.v1/*.schema.json` are generated JSON Schemas
(`npm run schemas:build`), and `schemas/README.md` lists the cross-field rules.

## Layout

```
src/contract.ts            audience-clips.v1 validators
src/youtube/               adapter interface, live (Data API v3) + fixture
src/research/              prefilter, Codex agent, fixture analyzer, evidence-verified brief, prompt
src/opusclip/              adapter interface, MCP, REST, fixture, unit normalization, ReviewInput assembly
src/runs.ts, src/store.ts  async run state machine + atomic JSON persistence
src/server.ts, public/     HTTP API + minimal UI
fixtures/                  synthetic YouTube/OpusClip data + exports/ for the review builder
scripts/                   check-env, codex-agent smoke, MCP discovery/login, fixture + schema builders
test/                      evidence integrity, timestamp normalization, job resumption + error mapping
```

## Live verification status (2026-10-11)

| Step | Status |
|---|---|
| Codex login (ChatGPT) and SDK structured output | **Tested live** (`npm run check:env -- --codex`) |
| Research agent (Codex) on fixture comments, including a prompt-injection comment | **Tested live** (`npm run smoke:codex-agent`): 3 themes, no invented IDs, injection ignored |
| OpusClip MCP endpoint reachable | **Probed**: `https://mcp.opus.pro/mcp` returns `401` + OAuth metadata |
| OpusClip MCP tool discovery / `customPrompt` check | **Blocked**: needs an interactive OAuth sign-in (`npm run opus:mcp-login`) with an API-enabled plan |
| YouTube comment retrieval (live) | **Blocked**: no `YOUTUBE_API_KEY` here. Adapter tested against recorded API error shapes |
| Live OpusClip project creation, polling, clips, transcript | **Blocked**: no OpusClip OAuth session or `OPUSCLIP_API_KEY` |
| Fixture end to end (HTTP, idempotent generate, kill-and-restart resume) | **Tested** |
