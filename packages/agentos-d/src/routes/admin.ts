/**
 * Admin routes — scope_violations telemetry.
 *
 * POST /api/admin/scope-violations
 *   Body: { revertedFromCommit, agentRunId?, agentId?, agentRole?, files: string[], reason?, revertedAt? }
 *   Returns: { id } — the created violation record
 *
 * GET /api/admin/scope-violations
 *   Query: ?agentId=&since=&limit=
 *   Returns: { items: ScopeViolationRow[] }
 *
 * GET /api/admin/scope-violations/summary
 *   Query: ?agentId=
 *   Returns: { agentId, totalReverts, topDirectories: string[], recentReverts: ScopeViolationRow[] }
 *
 * The scope-guard daemon (Coordinator-side) calls POST after each revert.
 * Admin UI reads via GET /summary.
 *
 * POST /api/admin/autopilot/dispatch
 *   Body: { actionIds: string[], idempotencyKey: string, dryRun?: boolean }
 *   Returns: { dispatched: number, skipped: number, failed: number, results: AutopilotResult[] }
 *
 * Bulk-dispatch the safe bucket. Evaluates actions for autopilot bucketing
 * and auto-executes those in the safe bucket (riskScore ≤ 0.3, no block rules).
 */

import type { Config } from "../config.js";
import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { eq, desc, and, gte, sql, inArray } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { compatProxyEvents, scopeViolations, approvalQueue, policyDecisions, actionLog, tenants } from "../db/schema.js";
import { getGraph } from "../services/mission-map.js";

const CreateViolationSchema = z.object({
  revertedFromCommit: z.string().min(1),
  agentRunId: z.string().optional(),
  agentId: z.string().optional(),
  agentRole: z.string().optional(),
  files: z.array(z.string()).min(1),
  reason: z.string().optional(),
  revertedAt: z.string().optional(), // ISO datetime; defaults to now
});

/**
 * Calculate autopilot bucket for various data structures.
 * Supports approval queue items, dispatch queue items, and policy decisions.
 */
function calculateAutopilotBucket(item: {
  decision?: string;
  proposed_action_kind?: string;
  proposedActionKind?: string;
  decision_reason?: string;
  decisionReason?: string;
  policy_decision_id?: string;
}): {
  decision: "allow" | "needsApproval" | "risky";
  riskScore: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  
  // Start with base risk from decision
  let riskScore = 0.0;
  const decision = item.decision || "allow";
  const actionKind = item.proposed_action_kind || item.proposedActionKind || "unknown";
  const decisionReason = item.decision_reason || item.decisionReason || "";
  
  // If any rule blocked, it's automatically risky
  if (decision === "block") {
    reasons.push("rule_pack.block");
    return {
      decision: "risky",
      riskScore: 1.0,
      reasons,
    };
  }

  // Calculate risk score based on decision type
  if (decision === "route_to_review") {
    riskScore = 0.4; // Base risk for route_to_review
    reasons.push("action_type.moderate_risk");
  }

  // Add action type risk (simplified for now)
  const actionTypeRisk = getActionTypeRisk(actionKind);
  riskScore = Math.max(riskScore, actionTypeRisk);
  
  if (actionTypeRisk >= 0.5) {
    reasons.push("action_type.high_risk");
  }

  // Add content-based risks from decision reason
  const contentRisks = getContentRisks(decisionReason);
  riskScore = Math.max(riskScore, contentRisks.score);
  reasons.push(...contentRisks.reasons);

  // Determine bucket based on risk score
  if (riskScore >= 0.7) {
    return {
      decision: "risky",
      riskScore,
      reasons,
    };
  } else if (riskScore <= 0.3 && decision === "allow" && reasons.length === 0) {
    return {
      decision: "allow",
      riskScore,
      reasons: reasons.length > 0 ? reasons : ["low_risk_action"],
    };
  } else {
    return {
      decision: "needsApproval",
      riskScore,
      reasons,
    };
  }
}

/**
 * Get risk score for action type based on the spec table
 */
