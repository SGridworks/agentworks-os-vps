/**
 * AWCP — Rule Pack Manifest Format
 *
 * Re-exports the rule pack schema from @agentworks/shared/schema
 * and adds AWCP-specific constants, tier helpers, and rule evaluation helpers.
 *
 * Spec: AWCP v0.1 Section 4
 */

export {
  RulePackTierSchema,
  type RulePackTier,
  DataProviderSchema,
  type DataProvider,
  DispositionSchema,
  type Disposition,
  ActionKindSchema,
  type ActionKind,
  SemVerSchema,
  type SemVer,
  IsoDateSchema,
  type IsoDate,
  AwcpSchemaVersionSchema,
  type AwcpSchemaVersion,
  RequiredDataDeclarationSchema,
  type RequiredDataDeclaration,
  ChangelogEntrySchema,
  type ChangelogEntry,
  ConditionClauseSchema,
  type ConditionClause,
  RuleSchema,
  type Rule,
  TestFixtureSchema,
  type TestFixture,
  RulePackSchema,
  type RulePack,
  rulePackJsonSchema,
} from "@agentworks/shared/schema";
// ============================================================
// AWCP spec version
// ============================================================

/** Current AWCP spec version. */
export const AWCP_SPEC_VERSION = "awcp/v0.1" as const;

/** Package version mirrors the AWCP spec version. */
export const AWCP_VERSION = "0.1.0";

// ============================================================
// Tier helpers
// ============================================================

export const TIER_LABELS = {
  free: "Free — Generic SMB starter pack. Not tailored to any industry or regulation.",
  paid: "Paid — Industry-specific pack built by SGridworks or partners.",
  "attorney-reviewed":
    "Attorney-Reviewed — Industry-specific pack reviewed and signed off by a named attorney.",
} as const;

export const TIER_CREDENTIALS = {
  free: "SGridworks",
  paid: "SGridworks",
  "attorney-reviewed": "Named attorney + SGridworks",
} as const;

/**
 * Returns true if the pack is at the attorney-reviewed tier.
 * Requires attorney_name AND attorney_engagement_letter_on_file.
 */
export function isAttorneyReviewed(pack: {
  attorney_reviewed?: boolean;
  attorney_name?: string | null;
  attorney_engagement_letter_on_file?: boolean;
}): boolean {
  return (
    pack.attorney_reviewed === true &&
    pack.attorney_name != null &&
    pack.attorney_engagement_letter_on_file === true
  );
}

// ============================================================
// Data provider labels (for UI display)
// ============================================================

export const DATA_PROVIDER_LABELS = {
  substrate: "Provided by the AgentWorks substrate",
  customer_integration: "Customer-configured adapter",
  external_api: "External API integration (Twilio, RealPhoneValidation, etc.)",
} as const;
