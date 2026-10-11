// Cross-service contract gate for the audience-clips.v1 handoff.
//
// The coordinator accepts a ReviewInput only when BOTH sides accept it: the
// producer's schema (stronger integrity: evidence resolution, playback order,
// status consistency) and the consumer's validator (strict ranges, duplicate
// ids; conservative warnings that downgrade instead of rejecting). The two
// packages keep their own schemas; this gate and the integration contract tests
// keep them in agreement.
import { ReviewInput as ProducerReviewInput, formatIssues } from "../../audience-research/src/contract.ts";
import { canonicalJson, sha256 } from "../../clip-review/src/canonical.ts";
import { validateHandoff, type Issue } from "../../clip-review/src/validate-input.ts";

export type ContractCheck =
  | { ok: true; hash: string; warnings: Issue[] }
  | { ok: false; errors: { side: "producer" | "consumer"; path: string; message: string }[] };

/** Same canonical SHA-256 the review service uses as its input hash. */
export function handoffHash(input: unknown): string {
  return sha256(canonicalJson(input));
}

export function checkHandoff(input: unknown): ContractCheck {
  const errors: { side: "producer" | "consumer"; path: string; message: string }[] = [];
  const producer = ProducerReviewInput.safeParse(input);
  if (!producer.success)
    for (const i of producer.error.issues) errors.push({ side: "producer", path: i.path.join(".") || "(root)", message: i.message });
  const consumer = validateHandoff(input);
  if (!consumer.ok) for (const e of consumer.errors) errors.push({ side: "consumer", path: e.path, message: e.message });
  if (errors.length || !consumer.ok) return { ok: false, errors };
  return { ok: true, hash: handoffHash(input), warnings: consumer.warnings };
}

export function describeContractErrors(errors: { side: string; path: string; message: string }[]): string {
  return errors.map((e) => `${e.side}: ${e.path}: ${e.message}`).join("; ");
}

export { formatIssues };
