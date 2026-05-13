/**
 * Lane Assignments Service — emits and resolves lane assignment trace rows.
 *
 * EMIT:    Called by POST /api/issues/auto-assign after lane matching + agent
 *          resolution. Writes one row to lane_assignments capturing the full
 *          input/output of the pipeline for this run.
 *
 * RESOLVE: Called when an issue's status transitions to done/cancelled/closed.
 *          Back-fills resolved_at + resolution on the matching lane_assignment
 *          row so the trace is complete for diagnosis.
 *
 * Both functions are fire-and-forget — errors are logged but do not fail the
 * calling request, since lane assignment trace is non-critical path.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { laneAssignments } from "../db/schema.js";
import type { NewLaneAssignmentRow } from "../db/schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LaneAssignmentResolution = "completed" | "closed" | "escalated";

export interface EmitLaneAssignmentInput {
  issueId: string;
  tenantId: string;
  issueDescription: string;
  extractedPaths?: string[]; // JSON array of file paths from lane-matcher
  matchedRole: string | null;
  laneMatchReason: string;
  ambiguous: boolean;
  triage: boolean;
  assignedAgentId: string | null;
  assignedAt?: string; // ISO datetime — defaults to now
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

/**
 * Insert a new lane_assignments row.
 * Safe to await or fire-and-forget — errors are swallowed with a console.warn.
 */
export async function emitLaneAssignment(
  input: EmitLaneAssignmentInput,
): Promise<void> {
  try {
    const db = getDb();
    const now = new Date().toISOString();

    const row: NewLaneAssignmentRow = {
      id: randomUUID(),
      issueId: input.issueId,
      tenantId: input.tenantId,
      issueDescription: input.issueDescription,
      extractedPaths: JSON.stringify(input.extractedPaths ?? []),
      matchedRole: input.matchedRole,
      laneMatchReason: input.laneMatchReason,
      ambiguous: input.ambiguous,
      triage: input.triage,
      assignedAgentId: input.assignedAgentId,
      assignedAt: input.assignedAt ?? now,
      resolvedAt: null,
      resolution: null,
      createdAt: now,
    };

    db.insert(laneAssignments).values(row).run();
  } catch (err) {
    // Non-critical path — never fail the calling request
    console.warn("[lane-assignments] failed to emit row:", err);
  }
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

export interface ResolveLaneAssignmentResult {
  updated: boolean;
  laneAssignmentId: string | null;
}

/**
 * Back-fill resolved_at + resolution for the lane_assignment row associated
 * with an issue that has reached a terminal state.
 *
 * @param issueId       Execution issue ID
 * @param resolution    completed | closed | escalated
 */
export async function resolveLaneAssignment(
  issueId: string,
  resolution: LaneAssignmentResolution,
): Promise<ResolveLaneAssignmentResult> {
  try {
    const db = getDb();
    const now = new Date().toISOString();

    // Fetch the latest unresolved row for this issue
    const existing = db
      .select({ id: laneAssignments.id })
      .from(laneAssignments)
      .where(eq(laneAssignments.issueId, issueId))
      .orderBy(laneAssignments.createdAt)
      .limit(1)
      .get();

    if (!existing) {
      return { updated: false, laneAssignmentId: null };
    }

    db.update(laneAssignments)
      .set({ resolvedAt: now, resolution })
      .where(eq(laneAssignments.id, existing.id))
      .run();

    return { updated: true, laneAssignmentId: existing.id };
  } catch (err) {
    console.warn("[lane-assignments] failed to resolve row for issue", issueId, err);
    return { updated: false, laneAssignmentId: null };
  }
}
