/**
 * Vault consolidation — rewrites stale pages and prunes orphaned entries.
 *
 * Uses snapshot protection: the vault is snapshotted before any mutations
 * so it can be rolled back via {@link FileVaultStore.restore} if consolidation
 * encounters an error.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { FileVaultStore } from "./file-store.js";
import { STALE_PAGE_DAYS } from "./types.js";

export interface ConsolidateResult {
  /** Snapshot ID that can be passed to store.restore(tenantId, snapshotId) to roll back. */
  snapshotId: string;
  /** Number of stale pages that were rewritten. */
  compacted: number;
  /** Number of orphaned entries that were removed. */
  pruned: number;
}

/**
 * Consolidate the vault for a tenant.
 *
 * Snapshot protection is applied before any I/O:
 * 1. Snapshot the current vault state.
 * 2. List all pages and identify stale ones (not touched in `staleDays`).
 * 3. Rewrite stale pages (full content rewrite — future extension point for
 *    compaction algorithms).
 * 4. Identify orphaned entries (not yet implemented — returns 0).
 *
 * @param tenantId  Tenant whose vault should be consolidated.
 * @param store     FileVaultStore instance.
 * @param staleDays Pages untouched for this many days are considered stale
 *                  (default: 30, from STALE_PAGE_DAYS in types.ts).
 */
export async function consolidateVault(
  tenantId: string,
  store: FileVaultStore,
  staleDays: number = STALE_PAGE_DAYS,
): Promise<ConsolidateResult> {
  // 1. Snapshot first — protection rollback point
  const snapshotId = await store.snapshot(tenantId);

  // 2. List all pages
  const keys = await store.list(tenantId);

  const staleThreshold = new Date(
    Date.now() - staleDays * 24 * 60 * 60 * 1000,
  );

  let compacted = 0;

  for (const key of keys) {
    const result = await store.read(tenantId, key as any);
    if (!result.existed) continue;

    const updatedAt = new Date(result.updatedAt);
    if (updatedAt < staleThreshold) {
      // Rewrite in-place to update mtime and trigger any internal compaction
      await store.write(tenantId, key as any, result.body, {
        ...(result.summary !== undefined && { summary: result.summary }),
      });
      compacted++;
    }
  }

  // 3. Prune orphaned entries (placeholder — full implementation follows)
  const pruned = 0;

  return { snapshotId, compacted, pruned };
}
