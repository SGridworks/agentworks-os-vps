/**
 * Types for vault pruning — importance scoring and selective page removal.
 */

export interface VaultPageWithImportance {
  tenantId: string;
  key: string;
  /** ISO-8601 */
  updatedAt: string;
  /** Computed importance 1-5, higher = more important */
  importance: number;
  /** Current page size in bytes */
  sizeBytes: number;
}

export interface PruneResult {
  /** Pages removed */
  pruned: number;
  /** Bytes freed */
  bytesFreed: number;
  /** Snapshot ID to rollback if needed */
  snapshotId: string;
}

export interface PruneOptions {
  /** Target bytes after prune (default: maxBytes * 0.7) */
  targetBytes?: number;
  /** Minimum importance to keep (default: 2) */
  minImportance?: number;
  /** dry run — no actual deletion */
  dryRun?: boolean;
}