function getActionTypeRisk(actionKind: string): number {
  const riskTable: Record<string, number> = {
    "memory.write": 0.10,
    "memory_write": 0.10,
    "file.read": 0.05,
    "file_read": 0.05,
    "http.get": 0.10,
    "http_get": 0.10,
    "http.post": 0.35,
    "http_post": 0.35,
    "shell.read_only": 0.10,
    "shell_read_only": 0.10,
    "shell.mutating": 0.50,
    "shell_mutating": 0.50,
    "email.send": 0.45,
    "email_send": 0.45,
    "sms.send": 0.55,
    "sms_send": 0.55,
    "db.write": 0.40,
    "db_write": 0.40,
  };
  
  return riskTable[actionKind] || 0.30; // Default moderate risk
}

/**
 * Extract content-based risks from decision reason
 */
function getContentRisks(decisionReason: string): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0.0;
  
  const lowerReason = decisionReason.toLowerCase();
  
  if (lowerReason.includes("tcpa") && lowerReason.includes("time")) {
    score = Math.max(score, 0.5);
    reasons.push("tcpa.time_of_day");
  }
  
  if (lowerReason.includes("fair housing") || lowerReason.includes("protected class")) {
    score = Math.max(score, 0.3);
    reasons.push("fair_housing.keyword_match");
  }
  
  if (lowerReason.includes("pii") || lowerReason.includes("phi")) {
    score = Math.max(score, 0.6);
    reasons.push("pii.high_confidence");
  }
  
  if (lowerReason.includes("consent") || lowerReason.includes("dnc")) {
    score = Math.max(score, 0.4);
    reasons.push("consent.unverified");
  }
  
  return { score, reasons };
}

