/**
 * Rule pack catalog — sourced from AgentWorks OS wiki compliance research.
 * These are the packs available at onboarding time.
 *
 * AWOS ships only the SMB Starter pack at onboarding.
 * Industry-specific compliance guardrails (TCPA, Fair Housing, HIPAA, etc.)
 * are built-in native rule packs.
 * The vault/wiki structure at wiki/regulatory/ provides a research framework
 * for agents to reference regulations — enforcement is now native.
 *
 * When adding a new pack:
 *   1. Add it here with tier and description
 *   2. Update the wizard copy in onboarding/page.tsx to reference it
 *   3. Ensure the YAML pack file exists at the path below
 */

export interface RulePackCatalogEntry {
  packId: string;
  /** Display name shown in the onboarding wizard */
  name: string;
  description: string;
  /** Free | Paid | Attorney Reviewed */
  tier: "free" | "paid" | "attorney-reviewed";
  /** Sub-label shown under the tier badge */
  tierLabel: string;
  /** Industry this pack primarily serves */
  industry: string;
  /** Short regulatory summary */
  regulations: string[];
  /** Path to the YAML pack file inside the container */
  yamlPath: string;
}

export const RULE_PACK_CATALOG: RulePackCatalogEntry[] = [
  {
    packId: "smb-starter",
    name: "SMB Compliance Starter",
    description:
      "Baseline compliance guardrails for small businesses running AI agents. " +
      "Covers do-not-contact, consent provenance, content boundaries, and data handling. " +
      "Not a substitute for industry-specific legal advice.",
    tier: "free",
    tierLabel: "Free",
    industry: "Small Business",
    regulations: ["General data handling", "Consent provenance"],
    yamlPath: "/opt/agentworks/rule-packs/smb-starter.yaml",
  },
];

/** Packs grouped by industry for the wizard's filtered display */
export function packsForIndustry(
  industry: string,
): RulePackCatalogEntry[] {
  if (!industry) return RULE_PACK_CATALOG;
  const lower = industry.toLowerCase();
  return RULE_PACK_CATALOG.filter(
    (p) =>
      p.industry.toLowerCase().includes(lower) ||
      p.industry === "Small Business",
  );
}
