/**
 * Dispatch routes — substrate-initiated tasks for target agents.
 *
 * The complement to policy.check: when a workflow (n8n, REST caller, MCP
 * tool) wants the substrate to hand a task to an agent, it POSTs here.
 * The route writes a tenant-scoped `dispatch_queue` row at status='queued'
 * and returns the task id. v1 has no in-process worker draining the queue;
 * adapters poll, or webhook fan-out can be wired later.
 *
 * POST /api/dispatch              { tenantId, taskKind, targetAgentId, input } → { taskId, status }
 * GET  /api/dispatch?tenantId=&status= …  paginated list
 * GET  /api/dispatch/:id          single row with parsed input
 * PATCH /api/dispatch/:id         { status, error? } — adapter side transitions
 */

import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { eq, and, desc, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { dispatchQueue, type NewDispatchQueueRow } from "../db/schema.js";
import { isPaused } from "../pause-service.js";
import type { Config } from "../config.js";

const ACTION_KIND_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

export function createDispatchRouter(_config: Config): Router {
  const router = Router();

  const DispatchRequestSchema = z.object({
    tenantId: z.string().uuid(),
    taskKind: z
      .string()
      .min(1)
      .regex(ACTION_KIND_RE, {
        message: "taskKind must be lowercase dot-separated (e.g. outbound.sms)",
      }),
    targetAgentId: z.string().min(1),
    input: z.record(z.unknown()).default({}),
    policyDecisionId: z.string().uuid().optional(),
  });

  const TransitionSchema = z.object({
    status: z.enum(["dispatched", "completed", "failed"]),
    error: z.string().optional(),
  });

  // Valid state transitions: queued→dispatched|failed, dispatched→completed|failed
  const VALID_TRANSITIONS: Record<string, string[]> = {
    queued: ["dispatched", "failed"],
    dispatched: ["completed", "failed"],
    completed: [],
    failed: [],
  };

  router.post("/", (req, res) => {
    if (isPaused()) {
      res.status(503).json({ error: "substrate_paused", reason: "substrate is paused" });
      return;
    }
    const parsed = DispatchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    const body = parsed.data;
    const db = getDb();
    const now = new Date().toISOString();
    const taskId = randomUUID();

    const row: NewDispatchQueueRow = {
      id: taskId,
      tenantId: body.tenantId,
      taskKind: body.taskKind,
      targetAgentId: body.targetAgentId,
      input: JSON.stringify(body.input),
      status: "queued",
      policyDecisionId: body.policyDecisionId ?? null,
      createdAt: now,
      dispatchedAt: null,
      completedAt: null,
      error: null,
    };
    db.insert(dispatchQueue).values(row).run();

    res.status(201).json({
      taskId,
      status: "queued",
      tenantId: body.tenantId,
      taskKind: body.taskKind,
      targetAgentId: body.targetAgentId,
      createdAt: now,
    });
  });

  router.get("/stats", (req, res) => {
    const db = getDb();
    const tenantId = typeof req.query.tenantId === "string" ? req.query.tenantId : undefined;
    const stuckMinutes = Number(req.query.stuckMinutes ?? 5);
    const stuckThreshold = Number.isFinite(stuckMinutes) && stuckMinutes > 0 ? stuckMinutes : 5;
    const stuckCutoff = new Date(Date.now() - stuckThreshold * 60_000).toISOString();

    const baseConditions = [];
    if (tenantId) baseConditions.push(eq(dispatchQueue.tenantId, tenantId));

    const counts = db
      .select({ status: dispatchQueue.status, count: sql<number>`count(*)` })
      .from(dispatchQueue)
      .where(baseConditions.length ? and(...baseConditions) : undefined)
      .groupBy(dispatchQueue.status)
      .all();

    const byStatus: Record<string, number> = { queued: 0, dispatched: 0, completed: 0, failed: 0 };
    for (const c of counts) byStatus[c.status] = Number(c.count);

    const oldestQueued = db
      .select({ createdAt: dispatchQueue.createdAt })
      .from(dispatchQueue)
      .where(
        and(
          ...baseConditions,
          eq(dispatchQueue.status, "queued"),
        )
      )
      .orderBy(dispatchQueue.createdAt)
      .limit(1)
      .get();

    const stuckConditions = [
      ...baseConditions,
      eq(dispatchQueue.status, "queued"),
      sql`${dispatchQueue.createdAt} < ${stuckCutoff}`,
    ];
    const stuck = db
      .select({ count: sql<number>`count(*)` })
      .from(dispatchQueue)
      .where(and(...stuckConditions))
      .get()?.count ?? 0;

    res.json({
      byStatus,
      queuedTotal: byStatus.queued,
      stuckCount: Number(stuck),
      stuckThresholdMinutes: stuckThreshold,
      oldestQueuedAt: oldestQueued?.createdAt ?? null,
    });
  });

  router.get("/", (req, res) => {
    const db = getDb();
    const { tenantId, status, targetAgentId, limit = "50", offset = "0" } = req.query;

    const conditions = [];
    if (tenantId) conditions.push(eq(dispatchQueue.tenantId, tenantId as string));
    if (status)
      conditions.push(
        eq(
          dispatchQueue.status,
          status as "queued" | "dispatched" | "completed" | "failed",
        ),
      );
    if (targetAgentId)
      conditions.push(eq(dispatchQueue.targetAgentId, targetAgentId as string));

    const rows = db
      .select()
      .from(dispatchQueue)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(dispatchQueue.createdAt))
      .limit(Number(limit))
      .offset(Number(offset))
      .all();

    const total =
      db
        .select({ count: sql<number>`count(*)` })
        .from(dispatchQueue)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .get()?.count ?? 0;

    const items = rows.map((row) => ({
      ...row,
      input: safeParseJson(row.input),
    }));
    res.json({ items, total, limit: Number(limit), offset: Number(offset) });
  });

  router.get("/:id", (req, res) => {
    const db = getDb();
    const row = db
      .select()
      .from(dispatchQueue)
      .where(eq(dispatchQueue.id, req.params.id))
      .get();
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ ...row, input: safeParseJson(row.input) });
  });

  router.patch("/:id", (req, res) => {
    const parsed = TransitionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    const db = getDb();
    const existing = db
      .select()
      .from(dispatchQueue)
      .where(eq(dispatchQueue.id, req.params.id))
      .get();
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const now = new Date().toISOString();
    const { status, error } = parsed.data;

    const allowed = VALID_TRANSITIONS[existing.status] ?? [];
    if (!allowed.includes(status)) {
      res.status(409).json({
        error: "invalid_transition",
        message: `Cannot transition from '${existing.status}' to '${status}'`,
        current_status: existing.status,
        requested_status: status,
        allowed_transitions: allowed,
      });
      return;
    }

    const update: Partial<NewDispatchQueueRow> = { status };
    if (status === "dispatched") update.dispatchedAt = now;
    if (status === "completed" || status === "failed") update.completedAt = now;
    if (error !== undefined) update.error = error;

    db.update(dispatchQueue)
      .set(update)
      .where(eq(dispatchQueue.id, req.params.id))
      .run();

    const updated = db
      .select()
      .from(dispatchQueue)
      .where(eq(dispatchQueue.id, req.params.id))
      .get();
    res.json({ ...updated, input: safeParseJson(updated?.input ?? "{}") });
  });

  return router;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
