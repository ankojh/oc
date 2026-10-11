# Build the two final OpusClip submission PDFs

Use the two adjacent content drafts as the starting copy:

- `rebrand-thesis-content.md`
- `proof-of-concept-page-content.md`

The application is being built in `/Users/ankojh/Desktop/opusclip-hackathon`. Inspect the final homepage, workbench, and existing integration before producing screenshots. This task is document production and verification; avoid changing product behavior to make a screenshot look successful.

## Required output

Produce exactly named required files:

1. `rebrand-thesis.pdf` — two pages maximum.
2. `proof-of-concept-page.pdf` — approximately seven pages, with readable high-fidelity frames and the annotated interaction.

Also retain the original screenshot PNGs and a short verification note. Package the required PDFs into `opusclip-rebrand-submission.zip`. Optional README and screenshot assets may be included if useful. Do not include credentials, data caches, dependencies, or private raw comments.

## Editorial rules

The drafts are intended to be usable copy. Page labels and screenshot markers guide production; remove all editorial notes and unresolved placeholders before export.

Reconcile statements against the actual implementation. If the headline, typography, palette, interaction timing, or screen states changed, update the copy and annotations. The page itself is the evidence; do not describe an earlier design as delivered.

The thesis explains the direction, why it fits the company, and how it contrasts with the current homepage. The proof-of-concept document demonstrates the page and how it can be built. Preserve that division and avoid duplicating the entire thesis in the second PDF.

Do not invent a submitter name, deployment URL, results metric, customer endorsement, or live integration success. Ask only for genuinely missing submission identity fields; otherwise omit them. The 20M+ company claim must remain attributed to OpusClip and not to the proposed feature.

## Screenshot capture plan

Capture real browser output at desktop width 1440px and mobile width 390px. Also inspect behavior at 1024px and 768px; additional PDF frames are optional. Capture at sufficient pixel density for readable export and preserve aspect ratios.

Required captures:

- Current homepage hero, for a compact before/after comparison.
- Redesigned complete desktop homepage.
- Desktop hero detail.
- Audience-informed section with one coherent evidence-to-clip example.
- Research-ready workbench state.
- Completed review or an accurately labeled designed state if integration is incomplete.
- Mobile hero and mobile audience-informed section.
- Three frames of the signature interaction from an identical viewport/crop.
- Actual design-system specimen or clean crops of implemented components.

A complete homepage overview may be small, but the PDF must also show readable detail. Never use one tiny full-page screenshot as the sole proof of design quality.

Choose a single fixture or live run for related evidence screenshots. Question, supporting comment, source passage, clip, and timestamps must agree. Synthetic fixtures require a visible sample label. Do not put fixture quotations beside an identifiable real creator as though they wrote them.

Do not spend OpusClip credits just to collect screenshots without the existing Generate acknowledgment. If only fixture mode is verified, use it honestly. Capture no keys, authentication prompts, local secrets, account emails, or debug payloads.

## Document design

Use the homepage's actual typography, warm background, restrained violet accent, and precise alignment. Prefer an A4 portrait thesis and a landscape proof-of-concept deck, unless the final frames clearly justify another format.

The thesis should feel like a concise editorial argument, with generous margins and a small comparison strip. The proof document should give screenshots most of the space: roughly two-thirds to three-quarters of each visual page. Keep annotations short, numbered, and close to their targets.

Use real selectable text, embedded fonts where supported, clear captions, page numbers, and clickable source links. Avoid decorative mock browser chrome that consumes space or implies unavailable functionality.

Use the available PDF/document skills and tools for generation. Render both PDFs into images and visually inspect every page. Repair overflow, clipped text, blurry screenshots, stretched imagery, tiny annotations, inconsistent spacing, and poor contrast. Validate the final PDF page counts and ZIP contents.

## Acceptance checklist

- Thesis is one or two pages and covers look, feel, principle, company fit, and current-state contrast.
- Proof document contains the whole homepage, readable desktop details, mobile frames, and at least one clearly specified interactive moment.
- Animation trigger, state change, timing, interruption behavior, and reduced-motion behavior are explicit.
- Webflow/application/Rive responsibilities are described without implying undelivered native files exist.
- Live, fixture, and proposed states are accurately distinguished.
- No screenshot placeholders, editorial notes, broken links, or fabricated outcomes remain.
- Both PDFs have been rendered and inspected, not merely generated.
- ZIP contains the correctly named required PDFs and no secrets.

The contents are ready before screenshots; final factual alignment and visual verification happen after the marketing build is available.
