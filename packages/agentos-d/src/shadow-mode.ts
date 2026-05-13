/**
 * Tenant shadow-mode resolution.
 *
 * Each tenant has a default `shadowMode` (boolean) and an optional
 * `shadowUntil` (ISO datetime). When policy.check is called without an
 * explicit per-request shadowMode, the substrate falls back to the
 * tenant default. If `shadowUntil` is set and has passed, the substrate
 * auto-flips the tenant to enforce mode (persists `shadowMode=false`,
 * clears `shadowUntil`) so the flip is durable.
 *
 * Default for new tenants: shadowMode=true (advisory only). Operators
 * promote to enforce by either flipping shadowMode directly or setting
 * a shadowUntil and letting the clock auto-flip.
 */

import { eq } from "drizzle-orm";
import { tenants } from "./db/schema.js";
import { getDb } from "./db/index.js";

export interface ShadowModeState {
  shadowMode: boolean;
  shadowUntil: string | null;
  autoFlipped: boolean;
}

/**
 * Resolve the effective shadowMode for a tenant. Side effect: if shadowUntil
 * has passed, persist shadowMode=false and clear shadowUntil.
 *
 * Returns shadowMode=true as a safe default if the tenant row isn't found —
 * the substrate prefers advisory over an unknown enforcement state.
 */
export function resolveTenantShadowMode(tenantId: string): ShadowModeState {
  const db = getDb();
  const row = db
    .select({
      shadowMode: tenants.shadowMode,
      shadowUntil: tenants.shadowUntil,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .get();

  if (!row) {
    return { shadowMode: true, shadowUntil: null, autoFlipped: false };
  }

  if (row.shadowUntil && row.shadowMode) {
    const cutoff = Date.parse(row.shadowUntil);
    if (Number.isFinite(cutoff) && cutoff <= Date.now()) {
      const now = new Date().toISOString();
      db.update(tenants)
        .set({ shadowMode: false, shadowUntil: null, updatedAt: now })
        .where(eq(tenants.id, tenantId))
        .run();
      return { shadowMode: false, shadowUntil: null, autoFlipped: true };
    }
  }

  return {
    shadowMode: row.shadowMode,
    shadowUntil: row.shadowUntil ?? null,
    autoFlipped: false,
  };
}

/**
 * Default shadow-until for a brand-new tenant: 7 days out. Used by tenant
 * creation when the operator doesn't pass an explicit clock.
 */
export function defaultShadowUntilIso(now: Date = new Date()): string {
  const d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  return d.toISOString();
}
