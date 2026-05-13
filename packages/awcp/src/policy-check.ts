/**
 * AWCP — Policy Check Request / Response
 *
 * Types for the POST /api/policy/check endpoint.
 * Covers the full request, response, per-rule decision breakdown,
 * override flow, and error response shapes.
 *
 * Spec: AWCP v0.1 Section 2
 */

import { z } from "zod";

// ============================================================
// Request
// ============================================================

/** Mode in which to evaluate the action. */
export const PolicyCheckModeSchema = z.enum(["enforce", "shadow"]);
export type PolicyCheckMode = z.infer<typeof PolicyCheckModeSchema>;

/**
 * Policy check request payload.
 *
 * mode: enforce = apply decisions (block/allow). shadow = log only.
 * rule_pack_ids: specific packs to evaluate. Omit to use all active packs for tenant.
 */
export const PolicyCheckRequestSchema = z.object({
  action: z.record(z.unknown()),
  rule_pack_ids: z.array(z.string()).optional(),
  mode: PolicyCheckModeSchema.default("enforce"),
  tenant_id: z.string().uuid(),
});
export type PolicyCheckRequest = z.infer<typeof PolicyCheckRequestSchema>;

// ============================================================
// Per-rule decision
// ============================================================

export const RuleDecisionSchema = z.object({
  rule_pack_id: z.string(),
  rule_pack_version: z.string(),
  rule_id: z.string(),
  decision: z.enum(["allow", "block", "route_to_review"]),
  reason: z.string(),
  citation: z.string().nullable().optional(),
  data_missing: z.array(z.string()).default([]),
});
export type RuleDecision = z.infer<typeof RuleDecisionSchema>;

// ============================================================
// Override
// ============================================================

/**
 * Human reviewer override of a route_to_review decision.
 * reviewer_id and justification are required for approve/reject.
 * send_back omits decision — the agent must revise and resubmit.
 */
export const OverrideSchema = z.object({
  applied: z.literal(true),
  reviewer_id: z.string().uuid(),
  justification: z.string().min(1),
});
export type Override = z.infer<typeof OverrideSchema>;

// ============================================================
// Response
// ============================================================

export const PolicyCheckResponseSchema = z.object({
  request_id: z.string().uuid(),
  decision: z.enum(["allow", "block", "route_to_review"]),
  evaluated_at: z.string().datetime(),
  decisions: z.array(RuleDecisionSchema),
  missing_data: z.array(z.string()).default([]),
  override: z
    .object({
      applied: z.literal(true),
      reviewer_id: z.string().uuid(),
      justification: z.string().min(1),
    })
    .nullable(),
});
export type PolicyCheckResponse = z.infer<
  typeof PolicyCheckResponseSchema
>;

// ============================================================
// Error responses
// ============================================================

export const PolicyCheckErrorSchema = z.object({
  error: z.string(),
  details: z
    .array(
      z.object({
        code: z.string(),
        message: z.string(),
        path: z.array(z.union([z.string(), z.number()])).optional(),
      })
    )
    .optional(),
});
export type PolicyCheckError = z.infer<typeof PolicyCheckErrorSchema>;
