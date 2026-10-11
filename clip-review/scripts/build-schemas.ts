// Emits versioned JSON Schemas for the audience-clips.v1 contract from the zod source of truth.
// Note: cross-field rules (end > start, reference integrity, quote/range checks) are enforced at
// runtime by src/validate-input.ts and src/verify-report.ts and cannot be expressed in JSON Schema.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ResearchBrief, ReviewInput, ReviewReport } from "../src/contract.ts";
import { Judgment } from "../src/agent/judgment.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas", "audience-clips.v1");
mkdirSync(dir, { recursive: true });
const emit = (name: string, schema: z.ZodType, title: string) => {
  const json = { $id: `audience-clips.v1/${name}`, title, ...(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as object) };
  writeFileSync(join(dir, name), JSON.stringify(json, null, 2) + "\n");
};
emit("research-brief.schema.json", ResearchBrief, "ResearchBrief");
emit("review-input.schema.json", ReviewInput, "ReviewInput");
emit("review-report.schema.json", ReviewReport, "ReviewReport");
emit("reviewer-judgment.schema.json", Judgment, "Reviewer model output (internal, clip-review-prompt.v1)");
console.log(`wrote schemas to ${dir}`);
