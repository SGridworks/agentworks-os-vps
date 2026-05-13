/**
 * AWCP — Audit Log Entry Format
 *
 * Append-only, hash-chained record of every policy engine evaluation.
 * Basis for Compliance Evidence Report, approval queue, and audit trail.
 *
 * Spec: AWCP v0.1 Section 3
 */

import { z } from "zod";
import { createHash } from "crypto";

// ============================================================
// Sub-schemas
// ============================================================

export const AuditActorSchema = z.object({
  id: z.string(),
  type: z.enum(["human", "agent"]),
});
export type AuditActor = z.infer<typeof AuditActorSchema>;

export const AuditContactSchema = z.object({
  id: z.string().uuid().nullable(),
  channel: z.string(),
});
export type AuditContact = z.infer<typeof AuditContactSchema>;

// Per-rule evaluation result
export const AuditRuleDecisionSchema = z.object({
  rule_pack_id: z.string(),
  rule_pack_version: z.string(),
  rule_id: z.string(),
  rule_pack_name: z.string(),
  rule_name: z.string(),
  decision: z.enum(["allow", "block", "route_to_review"]),
  reason: z.string(),
  citation: z.string().nullable(),
  data_missing: z.array(z.string()).default([]),
});
export type AuditRuleDecision = z.infer<typeof AuditRuleDecisionSchema>;

// Override record (when a reviewer overrides a route_to_review)
export const AuditOverrideSchema = z.object({
  reviewer_id: z.string().uuid(),
  reviewer_name: z.string(),
  original_decision: z.enum(["allow", "block", "route_to_review"]),
  override_decision: z.enum(["allow", "block", "route_to_review"]),
  justification: z.string(),
  decided_at: z.string().datetime(),
});
export type AuditOverride = z.infer<typeof AuditOverrideSchema>;

// ============================================================
// Hash chain
// ============================================================

/**
 * Fields that contribute to the audit entry hash.
 * Computed in declaration order; all fields are required.
 * Uses SHA-256.
 */
export interface AuditLogHashInput {
  entry_id: string;
  request_id: string;
  tenant_id: string;
  actor_id: string;
  action_kind: string;
  decision: string;
  decisions: AuditRuleDecision[];
  missing_data: string[];
  override: AuditOverride | null;
  previous_hash: string;
  logged_at: string;
}

/**
 * Compute the SHA-256 hash for an audit log entry.
 * Used by the substrate to produce the entry hash,
 * and by auditors to verify chain integrity.
 */
export function computeAuditLogHash(input: AuditLogHashInput): string {
  const payload = [
    input.entry_id,
    input.request_id,
    input.tenant_id,
    input.actor_id,
    input.action_kind,
    input.decision,
    JSON.stringify(input.decisions),
    JSON.stringify(input.missing_data),
    JSON.stringify(input.override),
    input.previous_hash,
    input.logged_at,
  ].join("|");

  return createHash("sha256").update(payload).digest("hex");
}

// ============================================================
// Audit log entry
// ============================================================

export const AuditLogEntrySchema = z.object({
  entry_id: z.string().uuid(),
  request_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  actor: AuditActorSchema,
  contact: AuditContactSchema.nullable(),
  action_kind: z.string(),
  decision: z.enum(["allow", "block", "route_to_review"]),
  decisions: z.array(AuditRuleDecisionSchema),
  missing_data: z.array(z.string()).default([]),
  mode: z.enum(["enforce", "shadow"]),
  override: AuditOverrideSchema.nullable(),
  hash: z.string(),
  previous_hash: z.string(),
  logged_at: z.string().datetime(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;
