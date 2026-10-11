# Verification and limitations

All checks below were completed **before the operator requested that further testing stop**. No further implementation tests are being run; final packaging reuses existing screenshots.

## Working

- Six-section marketing homepage with official logo, verified official destinations and actual page anchors.
- Video entry carries the visitor URL into the same-application workbench; invalid non-YouTube links receive visible error feedback.
- Compact accessible mobile disclosure; native buttons, dialog, visible focus and Escape behavior.
- Three sample question states update exact comments, source passages, time labels, clip explanation and pressed state. Rapid selection cancels previous animation; reduced motion bypasses animation. No automatic audio.
- Offline research → explicitly acknowledged sample Generate → sample review, evidence export and review-load failure/retry.
- Actual coordinator provider: research, Generate, observation, retry review, retry handoff, resume polling, reconcile and adopt existing project. No automatic force-new-project action.
- Real service fixture flow exercised through the redesigned workbench in isolated temporary data directories: research → one synthetic provider submission → immutable handoff → independent fixture reviewer → complete report. Four clips retained; one unverifiable; unanswered folder question visible; partial source coverage disclosed. Refresh retained provider submission count one.
- Fixture media unavailable and fake export URLs are not exposed as downloads. Evidence remains readable without video. Available live media loads only on explicit interaction; closing pauses playback.
- No agent, prompt, contract or integration source edited by the marketing implementation.

## Already completed checks

- Marketing TypeScript check passed.
- Marketing unit/server/adapter tests: **12 passed**.
- Browser checks at **1440, 1024, 768 and 390px**: no horizontal overflow, content loaded; screenshots captured.
- Keyboard menu/dialog, URL carryover, acknowledgment, rapid selection, reduced motion, refresh and sample review retry checked.
- Axe WCAG A/AA automated scan: **zero violations** for homepage, offline research and offline review at 1440 and 390px. Automated scans do not certify full accessibility or replace assistive-technology testing.
- Existing research tests: **53 passed**, type check passed.
- Existing reviewer tests: **67 passed**, type check passed.
- Existing integration tests: **13 passed**, type check passed. These cover cross-service contract, duplicate Generate, coordinator restart, lost review response, unknown fixture and uncertain submission recovery.

Evidence files: `deliverables/browser-verification.json`, `accessibility-verification.json`, `integration-verification.json`. Screenshots are in `deliverables/screenshots/`.

## Limitations / honest states

- **No live YouTube, paid OpusClip generation or live reviewed result was exercised in this marketing task.** Configured keys/service health do not prove access or entitlement. Live is disabled when prerequisites are absent and exposes real failure when a provider refuses work.
- Marketing hero/core/team imagery is a licensed **stock still** composition, not a generated video result. Caption layouts are illustrative, not spoken quotations. The fixture contains no playable media.
- The homepage and offline sample judgment are conservative hand-authored storyboards derived from the synthetic producer fixture. The integrated fixture runs the independent reviewer against its bound synthetic response; it is not a recorded live review.
- Actual rendering/export depends on upstream preview/export availability. This task does not add HD export generation or claim that previews are HD downloads.
- The marketing workbench intentionally links live passages to the source rather than attempting edited-clip seeking. It does not implement video editing, publishing, workspaces or brand administration; those link to the official product.
- Client refresh restores offline sample session state or observes a persisted coordinator ID; it never regenerates clips. Recovery does not force a new paid project. Unexpected coordinator outage pauses observation with an explicit resume control.
- Rive is a documented future optional marker layer, not included. Semantic interaction uses HTML/CSS and Web Animations API.
- PDFs are generated from already captured frames and documented states. No fresh site testing is performed after the stop request.

## Changes owned by this task

All implementation and submission files are under `marketing/`. Other builders' concurrent repository changes are left intact. No commit or push was made.
