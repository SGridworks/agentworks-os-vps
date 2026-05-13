/**
 * Vault pruning — removes low-importance pages when the vault exceeds a size threshold.
 */

import { computeImportance, ImportanceCalculator } from "./importance.js";
import type { VaultStore } from "./types.js";
import type { PruneOptions, PruneResult, VaultPageWithImportance } from "./pruning-types.js";

export async function pruneVault(
  store: VaultStore,
  tenantId: string,
  maxBytes: number,
  opts?: PruneOptions,
): Promise<PruneResult> {
  const targetBytes = opts?.targetBytes ?? maxBytes * 0.7;
  const minImportance = opts?.minImportance ?? 2;

  // 1. List all pages for the tenant
  const keys = store.list
    ? await store.list(tenantId)
    : [];

  if (keys.length === 0) {
    return { pruned: 0, bytesFreed: 0, snapshotId: "" };
  }

  // 2. Read each page and compute importance
  const pagesWithImportance: VaultPageWithImportance[] = await Promise.all(
    keys.map(async (key) => {
      const result = await store.read(tenantId, key);
      // Use existing importance if stored, otherwise compute
      const importance = result.importance ?? computeImportance({ updatedAt: result.updatedAt, body: result.body });
      const sizeBytes = Buffer.byteLength(result.body, "utf8");
      return {
        tenantId,
        key,
        updatedAt: result.updatedAt,
        importance,
        sizeBytes,
      };
    }),
  );

  // 3. Use ImportanceCalculator to find pages to prune
  const calculator = new ImportanceCalculator();
  const keysToPrune = calculator.compute(pagesWithImportance, targetBytes, minImportance);

  if (keysToPrune.length === 0) {
    return { pruned: 0, bytesFreed: 0, snapshotId: "" };
  }

  // Build a map for quick size lookup
  const sizeByKey = new Map(pagesWithImportance.map((p) => [p.key, p.sizeBytes]));
  const bytesToFree = keysToPrune.reduce((sum, k) => sum + (sizeByKey.get(k) ?? 0), 0);

  // 4. Snapshot first for rollback safety (only if not dry run)
  let snapshotId = "";
  if (!opts?.dryRun && "snapshot" in store) {
    snapshotId = await (store.snapshot as (tenantId: string) => Promise<string>)(tenantId);
  }

  // 5. Delete pages (unless dry run)
  if (!opts?.dryRun && "delete" in store) {
    await Promise.all(
      keysToPrune.map((key) => (store.delete as (tenantId: string, key: string) => Promise<void>)(tenantId, key)),
    );
  }

  return {
    pruned: keysToPrune.length,
    bytesFreed: bytesToFree,
    snapshotId,
  };
}
