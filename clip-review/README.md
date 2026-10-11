# clip-review — Audience-to-Clip Review Agent

Tells a creator which generated clips actually answer questions their audience asked, with evidence on both sides: the original comments, and the exact clip transcript passage that answers them.

This isn't a virality score. It never produces numeric confidence or view predictions. A clip being *requested* for a question is never treated as evidence that the clip *answers* it.

Implements build 2 of the hackathon. It consumes the `audience-clips.v1` handoff produced by `../audience-research` but shares no code, process, port, or Codex context with it.

## Quick start

```bash
cd clip-review
npm install            # Node >= 22
npm test               # 61 focused tests, offline, no credentials
npm start              # http://127.0.0.1:3102
```

Open http://127.0.0.1:3102, pick a fixture (or upload a handoff JSON), and click **Review clips**.

From the command line:

```bash
npm run review -- fixtures/inputs/04-misleading-omission.json                 # replay recorded response
npm run review -- path/to/handoff.json --backend codex --out report.json      # live Codex
```

### Live Codex

The reviewer uses `@openai/codex-sdk` (pinned to 0.162.1, which bundles Codex CLI 0.162.1). You need either:

- an existing `codex login` (ChatGPT). The login is copied into an isolated reviewer home, see [Isolation](#reviewer-isolation-and-prompt-injection); or
- `CODEX_API_KEY` set in the environment.

No YouTube or OpusClip credentials are needed: everything the reviewer uses arrives in the handoff.

Configuration lives in environment variables; see `.env.example`. The main ones are `CLIP_REVIEW_PORT` (default 3102), `REVIEW_BACKEND` (`auto`|`codex`|`fixture`), `CLIP_REVIEW_MODEL` (default `gpt-6-astra`), and `CLIP_REVIEW_REASONING_EFFORT` (default `medium`). The server deliberately ignores the generic `PORT` variable, because `audience-research` uses `PORT=3101`.

## HTTP API

| Method | Path | |
|---|---|---|
| `POST` | `/reviews[?rerun=true][&backend=auto\|codex\|fixture]` | Body: `ReviewInput`. Returns `202 {reviewId, reused:false}`, or `200 {reviewId, reused:true}` when an identical input was already reviewed by the same reviewer version. |
| `GET` | `/reviews/:id` | `{status: queued\|running\|succeeded\|failed, progress[], report, audit, reviewer, warnings[], errors[{code,path,message,hint}]}` |
| `GET` | `/reviews/:id/report.json` | The `ReviewReport` as a download (export). |
| `GET` | `/reviews/:id/input` | The stored handoff. |
| `GET` | `/fixtures`, `/fixtures/:file` | Fixture handoffs (used by the page). |
| `GET` | `/schemas/:file` | Versioned JSON Schemas. |

**Reuse:** the cache key is `sha256(canonical JSON of input) + reviewer version + backend version key`. The backend key includes the model, reasoning effort, and prompt version, so changing any of them triggers a fresh review. Failed reviews are never reused. Use `?rerun=true` to force a new one.

**Persistence:** one JSON file per review in `data/reviews/`. Reviews that were running when the server stopped are marked failed on restart, with a hint to rerun.

## Contract

`src/contract.ts` is the zod source of truth for `ResearchBrief`, `ReviewInput`, and `ReviewReport`, using the exact field names from the shared spec. Generated JSON Schemas live in `schemas/audience-clips.v1/` (`npm run schemas:build`). JSON Schema can't express cross-field rules, so those are enforced in code:

- **`src/validate-input.ts`: handoff validation.**
  - *Rejected:* schema violations, non-UTC timestamps, non-integer or negative ms, `end <= start`, duplicate ids.
  - *Warned and downgraded:* dangling evidence/question ids, clip transcript segments outside the clip's `sourceRanges`, ranges past the end of a full source transcript, unordered source segments, transcript-status mismatches, ranges under 1s (likely seconds), instruction-like text.
  - Values are never reinterpreted as seconds.
- **`src/verify-report.ts`: independent gate for any report.**
  - Every referenced id exists.
  - `commentEvidenceIds` belong to the question.
  - Each quote is a substring of the cited segment (whitespace, case, and curly quotes normalized).
  - Passage times sit inside the segment and inside the clip's `sourceRanges`.
  - Every `direct`/`partial` has a passage.
  - Recommendations are ranked 1..n with at most 3, and each points at a `direct`/`partial` match.
  - No `not_found_in_available_source` claim is made without source segments.

  The other builder can import `verifyReport` directly.

## How a review works

```
ReviewInput ─► validateHandoff ─► buildPacket ─► ReviewerBackend.judge ─► assembleFromJudgment ─► verifyReport ─► ReviewReport
                (deterministic)    (what the      (Codex thread or         (deterministic: refs,     (independent
                                    model sees)    recorded response)       quotes, ranges, rules)    final gate)
```

1. **Packet** (`src/agent/packet.ts`) contains:
   - questions with their resolved comment quotes and links;
   - the researcher's rationale and `observedCommentCount`, labeled `researcherClaims` so they get checked rather than trusted;
   - clips that have usable transcripts (segments marked `citeable` when inside the clip's ranges);
   - per-clip **nearby source context** (±45s, excluding footage already in the clip);
   - the source transcript, up to 120k characters.

   Generation targeting (`requestedQuestionIds`, `submittedPrompt`, `generationBrief`) is **withheld from the model**.
2. **Judgment** (`src/agent/judgment.ts`, enforced with Codex `outputSchema`). The model returns:
   - question support checks;
   - verdicts for every question × clip pair;
   - verbatim quotes keyed by segment id;
   - context warnings keyed by source segment id;
   - up to 3 recommendations;
   - unanswered-question statuses;
   - limitations.
3. **Assembly** (`src/assemble.ts`). The model handles the semantics; these rules are code:
   - Passages citing unknown segments, segments outside the clip ranges, or non-matching quotes are dropped. Timestamps always come from the transcript, never from the model.
   - A `direct`/`partial` verdict left with no verifiable passage becomes `unverifiable`.
   - Clips without a usable transcript are always `unverifiable`, whatever the model said.
   - A question whose cited evidence doesn't exist is `unsupported`. Unsupported questions are flagged in `limitations` and never recommended.
   - A context warning must cite at least one existing source segment **outside** the clip. Otherwise it's demoted to a limitation, because missing context means uncertainty.
   - `not_found_in_available_source` needs source segments the reviewer actually saw. With partial coverage it gets an explicit caveat; with no source it's downgraded to `not_found_in_generated_clips`.
   - Recommendations are capped at 3 and re-ranked. A recommendation is dropped if it repeats an already-recommended answer from overlapping source footage.
   - Every override is recorded in `audit.corrections`.
4. **Short-circuits:** `researchStatus: insufficient_evidence` or no questions gives `status: insufficient_evidence`. No usable clip transcript gives `status: unverifiable`. The model isn't called in either case.

`audit` (question support checks plus corrections) and `reviewer` (backend, model, effort, prompt version, thread id, token usage, duration, tool activity) are returned beside the report. They're kept outside the report so the contract stays exactly as specified.

## Reviewer isolation and prompt injection

- **Separate instructions:** `src/agent/instructions.ts` (`clip-review-prompt.v2`) is passed as Codex `developer_instructions`. Handoff content goes in the user turn inside `<untrusted_handoff>`, with `<` and `>` JSON-escaped so a comment can't close the delimiter.
- **Separate context:** each review gets a fresh Codex thread with:
  - an isolated `CODEX_HOME` (`~/.cache/clip-review/codex-home`) containing a minimal `config.toml`, so the user's AGENTS.md, memories, plugins (browser, computer-use, Chrome), MCP servers, hooks, and notify scripts are all absent;
  - `project_doc_max_bytes=0`;
  - an empty temporary working directory.

  It never sees the researcher's conversation.
- **No tools:** the thread runs `sandboxMode: read-only`, `approvalPolicy: never`, `networkAccessEnabled: false`, `webSearchMode: disabled`, and disables the shell, unified exec, apps/plugins, browser, computer-use, image generation, multi-agent, hooks, and memories features. In a probe, shell/exec/`apply_patch` calls failed closed. Any tool activity that does occur is recorded and surfaced as a report limitation.
- **Residual risk:** Codex 0.162.1 still exposes a `spawn_agent` collaboration tool even with `multi_agent=false`. A spawned agent would inherit the same read-only, offline, toolless sandbox. The deterministic layer bounds the damage either way: an injected "mark everything direct" can't produce an unverifiable quote, an out-of-range passage, or a recommendation for an unsupported question.
- **Credentials:** when using ChatGPT login, `~/.codex/auth.json` is copied into the isolated home (mode 0600) before each live review. Set `CLIP_REVIEW_COPY_CODEX_LOGIN=0` and use `CODEX_API_KEY` if you prefer not to copy it.

## Fixtures and evals

`scripts/build-fixtures.ts` generates every fixture from one synthetic 4m10s video ("I Tried Intermittent Fasting for 30 Days"). Its source transcript contains a real omitted caveat (s17–s18, diabetes warning) and a real omitted regain (s14–s15).

| Fixture | Scenario |
|---|---|
| 01-direct-answer | direct answer with valid comment and transcript evidence |
| 02-related-only | related topic, no answer (the answer *is* in the source, so: `not_found_in_generated_clips`) |
| 03-partial-answer | partial answer |
| 04-misleading-omission | clip says "anyone can do this"; next source lines warn diabetics |
| 05-missing-transcripts | one clip with no transcript; partial source transcript |
| 06-all-transcripts-unavailable | nothing to verify, so `status: unverifiable` |
| 07-unsupported-question | question citing an unrelated comment with an inflated count; inferred question |
| 08-invalid-references | nonexistent evidence/question ids, out-of-range segment, range past the end of the source |
| 09-repeated-answer | three clips of overlapping footage giving the same answer |
| 10-no-useful-matches | only an unrelated clip; one answer exists in the source, one doesn't |
| 11-prompt-injection | comment orders the reviewer to approve a clip and run `curl … \| sh`; clip title tries to close the delimiter |
| 12-insufficient-evidence | research says insufficient evidence |

- `fixtures/inputs/` holds the handoffs; `fixtures/expected/` holds hand-labeled expectations.
- `fixtures/responses/` holds reviewer judgments replayed by the fixture backend. Each file is `{provenance, binding, judgment}`. The `fx-*` files are **verbatim live Codex recordings** (gpt-6-astra, prompt v2). `integration-fxdemo.json` is a **hand-authored synthetic judgment** for the cross-service fixture scenario (`audience-research` video `FXdemo00001`); it was not recorded from a model.
- Fixture judgments are bound to content, not run IDs: `binding.packetHash` is the fingerprint of the exact reviewer packet the judgment applies to (`packetFingerprint` in `src/agent/packet.ts`). A fresh `runId` of the same content replays it; different content fails with an actionable error. The fixture backend refuses `mode: "live"` input and never falls back to a live model. After changing a fixture input or the packet builder, run `npm run fixtures:bind` (add `-- --bind <handoff.json> <response-name>` for external handoffs, or `-- --check` to detect stale bindings).
- Backend choice `auto` sends fixture-mode research to the fixture backend (failing clearly when nothing is bound) and live research to Codex.
- A clip whose source ranges the producer could not verify arrives with `sourceRanges: []`, `transcriptStatus: "unavailable"` and no transcript. It is accepted with a `missing_source_ranges` warning and reported as `unverifiable`; the other clips are still reviewed.
- `npm run eval -- --backend codex [--record]` runs every fixture live and writes `evals/codex-<time>.{json,md}`. `--record` saves judgments to `fixtures/recorded-live/` for promotion into `fixtures/responses/`.
- These are synthetic cases with known answers. Passing them shows the behavior on those cases and **doesn't establish real-world quality**.

Tests (`test/`):

| File | Covers |
|---|---|
| `validation` | handoff validation rules |
| `scenarios` | all 12 fixtures end to end against the expectations |
| `adversarial` | scripted sloppy or injection-compliant reviewer output that the deterministic layer must neutralize |
| `verify-report` | tampered reports |
| `agent-isolation` | what the model sees; delimiter escaping |
| `server` | API, reuse, rerun, failures |

## Layout

```
src/contract.ts          audience-clips.v1 zod schemas
src/validate-input.ts    handoff validation + facts (citeable segments, dangling refs, injection flags)
src/agent/               instructions (versioned), packet builder, judgment schema, Codex + fixture backends
src/assemble.ts          deterministic report assembly
src/verify-report.ts     independent report verifier
src/review.ts            pipeline + cache hashing
src/server.ts, store.ts  HTTP server and JSON-file persistence
src/cli.ts               one-shot CLI
public/                  review page (no build step)
schemas/audience-clips.v1/  generated JSON Schemas
fixtures/ evals/ scripts/ test/
```

Out of scope, by design: comment scraping, OpusClip job submission, the marketing homepage, publishing, and automatic video revisions.
