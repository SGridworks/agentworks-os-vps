/**
 * Vault contract types.
 *
 * Keys are forward-slash paths. The substrate enforces tenancy by
 * passing tenantId on every call; a store implementation is free to
 * map (tenantId, key) onto disk, SQLite, or remote storage however
 * makes sense.
 */

import { z } from "zod";

/**
 * Allowed page-key shape. Forward-slash path with no leading slash, no
 * `..`, and a constrained character set so the key cannot escape its
 * tenant subtree on a file-backed store.
 */
export const VaultKeySchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-zA-Z0-9_\-./]+$/, "key may only contain [A-Za-z0-9_-./]")
  .refine((k) => !k.startsWith("/"), "key must not start with /")
  .refine((k) => !k.includes(".."), "key must not contain ..")
  .refine((k) => !k.includes("//"), "key must not contain //");

export type VaultKey = z.infer<typeof VaultKeySchema>;

export const VaultWriteModeSchema = z.enum(["replace", "append"]);
export type VaultWriteMode = z.infer<typeof VaultWriteModeSchema>;

/**
 * A page — body plus minimal metadata. The body is markdown; storage
 * backends should treat it as opaque UTF-8 bytes.
 */
export interface VaultPageBase {
  tenantId: string;
  key: VaultKey;
  body: string;
  /** ISO-8601. */
  updatedAt: string;
  /** SHA-256 of body, lowercase hex. */
  sha256: string;
  /** 1-2 sentence indexable description. */
  summary?: string;
  /** "When I need to know..." retrieval-oriented trigger. */
  trigger?: string;
  /** Key for lazy-loaded detail content. */
  detail_key?: string;
  /** UUID of first writer. */
  authoringAgent?: string;
  /** UUID of last writer. */
  lastUpdatedBy?: string;
  /** ISO-8601 with millis. */
  lastUpdatedAt?: string;
  /** Agents that read the page since last update. */
  lastUsedBy?: Array<{ agentId: string; usedAt: string }>;
}

export const VaultPageSchema = z.object({
  tenantId: z.string(),
  key: VaultKeySchema,
  body: z.string(),
  updatedAt: z.string(),
  sha256: z.string(),
  summary: z.string().optional(),
  trigger: z.string().optional(),
  detail_key: z.string().optional(),
  authoringAgent: z.string().uuid().optional(),
  lastUpdatedBy: z.string().uuid().optional(),
  lastUpdatedAt: z.string().optional(),
  lastUsedBy: z.array(z.object({
    agentId: z.string().uuid(),
    usedAt: z.string()
  })).optional(),
});

export type VaultPage = z.infer<typeof VaultPageSchema>;

/**
 * Result of `read`. For missing keys, the store returns an empty body
 * and a zero-content sha256 with `existed = false` so callers can tell
 * "missing" from "empty" without raising.
 */
export interface VaultReadResult extends VaultPage {
  existed: boolean;
  /** Computed importance 1-5 for pruning decisions. */
  importance?: number;
}

/**
 * Options on `write`. `replace` overwrites the file atomically; `append`
 * adds the body to the end with a timestamp header.
 */
export interface VaultWriteOptions {
  mode?: VaultWriteMode; // defaults to "replace"
  /** 1-2 sentence indexable description. */
  summary?: string;
  /** "When I need to know..." retrieval-oriented trigger. */
  trigger?: string;
  /** Expensive/large content stored separately and loaded on demand. */
  detail_body?: string;
  /** Computed importance 1-5 for pruning decisions. */
  importance?: number;
  /** Agents that read the page since last update. Used for updating lastUsedBy without changing content. */
  lastUsedBy?: Array<{ agentId: string; usedAt: string }>;
}

/**
 * Result of `write`. Returns the resulting page metadata, including the
 * post-write sha256 and bytesWritten (the body length in bytes, not the
 * total file size — which can grow under append).
 */
export interface VaultWriteResult {
  tenantId: string;
  key: VaultKey;
  bytesWritten: number;
  updatedAt: string;
  sha256: string;
}

/**
 * The contract every vault store must implement. Stores SHOULD be
 * idempotent on `read` (no side effects) and atomic on `replace` (no
 * partial writes ever land on the read path).
 */
export interface VaultStore {
  read(tenantId: string, key: VaultKey): Promise<VaultReadResult>;
  write(
    tenantId: string,
    key: VaultKey,
    body: string,
    opts?: VaultWriteOptions,
  ): Promise<VaultWriteResult>;
  list?(tenantId: string): Promise<string[]>;
  delete?(tenantId: string, key: VaultKey): Promise<void>;
  snapshot?(tenantId: string): Promise<string>;
  restore?(tenantId: string, snapshotId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Cognitive budget & compaction trigger
// ---------------------------------------------------------------------------

/** Default maximum warm word count before triggering compaction. */
export const DEFAULT_WORD_BUDGET = 50_000;

/** Age in days after which a page is considered "stale". */
export const STALE_PAGE_DAYS = 30;

/** Fraction of wordBudget that triggers warning (0-1). */
export const BUDGET_WARNING_THRESHOLD = 0.8;

/**
 * Captures the current cognitive "budget" state of the vault — used to decide
 * when to trigger compaction.
 */
export interface CognitiveBudget {
  /** Total active pages in the vault. */
  activePages: number;
  /** Pages that were written or referenced in the last N days. */
  warmPages: number;
  /** Pages that have not been touched in 30+ days. */
  stalePages: number;
  /** Word count of all non-stale pages. */
  warmWordCount: number;
  /** Budget limit in words (configurable per tenant). */
  wordBudget: number;
  /** ISO-8601 timestamp of last compaction. */
  lastCompactedAt?: string;
}

/**
 * Trigger for vault compaction — fires when budget is exceeded.
 */
export interface CompactionTrigger {
  /** Why compaction was triggered. */
  reason: "word_budget_exceeded" | "stale_pages_threshold" | "manual";
  /** The budget state at time of triggering. */
  budget: CognitiveBudget;
  /** ISO-8601 timestamp. */
  triggeredAt: string;
}

/**
 * Sensor that tracks vault activity and emits budget signals.
 * Implementations can use this to decide when to call prune/consolidate.
 */
export interface CognitiveSensor {
  /**
   * Compute the current cognitive budget.
   * @param tenantId — tenant to evaluate
   * @param wordBudget — optional override for the per-tenant word budget
   */
  sense(tenantId: string, wordBudget?: number): Promise<CognitiveBudget>;

  /**
   * Check if a compaction trigger is currently active.
   * Returns a trigger if budget is exceeded, or null if within limits.
   */
  shouldCompact?(tenantId: string, wordBudget?: number): Promise<CompactionTrigger | null>;
}
