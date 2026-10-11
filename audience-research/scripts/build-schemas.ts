// Emits versioned JSON Schemas for audience-clips.v1 from the runtime zod schemas.
// Cross-field rules (evidence IDs resolve, playback order, status consistency)
// are enforced at runtime by src/contract.ts and documented in schemas/README.md.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ROOT_DIR } from "../src/config.js";
import { ResearchBrief, ReviewInput, SCHEMA_VERSION } from "../src/contract.js";

const dir = path.join(ROOT_DIR, "schemas", SCHEMA_VERSION);
mkdirSync(dir, { recursive: true });
for (const [name, schema] of [["ResearchBrief", ResearchBrief], ["ReviewInput", ReviewInput]] as const) {
  const json = { $id: `https://local.invalid/schemas/${SCHEMA_VERSION}/${name}.schema.json`, title: `${name} (${SCHEMA_VERSION})`, ...z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }) };
  writeFileSync(path.join(dir, `${name}.schema.json`), `${JSON.stringify(json, null, 2)}\n`);
  console.log(`wrote schemas/${SCHEMA_VERSION}/${name}.schema.json`);
}
