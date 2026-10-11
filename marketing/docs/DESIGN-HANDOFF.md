# Design rationale and production handoff

## Thesis: more from every moment

The current OpusClip homepage emphasizes speed, virality, a dense feature menu, creator proof and growth. This independent redesign keeps the core long-video → short-clips promise and link-entry habit, but changes the expression to calm editorial clarity. Instrument Sans, generous alignment, warm-white space, charcoal stages and fine rules supply structure; footage crops and source/portrait proportions explain the product before interaction.

The emphasis is approximately 70% core OpusClip and 30% audience-informed addition: hero, three-step sequence, creator/team relevance and closing action remain core. Only the distinct concept-preview stage introduces the new feature. It is not a separate research brand, virality predictor or fabricated customer story.

The contact-sheet vocabulary makes selection understandable: source, cuts, caption style, question, cited passage and reviewed clip. Violet is reserved for action, selected evidence and a small amount of type, not decorative gradients. No glass, decorative display font or repeated floating-feature-card grid.

## Tokens / layout

- Paper #F7F6F2; ink #191A1D; muted #62636A; action #6046E8; rule #DEDCD6; media stage #202126.
- Headings/interface: self-hosted Instrument Sans, 400–700. Sparse system monospace for indices and source timecodes.
- Maximum 1200px container; desktop twelve-column grid, 24px gap; mobile 20px gutters and semantic single-column order.
- Sections approximately 112px apart desktop, 72px mobile. Buttons 8px radius, panels 12px. Minimum 44px controls; no decorative shadows.
- Landscape 16:9 source; portrait 9:16 crops. Reserved dimensions; stock stills load before any video. Fixture preview is typographic and honestly unavailable as media.

## Signature interaction / Webflow–Rive specification

**State:** selected question ID; supporting comment IDs and count; source passage and integer-ms range; matching clip ID and verdict or no-match; timeline position; transition generation. The current interaction is semantic HTML plus Web Animations API, not canvas evidence.

**Trigger:** click, tap, Enter or Space on one of three native question buttons. Each button exposes `aria-pressed`; the list is an accessible group, not a custom tab implementation.

| Time | Effect | Semantic content |
|---|---|---|
| 0ms | Update selected button and `aria-pressed` immediately | Replace comment, source passage, time, clip title, explanation and relationship text with the latest fixture selection |
| 0–180ms | Brief transcript highlight resolves to selected evidence background | Passage remains readable and visible |
| 180–460ms | Marker moves to passage start on the source timeline, 280ms ease-out | Time labels identify **source** time, not clip playback time |
| 420–600ms | Clip poster fades from 25% to 100% opacity, 180ms | Text preview is the selected synthetic passage or explicit no-match |
| 600ms | Rest state | Question, evidence and clip remain visible together |

Each selection cancels all prior animation objects before starting the latest sequence. There is no interaction lock or audio autoplay. Content is replaced immediately, so no stale evidence waits for animation completion. A live relationship status supplies the nonvisual explanation without repeated progress announcements.

**Reduced motion:** all animations are canceled; content and marker position update immediately. No moving marker, delayed fade or scroll animation. The explanation is identical. Fixture video is unavailable and labeled; future available media loads only after an explicit Load preview control, and playback requires the player's controls. Closing the workbench pauses all video elements.

**Three fixture states:** microphone setup is a partial answer (model not named); color grade is partial (saturation passage omitted from cut); folder organization is in the available source but not in a generated clip. Full-source absence is never inferred from the partial transcript. All text, counts and ranges derive from the captured producer fixture. Homepage and offline judgments are explicitly hand-authored storyboard judgments, not recorded agent output.

**Rive boundary:** Rive may eventually render the decorative timeline marker. Its input would be selected question ID / normalized source position / reduced-motion flag. The native question buttons, quotes, source links, status text and media controls remain outside Rive. Disable pointer events and screen-reader duplication on the decorative asset. Do not make evidence available only through animation.

## Webflow mapping

| Section | Webflow structure | Reusable element |
|---|---|---|
| Navigation | 1200px Container, horizontal flex; mobile disclosure | Official logo, primary button, anchor link |
| Hero | Twelve-column Grid, 6/6 desktop; stacked mobile | Video-entry form, source frame, portrait cut |
| Core workflow | Three-column editorial Grid, fine borders; stacked numbered rows mobile | Step index + heading + copy; one visual strip |
| Audience concept | Warm container enclosing charcoal stage; 7/5 evidence/preview grid, stacked mobile | Question button, evidence quote, passage, timeline, text poster |
| Creators / teams | Two-column editorial block with one style-detail figure | Benefit copy and official product link |
| Closing / footer | Rule-separated container and compact flex links | Shared CTA and official logo |
| Workbench | Embedded application module / accessible native dialog | Shared tokens, input, Generate acknowledgment, evidence results, state/recovery controls |

Use native Webflow sections and anchors for static marketing content. Keep the stateful workbench and question–clip interaction as small embedded JS modules with semantic HTML. Styling should consume the shared custom properties. Do not migrate agent code or prompts into Webflow/Rive.

## Integration boundary

The marketing server on 3103 proxies **actual** coordinator routes on 3100 with a loopback target and a narrow allowlist. `POST /api/integrations` starts research; `POST /api/integrations/:id/generate` is deliberate and sends only `{confirmCredits:true}`. GET observes a persisted ID; retry-review/retry-handoff/resume-polling/reconcile/adopt-project retain existing ownership. No force-new-project endpoint is exposed by the marketing adapter.

The coordinator owns immutable snapshots, paid submission single-flight and review dispatch. The homepage never becomes a third LLM agent and never sends a paid job directly. Live readiness is not provider entitlement verification. Source passages link to the original source when live; no unsafe clip seeking is attempted by this marketing workbench.

## Attribution

“Used by 20M+ creators and businesses” was observed on https://www.opus.pro/ and refers only to the official product. The media kit currently has older 16M copy; the requested homepage claim is used, not extrapolated. Logo from https://media.opus.pro/. Stock still under Pexels license (source recorded in README); illustrative labels avoid attributing synthetic comments or spoken text to that person. Instrument Sans is self-hosted under SIL OFL.
