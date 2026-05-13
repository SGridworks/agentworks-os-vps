/**
 * decisionLog.ts — policy_decisions insert helper.
 *
 * Every code path that returns a policy decision MUST call logDecision() so
 * that the hash chain stays continuous and the decision is durably recorded.
 * Calling this function is the definition of "logging a decision" — there are
 * no other acceptable ways to create a policy_decisions row.
 *
 * Usage:
 *   const { row, decisionId } = logDecision({ tenantId, actor, ... });
 */

import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { getDb } from "../../db/index.js";
import { policyDecisions, approvalQueue } from "../../db/schema.js";
import { eq, desc } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Actor {
  id?: string | undefined;
  type?: "human" | "agent" | "system" | undefined;
  label?: string | undefined;
}

export interface Contact {
  type?: "person" | "business" | undefined;
  label?: string | undefined;
  address?: string | undefined;
  id?: string | undefined;
}

export interface Consent {
  source: "written" | "verbal" | "inferred" | "none" | "unknown";
  recordRef?: string | undefined;
  verified?: boolean | undefined;
}

export interface LogDecisionOptions {
  tenantId: string;
  actionId?: string | undefined;
  actor: Actor;
  contact?: Contact | undefined;
  channel?:
    | "sms"
    | "email"
    | "voice"
    | "chat"
    | "api"
    | "crm"
    | "other"
    | undefined;
  jurisdiction?: string | undefined;
  consent?: Consent | undefined;
  purpose?: string | undefined;
  proposedAction: {
    kind: string;
    summary: string;
  };
  evidenceSnapshot: Record<string, unknown>;
  decision: "allow" | "block" | "route_to_review";
  decisionReason: string;
  shadowMode: boolean;
  /** Populated when the decision came from a specific rule pack */
  rulePackId?: string | null;
  rulePackVersion?: string | null;
  /** Override fields — populated when a human overrode a prior decision */
  overriddenBy?: string | null;
  overriddenByLabel?: string | null;
  originalDecision?: "allow" | "block" | "route_to_review" | null;
  overrideReason?: string | null;
  /** Review fields — populated when a reviewer acted on a route_to_review */
  reviewedBy?: string | null;
  reviewedByLabel?: string | null;
  reviewDecision?: "approve" | "reject" | "return_to_author" | null;
  reviewNote?: string | null;
}

export interface LogDecisionResult {
  /** The inserted row — structure matches the policy_decisions columns */
  row: {
    id: string;
    actionId: string;
    tenantId: string;
    actorId: string;
    actorType: "human" | "agent" | "system";
    actorLabel: string;
    contactId: string | null;
    contactType: "person" | "business" | null;
    contactLabel: string | null;
    contactAddress: string | null;
    channel: string | null;
    jurisdiction: string | null;
    consentSource: string | null;
    consentRecordRef: string | null;
    consentVerified: boolean | null;
    purpose: string | null;
    rulePackId: string | null;
    rulePackVersion: string | null;
    proposedActionKind: string;
    proposedActionSummary: string;
    evidenceSnapshot: string;
    decision: "allow" | "block" | "route_to_review";
    decisionReason: string;
    shadowMode: boolean;
    overriddenBy: string | null;
    overriddenByLabel: string | null;
    originalDecision: string | null;
    overrideReason: string | null;
    overriddenAt: string | null;
    reviewedBy: string | null;
    reviewedByLabel: string | null;
    reviewDecision: string | null;
    reviewNote: string | null;
    reviewedAt: string | null;
    prevDecisionHash: string | null;
    decisionHash: string;
    proposedAt: string;
    decidedAt: string;
    createdAt: string;
    updatedAt: string;
  };
  /** Convenience — the UUID of the inserted row */
  decisionId: string;
  /** Set when decision === 'route_to_review' && shadowMode === false */
  approvalQueueId: string | null;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Insert a policy_decisions row and, when appropriate, an approval_queue entry.
 * Returns the inserted row and the decision ID.
 *
 * Hash chain: each row references the previous row's decisionHash for the same
 * tenant, forming a tamper-evident log.
 */
export function logDecision(
  opts: LogDecisionOptions,
): LogDecisionResult {
  const db = getDb();
  const now = new Date().toISOString();
  const decisionId = randomUUID();
  const actionId = opts.actionId ?? randomUUID();

  const evidenceStr = JSON.stringify(opts.evidenceSnapshot);
  const decisionHash = createHash("sha256")
    .update(evidenceStr + opts.decision + opts.decisionReason)
    .digest("hex");

  // Fetch previous hash for chain continuity
  const prevRow = db
    .select({ decisionHash: policyDecisions.decisionHash })
    .from(policyDecisions)
    .where(eq(policyDecisions.tenantId, opts.tenantId))
    .orderBy(desc(policyDecisions.createdAt))
    .get() as { decisionHash: string } | undefined;
  const prevDecisionHash = prevRow?.decisionHash ?? null;

  const row = {
    id: decisionId,
    actionId,
    tenantId: opts.tenantId,
    actorId: opts.actor.id ?? "unknown",
    actorType: opts.actor.type ?? "system",
    actorLabel: opts.actor.label ?? "(unknown)",
    contactId: opts.contact?.id ?? null,
    contactType: opts.contact?.type ?? null,
    contactLabel: opts.contact?.label ?? null,
    contactAddress: opts.contact?.address ?? null,
    channel: opts.channel ?? null,
    jurisdiction: opts.jurisdiction ?? null,
    consentSource: opts.consent?.source ?? null,
    consentRecordRef: opts.consent?.recordRef ?? null,
    consentVerified:
      opts.consent?.verified !== undefined
        ? (opts.consent.verified as boolean)
        : null,
    purpose: opts.purpose ?? null,
    rulePackId: opts.rulePackId ?? null,
    rulePackVersion: opts.rulePackVersion ?? null,
    proposedActionKind: opts.proposedAction.kind,
    proposedActionSummary: opts.proposedAction.summary,
    evidenceSnapshot: evidenceStr,
    decision: opts.decision,
    decisionReason: opts.decisionReason,
    shadowMode: opts.shadowMode,
    overriddenBy: opts.overriddenBy ?? null,
    overriddenByLabel: opts.overriddenByLabel ?? null,
    originalDecision: opts.originalDecision ?? null,
    overrideReason: opts.overrideReason ?? null,
    overriddenAt: opts.overriddenBy ? now : null,
    reviewedBy: opts.reviewedBy ?? null,
    reviewedByLabel: opts.reviewedByLabel ?? null,
    reviewDecision: opts.reviewDecision ?? null,
    reviewNote: opts.reviewNote ?? null,
    reviewedAt: opts.reviewedBy ? now : null,
    prevDecisionHash,
    decisionHash,
    proposedAt: now,
    decidedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(policyDecisions).values(row).run();

  // Auto-enqueue for human review when routed to review in enforce mode.
  // Shadow mode decisions are advisory-only — no queue entry needed.
  let approvalQueueId: string | null = null;
  if (opts.decision === "route_to_review" && opts.shadowMode === false) {
    approvalQueueId = randomUUID();
    const aqRow = {
      id: approvalQueueId,
      policyDecisionId: decisionId,
      tenantId: opts.tenantId,
      actorLabel: opts.actor.label ?? "",
      proposedActionKind: opts.proposedAction.kind,
      proposedActionSummary: opts.proposedAction.summary,
      decisionReason: opts.decisionReason,
      status: "pending" as const,
      reviewedBy: null,
      reviewedByLabel: null,
      reviewNote: null,
      reviewedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(approvalQueue).values(aqRow).run();
  }

  return { row, decisionId, approvalQueueId };
}
