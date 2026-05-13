/**
 * Issues routes — Auto-assign router (RFC 008 Section 3).
 *
 * This router provides the auto-assignment logic that the execution orchestrator
 * calls after creating an issue without an explicit assignee.
 *
 * Integration: the execution layer POSTs here immediately after creating an
 * issue row. The response tells the caller which agent to assign.
 *
 * POST /api/issues/auto-assign
 *   Body:    { companyId, issueId, description, currentAssigneeAgentId? }
 *   Returns: { assigneeAgentId?, triage: boolean, reason: string }
 *
 * GET /api/issues/lane-match-preview?description=...
 *   Dry-run: returns the lane match result without any DB side effects.
 */

import { Router } from "express";
import { z } from "zod";
import { matchLane, loadLaneConfig, type LaneMatchResult } from "../services/lane-matcher.js";
import { autoAssignAgent } from "../services/auto-assign.js";
import { emitLaneAssignment, resolveLaneAssignment } from "../services/lane-assignments.js";
import type { Config } from "../config.js";

const AUTO_ASSIGN_TIMEOUT_MS = 8_000;

export function createIssuesRouter(_config: Config): Router {
  const router = Router();

  // ---------------------------------------------------------------------------
  // Schemas
  // ---------------------------------------------------------------------------

  const AutoAssignRequestSchema = z.object({
    companyId: z.string().uuid(),
    issueId: z.string().uuid(),
    description: z.string(),
    /**
     * If already set, auto-assign is skipped (manual assignment wins per RFC 008).
     * Pass null or omit to trigger lane matching.
     */
    currentAssigneeAgentId: z.string().uuid().nullable().optional(),
  });

  // ---------------------------------------------------------------------------
  // POST /api/issues/auto-assign
  // ---------------------------------------------------------------------------

  router.post("/auto-assign", async (req, res) => {
    const parsed = AutoAssignRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }

    const { companyId, issueId, description, currentAssigneeAgentId } = parsed.data;

    // Manual assignment wins — do not overwrite. Check !== undefined so that
    // explicitly passing null (no manual assignment, don't auto-assign either)
    // also skips lane matching.
    if (currentAssigneeAgentId !== undefined) {
      res.json({
        triage: false,
        assigneeAgentId: currentAssigneeAgentId,
        role: null,
        agentIdPrefix: null,
        reason: "Manual assignment — lane matching skipped",
        matched: false,
        ambiguous: false,
      });
      return;
    }

    const result: LaneMatchResult = matchLane({ issueDescription: description });

    // No role matched, or ambiguous → triage
    if (!result.matched || result.ambiguous) {
      // Emit lane assignment trace (fire-and-forget, non-critical)
      void emitLaneAssignment({
        issueId,
        tenantId: companyId,
        issueDescription: description,
        matchedRole: result.role ?? null,
        laneMatchReason: result.reason,
        ambiguous: result.ambiguous,
        triage: true,
        assignedAgentId: null,
      });

      res.json({
        triage: true,
        assigneeAgentId: null,
        role: result.role ?? null,
        agentIdPrefix: result.agentIdPrefix ?? null,
        reason: result.reason,
        matched: result.matched,
        ambiguous: result.ambiguous,
      });
      return;
    }

    // Lane matched a role — now resolve to a specific least-loaded agent
    const ac = await autoAssignAgent(
      result.role!,
      companyId,
      undefined, // use default lane config
      AbortSignal.timeout(AUTO_ASSIGN_TIMEOUT_MS),
    );

    // Emit lane assignment trace (fire-and-forget, non-critical)
    void emitLaneAssignment({
      issueId,
      tenantId: companyId,
      issueDescription: description,
      matchedRole: result.role ?? null,
      laneMatchReason: result.reason,
      ambiguous: result.ambiguous,
      triage: ac.triage,
      assignedAgentId: ac.assigneeAgentId,
      assignedAt: new Date().toISOString(),
    });

    res.json({
      triage: ac.triage,
      assigneeAgentId: ac.assigneeAgentId,
      role: ac.role,
      agentIdPrefix: result.agentIdPrefix ?? null,
      reason: ac.reason,
      matched: result.matched,
      ambiguous: result.ambiguous,
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/issues/lanes — read-only view of the active lane config.
  // ---------------------------------------------------------------------------

  router.get("/lanes", (_req, res) => {
    try {
      const cfg = loadLaneConfig();
      res.json({
        roles: Object.entries(cfg.roles ?? {}).map(([role, def]) => ({
          role,
          agentIdPrefix: def.agent_id_prefix,
          allow: def.allow,
          description: def.description,
        })),
        universalAllow: cfg._universal_allow ?? [],
      });
    } catch (err) {
      res.status(500).json({
        error: "lane_config_unreadable",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /api/issues/lane-match-preview
  // ---------------------------------------------------------------------------

  router.get("/lane-match-preview", (req, res) => {
    const { description } = req.query;
    if (!description || typeof description !== "string") {
      res.status(400).json({ error: "description query param required" });
      return;
    }

    const result: LaneMatchResult = matchLane({ issueDescription: description });

    res.json({
      triage: !result.matched,
      role: result.role ?? null,
      agentIdPrefix: result.agentIdPrefix ?? null,
      reason: result.reason,
      matched: result.matched,
      ambiguous: result.ambiguous,
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /api/issues/:issueId/resolve-lane-assignment
  // Called by ProcessWatcher when the linked execution run completes.
  // or by a human closing/triaging the issue directly.
  // -------------------------------------------------------------------------
  router.patch("/:issueId/resolve-lane-assignment", async (req, res) => {
    const { issueId } = req.params;
    const { resolution } = req.body as { resolution?: string };

    if (!resolution || !["completed", "closed", "escalated"].includes(resolution)) {
      res.status(400).json({
        error: "invalid_request",
        message: "resolution must be one of: completed, closed, escalated",
      });
      return;
    }

    const result = await resolveLaneAssignment(issueId, resolution as "completed" | "closed" | "escalated");

    if (!result.updated) {
      res.status(404).json({ error: "not_found", message: "No unresolved lane assignment found for this issue" });
      return;
    }

    res.json({ ok: true, laneAssignmentId: result.laneAssignmentId });
  });

  return router;
}
