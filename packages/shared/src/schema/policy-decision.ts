/**
 * RFC 002 — Policy Decision Data Model v0.1
 * Append-only, hash-chained record of every policy engine evaluation.
 * Basis for Compliance Evidence Report, approval queue, and audit trail.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// --- Sub-schemas ---

export const ContactSchema = z.object({
  id: z.string().optional(),
  type: z.enum(["person", "business"]),
  label: z.string(),
  address: z.string(),
});

export type Contact = z.infer<typeof ContactSchema>;

export const ConsentSchema = z.object({
  source: z.enum(["written", "verbal", "inferred", "none", "unknown"]),
  capturedAt: z.string().datetime().optional(),
  capturedBy: z.string().optional(),
  recordRef: z.string().optional(),
  verified: z.boolean().default(false),
  scope: z.array(z.string()).default([]),
  expiresAt: z.string().datetime().optional(),
});

export type Consent = z.infer<typeof ConsentSchema>;

export const ToolSchema = z.object({
  id: z.string(),
  name: z.string(),
  adapterKey: z.string().optional(),
  policyMode: z.enum(["shadow", "enforce"]),
});

export type Tool = z.infer<typeof ToolSchema>;

export const RuleCitationSchema = z.object({
  ruleId: z.string(),
  matchedField: z.string(),
  matchedValue: z.unknown(),
  operator: z.string(),
});

export type RuleCitation = z.infer<typeof RuleCitationSchema>;

export const EvidenceSchema = z.object({
  ruleIds: z.array(z.string()).default([]),
  ruleNames: z.array(z.string()).default([]),
  ruleCitations: z.array(RuleCitationSchema).default([]),
  missingFields: z.array(z.string()).default([]),
  actionSnapshot: z.record(z.unknown()),
});

export type Evidence = z.infer<typeof EvidenceSchema>;

export const OverrideSchema = z.object({
  overriddenBy: z.string(),
  overriddenByLabel: z.string(),
  originalDecision: z.enum(["allow", "block", "route_to_review"]),
  overrideReason: z.string(),
  overriddenAt: z.string().datetime(),
});

export type Override = z.infer<typeof OverrideSchema>;

export const ReviewSchema = z.object({
  reviewedBy: z.string().optional(),
  reviewedByLabel: z.string().optional(),
  reviewDecision: z.enum(["approve", "reject", "return_to_author"]).optional(),
  reviewNote: z.string().optional(),
  reviewedAt: z.string().datetime().optional(),
});

export type Review = z.infer<typeof ReviewSchema>;

// --- Main schema ---

export const PolicyDecisionSchema = z.object({
  id: z.string().uuid(),
  actionId: z.string().uuid(),

  // Actor
  actorId: z.string(),
  actorType: z.enum(["human", "agent", "system"]),
  actorLabel: z.string(),

  // Tenant
  tenantId: z.string().uuid(),

  // Contact
  contact: ContactSchema.optional(),
  channel: z
    .enum(["sms", "email", "voice", "chat", "api", "crm", "other"])
    .optional(),
  jurisdiction: z.string().optional(),

  // Consent
  consent: ConsentSchema.optional(),

  // Purpose
  purpose: z.string().optional(),
  rulePackId: z.string().optional(),
  rulePackVersion: z.string().optional(),

  // Tool
  tool: ToolSchema.optional(),

  // Proposed action
  proposedActionKind: z.string(),
  proposedActionSummary: z.string(),

  // Evidence
  evidence: EvidenceSchema,

  // Decision
  decision: z.enum(["allow", "block", "route_to_review"]),
  decisionReason: z.string(),
  shadowMode: z.boolean().default(false),

  // Override
  override: OverrideSchema.optional(),

  // Review
  review: ReviewSchema.optional(),

  // Hash chain
  prevDecisionHash: z.string().optional(),
  decisionHash: z.string(),

  // Timestamps
  proposedAt: z.string().datetime(),
  decidedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});

export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

// JSON Schema export
export const policyDecisionJsonSchema = zodToJsonSchema(
  PolicyDecisionSchema,
  "PolicyDecision"
);
