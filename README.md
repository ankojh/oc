# Audience questions → OpusClip → clip review

A local feature app for one public YouTube video at a time. The **research agent** reads sampled comments and identifies evidence-backed questions; the creator deliberately clicks **Generate clips** (OpusClip); the independent **review agent** checks whether generated clips actually answer those questions. The coordinator is ordinary application code, not a third agent. It keeps each service independently usable.

## Start locally (Node 22+)

```sh
npm run setup                  # first time: install the three existing lockfiles
cp .env.example .env           # only if you don't already have .env
# fill .env privately; see Configuration below
npm run check:env              # prints sources/status, never secret values
npm start                      # http://127.0.0.1:3100
```

`npm start -- --env-file /absolute/path/to/.env` uses an explicit alternate file. `INTEGRATION_ENV_FILE=/absolute/path/to/.env npm start` also works. All three servers bind **only to 127.0.0.1**. The page uses same-origin calls to the coordinator; the coordinator calls the other services server-to-server. It does not talk to YouTube, OpusClip or Codex itself.

**Fixture demo without credentials:** choose Fixture, click **Load fixture demo**, then **Research comments**, review the evidence, and click **Generate clips**. The reviewer judgment is a **hand-authored synthetic fixture**, not a live model recording. Fixture preview URLs do not contain playable media. Fixture mode does not call YouTube, Codex or OpusClip or consume credits. An unknown fixture goal/content fails clearly; it never falls back to a paid model.

**Live mode:** put a YouTube Data API v3 key in `YOUTUBE_API_KEY`. The research agent and review agent use `CODEX_API_KEY` if set, or an existing file-based `~/.codex/auth.json` login (`codex login`); a keyring-only login is not automatically copied to the isolated reviewer home. The reviewer model remains configurable via `CLIP_REVIEW_MODEL` and may not be available to every account. For OpusClip select:

- `OPUSCLIP_TRANSPORT=rest` plus `OPUSCLIP_API_KEY` (and optional `OPUSCLIP_ORG_ID`), or
- `OPUSCLIP_TRANSPORT=mcp`, then `npm --prefix audience-research run opus:mcp-login` for browser OAuth.

The **Generate** button requires an explicit credit acknowledgement; it submits one OpusClip project (the API lists a 10-credit minimum). No automatic new paid project is submitted after a timeout, restart, failed review or refresh. If the submission is uncertain, use Reconcile, inspect candidate projects and adopt the right one. Only after checking the OpusClip dashboard can you explicitly request a **new** project, with two separate confirmations. Review retry uses the saved snapshot, not a new OpusClip project. Generation completion is distinct from review completion.

## Configuration

`npm start` reads **one root `.env` file**. Precedence for every setting: **nonempty shell environment > nonempty root env-file entry > service default**. Blank template entries are ignored. The research service alone also falls back to its own `audience-research/.env` for keys that remain unset (its original behavior); the reviewer never loads a `.env` on its own. Each launched service retains its working directory and original data directory unless `DATA_DIR`, `CLIP_REVIEW_DATA_DIR`, or `INTEGRATION_DATA_DIR` is set. Defaults: ports 3100/3101/3102, and each service's local `data/` directory.

`REVIEW_BACKEND=fixture` is the safe direct-review default in the template; the coordinator **explicitly** selects `?backend=fixture` for fixture runs and `?backend=codex` for live runs. `auto` in clip-review is also safe for fixture research (no implicit live fallback). The reviewer child receives only its own configuration and the shared `CODEX_API_KEY`, not YouTube or OpusClip keys. The coordinator child receives no secrets. The populated root `.env`, service `.env` files, local data and node_modules are ignored; **never include them in a submission archive**. A pre-existing stray `audience-research/Untitled` file may contain a raw credential; it is ignored and should be removed or rotated before packaging.

## What the screen shows

- Original comment quotes and links, sampling method/count and limitations, explicit/inferred question labels.
- OpusClip generation stage/project ID and separate review stage, plus actionable errors.
- Up to three recommendations **only when supported**: clip preview if available, cited answer passage, verdict (`direct`, `partial`, `related_only`, `no_match`, `unverifiable`), context warnings and caveats.
- Unanswered questions and what was/was not checked, including clips without verified ranges or transcripts.
- Source transcript coverage and reviewer audit/warnings/metadata under Diagnostics.

Source timestamps are not clip playback timestamps. The UI maps source passages through ordered clip source ranges and accumulates preceding durations; it omits seeking when ranges overlap or are missing, and checks actual preview duration against summed ranges before seeking. Otherwise it links to the original source timestamp. Preview URLs are **not** HD export URLs. The MCP adapter does not request HD exports until its live tool schema has been verified.

## Local APIs and persistence

| Service | Address | API |
|---|---|---|
| Integration | `127.0.0.1:3100` | `POST /api/integrations` `{videoUrl, creatorGoal?, mode}`, `GET /api/integrations/:id`, `POST /api/integrations/:id/generate` `{confirmCredits:true}`, `/reconcile`, `/adopt-project` `{projectId}`, `/resume-polling`, `/force-new-project` `{confirmCredits:true,confirmNewProject:true}`, `/retry-review`, `/retry-handoff` |
| Research | `127.0.0.1:3101` | Original `/research`, `/runs/:runId`, `/runs/:runId/generate`, `/runs/:runId/review-input`, recovery endpoints |
| Review | `127.0.0.1:3102` | Original `/reviews?backend=fixture|codex`, `/reviews/:reviewId` |

Integration records, exact immutable ReviewInput snapshots and review results are saved atomically under `integration/data/integrations/<id>/`. Research and review persist their own records in their own `data/` directories. Refresh is observation only; a coordinator restart resumes in-progress work. Review POSTs are single-flight; a lost response retries the identical snapshot, allowing clip-review's hash/version cache to return the same review ID. The independent producer/consumer validators are checked together before the snapshot is saved.

Fixture responses in `clip-review/fixtures/responses/` bind to the **fingerprint of the exact reviewer packet**, not the run ID. The `fx-*` judgments retain their live-recording provenance. `integration-fxdemo.json` is explicitly **hand-authored synthetic**. After changing fixture input or packet logic, use `npm --prefix clip-review run fixtures:bind -- --check` to detect stale bindings; see `clip-review/README.md` for how to bind a new scenario.

## Verify

```sh
npm run typecheck
npm test
npm --prefix clip-review run fixtures:bind -- --check --bind ../audience-research/fixtures/exports/review-input.fixture.json integration-fxdemo
```

`npm test` runs both original suites plus integration tests, including a real HTTP fixture flow from research through Generate, exported ReviewInput, reviewer and verified report. It also checks refresh/restart, duplicate clicks, lost review responses, review retry, insufficient evidence, unknown fixtures, mixed/missing ranges and transcripts, no clips, source coverage uncertainty, ambiguous generation recovery and provider submission count. Fixture tests do **not** verify provider credentials, API schemas, entitlements or paid generation.

See [VERIFICATION.md](VERIFICATION.md) for current fixture/live/untested results and blockers.
