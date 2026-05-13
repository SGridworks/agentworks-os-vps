/**
 * RFC 005 — Rule Pack YAML Schema v1.0
 * Versioned JSON Schema for AgentWorks compliance rule packs.
 *
 * Schema URI: https://agentworks.os/schema/rule-pack/v1.0
 * JSON Schema version: draft-07 (JSON Schema IETF RFC draft-07)
 *
 * Governs:
 * - Pack-level identity, tier, and credentialing
 * - Per-rule conditions, required-data declarations, and dispositions
 * - Test fixtures for dry-run validation
 * - Changelog entries
 *
 * AWCP reference: Section 4 (Rule Pack Manifest Format) of AWCP v0.1 spec.
 * Aligned with: action.ts (RFC 001), policy-decision.ts (RFC 002).
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// ============================================================
// Enums
// ============================================================

export const RulePackTierSchema = z.enum(["free", "paid", "attorney-reviewed"]);
export type RulePackTier = z.infer<typeof RulePackTierSchema>;

export const DataProviderSchema = z.enum([
  "substrate",
  "customer_integration",
  "external_api",
]);
export type DataProvider = z.infer<typeof DataProviderSchema>;

export const DispositionSchema = z.enum(["allow", "block", "route_to_review"]);
export type Disposition = z.infer<typeof DispositionSchema>;

export const ActionKindSchema = z.string().regex(
  /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/,
  {
    message:
      "actionKind must be lowercase dot-separated (e.g. outbound.sms, crm.write)",
  }
);
export type ActionKind = z.infer<typeof ActionKindSchema>;

// ============================================================
// Sub-schemas
// ============================================================

/**
 * A semantic version string (MAJOR.MINOR.PATCH).
 * Pre-release variants (e.g. "0.1.0-draft") are allowed in v0.x.
 * After v1.0 stable, only standard semver is allowed.
 */
export const SemVerSchema = z.string().regex(
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+((?:[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)))?$/,
  { message: "Must be a valid semver string" }
);
export type SemVer = z.infer<typeof SemVerSchema>;

/**
 * ISO 8601 date string (YYYY-MM-DD).
 * Used in changelog entries.
 */
export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
  message: "Must be an ISO 8601 date (YYYY-MM-DD)",
});
export type IsoDate = z.infer<typeof IsoDateSchema>;

/**
 * AWCP schema version this pack targets.
 * Format: "awcp/vMAJOR.MINOR"
 */
export const AwcpSchemaVersionSchema = z.string().regex(/^awcp\/v\d+\.\d+$/, {
  message: "Must be 'awcp/v' followed by major.minor (e.g. awcp/v1.0)",
});
export type AwcpSchemaVersion = z.infer<typeof AwcpSchemaVersionSchema>;

/** Declaration of a single data field that a rule may require. */
export const RequiredDataDeclarationSchema = z.object({
  field: z.string().min(1),
  description: z.string().min(1),
  data_provider: DataProviderSchema,
});
export type RequiredDataDeclaration = z.infer<
  typeof RequiredDataDeclarationSchema
>;

/** Changelog entry for a pack version bump. */
export const ChangelogEntrySchema = z.object({
  version: SemVerSchema,
  date: IsoDateSchema,
  changes: z.string().min(1),
});
export type ChangelogEntry = z.infer<typeof ChangelogEntrySchema>;

// ============================================================
// Condition system
// ============================================================

/**
 * A single condition clause: when <predicate> then <outcome>.
 *
 * The "when" block is a record of field → value comparisons.
 * Supported operators are inferred from value type:
 *   boolean        → equality check (field === value)
 *   string         → equality check (field === value)
 *   string[]       → membership check (field IN values)
 *   null           → null-check (field === null)
 *   object {gte,lt}→ range check (gte ≤ field < lt) for time-of-day strings
 *
 * All conditions within a clause are ANDed together.
 * A rule may have multiple condition clauses; they are ORed.
 * First matching clause determines the outcome.
 */
export const ConditionClauseSchema = z.object({
  when: z.record(z.unknown()),
  then: z.object({
    decision: DispositionSchema,
    reason: z.string().min(1),
    citation: z.string().nullable().optional(),
  }),
});
export type ConditionClause = z.infer<typeof ConditionClauseSchema>;

// ============================================================
// Rule
// ============================================================

/**
 * A single compliance rule.
 *
 * evaluation_order: rules are sorted ascending by this field.
 *   Priority 1 runs before priority 10.
 *   First rule to return block or route_to_review stops evaluation.
 *   Earlier allow decisions do NOT short-circuit later rules.
 *
 * required_data: list of top-level action fields this rule needs.
 *   If any declared field is null/missing in the action record,
 *   disposition_when_missing applies.
 *
 * conditions: ordered list of when/then clauses.
 *   All predicates in a clause are ANDed.
 *   Clauses are evaluated in order; first match wins.
 */
export const RuleSchema = z.object({
  rule_id: z.string().min(1).max(64),
  name: z.string().min(1).max(256),
  description: z.string().min(1),

  /**
   * List of action record fields this rule requires.
   * Empty array means no required fields — conditions are evaluated directly.
   */
  required_data: z.array(z.string()).default([]),

  /**
   * What to do when any required_data field is null or absent.
   * Default: route_to_review (most conservative).
   */
  disposition_when_missing: DispositionSchema.default("route_to_review"),

  /**
   * Evaluation priority. Lower = earlier.
   * Default: 100 (runs after all explicit-priority rules).
   */
  priority: z.number().int().min(1).max(1000).default(100),

  /**
   * Ordered condition clauses. First matching clause wins.
   * All predicates inside a single clause are ANDed.
   */
  conditions: z.array(ConditionClauseSchema).min(1),
});
export type Rule = z.infer<typeof RuleSchema>;

