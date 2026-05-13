/**
 * Approval queue routes: list, review, and resolve pending approvals.
 *
 * GET    /api/approval-queue           - list queue entries (filterable)
 * GET    /api/approval-queue/:id        - get a single entry with linked decision
 * PATCH  /api/approval-queue/:id/review - submit a review decision
 */

import { Router } from "express";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { getDb } from "../db/index.js";
import { approvalQueue, policyDecisions, type NewApprovalQueueRow, type NewPolicyDecisionRow } from "../db/schema.js";
import { eq, desc, and, sql } from "drizzle-orm";
import type { Config } from "../config.js";
import { broadcast } from "../websocket-server.js";

export function createApprovalQueueRouter(config: Config): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // Schemas
  // -------------------------------------------------------------------------

  const ReviewRequestSchema = z.object({
    reviewedBy: z.string(),
    reviewedByLabel: z.string(),
    reviewDecision: z.enum(["approve", "reject", "return_to_author"]),
    reviewNote: z.string().optional(),
  });

  const EnqueueRequestSchema = z.object({
    tenantId: z.string().uuid(),
    actorId: z.string().min(1).max(180).default("automation"),
    actorLabel: z.string().min(1).max(180).default("Automation"),
    proposedActionKind: z.string().min(1).max(180),
    proposedActionSummary: z.string().min(1).max(2000),
    decisionReason: z.string().min(1).max(2000).default("Queued by automation"),
  });

  router.post("/", (req, res) => {
    const parsed = EnqueueRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }

    const now = new Date().toISOString();
    const policyDecisionId = randomUUID();
    const approvalId = randomUUID();
    const hashBase = `${policyDecisionId}:${parsed.data.tenantId}:${now}`;
    const decisionHash = createHash("sha256").update(hashBase).digest("hex");
    const decision: NewPolicyDecisionRow = {
      id: policyDecisionId,
      actionId: policyDecisionId,
      tenantId: parsed.data.tenantId,
      actorId: parsed.data.actorId,
      actorType: "system",
      actorLabel: parsed.data.actorLabel,
      proposedActionKind: parsed.data.proposedActionKind,
      proposedActionSummary: parsed.data.proposedActionSummary,
      evidenceSnapshot: "{}",
      decision: "route_to_review",
      decisionReason: parsed.data.decisionReason,
      shadowMode: false,
      prevDecisionHash: null,
      decisionHash,
      proposedAt: now,
      decidedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const entry: NewApprovalQueueRow = {
      id: approvalId,
      policyDecisionId,
      tenantId: parsed.data.tenantId,
      actorLabel: parsed.data.actorLabel,
      proposedActionKind: parsed.data.proposedActionKind,
      proposedActionSummary: parsed.data.proposedActionSummary,
      decisionReason: parsed.data.decisionReason,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };

    const db = getDb();
    db.insert(policyDecisions).values(decision).run();
    db.insert(approvalQueue).values(entry).run();
    broadcast({
      type: "approval_enqueued",
      approvalQueueId: approvalId,
      tenantId: parsed.data.tenantId,
      actorLabel: parsed.data.actorLabel,
      proposedActionKind: parsed.data.proposedActionKind,
      proposedActionSummary: parsed.data.proposedActionSummary,
      decisionReason: parsed.data.decisionReason,
      enqueuedAt: now,
    });
    res.status(201).json(entry);
  });

  // -------------------------------------------------------------------------
  // GET /api/approval-queue
  // -------------------------------------------------------------------------

  router.get("/", (req, res) => {
    const db = getDb();
    const { tenantId, status, limit = "50", offset = "0" } = req.query;

    const conditions = [];
    if (tenantId)
      conditions.push(eq(approvalQueue.tenantId, tenantId as string));
    if (status)
      conditions.push(
        eq(
          approvalQueue.status,
          status as "pending" | "approved" | "rejected" | "returned"
        )
      );

    const rows = db
      .select()
      .from(approvalQueue)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(approvalQueue.createdAt))
      .limit(Number(limit))
      .offset(Number(offset))
      .all();

    const total =
      db
        .select({ count: sql<number>`count(*)` })
        .from(approvalQueue)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .get()?.count ?? 0;

    res.json({ items: rows, total, limit: Number(limit), offset: Number(offset) });
  });

  // -------------------------------------------------------------------------
  // GET /api/approval-queue/:id
  // -------------------------------------------------------------------------

  router.get("/:id", (req, res) => {
    const db = getDb();

    const entry = db
      .select()
      .from(approvalQueue)
      .where(eq(approvalQueue.id, req.params.id))
      .get();

    if (!entry) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    // Attach linked policy decision
    const decision = db
      .select()
      .from(policyDecisions)
      .where(eq(policyDecisions.id, entry.policyDecisionId))
      .get();

    res.json({ ...entry, policyDecision: decision ?? null });
  });

  // -------------------------------------------------------------------------
  // PATCH /api/approval-queue/:id/review
  // -------------------------------------------------------------------------

  router.patch("/:id/review", (req, res) => {
    const parsed = ReviewRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }

    const db = getDb();
    const now = new Date().toISOString();
    const { reviewedBy, reviewedByLabel, reviewDecision, reviewNote } = parsed.data;

    const existing = db
      .select()
      .from(approvalQueue)
      .where(eq(approvalQueue.id, req.params.id))
      .get();

    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    if (existing.status !== "pending") {
      res.status(409).json({ error: "already_reviewed" });
      return;
    }

    // Update queue entry
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db.update(approvalQueue) as any)
      .set({
        status: reviewDecision === "approve" ? "approved" : reviewDecision === "reject" ? "rejected" : "returned",
        reviewedBy,
        reviewedByLabel,
        reviewNote: reviewNote ?? null,
        reviewedAt: now,
        updatedAt: now,
      })
      .where(eq(approvalQueue.id, req.params.id))
      .run();

    // Update linked policy decision's review fields
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db.update(policyDecisions) as any)
      .set({
        reviewedBy,
        reviewedByLabel,
        reviewDecision,
        reviewNote: reviewNote ?? null,
        reviewedAt: now,
      })
      .where(eq(policyDecisions.id, existing.policyDecisionId))
      .run();

    const updated = db
      .select()
      .from(approvalQueue)
      .where(eq(approvalQueue.id, req.params.id))
      .get();

    // Broadcast to connected WebSocket clients so admin-ui inbox lights up <2s
    broadcast({
      type: "approval_reviewed",
      approvalQueueId: req.params.id,
      status: reviewDecision === "approve" ? "approved" : reviewDecision === "reject" ? "rejected" : "returned",
      reviewedBy,
      reviewedAt: now,
    });

    res.json(updated);
  });

  return router;
}
