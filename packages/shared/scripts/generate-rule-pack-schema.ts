/**
 * Generate rule-pack-v1.0.json from the Zod schema.
 * Run: npx tsx scripts/generate-rule-pack-schema.ts
 */

import { writeFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { RulePackSchema } from "../src/schema/rule-pack";

const jsonSchema = zodToJsonSchema(RulePackSchema, "RulePack");
const outPath = join(process.cwd(), "src", "schema", "rule-pack-v1.0.json");
writeFileSync(outPath, JSON.stringify(jsonSchema, null, 2));
console.log("Written:", outPath);
