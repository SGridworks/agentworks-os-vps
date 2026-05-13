# RFC 002 — Policy Decision Data Model v0.1

**Status**: Approved (2026-04-28 by TechLead; policy decision schema + tests shipped in packages/shared/src/schema/policy-decision.ts)
**Author**: TechLead
**Created**: 2026-04-27
**Blocks**: AWO-5 (in_progress), AWO-26 (DB migration), AWO-75 (Compliance Evidence Report), AWO-94 (AWCP audit log spec)
**Review**: CEO + ComplianceConsultant must sign off before implementation
**Requires**: RFC 001 (canonical action schema)

---

## Problem

Every policy decision — allow, block, or route_to_review — must be logged with full provenance. This log is the basis of the Compliance Evidence Report, the approval queue, and the hash-chained audit trail. Without a structured data model, shadow mode produces unstructured text that cannot be queried, exported, or reliably used as legal evidence.

The policy decision record must capture: who did what, what rule fired, what data was missing, what the outcome was, who overrode it, and who reviewed it.

---

## Design Principles

1. Append-only. No updates to decision records after creation.
2. Hash-chained. Each record includes the hash of the previous record, forming a tamper-evident chain.
3. Self-contained. A decision record has everything needed to reconstruct the compliance posture at a point in time without cross-referencing other tables.
4. Normalized consent/jurisdiction/purpose. These are first-class fields, not JSON blobs — enables reporting queries across all three dimensions.
5. Decoupled from the action. PolicyDecision is a separate table from ActionLog. A single action may generate multiple decisions over time (initial + override).

---

## Schema

```typescript
// packages/shared/src/schema/policy-decision.ts

import { z } from "zod";

/**
 * A policy decision record. Created for every action that enters the policy engine.
 * Append-only. Hash-chained. Self-contained.
 */
export const PolicyDecisionSchema = z.object({
  id: z.string().uuid(),
  /** Links to action_log.id */
  actionId: z.string().uuid(),

  // --- Actor (who triggered the action) ---
  actorId: z.string(),
  actorType: z.enum(["human", "agent", "system"]),
  actorLabel: z.string(),

  // --- Tenant ---
  tenantId: z.string().uuid(),

  // --- Contact (target party — who the action is directed at) ---
  contact: ContactSchema.optional(),
  /** Channel through which the action was attempted. */
  channel: z.enum(["sms", "email", "voice", "chat", "api", "crm", "other"]).optional(),
  /** Jurisdiction for this contact (US state or "federal"). */
  jurisdiction: z.string().optional(),

  // --- Consent provenance ---
  consent: ConsentSchema.optional(),

  // --- Purpose ---
  purpose: z.string().optional(),
  /** Rule pack that generated this decision. */
  rulePackId: z.string().optional(),
  rulePackVersion: z.string().optional(),

  // --- Tool ---
  tool: ToolSchema.optional(),

  // --- Proposed action (reference) ---
  proposedActionKind: z.string(),
  proposedActionSummary: z.string(),

  // --- Evidence ---
  evidence: EvidenceSchema,

  // --- Decision ---
  decision: z.enum(["allow", "block", "route_to_review"]),
  /** Human-readable explanation. Used in admin UI and Compliance Evidence Report. */
  decisionReason: z.string(),
  /** Whether this decision was made in shadow (observe-only) mode. */
  shadowMode: z.boolean().default(false),

  // --- Override ---
  /** If overridden, who did it and why. */
  override: OverrideSchema.optional(),

  // --- Review (for route_to_review) ---
  review: ReviewSchema.optional(),

  // --- Hash chain ---
  prevDecisionHash: z.string().optional(),
  decisionHash: z.string(),

  // --- Timestamps ---
  proposedAt: z.string().datetime(),
  decidedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});

export const ContactSchema = z.object({
  id: z.string().optional(),
  type: z.enum(["person", "business"]),
  label: z.string(),
  /** Phone or email used for the outreach. */
  address: z.string(), // e.g., +1555..., name@example.com
});

export const ConsentSchema = z.object({
  /** Source of consent: written, verbal, inferred, none */
  source: z.enum(["written", "verbal", "inferred", "none", "unknown"]),
  capturedAt: z.string().datetime().optional(),
  capturedBy: z.string().optional(),
  /** URL or reference to consent record if digitally captured */
  recordRef: z.string().optional(),
  /** Whether consent has been verified (vs. self-asserted) */
  verified: z.boolean().default(false),
  /** Consent scope — what the contact agreed to */
  scope: z.array(z.string()).default([]),
  expiresAt: z.string().datetime().optional(),
});

export const ToolSchema = z.object({
  id: z.string(),
  name: z.string(),
  adapterKey: z.string().optional(),
  /** Tool's configured policy mode (shadow/enforce) at time of decision */
  policyMode: z.enum(["shadow", "enforce"]),
});

export const EvidenceSchema = z.object({
  /** Rule IDs that fired (matched the action). */
  ruleIds: z.array(z.string()).default([]),
  /** Rule names that fired, for audit readability. */
  ruleNames: z.array(z.string()).default([]),
  /** Structured citation per rule — which fields matched. */
  ruleCitations: z
    .array(
      z.object({
        ruleId: z.string(),
        matchedField: z.string(),
        matchedValue: z.unknown(),
        operator: z.string(),
      })
    )
    .default([]),
  /** Missing data fields that triggered route_to_review */
  missingFields: z.array(z.string()).default([]),
  /** Raw action envelope snapshot (immutable copy) */
  actionSnapshot: z.record(z.unknown()),
});

export const OverrideSchema = z.object({
  overriddenBy: z.string(), // userId or agentId
  overriddenByLabel: z.string(),
  originalDecision: z.enum(["allow", "block", "route_to_review"]),
  overrideReason: z.string(),
  overriddenAt: z.string().datetime(),
});

export const ReviewSchema = z.object({
  reviewedBy: z.string().optional(), // set when decided
  reviewedByLabel: z.string().optional(),
  reviewDecision: z.enum(["approve", "reject", "return_to_author"]).optional(),
  reviewNote: z.string().optional(),
  reviewedAt: z.string().datetime().optional(),
});

export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
export type Contact = z.infer<typeof ContactSchema>;
export type Consent = z.infer<typeof ConsentSchema>;
export type Tool = z.infer<typeof ToolSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Override = z.infer<typeof OverrideSchema>;
export type Review = z.infer<typeof ReviewSchema>;
```

