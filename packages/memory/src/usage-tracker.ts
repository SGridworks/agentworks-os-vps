/**
 * Usage tracker for memory documents.
 * 
 * Provides batched/debounced updates to lastUsedBy arrays to avoid hot-path overhead.
 * Updates are batched by (tenantId, key, agentId) and flushed periodically.
 */

import type { FileVaultStore } from "./file-store.js";

interface UsageEntry {
  tenantId: string;
  key: string;
  agentId: string;
  usedAt: string;
}

interface BatchedUpdate {
  tenantId: string;
  key: string;
  agentId: string;
  usedAt: string;
}

export class UsageTracker {
  private vaultStore: FileVaultStore;
  private pendingUpdates: Map<string, BatchedUpdate> = new Map();
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;

  constructor(vaultStore: FileVaultStore, options?: {
    batchSize?: number;
    flushIntervalMs?: number;
  }) {
    this.vaultStore = vaultStore;
    this.batchSize = options?.batchSize ?? 100;
    this.flushIntervalMs = options?.flushIntervalMs ?? 5000; // 5 second default
  }

  /**
   * Record a usage event. This is batched and flushed asynchronously.
   */
  recordUsage(tenantId: string, key: string, agentId: string): void {
    const updateKey = `${tenantId}:${key}:${agentId}`;
    const usedAt = new Date().toISOString();
    
    // Update or create the pending update
    this.pendingUpdates.set(updateKey, {
      tenantId,
      key,
      agentId,
      usedAt,
    });

    // Schedule a flush if not already scheduled
    if (!this.flushTimer && this.pendingUpdates.size >= this.batchSize) {
      this.scheduleFlush();
    } else if (!this.flushTimer) {
      this.scheduleFlush();
    }
  }

  /**
   * Force flush all pending updates immediately.
   */
  async flush(): Promise<void> {
    if (this.pendingUpdates.size === 0) return;

    const updates = Array.from(this.pendingUpdates.values());
    this.pendingUpdates.clear();

    // Group updates by tenant and key for efficient processing
    const grouped = new Map<string, Map<string, BatchedUpdate[]>>();
    
    for (const update of updates) {
      const tenantKey = `${update.tenantId}`;
      if (!grouped.has(tenantKey)) {
        grouped.set(tenantKey, new Map());
      }
      
      const keyMap = grouped.get(tenantKey)!;
      if (!keyMap.has(update.key)) {
        keyMap.set(update.key, []);
      }
      
      keyMap.get(update.key)!.push(update);
    }

    // Process each tenant/key group
    for (const [tenantKey, keyMap] of grouped) {
      const tenantId = tenantKey;
      
      for (const [key, updates] of keyMap) {
        try {
          await this.updateLastUsedBy(tenantId, key, updates);
        } catch (error) {
          console.error(`Failed to update lastUsedBy for ${tenantId}:${key}:`, error);
          // Log error but continue with other updates
        }
      }
    }
  }

  /**
   * Update lastUsedBy for a specific document.
   * Keeps only the 10 most recent entries.
   */
  private async updateLastUsedBy(tenantId: string, key: string, updates: BatchedUpdate[]): Promise<void> {
    // Read current document to get existing lastUsedBy
    const current = await this.vaultStore.read(tenantId, key);
    
    if (!current.existed) {
      // Document doesn't exist, skip update
      return;
    }

    // Get existing lastUsedBy or initialize empty array
    const existingLastUsedBy = current.lastUsedBy || [];
    
    // Create a map to deduplicate by agentId and keep most recent
    const lastUsedMap = new Map<string, string>();
    
    // Add existing entries first (they'll be overridden by newer ones if same agent)
    for (const entry of existingLastUsedBy) {
      lastUsedMap.set(entry.agentId, entry.usedAt);
    }
    
    // Add new updates (they override existing entries for same agent)
    for (const update of updates) {
      lastUsedMap.set(update.agentId, update.usedAt);
    }
    
    // Convert back to array and sort by usedAt (most recent first)
    const updatedLastUsedBy = Array.from(lastUsedMap.entries())
      .map(([agentId, usedAt]) => ({ agentId, usedAt }))
      .sort((a, b) => new Date(b.usedAt).getTime() - new Date(a.usedAt).getTime())
      .slice(0, 10); // Keep only 10 most recent

    // Write back the updated frontmatter without changing content
    await this.vaultStore.write(tenantId, key, current.body, {
      mode: "replace",
      // Pass the updated lastUsedBy as frontmatter
      // The FileVaultStore will merge this with existing frontmatter
      lastUsedBy: updatedLastUsedBy,
    });
  }

  /**
   * Schedule a flush of pending updates.
   */
  private scheduleFlush(): void {
    if (this.flushTimer) return;
    
    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      try {
        await this.flush();
      } catch (error) {
        console.error("Failed to flush usage updates:", error);
      }
    }, this.flushIntervalMs);
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Note: We don't flush remaining updates on destroy to avoid blocking shutdown
    // In a production system, you might want to await this.flush() before destroy
  }
}