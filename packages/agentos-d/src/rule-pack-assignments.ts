/**
 * Per-tenant rule pack subscription helpers.
 *
 * Pure data layer: list/assign/unassign rows in tenant_rule_pack_assignments.
 * The evaluator side (filtering loaded packs by per-tenant subscription)
 * is wired separately so the table can land first.
 */

import { and, eq } from "drizzle-orm";
import {
  tenantRulePackAssignments,
  type NewTenantRulePackAssignmentRow,
} from "./db/schema.js";
import { getDb } from "./db/index.js";

/**
 * Default pack auto-assigned at tenant creation. Driven entirely by the
 * AGENTWORKS_DEFAULT_PACK_ID environment variable. The smb-starter default
 * lives in `docker-compose.yml` (interpolated as
 * `${AGENTWORKS_DEFAULT_PACK_ID:-smb-starter}`) so industry-specific
 * deployments can override or disable auto-assignment without touching
 * code.
 *
 *   AGENTWORKS_DEFAULT_PACK_ID=utility-distribution-starter   # custom
 *   AGENTWORKS_DEFAULT_PACK_ID=                               # disabled
 *   (unset in container)                                      # disabled
 *
 * `tenants.ts` skips the auto-assign call when this is null.
 */
export const DEFAULT_PACK_ID: string | null = (() => {
  const v = process.env.AGENTWORKS_DEFAULT_PACK_ID;
  if (v === undefined || v === "") return null;
  return v;
})();

/**
 * Filter the loaded rule packs to those a tenant has subscribed to.
 *
 * Safe-default semantics: a tenant with ZERO assignments gets every loaded
 * pack — i.e. behavior is unchanged for any tenant that existed before
 * AWO-27 / AWO-140 landed. This avoids silently narrowing coverage during
 * rollout. Once an operator explicitly assigns at least one pack, the
 * tenant is in opt-in territory and only assigned packs apply.
 */
export function getEffectivePacksForTenant<T extends { pack_id: string }>(
  tenantId: string,
  allPacks: readonly T[],
): T[] {
  const assignments = listAssignments(tenantId);
  if (assignments.length === 0) return [...allPacks];
  const assignedIds = new Set(assignments.map((a) => a.packId));
  return allPacks.filter((p) => assignedIds.has(p.pack_id));
}

export interface AssignmentRow {
  id: string;
  tenantId: string;
  packId: string;
  mode: "enforce" | "shadow";
  assignedAt: string;
  updatedAt: string;
}

export function listAssignments(tenantId: string): AssignmentRow[] {
  const db = getDb();
  return db
    .select()
    .from(tenantRulePackAssignments)
    .where(eq(tenantRulePackAssignments.tenantId, tenantId))
    .all() as AssignmentRow[];
}

export function assignPackToTenant(
  tenantId: string,
  packId: string,
  mode: "enforce" | "shadow" = "enforce",
): AssignmentRow {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db
    .select()
    .from(tenantRulePackAssignments)
    .where(
      and(
        eq(tenantRulePackAssignments.tenantId, tenantId),
        eq(tenantRulePackAssignments.packId, packId),
      ),
    )
    .get() as AssignmentRow | undefined;

  if (existing) {
    db.update(tenantRulePackAssignments)
      .set({ mode, updatedAt: now })
      .where(eq(tenantRulePackAssignments.id, existing.id))
      .run();
    return { ...existing, mode, updatedAt: now };
  }

  const row: NewTenantRulePackAssignmentRow = {
    id: `${tenantId}-${packId}`,
    tenantId,
    packId,
    mode,
    assignedAt: now,
    updatedAt: now,
  };
  db.insert(tenantRulePackAssignments).values(row).run();
  return row as AssignmentRow;
}

export function unassignPackFromTenant(
  tenantId: string,
  packId: string,
): boolean {
  const db = getDb();
  const result = db
    .delete(tenantRulePackAssignments)
    .where(
      and(
        eq(tenantRulePackAssignments.tenantId, tenantId),
        eq(tenantRulePackAssignments.packId, packId),
      ),
    )
    .run();
  return (result.changes ?? 0) > 0;
}