---

## Hash Chain Algorithm

```
decisionHash = SHA-256(
  id +
  actionId +
  decision +
  decisionReason +
  COALESCE(prevDecisionHash, "GENESIS") +
  createdAt
)
```

- Hash is computed in application code, not in the DB.
- GENESIS record (first ever for a tenant) uses literal string "GENESIS" as prevDecisionHash.
- Hash chain enables tamper-evidence: any modification to a past record breaks the chain from that point forward.
- Compliance Evidence Report generator verifies chain integrity before signing.

---

## DB Tables

New tables to add via migration (AWO-26):

```sql
-- action_log: one row per action envelope received
CREATE TABLE action_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  request_id UUID NOT NULL UNIQUE,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  context JSONB NOT NULL,
  proposed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- policy_decisions: one row per policy engine evaluation
CREATE TABLE policy_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id UUID NOT NULL REFERENCES action_log(id),
  company_id UUID NOT NULL REFERENCES companies(id),

  -- Actor
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_label TEXT NOT NULL,

  -- Tenant
  tenant_id UUID NOT NULL,

  -- Contact
  contact JSONB,
  channel TEXT,
  jurisdiction TEXT,

  -- Consent
  consent JSONB,

  -- Purpose
  purpose TEXT,
  rule_pack_id TEXT,
  rule_pack_version TEXT,

  -- Tool
  tool JSONB,

  -- Proposed action
  proposed_action_kind TEXT NOT NULL,
  proposed_action_summary TEXT NOT NULL,

  -- Evidence
  evidence JSONB NOT NULL,

  -- Decision
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'block', 'route_to_review')),
  decision_reason TEXT NOT NULL,
  shadow_mode BOOLEAN NOT NULL DEFAULT false,

  -- Override
  override JSONB,

  -- Review
  review JSONB,

  -- Hash chain
  prev_decision_hash TEXT,
  decision_hash TEXT NOT NULL,

  -- Timestamps
  proposed_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Indexes
  CONSTRAINT unique_action_first_decision UNIQUE (action_id)
    WHERE override IS NULL
);
```

**Note**: Existing `approvals` table (paperclip) is NOT used for the approval queue. The `review` field in `policy_decisions` handles the route_to_review flow. This avoids overloading paperclip's existing approval semantics with policy-specific semantics.

---

## Relation to Existing Paperclip Schema

| Paperclip table | AgentWorks relationship |
|---|---|
| `activity_log` | Not overloaded. Policy decisions use `policy_decisions`. |
| `approvals` | Not overloaded. Policy-specific approvals use `policy_decisions.review`. |
| `agents` | `actor.actorId` references agent IDs for agent-originated actions. |
| `issues` | Scanner findings surface as Issues (separate path, not via policy_decisions). |
| `documents` | Vault content referenced via `context.vaultRefs`, not embedded. |

---

## Compliance Evidence Report Usage

Each monthly Compliance Evidence Report queries:

```sql
SELECT
  tenant_id,
  decision,
  COUNT(*) as count,
  MIN(decided_at) as first_decision,
  MAX(decided_at) as last_decision
FROM policy_decisions
WHERE decided_at BETWEEN :period_start AND :period_end
GROUP BY tenant_id, decision;
```

Report includes per-decision: action summary, rule citations, decision reason, override/review metadata, hash chain integrity verification result.

---

## Implementation Notes

- Schema lives in `packages/shared/src/schema/policy-decision.ts`
- Zod types + JSON Schema export same pattern as RFC 001
- Migration in `packages/db/src/schema/policy-decisions.ts` (new file, NOT appended to existing tables)
- Hash computation utility in `packages/shared/src/crypto.ts` (SHA-256, Node built-in `crypto`)
- ComplianceConsultant owns: consent field semantics, jurisdiction normalization rules, missing-data-to-review routing logic
- The `missingFields` in `evidence` is the integration point: when the policy engine evaluates a rule pack that declares required data the substrate cannot provide, it populates `missingFields` and sets `decision: route_to_review`

---

## Open Questions

1. Should `decisionHash` use HMAC (tenant-scoped key) or plain SHA-256? Plain SHA-256 is auditable by the customer without key sharing. HMAC adds integrity but requires key management. Recommend: plain SHA-256 for v0.1 draft; HMAC optional in v1.0.
2. Should `consent` be a separate table (normalized) or always embedded in the decision record? v0.1: embedded in `evidence.consent`. If consent records become independently queriable (consent revocation), normalize in v1.1.
3. How does the approval queue surface in the admin UI? `policy_decisions` WHERE `decision = 'route_to_review' AND review IS NULL` is the queue query. FrontendEngineer owns the UI; this is the API contract.
