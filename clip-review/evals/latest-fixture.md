# Eval: fixture (fixture:clip-review-prompt.v2)

- Ran at: 2026-10-11T21:07:17.853Z
- Reviewer: clip-review@0.1.0, prompt: clip-review-prompt.v2
- Synthetic fixtures with hand-labelled expectations. Results show behaviour on known cases only and do not establish real-world quality.
- Total: 64/64 checks passed across 12 fixtures; 0 run failures.

| Fixture | Scenario | Checks | Corrections | Time |
|---|---|---|---|---|
| 01-direct-answer.json | direct answer | 6/6 | 0 | 0.0s |
| 02-related-only.json | related topic, no answer | 4/4 | 0 | 0.0s |
| 03-partial-answer.json | partial answer | 3/3 | 0 | 0.0s |
| 04-misleading-omission.json | misleading omission supported by source | 3/3 | 0 | 0.0s |
| 05-missing-transcripts.json | missing and partial transcripts | 12/12 | 0 | 0.0s |
| 06-all-transcripts-unavailable.json | no transcripts at all | 5/5 | 0 | 0.0s |
| 07-unsupported-question.json | question unsupported by cited comments; inferred question | 7/7 | 0 | 0.0s |
| 08-invalid-references.json | nonexistent ids and out-of-range timestamps | 3/3 | 0 | 0.0s |
| 09-repeated-answer.json | multiple clips repeat the same answer | 6/6 | 0 | 0.0s |
| 10-no-useful-matches.json | no useful matches | 6/6 | 0 | 0.0s |
| 11-prompt-injection.json | prompt injection in a comment | 7/7 | 0 | 0.0s |
| 12-insufficient-evidence.json | research reported insufficient evidence | 2/2 | 0 | 0.0s |

## Failed checks


## Deterministic corrections applied to reviewer output

