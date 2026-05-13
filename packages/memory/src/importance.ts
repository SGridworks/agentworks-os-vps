/**
 * Importance scoring for vault pages.
 *
 * Score is 1-5:
 *   1 = least important (old, short, no events)
 *   5 = most important (recent, long, high event count)
 */

import type { VaultPageWithImportance } from "./pruning-types.js";

const MS_PER_DAY = 86_400_000;

/** Pages newer than this are considered "recent" for scoring purposes. */
const RECENT_DAYS = 7;
/** Pages older than this are considered "stale" for scoring purposes. */
const STALE_DAYS = 30;

/**
 * Compute importance score (1-5) for a page.
 *
 * Scoring:
 *   - Base recency: updatedAt within 7 days = +1, within 30 days = 0, older = -1
 *   - Body length: longer content (>= 500 chars) = +1
 *   - eventCount: if provided and > 0 = +1
 *   - Clamped to 1-5
 */
export function computeImportance(page: {
  updatedAt: string;
  body: string;
  eventCount?: number;
}): number {
  const now = Date.now();
  const updated = new Date(page.updatedAt).getTime();
  const ageDays = (now - updated) / MS_PER_DAY;

  let score = 0;

  // Recency scoring
  if (ageDays <= RECENT_DAYS) {
    score += 1;
  } else if (ageDays <= STALE_DAYS) {
    score += 0;
  } else {
    score -= 1;
  }

  // Body length scoring — substantive content
  if (page.body.length >= 500) {
    score += 1;
  }

  // Event count scoring
  if (page.eventCount !== undefined && page.eventCount > 0) {
    score += 1;
  }

  // Clamp to 1-5
  return Math.max(1, Math.min(5, score));
}

/**
 * Determines which pages to prune using a greedy approach:
 * sort by importance ascending, then remove lowest importance first
 * until the vault is under targetBytes.
 *
 * Pages with importance < minImportance are always eligible for pruning.
 */
export class ImportanceCalculator {
  /**
   * Returns an ordered list of page keys to prune.
   *
   * Greedy algorithm:
   * 1. Sort pages by importance ascending (lowest importance first).
   * 2. Accumulate pages until targetBytes is satisfied.
   * 3. Return the list of keys to prune.
   */
  compute(
    pages: VaultPageWithImportance[],
    targetBytes: number,
    minImportance: number = 2,
  ): string[] {
    // Current total bytes across all pages
    const totalBytes = pages.reduce((sum, p) => sum + p.sizeBytes, 0);

    // Already under target — nothing to prune
    if (totalBytes <= targetBytes) {
      return [];
    }

    // Sort by importance ascending; within same importance, larger pages first
    // (remove larger low-importance pages first to maximize bytes freed per page removed)
    const sorted = [...pages].sort((a, b) => {
      if (a.importance !== b.importance) {
        return a.importance - b.importance; // lowest importance first
      }
      return b.sizeBytes - a.sizeBytes; // larger first among same importance
    });

    const toPrune: string[] = [];
    let bytesAfterPrune = totalBytes;

    for (const page of sorted) {
      // Stop once we're under target
      if (bytesAfterPrune <= targetBytes) {
        break;
      }

      // Skip pages that are too important to remove
      if (page.importance >= minImportance) {
        continue;
      }

      toPrune.push(page.key);
      bytesAfterPrune -= page.sizeBytes;
    }

    return toPrune;
  }
}
