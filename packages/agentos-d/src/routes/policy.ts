/**
 * Policy engine routes — evaluate, override, and query policy decisions.
 *
 * POST   /api/policy/evaluate      — evaluate an action envelope against active rule packs
 * GET    /api/policy/decisions     — list decisions with optional filters
 * GET    /api/policy/decisions/:id — get a single decision
 * PATCH  /api/policy/decisions/:id/override — apply a human override
 */

import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { policyDecisions, type PolicyDecisionRow } from "../db/schema.js";
import { eq, desc, and, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import {
  callPolicyCheck,
  getRulePacks,
  getRulePackLoadErrors,
  clearRulePackCache,
} from "./mcp.js";
import { isPaused } from "../pause-service.js";
import { logDecision } from "../services/policy/decisionLog.js";
import { broadcast } from "../websocket-server.js";
import { ActionEnvelopeSchema } from "@agentworks/shared";

export function createPolicyRouter(_config: Config): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // Schemas
  // -------------------------------------------------------------------------

  const EvaluateRequestSchema = z.object({
    actionId: z.string().uuid().optional(),
    tenantId: z.string().uuid(),
    actor: z.object({
      id: z.string(),
      type: z.enum(["human", "agent", "system"]),
      label: z.string(),
    }),
    contact: z
      .object({
        type: z.enum(["person", "business"]).optional(),
        label: z.string().optional(),
        address: z.string().optional(),
      })
      .optional(),
    channel: z
      .enum(["sms", "email", "voice", "chat", "api", "crm", "other"])
      .optional(),
    jurisdiction: z.string().optional(),
    consent: z
      .object({
        source: z.enum(["written", "verbal", "inferred", "none", "unknown"]),
        recordRef: z.string().optional(),
        verified: z.boolean().optional(),
      })
      .optional(),
    purpose: z.string().optional(),
    proposedAction: z.object({
      kind: z.string(),
      summary: z.string(),
    }),
    evidenceSnapshot: z.record(z.unknown()),
    shadowMode: z.boolean().optional().default(false),
  });

  const OverrideRequestSchema = z.object({
    overriddenBy: z.string(),
    overriddenByLabel: z.string(),
    originalDecision: z.enum(["allow", "block", "route_to_review"]),
    overrideReason: z.string().min(1),
  });

  // -------------------------------------------------------------------------
  // GET /api/policy/packs
  // -------------------------------------------------------------------------

  router.get("/packs", async (req, res) => {
    const packs = await getRulePacks();
    const loadErrors = getRulePackLoadErrors();
    res.json({
      items: packs.map((p) => ({
        pack_id: p.pack_id,
        pack_version: p.pack_version,
        pack_name: p.pack_name ?? null,
        pack_description: p.pack_description ?? null,
        target_action_kinds: p.target_action_kinds,
        rules_count: p.rules.length,
        industry: p.industry ?? null,
      })),
      total: packs.length,
      // loadErrors[] surfaces YAML files that failed to parse, with the
      // loader's error message. Empty when every pack loaded cleanly.
      loadErrors,
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/policy/packs/reload
  // Clears the in-memory rule pack cache and rescans RULE_PACKS_DIR.
  // Operators use this after editing a YAML on disk so they don't have to
  // recreate the daemon container to pick up the change.
  // -------------------------------------------------------------------------

  router.post("/packs/reload", async (req, res) => {
    clearRulePackCache();
    const packs = await getRulePacks();
    const loadErrors = getRulePackLoadErrors();
    res.json({
      ok: true,
      packs_loaded: packs.length,
      load_errors: loadErrors.length,
      loadErrors,
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/policy/packs/stats?tenantId=...
  // Per-pack stats for the v2 rule-packs dashboard. tenantId is optional —
  // when omitted, counts span all tenants. Computes:
  //   rulesCount   — from the loaded YAML pack
  //   fires24h     — COUNT policy_decisions where rule_pack_id = pack_id
  //                  AND decided_at >= now-24h
  //   lastFireAt   — MAX(decided_at) for the same filter (or null)
  // -------------------------------------------------------------------------

  router.get("/packs/stats", async (req, res) => {
    const tenantId = typeof req.query.tenantId === "string" ? req.query.tenantId : undefined;
    if (tenantId !== undefined && !z.string().uuid().safeParse(tenantId).success) {
      res.status(400).json({ error: "invalid_request", message: "tenantId must be a UUID" });
      return;
    }
    const packs = await getRulePacks();
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const sqlite = (getDb() as unknown as { $client: import("better-sqlite3").Database }).$client;
    const stmtAll = sqlite.prepare(
      `SELECT COUNT(*) AS fires, MAX(decided_at) AS last_fire
         FROM policy_decisions
        WHERE rule_pack_id = ? AND decided_at >= ?`,
    );
    const stmtTenant = sqlite.prepare(
      `SELECT COUNT(*) AS fires, MAX(decided_at) AS last_fire
         FROM policy_decisions
        WHERE rule_pack_id = ? AND tenant_id = ? AND decided_at >= ?`,
    );

    let totalRules = 0;
    let totalFires24h = 0;
    const items = packs.map((p) => {
      const row = (tenantId
        ? stmtTenant.get(p.pack_id, tenantId, cutoff)
        : stmtAll.get(p.pack_id, cutoff)) as { fires: number; last_fire: string | null };
      totalRules += p.rules.length;
      totalFires24h += row.fires;
      return {
        packId: p.pack_id,
        packVersion: p.pack_version,
        rulesCount: p.rules.length,
        fires24h: row.fires,
        lastFireAt: row.last_fire,
      };
    });

    res.json({
      generatedAt: new Date().toISOString(),
      windowHours: 24,
      tenantId: tenantId ?? null,
      totals: { rulesCount: totalRules, fires24h: totalFires24h },
      items,
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /api/policy/packs/:packId/mode  (AWO-187)
  // Per-pack shadow/enforce override. Upserts policy_pack_mode row.
  // -------------------------------------------------------------------------

  const PackModePatchSchema = z.object({
    mode: z.enum(["shadow", "enforce"]),
    reviewerId: z.string().min(1),
    reason: z.string().optional(),
  });

  router.patch("/packs/:packId/mode", (req, res) => {
    const parsed = PackModePatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    const { packId } = req.params;
    if (!packId || packId.length === 0) {
      res.status(400).json({ error: "missing_pack_id" });
      return;
    }
    const { mode, reviewerId, reason } = parsed.data;
    const flippedAt = new Date().toISOString();
    try {
      const db = getDb();
      // drizzle doesn't have this table in schema.ts yet; raw SQL via better-sqlite3
      // is intentional — keeps the migration self-contained without a schema rev.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sqlite = (db as any).$client as import("better-sqlite3").Database;
      sqlite
        .prepare(
          `INSERT INTO policy_pack_mode (pack_id, mode, flipped_by, flipped_at, reason)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(pack_id) DO UPDATE SET
             mode = excluded.mode,
             flipped_by = excluded.flipped_by,
             flipped_at = excluded.flipped_at,
             reason = excluded.reason`,
        )
        .run(packId, mode, reviewerId, flippedAt, reason ?? null);
      res.json({ packId, mode, flippedBy: reviewerId, flippedAt, reason: reason ?? null });
    } catch (err) {
      res.status(500).json({ error: "db_write_failed", message: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/policy/packs/:packId/draft  (AWO-195)
  // GET  /api/policy/packs/:packId/draft
  // POST /api/policy/packs/:packId/draft/promote
  // Per-pack draft staging for the rule-pack YAML editor.
  // -------------------------------------------------------------------------

  const DraftSaveSchema = z.object({
    yaml: z.string().min(1),
    savedBy: z.string().optional(),
  });

  router.post("/packs/:packId/draft", (req, res) => {
    const parsed = DraftSaveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    const { packId } = req.params;
    if (!packId) {
      res.status(400).json({ error: "missing_pack_id" });
      return;
    }
    try {
      const db = getDb();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sqlite = (db as any).$client as import("better-sqlite3").Database;
      const savedAt = new Date().toISOString();
      sqlite
        .prepare(
          `INSERT INTO rule_pack_drafts (pack_id, yaml, saved_by, saved_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(pack_id) DO UPDATE SET
             yaml = excluded.yaml,
             saved_by = excluded.saved_by,
             saved_at = excluded.saved_at`,
        )
        .run(packId, parsed.data.yaml, parsed.data.savedBy ?? null, savedAt);
      res.json({ packId, savedAt, savedBy: parsed.data.savedBy ?? null });
    } catch (err) {
      res.status(500).json({ error: "db_write_failed", message: (err as Error).message });
    }
  });

  router.get("/packs/:packId/draft", (req, res) => {
    const { packId } = req.params;
    if (!packId) {
      res.status(400).json({ error: "missing_pack_id" });
      return;
    }
    try {
      const db = getDb();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sqlite = (db as any).$client as import("better-sqlite3").Database;
      const row = sqlite
        .prepare(
          `SELECT pack_id as packId, yaml, saved_by as savedBy, saved_at as savedAt
             FROM rule_pack_drafts WHERE pack_id = ?`,
        )
        .get(packId);
      if (!row) {
        res.status(404).json({ error: "no_draft" });
        return;
      }
      res.json(row);
    } catch (err) {
      res.status(500).json({ error: "db_read_failed", message: (err as Error).message });
    }
  });

  router.post("/packs/:packId/draft/promote", (req, res) => {
    const { packId } = req.params;
    if (!packId) {
      res.status(400).json({ error: "missing_pack_id" });
      return;
    }
    // The promote step deletes the draft row and returns the YAML the caller
    // can then PUT to /api/policy/rule-packs/:id (the existing replace path).
    // Atomic file replacement is the rule-pack-loader's responsibility, kept
    // separate so this route stays lane-clean.
    try {
      const db = getDb();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sqlite = (db as any).$client as import("better-sqlite3").Database;
      const row = sqlite
        .prepare(
          `SELECT pack_id as packId, yaml, saved_by as savedBy, saved_at as savedAt
             FROM rule_pack_drafts WHERE pack_id = ?`,
        )
        .get(packId);
      if (!row) {
        res.status(404).json({ error: "no_draft" });
        return;
      }
      sqlite.prepare("DELETE FROM rule_pack_drafts WHERE pack_id = ?").run(packId);
      res.json({ promoted: true, draft: row });
    } catch (err) {
      res.status(500).json({ error: "db_write_failed", message: (err as Error).message });
    }
  });

  router.get("/packs/:packId/mode", (req, res) => {
    const { packId } = req.params;
    if (!packId) {
      res.status(400).json({ error: "missing_pack_id" });
      return;
    }
    try {
      const db = getDb();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sqlite = (db as any).$client as import("better-sqlite3").Database;
      const row = sqlite
        .prepare(
          `SELECT pack_id as packId, mode, flipped_by as flippedBy,
                  flipped_at as flippedAt, reason
             FROM policy_pack_mode WHERE pack_id = ?`,
        )
        .get(packId) as
        | { packId: string; mode: string; flippedBy: string | null; flippedAt: string; reason: string | null }
        | undefined;
      if (!row) {
        res.json({ packId, mode: "shadow", flippedBy: null, flippedAt: null, reason: null });
        return;
      }
      res.json(row);
    } catch (err) {
      res.status(500).json({ error: "db_read_failed", message: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/policy/evaluate
  // -------------------------------------------------------------------------

  router.post("/evaluate", async (req, res) => {
    // Validate against the canonical action envelope schema first
    const envParsed = ActionEnvelopeSchema.safeParse(req.body);
    if (!envParsed.success) {
      res.status(400).json({ error: "invalid_action_envelope", details: envParsed.error.flatten() });
      return;
    }

    const parsed = EvaluateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }

    if (isPaused()) {
      res.status(503).json({ error: "service_paused" });
      return;
    }

    const body = parsed.data;
    const now = new Date().toISOString();
    const actionId = body.actionId ?? randomUUID();

    // Policy engine evaluation: the full rule-pack evaluation path is
    // callPolicyCheck (used by /api/policy/check). This endpoint applies a
    // minimal fallback: allow by default, route-to-review when consent
    // source != "none" but verified === false (handles common TCPA pattern).
    let decision: "allow" | "block" | "route_to_review" = "allow";
    let decisionReason = "default_allow";

    if (
      body.consent &&
      body.consent.source !== "none" &&
      body.consent.verified === false
    ) {
      decision = "route_to_review";
      decisionReason = "unverified_consent_requires_review";
    }

    const { decisionId, approvalQueueId } = logDecision({
      tenantId: body.tenantId,
      actionId,
      actor: body.actor,
      ...(body.contact
        ? {
            contact: {
              type: body.contact.type ?? "person",
              label: body.contact.label ?? "",
              address: body.contact.address ?? "",
            },
          }
        : {}),
      channel: body.channel,
      jurisdiction: body.jurisdiction,
      consent: body.consent
        ? {
            source: body.consent.source,
            recordRef: body.consent.recordRef,
            verified: body.consent.verified,
          }
        : undefined,
      purpose: body.purpose,
      ...(body.proposedAction && {
        proposedAction: {
          kind: body.proposedAction.kind,
          summary: body.proposedAction.summary,
        },
      }),
      evidenceSnapshot: body.evidenceSnapshot,
      decision,
      decisionReason,
      shadowMode: body.shadowMode ?? false,
    });

    // WebSocket broadcast: notify admin-ui inbox immediately when an approval is queued.
    // This satisfies the <2s latency requirement for criterion #6.
    if (approvalQueueId) {
      broadcast({
        type: "approval_enqueued",
        approvalQueueId,
        tenantId: body.tenantId,
        actorLabel: body.actor.label ?? "",
        proposedActionKind: body.proposedAction?.kind ?? "unknown",
        proposedActionSummary: body.proposedAction?.summary ?? "",
        decisionReason,
        enqueuedAt: now,
      });
    }

    res.status(201).json({
      decisionId,
      actionId,
      decision,
      decisionReason,
      shadowMode: body.shadowMode ?? false,
      rulePackId: null,
      rulePackVersion: null,
      createdAt: now,
      approvalQueueId: approvalQueueId ?? null,
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/policy/check
  //
  // n8n-friendly thin REST wrapper around the canonical policy.check pipeline
  // exported from routes/mcp.ts. Accepts the simpler shape that custom n8n
  // nodes pass through workflows; same evaluation logic, same hash chain.
  //
  //   request:  { actionKind, payload, actorId, tenantId, actorLabel? }
  //   response: { decision, ruleId, reason, requestId, reviewed }
  // -------------------------------------------------------------------------

  const PolicyCheckRestSchema = z.object({
    tenantId: z.string().uuid(),
    actionKind: z.string().min(1),
    payload: z.record(z.unknown()).default({}),
    actorId: z.string().min(1),
    actorLabel: z.string().optional(),
    actorType: z.enum(["human", "agent", "system"]).optional(),
    summary: z.string().optional(),
    shadowMode: z.boolean().optional(),
  });

  router.post("/check", async (req, res) => {
    if (isPaused()) {
      res.status(503).json({ error: "substrate_paused", reason: "substrate is paused" });
      return;
    }
    const parsed = PolicyCheckRestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    const body = parsed.data;
    const argsBase = {
      tenantId: body.tenantId,
      actor: {
        id: body.actorId,
        type: body.actorType ?? ("agent" as const),
        label: body.actorLabel ?? body.actorId,
      },
      proposedAction: {
        kind: body.actionKind,
        summary: body.summary ?? body.actionKind,
      },
      evidenceSnapshot: body.payload,
    };
    const args = body.shadowMode === undefined
      ? argsBase
      : { ...argsBase, shadowMode: body.shadowMode };

    const result = await callPolicyCheck(args, _config);
    const text = result.content[0]?.text ?? "{}";
    let inner: Record<string, unknown> = {};
    try {
      inner = JSON.parse(text) as Record<string, unknown>;
    } catch {
      res.status(500).json({ error: "policy_check_payload_unparseable" });
      return;
    }
    if (result.isError) {
      res.status(500).json({ error: "policy_check_failed", details: inner });
      return;
    }
    res.status(200).json({
      decision: inner.decision,
      ruleId: inner.rulePackId ?? null,
      reason: inner.decisionReason,
      requestId: inner.actionId,
      decisionId: inner.decisionId,
      shadowMode: inner.shadowMode,
      approvalQueueId: inner.approvalQueueId ?? null,
      reviewed: false,
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/policy/decisions
  // -------------------------------------------------------------------------

  router.get("/decisions", (req, res) => {
    const db = getDb();
    const { tenantId, decision, limit = "50", offset = "0" } = req.query;

    const conditions = [];
    if (tenantId) conditions.push(eq(policyDecisions.tenantId, tenantId as string));
    if (decision)
      conditions.push(
        eq(policyDecisions.decision, decision as "allow" | "block" | "route_to_review")
      );

    const rows = db
      .select()
      .from(policyDecisions)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(policyDecisions.createdAt))
      .limit(Number(limit))
      .offset(Number(offset))
      .all();

    const total = db
      .select({ count: sql<number>`count(*)` })
      .from(policyDecisions)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .get()?.count ?? 0;

    res.json({ items: rows, total, limit: Number(limit), offset: Number(offset) });
  });

  // -------------------------------------------------------------------------
  // GET /api/policy/decisions/:id
  // -------------------------------------------------------------------------

  router.get("/decisions/:id", (req, res) => {
    const db = getDb();
    const row = db
      .select()
      .from(policyDecisions)
      .where(eq(policyDecisions.id, req.params.id))
      .get();

    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(row);
  });

  // -------------------------------------------------------------------------
  // PATCH /api/policy/decisions/:id/override
  // -------------------------------------------------------------------------

  router.patch("/decisions/:id/override", (req, res) => {
    const parsed = OverrideRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }

    const db = getDb();
    const now = new Date().toISOString();

    const existing = db
      .select()
      .from(policyDecisions)
      .where(eq(policyDecisions.id, req.params.id))
      .get();

    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const { overriddenBy, overriddenByLabel, originalDecision, overrideReason } = parsed.data;

    db.update(policyDecisions)
      .set({
        overriddenBy,
        overriddenByLabel,
        originalDecision,
        overrideReason,
        overriddenAt: now,
        decision: originalDecision === "route_to_review" ? "allow" : originalDecision,
        updatedAt: now,
      })
      .where(eq(policyDecisions.id, req.params.id))
      .run();

    const updated = db
      .select()
      .from(policyDecisions)
      .where(eq(policyDecisions.id, req.params.id))
      .get();

    res.json(updated);
  });

  return router;
}