export function createAdminRouter(_config: Config): Router {
  const router = Router();

  router.get("/compat-proxy-events", async (req, res) => {
    const { statusCode, since, limit = "100" } = req.query as Record<string, string>;
    const db = getDb();

    const conditions = [];
    if (statusCode) conditions.push(eq(compatProxyEvents.statusCode, Number(statusCode)));
    if (since) conditions.push(gte(compatProxyEvents.createdAt, since));

    const limitNum = Math.min(parseInt(limit, 10) || 100, 1000);
    const rows = db
      .select()
      .from(compatProxyEvents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(compatProxyEvents.createdAt))
      .limit(limitNum)
      .all();

    res.json({ items: rows });
  });

  // POST /api/admin/scope-violations — write a violation record
  router.post("/scope-violations", async (req, res) => {
    const parsed = CreateViolationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }

    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();
    const row = {
      id,
      revertedFromCommit: parsed.data.revertedFromCommit,
      agentRunId: parsed.data.agentRunId ?? null,
      agentId: parsed.data.agentId ?? null,
      agentRole: parsed.data.agentRole ?? null,
      files: JSON.stringify(parsed.data.files),
      reason: parsed.data.reason ?? null,
      revertedAt: parsed.data.revertedAt ?? now,
      createdAt: now,
    };

    db.insert(scopeViolations).values(row).run();
    res.status(201).json({ id });
  });

  // GET /api/admin/scope-violations — list violations with optional filters
  router.get("/scope-violations", async (req, res) => {
    const { agentId, since, limit = "100" } = req.query as Record<string, string>;
    const db = getDb();

    const conditions = [];
    if (agentId) conditions.push(eq(scopeViolations.agentId, agentId));
    if (since) conditions.push(gte(scopeViolations.revertedAt, since));

    const limitNum = Math.min(parseInt(limit, 10) || 100, 1000);
    const rows = db
      .select()
      .from(scopeViolations)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(scopeViolations.revertedAt))
      .limit(limitNum)
      .all();

    const items = rows.map((r) => ({
      ...r,
      files: JSON.parse(r.files as string) as string[],
    }));

    res.json({ items });
  });

  // GET /api/admin/scope-violations/summary — aggregated per-agent summary
  router.get("/scope-violations/summary", async (req, res) => {
    const { agentId } = req.query as Record<string, string>;
    const db = getDb();

    // Count total reverts per agent (or all)
    const countRows = db
      .select({
        agentId: scopeViolations.agentId,
        count: sql<number>`count(*)`.as("count"),
      })
      .from(scopeViolations)
      .where(agentId ? eq(scopeViolations.agentId, agentId) : undefined)
      .groupBy(scopeViolations.agentId)
      .all();

    // Per-agent top directories from files
    const dirCount: Record<string, Record<string, number>> = {};
    const recentRows = db
      .select()
      .from(scopeViolations)
      .where(agentId ? eq(scopeViolations.agentId, agentId) : undefined)
      .orderBy(desc(scopeViolations.revertedAt))
      .limit(20)
      .all();

    for (const row of recentRows) {
      const aid = row.agentId ?? "(unknown)";
      if (!dirCount[aid]) dirCount[aid] = {};
      const files = JSON.parse(row.files as string) as string[];
      for (const f of files) {
        const dir = f.split("/").slice(0, 3).join("/"); // top-3 path segments
        dirCount[aid][dir] = (dirCount[aid][dir] ?? 0) + 1;
      }
    }

    const summaries = countRows.map(({ agentId: aid, count }) => {
      const topDirs = Object.entries(dirCount[aid ?? ""] ?? {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([dir, c]) => ({ dir, count: c }));

      return {
        agentId: aid,
        totalReverts: count,
        topDirectories: topDirs,
      };
    });

    res.json({ summaries });
  });

  /**
   * GET /api/admin/activity-log
   * Same shape as ActivityLogEntry consumed by the Activity Log page.
   * Joins action_log with policy_decisions to surface outcome.
   */
  router.get("/activity-log", (req, res) => {
    const sqlite = getDb().$client;
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 1000);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
    const tenantId = typeof req.query.tenantId === "string" ? req.query.tenantId : null;
    const agentId = typeof req.query.agentId === "string" ? req.query.agentId : null;
    const actionKind = typeof req.query.actionKind === "string" ? req.query.actionKind : null;
    const decision = typeof req.query.decision === "string" ? req.query.decision : null;
    const from = typeof req.query.from === "string" ? req.query.from : null;
    const to = typeof req.query.to === "string" ? req.query.to : null;

    const where: string[] = [];
    const params: unknown[] = [];
    if (tenantId)   { where.push("a.tenant_id = ?"); params.push(tenantId); }
    if (agentId)    { where.push("a.actor_id = ?");  params.push(agentId); }
    if (actionKind) { where.push("a.action_kind = ?"); params.push(actionKind); }
    if (decision)   { where.push("p.decision = ?"); params.push(decision); } // outcome filter
    if (from)       { where.push("a.logged_at >= ?"); params.push(from); }
    if (to)         { where.push("a.logged_at <= ?"); params.push(to); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const rows = sqlite
      .prepare(
        `SELECT a.id, a.tenant_id, a.actor_id, a.actor_label, a.action_kind,
                COALESCE(p.decision, 'allow') AS outcome, a.logged_at AS timestamp
         FROM action_log a
         LEFT JOIN policy_decisions p ON p.id = a.policy_decision_id
         ${whereSql}
         ORDER BY a.logged_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as Array<{
        id: string; tenant_id: string; actor_id: string; actor_label: string;
        action_kind: string; outcome: string; timestamp: string;
      }>;

    res.json(rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      actorId: r.actor_id,
      actorLabel: r.actor_label,
      actionKind: r.action_kind,
      outcome: r.outcome,
      timestamp: r.timestamp,
    })));
  });

  /**
   * GET /api/admin/triage-queue
   * Issues with no assignee — the inbox the operator needs to fan out.
   * Returns suggestedRoles by simple title heuristic so the UI's role-picker
   * can prefill. Real auto-routing lives in /api/issues/lanes (RFC 008).
   */
  router.get("/triage-queue", (_req, res) => {
    const sqlite = getDb().$client;
    const issueRows = sqlite
      .prepare(
        `SELECT id, identifier, title, priority, created_at, metadata_json
         FROM execution_issues
         WHERE assignee_agent_id IS NULL
           AND status IN ('todo','triage','inbox','in_progress')
         ORDER BY
           CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                         WHEN 'medium' THEN 2 ELSE 3 END,
           created_at DESC
         LIMIT 200`
      )
      .all() as Array<{ id: string; identifier: string | null; title: string; priority: string; created_at: string; metadata_json: string | null }>;

    const agentRows = sqlite
      .prepare(
        `SELECT id, name, COALESCE(role,'') AS title FROM execution_agents WHERE status = 'active' ORDER BY name`
      )
      .all() as Array<{ id: string; name: string; title: string }>;

    const issues = issueRows.map((r) => {
      const lower = r.title.toLowerCase();
      const suggested: string[] = [];
      if (/(spec|design|plan|contract)/.test(lower)) suggested.push("pm");
      if (/(impl|implement|api|endpoint|backend|fix|refactor|build)/.test(lower)) suggested.push("engineer");
      if (/(qa|test|smoke|verify|review)/.test(lower)) suggested.push("qa");
      if (/(doc|write|publish|memo)/.test(lower)) suggested.push("writer");
      return {
        id: r.id,
        identifier: r.identifier ?? r.id.slice(0, 8),
        title: r.title,
        priority: r.priority,
        createdAt: r.created_at,
        matchedRole: suggested[0] ?? null,
        triageReason: suggested.length === 0 ? "no role match" : null,
        suggestedRoles: suggested,
      };
    });

    res.json({ issues, agents: agentRows, count: issues.length });
  });

  router.post("/triage-queue/assign", (req, res) => {
    const Body = z.object({
      issueId: z.string().uuid(),
      assigneeAgentId: z.string().uuid(),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    const sqlite = getDb().$client;
    const exists = sqlite
      .prepare("SELECT 1 FROM execution_agents WHERE id = ?")
      .get(parsed.data.assigneeAgentId);
    if (!exists) {
      res.status(404).json({ error: "agent_not_found" });
      return;
    }
    const issueRow = sqlite
      .prepare(
        "SELECT tenant_id, identifier, project_id, assignee_agent_id FROM execution_issues WHERE id = ?"
      )
      .get(parsed.data.issueId) as
        | { tenant_id: string; identifier: string | null; project_id: string; assignee_agent_id: string | null }
        | undefined;
    const now = new Date().toISOString();
    const result = sqlite
      .prepare(
        `UPDATE execution_issues SET assignee_agent_id = ?, updated_at = ? WHERE id = ?`
      )
      .run(parsed.data.assigneeAgentId, now, parsed.data.issueId);
    if (result.changes === 0) {
      res.status(404).json({ error: "issue_not_found" });
      return;
    }
    if (issueRow) {
      sqlite
        .prepare(
          `INSERT INTO action_log
           (id, tenant_id, actor_id, actor_type, actor_label, action_kind,
            payload_snapshot, vault_refs, conversation_refs, project_refs,
            policy_decision_id, proposed_at, logged_at)
           VALUES (?, ?, ?, 'system', 'Coordinator', 'issue.assign', ?, '[]', '[]', ?, NULL, ?, ?)`
        )
        .run(
          randomUUID(),
          issueRow.tenant_id,
          parsed.data.assigneeAgentId,
          JSON.stringify({
            issueId: parsed.data.issueId,
            identifier: issueRow.identifier,
            from: issueRow.assignee_agent_id,
            to: parsed.data.assigneeAgentId,
          }),
          JSON.stringify([issueRow.project_id]),
          now,
          now,
        );
    }
    res.json({ success: true, issue: { id: parsed.data.issueId, assigneeAgentId: parsed.data.assigneeAgentId } });
  });

  /**
   * GET /api/admin/decisions-per-min
   * Mission Control KPI cell. Returns rolling rate over the trailing window.
   */
  router.get("/decisions-per-min", (req, res) => {
    const windowMin = Number(req.query.windowMinutes ?? 60);
    const w = Number.isFinite(windowMin) && windowMin > 0 ? windowMin : 60;
    const cutoff = new Date(Date.now() - w * 60_000).toISOString();
    const sqlite = getDb().$client;
    const tenantId = typeof req.query.tenantId === "string" ? req.query.tenantId : null;
    const params: unknown[] = [cutoff];
    let where = `created_at >= ?`;
    if (tenantId) { where += ` AND tenant_id = ?`; params.push(tenantId); }
    const row = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM policy_decisions WHERE ${where}`)
      .get(...params) as { n: number };
    const perMin = row.n / w;
    res.json({ windowMinutes: w, total: row.n, perMin: Math.round(perMin * 100) / 100 });
  });

  /**
   * GET /api/admin/process-health
   * Per-agent compliance digest. Built from action_log + policy_decisions
   * counts. Without scope-violation data we report pass-only; once the
   * scope-guard daemon is wired up this will populate flag + autoFix.
   */
  router.get("/process-health", (_req, res) => {
    const sqlite = getDb().$client;
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const todayIso = today.toISOString();

    const totalActions = (sqlite
      .prepare("SELECT COUNT(*) AS n FROM action_log WHERE proposed_at >= ?")
      .get(todayIso) as { n: number }).n;
    const violationsCaught = (sqlite
      .prepare("SELECT COUNT(*) AS n FROM policy_decisions WHERE created_at >= ? AND decision IN ('block','route_to_review')")
      .get(todayIso) as { n: number }).n;

    const agents = sqlite
      .prepare(`SELECT id, name FROM execution_agents WHERE status = 'active' ORDER BY name`)
      .all() as Array<{ id: string; name: string }>;

    // Per-agent: count actions, blocks, routes today
    const agentDigests = agents.map((a) => {
      const pass = (sqlite
        .prepare(`SELECT COUNT(*) AS n FROM action_log WHERE actor_id = ? AND proposed_at >= ?`)
        .get(a.id, todayIso) as { n: number }).n;
      const flag = (sqlite
        .prepare(`SELECT COUNT(*) AS n FROM policy_decisions WHERE actor_id = ? AND created_at >= ? AND decision IN ('block','route_to_review')`)
        .get(a.id, todayIso) as { n: number }).n;
      return {
        agentId: a.id,
        agentName: a.name,
        checks: [
          { checkId: "actions", label: "Actions", pass, flag, autoFix: 0 },
        ],
      };
    });

    // Top offenders: agents with the most flags today.
    const topOffenders = agentDigests
      .map((d) => ({
        agentId: d.agentId,
        agentName: d.agentName,
        totalFlags: d.checks.reduce((s, c) => s + c.flag, 0),
        topCheck: "actions",
        topSeverity: "warn" as const,
      }))
      .filter((o) => o.totalFlags > 0)
      .sort((a, b) => b.totalFlags - a.totalFlags)
      .slice(0, 5);

    res.json({
      digest: {
        today: { totalActions, violationsCaught },
        period: "today",
        generatedAt: new Date().toISOString(),
        agents: agentDigests,
        topOffenders,
        checkDefinitions: [
          { checkId: "actions", label: "Actions", description: "Total proposed actions logged today" },
        ],
      },
    });
  });

  /**
   * POST /api/admin/autopilot/dispatch
   * Bulk-dispatch the safe bucket. Evaluates actions for autopilot bucketing
   * and auto-executes those in the safe bucket (riskScore ≤ 0.3, no block rules).
   */
  const AutopilotDispatchSchema = z.object({
    actionIds: z.array(z.string().uuid()).min(1).max(50), // 50 actions per batch max
    idempotencyKey: z.string().min(1).max(128),
    dryRun: z.boolean().optional().default(false),
  });

  interface AutopilotResult {
    actionId: string;
    decision: "allow" | "needsApproval" | "risky";
    riskScore: number;
    reasons: string[];
    dispatched: boolean;
  }

  router.post("/autopilot/dispatch", async (req, res) => {
    const parsed = AutopilotDispatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }

    const db = getDb();
    const { actionIds, idempotencyKey, dryRun } = parsed.data;

    // Check for existing dispatch with this idempotency key
    const existingDispatch = db
      .select()
      .from(approvalQueue)
      .where(eq(approvalQueue.idempotencyKey, idempotencyKey))
      .limit(1)
      .get();

    if (existingDispatch) {
      // Return cached results for idempotency
      const results = db
        .select({
          actionId: approvalQueue.policyDecisionId,
          decision: approvalQueue.autopilotDecision,
          riskScore: approvalQueue.riskScore,
          reasons: approvalQueue.reasons,
          dispatched: sql<boolean>`${approvalQueue.dispatchedAt} IS NOT NULL`,
        })
        .from(approvalQueue)
        .where(eq(approvalQueue.idempotencyKey, idempotencyKey))
        .all()
        .map(row => ({
          actionId: row.actionId,
          decision: row.decision || "needsApproval",
          riskScore: row.riskScore || 0,
          reasons: row.reasons ? JSON.parse(row.reasons) as string[] : [],
          dispatched: Boolean(row.dispatched),
        }));

      const dispatched = results.filter(r => r.dispatched).length;
      const skipped = results.filter(r => !r.dispatched).length;

      res.json({
        dispatched,
        skipped,
        failed: 0,
        results,
        idempotent: true,
      });
      return;
    }

    // Get policy decisions for the requested actions
    const decisions = db
      .select()
      .from(policyDecisions)
      .where(inArray(policyDecisions.actionId, actionIds))
      .all();

    if (decisions.length === 0) {
      res.status(404).json({ error: "no_actions_found" });
      return;
    }

    const results: AutopilotResult[] = [];
    let dispatchedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const decision of decisions) {
      try {
        // Calculate autopilot bucket and risk score
        const autopilotResult = calculateAutopilotBucket(decision);
        
        results.push({
          actionId: decision.actionId,
          decision: autopilotResult.decision,
          riskScore: autopilotResult.riskScore,
          reasons: autopilotResult.reasons,
          dispatched: false, // Will update below
        });

        if (dryRun) {
          // In dry run mode, just calculate and return results
          if (autopilotResult.decision === "allow") dispatchedCount++;
          else skippedCount++;
          continue;
        }

        // Update approval queue with autopilot decision
        const now = new Date().toISOString();
        const dispatchedAt = autopilotResult.decision === "allow" ? now : null;
        const existingQueueRow = db
          .select({ id: approvalQueue.id })
          .from(approvalQueue)
          .where(eq(approvalQueue.policyDecisionId, decision.id))
          .get();

        const queueUpdate = {
          autopilotDecision: autopilotResult.decision,
          riskScore: autopilotResult.riskScore,
          reasons: JSON.stringify(autopilotResult.reasons),
          idempotencyKey,
          dispatchedAt,
          updatedAt: now,
        };

        if (existingQueueRow) {
          db.update(approvalQueue)
            .set(queueUpdate)
            .where(eq(approvalQueue.policyDecisionId, decision.id))
            .run();
        } else {
          db.insert(approvalQueue)
            .values({
              id: randomUUID(),
              policyDecisionId: decision.id,
              tenantId: decision.tenantId,
              actorLabel: decision.actorLabel,
              proposedActionKind: decision.proposedActionKind,
              proposedActionSummary: decision.proposedActionSummary,
              decisionReason: decision.decisionReason,
              status: autopilotResult.decision === "allow" ? "approved" : "pending",
              ...queueUpdate,
              createdAt: now,
            })
            .run();
        }

        if (autopilotResult.decision === "allow") {
          // Auto-execute the action by creating an action log entry
          const actionLogId = randomUUID();
          db.insert(actionLog)
            .values({
              id: actionLogId,
              tenantId: decision.tenantId,
              actorId: decision.actorId,
              actorType: decision.actorType,
              actorLabel: decision.actorLabel,
              actionKind: decision.proposedActionKind,
              payloadSnapshot: "{}", // Minimal payload for auto-executed actions
              vaultRefs: "[]",
              conversationRefs: "[]",
              projectRefs: "[]",
              policyDecisionId: decision.id,
              proposedAt: decision.proposedAt,
              loggedAt: now,
            })
            .run();

          dispatchedCount++;
        } else {
          skippedCount++;
        }

        // Update the result to reflect actual dispatch status
        const resultIndex = results.findIndex(r => r.actionId === decision.actionId);
        const target = resultIndex !== -1 ? results[resultIndex] : undefined;
        if (target) {
          target.dispatched = autopilotResult.decision === "allow";
        }

      } catch (error) {
        failedCount++;
        console.error(`Failed to process action ${decision.actionId}:`, error);
      }
    }

    res.json({
      dispatched: dispatchedCount,
      skipped: skippedCount,
      failed: failedCount,
      results,
      idempotent: false,
    });
  });

  /**
   * GET /api/admin/autopilot
   * Returns bucketing summary for autopilot: {safe, needsApproval, risky}
   * Computed from triage queue + policy decisions + dispatch queue + idle-agent state
   */
  router.get("/autopilot", (req, res) => {
    try {
      const { tenantId } = req.query as Record<string, string>;
      
      if (!tenantId) {
        res.status(400).json({ error: "tenantId required" });
        return;
      }

      const sqlite = getDb().$client;
      
      // Get pending actions from various sources
      const now = new Date().toISOString();
      
      // 1. Get unassigned issues from triage queue (issues with no assignee)
      let triageIssues: Array<{
        id: string;
        title: string;
        priority: string;
        created_at: string;
        metadata_json: string | null;
      }> = [];
      
      try {
        triageIssues = sqlite
          .prepare(`
            SELECT ei.id, ei.title, ei.priority, ei.created_at, ei.metadata_json
            FROM execution_issues ei
            JOIN execution_companies ec ON ei.company_id = ec.id
            WHERE ec.tenant_id = ?
              AND ei.assignee_agent_id IS NULL
              AND ei.status IN ('todo','triage','inbox','in_progress')
          `)
          .all(tenantId) as typeof triageIssues;
      } catch (error) {
        console.error("Error fetching triage issues:", error);
        // Continue with empty triage issues if table doesn't exist yet
      }

      // 2. Get pending approval queue items
      let approvalQueueItems: Array<{
        id: string;
        policy_decision_id: string;
        proposed_action_kind: string;
        decision_reason: string;
        decision: string;
        proposed_at: string;
        actor_label: string;
      }> = [];
      
      try {
        approvalQueueItems = sqlite
          .prepare(`
            SELECT aq.id, aq.policy_decision_id, aq.proposed_action_kind, aq.decision_reason,
                   pd.decision, pd.proposed_at, pd.actor_label
            FROM approval_queue aq
            JOIN policy_decisions pd ON aq.policy_decision_id = pd.id
            WHERE aq.tenant_id = ? AND aq.status = 'pending'
          `)
          .all(tenantId) as typeof approvalQueueItems;
      } catch (error) {
        console.error("Error fetching approval queue items:", error);
        // Continue with empty approval queue if table doesn't exist yet
      }

      // 3. Get queued dispatch items
      let dispatchQueueItems: Array<{
        id: string;
        task_kind: string;
        input: string;
        policy_decision_id: string | null;
        decision: string | null;
        proposed_at: string;
        actor_label: string;
      }> = [];
      
      try {
        dispatchQueueItems = sqlite
          .prepare(`
            SELECT dq.id, dq.task_kind, dq.input, dq.policy_decision_id,
                   pd.decision, pd.proposed_at, pd.actor_label
            FROM dispatch_queue dq
            LEFT JOIN policy_decisions pd ON dq.policy_decision_id = pd.id
            WHERE dq.tenant_id = ? AND dq.status = 'queued'
          `)
          .all(tenantId) as typeof dispatchQueueItems;
      } catch (error) {
        console.error("Error fetching dispatch queue items:", error);
        // Continue with empty dispatch queue if table doesn't exist yet
      }

      // 4. Get recent policy decisions that might need autopilot evaluation
      let recentDecisions: Array<{
        id: string;
        action_id: string;
        decision: string;
        proposed_action_kind: string;
        decision_reason: string;
        proposed_at: string;
      }> = [];
      
      try {
        recentDecisions = sqlite
          .prepare(`
            SELECT id, action_id, decision, proposed_action_kind, decision_reason, proposed_at
            FROM policy_decisions
            WHERE tenant_id = ?
              AND proposed_at >= datetime(?, '-1 hour')
              AND decision IN ('allow', 'route_to_review')
              AND id NOT IN (SELECT policy_decision_id FROM approval_queue WHERE tenant_id = ?)
            ORDER BY proposed_at DESC
            LIMIT 100
          `)
          .all(tenantId, now, tenantId) as typeof recentDecisions;
      } catch (error) {
        console.error("Error fetching recent decisions:", error);
        // Continue with empty recent decisions if query fails
      }

      // Initialize counters
      let safe = 0;
      let needsApproval = 0;
      let risky = 0;

      // Process triage issues - these typically need approval as they require human assignment
      needsApproval += triageIssues.length;

      // Process approval queue items
      for (const item of approvalQueueItems) {
        const evaluation = calculateAutopilotBucket(item);
        
        switch (evaluation.decision) {
          case "allow":
            safe++;
            break;
          case "needsApproval":
            needsApproval++;
            break;
          case "risky":
            risky++;
            break;
        }
      }

      // Process dispatch queue items. calculateAutopilotBucket expects a
      // shape with non-null decision/proposed_action_kind/decision_reason;
      // dispatch_queue rows can be null on those fields if the dispatch
      // pre-dates a policy decision. Adapt safely.
      for (const item of dispatchQueueItems) {
        const arg: { decision?: string; proposed_action_kind?: string; decision_reason?: string; policy_decision_id?: string } = {};
        if (item.decision) arg.decision = item.decision;
        if (item.policy_decision_id) arg.policy_decision_id = item.policy_decision_id;
        const evaluation = calculateAutopilotBucket(arg);
        
        switch (evaluation.decision) {
          case "allow":
            safe++;
            break;
          case "needsApproval":
            needsApproval++;
            break;
          case "risky":
            risky++;
            break;
        }
      }

      // Process recent policy decisions that aren't in approval queue yet
      for (const decision of recentDecisions) {
        const evaluation = calculateAutopilotBucket({
          decision: decision.decision,
          proposed_action_kind: decision.proposed_action_kind,
          decision_reason: decision.decision_reason,
        });
        
        switch (evaluation.decision) {
          case "allow":
            safe++;
            break;
          case "needsApproval":
            needsApproval++;
            break;
          case "risky":
            risky++;
            break;
        }
      }

      res.json({
        safe,
        needsApproval,
        risky,
        summary: {
          triageIssues: triageIssues.length,
          approvalQueue: approvalQueueItems.length,
          dispatchQueue: dispatchQueueItems.length,
          recentDecisions: recentDecisions.length,
        },
        generatedAt: now,
      });
    } catch (error) {
      console.error("Error in /api/admin/autopilot:", error);
      res.status(500).json({ error: "internal_server_error", message: "Failed to compute autopilot summary" });
    }
  });

  /**
   * GET /api/admin/mission-map
   * Returns graph data for the mission map visualization.
   * Query params:
   *   - tenantId: required
   *   - root: optional node id to use as root for subgraph
   *   - depth: optional max depth (default: 3, max: 5)
   */
  router.get("/mission-map", (req, res) => {
    const { tenantId, root, depth } = req.query as Record<string, string>;
    
    if (!tenantId) {
      res.status(400).json({ error: "tenantId required" });
      return;
    }

    try {
      const depthNum = depth ? parseInt(depth, 10) : 3;
      const opts: { tenantId: string; root?: string; depth: number } = { tenantId, depth: depthNum };
      if (root) opts.root = root;
      const result = getGraph(opts);
      
      res.json(result);
    } catch (error) {
      console.error("Error fetching mission map graph:", error);
      res.status(500).json({ 
        error: "internal_server_error", 
        message: "Failed to fetch mission map graph" 
      });
    }
  });

  return router;
}
