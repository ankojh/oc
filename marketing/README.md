# OpusClip — More from every moment

Independent redesign concept: Swiss editorial typography + film contact-sheet framing, with a focused audience-informed clipping workbench.

## Open the page

Node 22+:

```bash
cd /Users/ankojh/Desktop/opusclip-hackathon/marketing
npm ci
npm start
```

Open **http://127.0.0.1:3103**. This works without keys or the integration services. “Explore a sample” loads an explicitly labeled offline synthetic storyboard. No credits are spent.

## Connect the existing integration

With the three integration packages installed, run from `marketing/`:

```bash
npm run start:connected
# Optional: npm run start:connected -- --env-file /absolute/path/to/shared.env
```

This starts the existing root launcher and the marketing server. If the integration is already running, use `npm start` here instead. Ports remain 3100 coordinator, 3101 research, 3102 reviewer, 3103 homepage. `MARKETING_PORT` changes the homepage port; `COORDINATOR_ORIGIN=http://127.0.0.1:3100` changes its loopback-only target. With nondefault integration ports, set both launcher settings and `COORDINATOR_ORIGIN` explicitly.

The homepage probes the actual coordinator and service health. Integrated fixture mode becomes available only when both services are up; Live research is unavailable until the coordinator reports a configured YouTube key. Readiness is **not** a claim of authenticated OpusClip entitlement or a verified live model. Generate remains a separate checkbox-acknowledged action. The homepage never calls OpusClip directly.

## Modes and evidence

- **Offline sample:** frozen copy of the existing research fixture, plus a conservative hand-authored marketing storyboard judgment. Not an agent review.
- **Integrated fixture:** real research → Generate → exported ReviewInput → independent reviewer pipeline, using synthetic data and the bound hand-authored fixture judgment. No live media or paid generation.
- **Live:** uses the integration coordinator's real routes when configured. Not live-verified in this marketing task. Provider errors and recovery remain explicit.

The visitor's URL is retained even when a sample uses `FXdemo00001` instead. Fake fixture URLs are never offered as video previews or HD downloads. Synthetic comments are not associated with the stock creator. Unknown ranges/transcripts and unanswered questions remain visible.

The static server exposes only `public/`, a narrow coordinator route allowlist, and a readiness endpoint. It is loopback-only, refuses cross-origin actions and non-loopback Host headers, and forwards no credentials. It has no force-new-project action. Agents, their prompts, contracts and integration files were not edited by this marketing implementation.

## Files

- `public/index.html`, `styles.css`: six-section responsive homepage and semantic dialog workbench.
- `public/app.js`: marketing interactions + offline workbench.
- `src/adapter.ts`: typed offline boundary and sample-evidence validation.
- `src/coordinator-adapter.ts`, `public/coordinator-ui.js`: actual coordinator routes and joined-evidence workbench.
- `server.mjs`: local static server + narrow same-origin proxy.
- `docs/DESIGN-HANDOFF.md`: rationale, animation and Webflow/Rive mapping.
- `docs/VERIFICATION.md`: working interactions, checks already completed and limitations.
- `docs/sample-provenance.json`: frozen synthetic export provenance.
- `deliverables/`: required PDFs, ZIP and captured screenshots.

## Submission

`deliverables/opusclip-rebrand-submission.zip` contains only `rebrand-thesis.pdf`, `proof-of-concept-page.pdf`, and a short README. It excludes credentials, environment files, authentication caches, dependencies, service data and build intermediates.

## References / rights

- Official homepage and company proof claim: https://www.opus.pro/ — “Used by 20M+ creators and businesses.” This is attributed to OpusClip, not usage of the proposed feature.
- Official horizontal logo: https://media.opus.pro/ and the linked `OC_B_Horizontal.png`. Proportions unchanged; independent concept only.
- Stock still: https://www.pexels.com/photo/podcast-host-in-recording-studio-with-microphone-36917944/ ; original image https://images.pexels.com/photos/36917944/pexels-photo-36917944.jpeg . Used under https://www.pexels.com/license/ ; no endorsement implied. Cropping and caption layouts are illustrative, not generated video or spoken quotations.
- Instrument Sans: Google Fonts, SIL Open Font License 1.1. Self-hosted; license at `public/assets/InstrumentSans-OFL.txt`.
- Official footer destinations verified from the company homepage: pricing, dashboard sign-in, Help, privacy-policy, terms-of-service and team-workspace.

No testimonials, audience comments, performance results, or real generation outcomes were invented.