// ============================================================
// Test fixtures
// ============================================================

/**
 * A dry-run test case embedded in a rule pack.
 * Run with: agentworks pack dry-run <pack-file> --fixture=<name>
 */
export const TestFixtureSchema = z.object({
  name: z.string().min(1),
  /** Flat action record fields to inject. */
  input: z.record(z.unknown()),
  expected: z.object({
    decision: DispositionSchema,
    /** rule_id that triggered the decision, or null if no rule matched. */
    rule_id: z.string().nullish(),
  }),
});
export type TestFixture = z.infer<typeof TestFixtureSchema>;

// ============================================================
// Pack (top-level)
// ============================================================

/**
 * Root schema for a rule pack YAML document.
 *
 * Pack identity fields (pack_id, pack_version, schema_version) are
 * required and immutable after v1.0 stable — they form the canonical
 * identity key for versioning, caching, and audit.
 *
 * Tier and attorney_reviewed fields gate commercial features.
 * attorney_reviewed: true requires:
 *   1. attorney_name is non-null
 *   2. attorney_engagement_letter_on_file: true
 *   These invariants are enforced by the loader, not the schema.
 */
export const RulePackSchema = z.object({
  // --- Identity (required) ---
  pack_id: z.string().min(1).max(128),
  pack_version: SemVerSchema,
  schema_version: AwcpSchemaVersionSchema,

  // --- Identity (recommended) ---
  pack_name: z.string().min(1).max(256).optional(),
  pack_description: z.string().optional(),

  // --- Credentialing ---
  tier: RulePackTierSchema.default("free"),
  credentialed_by: z.string().optional(),

  /**
   * Whether a licensed attorney has reviewed this pack's rules.
   * Tier attorney-reviewed requires this to be true AND:
   *   - attorney_name must be set
   *   - attorney_engagement_letter_on_file must be true
   */
  attorney_reviewed: z.boolean().default(false),
  attorney_name: z.string().nullish(),
  attorney_engagement_letter_on_file: z.boolean().default(false),

  // --- Scope ---
  /**
   * Target jurisdictions (US state codes, "US-Federal", ISO 3166-1 alpha-2).
   * null means "all jurisdictions" (use with caution).
   */
  jurisdiction: z.array(z.string()).nullish(),
  industry: z.array(z.string().nullable()).nullish(),
  target_action_kinds: z.array(ActionKindSchema).nullish(),

  // --- Data requirements ---
  /**
   * Global default for what to do when a rule requires data that is absent.
   * Per-rule disposition_when_missing overrides this.
   */
  missing_data_disposition: DispositionSchema.default("route_to_review"),

  /**
   * Declares all data fields this pack may reference, across all rules.
   * Used by the UI to show operators which integrations they need to configure.
   */
  required_data_declarations: z
    .array(RequiredDataDeclarationSchema)
    .nullish(),

  // --- Rules ---
  rules: z.array(RuleSchema).min(1),

  // --- Test fixtures ---
  test_fixtures: z.array(TestFixtureSchema).nullish(),

  // --- Changelog ---
  changelog: z.array(ChangelogEntrySchema).nullish(),
});
export type RulePack = z.infer<typeof RulePackSchema>;

// ============================================================
// JSON Schema export (for validators, code generators, UI)
// ============================================================

/**
 * IETF JSON Schema draft-07 representation of the rule pack schema.
 * Use this for:
 * - Validating pack YAML/JSON before loading
 * - Generating TypeScript types from json-schema-to-typescript
 * - Driving the pack authoring UI form schema
 * - Generating sample packs via json-schema-faker
 *
 * Schema URI: https://agentworks.os/schema/rule-pack/v1.0
 *
 * Note: We use a no-defaults variant for schema export because zod-to-json-schema
 * has a known type-instantiation issue with ZodDefault on complex schemas.
 * The main RulePackSchema is used for parsing/validation (where defaults apply).
 *
 * Generated by: scripts/generate-rule-pack-schema.ts
 * Do not edit by hand — edit rule-pack.ts and regenerate.
 */
const RulePackSchemaNoDefaults = z.object({
  pack_id: z.string().min(1).max(128),
  pack_version: SemVerSchema,
  schema_version: AwcpSchemaVersionSchema,
  pack_name: z.string().min(1).max(256).optional(),
  pack_description: z.string().optional(),
  tier: RulePackTierSchema.default("free"),
  credentialed_by: z.string().optional(),
  attorney_reviewed: z.boolean().default(false),
  attorney_name: z.string().nullish(),
  attorney_engagement_letter_on_file: z.boolean().default(false),
  jurisdiction: z.array(z.string()).nullish(),
  industry: z.array(z.string().nullable()).nullish(),
  target_action_kinds: z.array(ActionKindSchema).nullish(),
  missing_data_disposition: DispositionSchema.default("route_to_review"),
  required_data_declarations: z
    .array(RequiredDataDeclarationSchema)
    .nullish(),
  rules: z.array(RuleSchema).min(1),
  test_fixtures: z.array(TestFixtureSchema).nullish(),
  changelog: z.array(ChangelogEntrySchema).nullish(),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const rulePackJsonSchema = zodToJsonSchema(
  RulePackSchemaNoDefaults as any,
  "RulePack"
) as any;
