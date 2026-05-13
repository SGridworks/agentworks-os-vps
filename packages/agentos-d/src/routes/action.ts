/**
 * Action log routes — ingest and query the append-only action log.
 *
 * POST   /api/action          — ingest a new action envelope
 * GET    /api/action          — list logged actions (filterable)
 * GET    /api/action/:id      — get a single action log entry
 */

import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { actionLog, type NewActionLogRow } from "../db/schema.js";
import { eq, desc, and, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";

export function createActionRouter(config: Config): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // Schemas
  // -------------------------------------------------------------------------

  const IngestActionSchema = z.object({
    tenantId: z.string().uuid(),
    actor: z.object({
      id: z.string(),
      type: z.enum(["human", "agent", "system"]),
      label: z.string(),
    }),
    actionKind: z.string(),
    payloadSnapshot: z.record(z.unknown()),
    vaultRefs: z.array(z.string()).default([]),
    conversationRefs: z.array(z.string()).default([]),
    projectRefs: z.array(z.string()).default([]),
    policyDecisionId: z.string().uuid().optional(),
    proposedAt: z.string().datetime().optional(),
  });

  // -------------------------------------------------------------------------
  // POST /api/action
  // -------------------------------------------------------------------------

  router.post("/", (req, res) => {
    const parsed = IngestActionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }

    const body = parsed.data;
    const db = getDb();
    const now = new Date().toISOString();
    const id = randomUUID();

    const newRow: NewActionLogRow = {
      id,
      tenantId: body.tenantId,
      actorId: body.actor.id,
      actorType: body.actor.type,
      actorLabel: body.actor.label,
      actionKind: body.actionKind,
      payloadSnapshot: JSON.stringify(body.payloadSnapshot),
      vaultRefs: JSON.stringify(body.vaultRefs),
      conversationRefs: JSON.stringify(body.conversationRefs),
      projectRefs: JSON.stringify(body.projectRefs),
      policyDecisionId: body.policyDecisionId ?? null,
      proposedAt: body.proposedAt ?? now,
      loggedAt: now,
    };

    db.insert(actionLog).values(newRow).run();

    res.status(201).json({ id, tenantId: body.tenantId, loggedAt: now });
  });

  // -------------------------------------------------------------------------
  // GET /api/action
  // -------------------------------------------------------------------------

  router.get("/", (req, res) => {
    const db = getDb();
    const {
      tenantId,
      actorId,
      actionKind,
      policyDecisionId,
      from,
      to,
      limit = "50",
      offset = "0",
    } = req.query;

    const conditions = [];
    if (tenantId) conditions.push(eq(actionLog.tenantId, tenantId as string));
    if (actorId) conditions.push(eq(actionLog.actorId, actorId as string));
    if (actionKind)
      conditions.push(eq(actionLog.actionKind, actionKind as string));
    if (policyDecisionId)
      conditions.push(eq(actionLog.policyDecisionId, policyDecisionId as string));
    if (from) conditions.push(sql`${actionLog.loggedAt} >= ${from as string}`);
    if (to) conditions.push(sql`${actionLog.loggedAt} <= ${to as string}`);

    const rows = db
      .select()
      .from(actionLog)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(actionLog.loggedAt))
      .limit(Number(limit))
      .offset(Number(offset))
      .all();

    const total =
      db
        .select({ count: sql<number>`count(*)` })
        .from(actionLog)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .get()?.count ?? 0;

    // Parse JSON fields for each row
    const items = rows.map((row) => ({
      ...row,
      payloadSnapshot: JSON.parse(row.payloadSnapshot as string),
      vaultRefs: JSON.parse(row.vaultRefs as string),
      conversationRefs: JSON.parse(row.conversationRefs as string),
      projectRefs: JSON.parse(row.projectRefs as string),
    }));

    res.json({ items, total, limit: Number(limit), offset: Number(offset) });
  });

  // -------------------------------------------------------------------------
  // GET /api/action/export.csv
  // Streams the audit log as RFC 4180 CSV. Same filter set as GET /api/action.
  // No pagination — designed for compliance review export. Tenants with
  // large logs should pass tenantId + a date range (TODO: from/to).
  // -------------------------------------------------------------------------

  router.get("/export.csv", (req, res) => {
    const db = getDb();
    const { tenantId, actorId, actionKind, policyDecisionId } = req.query;

    const conditions = [];
    if (tenantId) conditions.push(eq(actionLog.tenantId, tenantId as string));
    if (actorId) conditions.push(eq(actionLog.actorId, actorId as string));
    if (actionKind) conditions.push(eq(actionLog.actionKind, actionKind as string));
    if (policyDecisionId)
      conditions.push(eq(actionLog.policyDecisionId, policyDecisionId as string));

    const rows = db
      .select()
      .from(actionLog)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(actionLog.loggedAt))
      .all();

    const escape = (v: unknown): string => {
      if (v === null || v === undefined) return "";
      const s = typeof v === "string" ? v : JSON.stringify(v);
      if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    const cols = [
      "id",
      "tenantId",
      "actorId",
      "actorType",
      "actorLabel",
      "actionKind",
      "policyDecisionId",
      "loggedAt",
      "payloadSnapshot",
      "vaultRefs",
      "conversationRefs",
      "projectRefs",
    ] as const;

    const filename = `agentworks-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.write(cols.join(",") + "\r\n");
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      const line = cols.map((c) => escape(r[c])).join(",");
      res.write(line + "\r\n");
    }
    res.end();
  });

  // -------------------------------------------------------------------------
  // GET /api/action/:id
  // -------------------------------------------------------------------------

  router.get("/:id", (req, res) => {
    const db = getDb();

    const row = db
      .select()
      .from(actionLog)
      .where(eq(actionLog.id, req.params.id))
      .get();

    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    res.json({
      ...row,
      payloadSnapshot: JSON.parse(row.payloadSnapshot as string),
      vaultRefs: JSON.parse(row.vaultRefs as string),
      conversationRefs: JSON.parse(row.conversationRefs as string),
      projectRefs: JSON.parse(row.projectRefs as string),
    });
  });

  return router;
}
