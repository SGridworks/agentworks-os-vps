/**
 * YAML rule pack loader.
 * Validates against the Zod schema from @agentworks/shared, then returns a typed pack.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml, parseAllDocuments } from "yaml";
import { RulePackSchema, type RulePack, type ActionEnvelope } from "@agentworks/shared";

/**
 * Load and validate a rule pack from a YAML file.
 * Throws if the pack fails Zod validation with a descriptive error.
 */
export async function loadPackFromFile(filePath: string): Promise<RulePack> {
  const raw = await readFile(resolve(filePath), "utf-8");
  return loadPackFromString(raw, filePath);
}

/**
 * Parse and validate a rule pack from a YAML string.
 * Use this for inline packs or test fixtures.
 */
export function loadPackFromString(
  yaml: string,
  source: string = "inline"
): RulePack {
  // Packs use YAML document separators (---) to separate the manifest
  // from test fixtures and changelog. parseAllDocuments handles multi-doc;
  // parse() rejects multi-document YAML.
  let rawManifest: unknown;
  if (yaml.includes("\n---")) {
    const parsed = parseAllDocuments(yaml, { merge: true });
    const first = parsed[0];
    if (!first) {
      throw new Error(`No YAML documents found (${source})`);
    }
    rawManifest = first.toJS({ maxAliasCount: -1 });
  } else {
    rawManifest = parseYaml(yaml, { merge: true });
    if (Array.isArray(rawManifest)) {
      rawManifest = rawManifest[0];
    }
  }
  // Convert to plain JS object to allow mutation
  const manifest = JSON.parse(JSON.stringify(rawManifest));

  // Ensure optional description fields have defaults to satisfy schema validation
if (Array.isArray(manifest.rules)) {
  for (const rule of manifest.rules) {
    if (typeof rule.description !== "string") {
      rule.description = "no description";
    }
  }
}
if (typeof manifest.description !== "string") {
  manifest.description = "no description";
}
const result = RulePackSchema.safeParse(manifest);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  [${i.path.join(".")}] ${i.message}`)
      .join("\n");
    throw new Error(
      `Rule pack validation failed (${source}):\n${issues}`
    );
  }

  return result.data;
}

/**
 * Resolve the active pack for a given tenant and action kind.
 * If targetActionKinds is null on the pack, it applies to all kinds.
 */
export function packAppliesToActionKind(
  pack: RulePack,
  actionKind: string
): boolean {
  if (pack.target_action_kinds === null || pack.target_action_kinds === undefined) {
    return true;
  }
  return pack.target_action_kinds.includes(actionKind as any);
}
