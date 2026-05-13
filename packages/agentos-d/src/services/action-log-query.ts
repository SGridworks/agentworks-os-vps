/**
 * Action log query helpers for Operator UX v2 morning brief and other features.
 * Provides typed helper functions to query the action_log table with common filters.
 */

import { getSqlite } from "../db/index.js";

export interface ActionLogQueryOptions {
  /** Filter by action kind (e.g., "policy.check", "agent.wakeup") */
  actionKind?: string;
  /** Filter by actor type */
  actorType?: "human" | "agent" | "system";
  /** Filter by actor ID */
  actorId?: string;
  /** Maximum number of results to return (default: 1000) */
  limit?: number;
  /** Order by logged_at descending (default: true) */
  orderDesc?: boolean;
}

export interface ActionLogRow {
  id: string;
  tenantId: string;
  actorId: string;
  actorType: "human" | "agent" | "system";
  actorLabel: string;
  actionKind: string;
  payloadSnapshot: Record<string, unknown>;
  vaultRefs: string[];
  conversationRefs: string[];
  projectRefs: string[];
  policyDecisionId: string | null;
  proposedAt: string;
  loggedAt: string;
}

/**
 * Query action logs since a given timestamp for a specific tenant.
 * This is the main helper function for the morning brief functionality.
 * 
 * @param tenantId - The tenant ID to filter by
 * @param isoCutoff - ISO timestamp for the earliest log entry to include
 * @param opts - Additional query options
 * @returns Array of action log rows matching the criteria
 */
export function actionLogSince(
  tenantId: string,
  isoCutoff: string,
  opts: ActionLogQueryOptions = {}
): ActionLogRow[] {
  const sqlite = getSqlite();
  
  // Build query conditions
  const conditions: string[] = ["tenant_id = ?", "logged_at >= ?"];
  const params: any[] = [tenantId, isoCutoff];
  
  if (opts.actionKind) {
    conditions.push("action_kind = ?");
    params.push(opts.actionKind);
  }
  
  if (opts.actorType) {
    conditions.push("actor_type = ?");
    params.push(opts.actorType);
  }
  
  if (opts.actorId) {
    conditions.push("actor_id = ?");
    params.push(opts.actorId);
  }
  
  const limit = opts.limit ?? 1000;
  const order = opts.orderDesc !== false ? "DESC" : "ASC";
  
  const query = `
    SELECT 
      id,
      tenant_id as tenantId,
      actor_id as actorId,
      actor_type as actorType,
      actor_label as actorLabel,
      action_kind as actionKind,
      payload_snapshot as payloadSnapshot,
      vault_refs as vaultRefs,
      conversation_refs as conversationRefs,
      project_refs as projectRefs,
      policy_decision_id as policyDecisionId,
      proposed_at as proposedAt,
      logged_at as loggedAt
    FROM action_log
    WHERE ${conditions.join(" AND ")}
    ORDER BY logged_at ${order}
    LIMIT ?
  `;
  
  params.push(limit);
  
  const rows = sqlite.prepare(query).all(...params) as any[];
  
  return rows.map(row => ({
    id: row.id,
    tenantId: row.tenantId,
    actorId: row.actorId,
    actorType: row.actorType,
    actorLabel: row.actorLabel,
    actionKind: row.actionKind,
    payloadSnapshot: parseJson(row.payloadSnapshot) as Record<string, unknown>,
    vaultRefs: parseJsonArray(row.vaultRefs),
    conversationRefs: parseJsonArray(row.conversationRefs),
    projectRefs: parseJsonArray(row.projectRefs),
    policyDecisionId: row.policyDecisionId,
    proposedAt: row.proposedAt,
    loggedAt: row.loggedAt,
  }));
}

/**
 * Count action logs since a given timestamp for a specific tenant.
 * Useful for getting summary statistics without loading all rows.
 * 
 * @param tenantId - The tenant ID to filter by
 * @param isoCutoff - ISO timestamp for the earliest log entry to include
 * @param opts - Additional query options
 * @returns Count of action logs matching the criteria
 */
export function countActionLogSince(
  tenantId: string,
  isoCutoff: string,
  opts: ActionLogQueryOptions = {}
): number {
  const sqlite = getSqlite();
  
  // Build query conditions
  const conditions: string[] = ["tenant_id = ?", "logged_at >= ?"];
  const params: any[] = [tenantId, isoCutoff];
  
  if (opts.actionKind) {
    conditions.push("action_kind = ?");
    params.push(opts.actionKind);
  }
  
  if (opts.actorType) {
    conditions.push("actor_type = ?");
    params.push(opts.actorType);
  }
  
  if (opts.actorId) {
    conditions.push("actor_id = ?");
    params.push(opts.actorId);
  }
  
  const query = `
    SELECT COUNT(*) as count
    FROM action_log
    WHERE ${conditions.join(" AND ")}
  `;
  
  const result = sqlite.prepare(query).get(...params) as { count: number };
  return result.count;
}

/**
 * Get distinct action kinds for a tenant since a given timestamp.
 * Useful for understanding what types of actions occurred in a time window.
 * 
 * @param tenantId - The tenant ID to filter by
 * @param isoCutoff - ISO timestamp for the earliest log entry to include
 * @returns Array of distinct action kinds
 */
export function getDistinctActionKindsSince(
  tenantId: string,
  isoCutoff: string
): string[] {
  const sqlite = getSqlite();
  
  const query = `
    SELECT DISTINCT action_kind
    FROM action_log
    WHERE tenant_id = ? AND logged_at >= ?
    ORDER BY action_kind
  `;
  
  const rows = sqlite.prepare(query).all(tenantId, isoCutoff) as { action_kind: string }[];
  return rows.map(row => row.action_kind);
}

/**
 * Get action logs grouped by action kind with counts.
 * Useful for summary statistics like those needed in morning brief.
 * 
 * @param tenantId - The tenant ID to filter by
 * @param isoCutoff - ISO timestamp for the earliest log entry to include
 * @returns Array of action kinds with their counts
 */
export function getActionLogSummaryByKind(
  tenantId: string,
  isoCutoff: string
): Array<{ actionKind: string; count: number }> {
  const sqlite = getSqlite();
  
  const query = `
    SELECT 
      action_kind as actionKind,
      COUNT(*) as count
    FROM action_log
    WHERE tenant_id = ? AND logged_at >= ?
    GROUP BY action_kind
    ORDER BY count DESC
  `;
  
  const rows = sqlite.prepare(query).all(tenantId, isoCutoff) as { actionKind: string; count: number }[];
  return rows;
}

/**
 * Helper function to parse JSON strings safely
 */
function parseJson(value: string | null): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/**
 * Helper function to parse JSON arrays safely
 */
function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}