/**
 * provider-config-service.ts
 *
 * Loads per-tenant LLM provider topology from the tenant_provider_configs table.
 * Each row represents one provider in the fallback chain for a tenant.
 *
 * The service caches results (default 60-second TTL) to avoid DB round-trips
 * on every request.  Cache is invalidated on explicit invalidate() call.
 */

import { eq } from "drizzle-orm";
import { tenantProviderConfigs } from "../db/schema.js";
import type { TenantProviderConfigRow } from "../db/schema.js";

export interface ResolvedProviderConfig {
  name: string;
  endpoint: string;
  apiKey: string;
  isPrimary: boolean;
  fallbackOrder: number;
}

export interface TenantProviderTopology {
  tenantId: string;
  providers: ResolvedProviderConfig[];
  updatedAt: number; // Unix ms
}

const DEFAULT_CACHE_TTL_MS = 60_000;

export class ProviderConfigService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;
  private cache = new Map<string, { topology: TenantProviderTopology; expiresAt: number }>();
  private cacheTtlMs: number;

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: any,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  ) {
    this.db = db;
    this.cacheTtlMs = cacheTtlMs;
  }

  /**
   * Resolve the full provider topology for a tenant.
   * Returns null when no config exists for the tenant (caller falls back to env defaults).
   */
  getTopology(tenantId: string): TenantProviderTopology | null {
    const now = Date.now();
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiresAt > now) return cached.topology;

    const rows = this.db
      .select()
      .from(tenantProviderConfigs)
      .where(eq(tenantProviderConfigs.tenantId, tenantId))
      .all() as TenantProviderConfigRow[];

    if (rows.length === 0) return null;

    const providers: ResolvedProviderConfig[] = rows
      .filter((r) => r.enabled)
      .map((r) => ({
        name: r.providerName,
        // Decrypt apiKeyOverride here when secureStorage is wired
        apiKey: r.apiKeyOverride ?? "",
        endpoint: r.endpointOverride ?? `https://api.${r.providerName}.com/v1`,
        isPrimary: r.fallbackOrder === 0,
        fallbackOrder: r.fallbackOrder,
      }))
      .sort((a, b) => a.fallbackOrder - b.fallbackOrder);

    const topology: TenantProviderTopology = { tenantId, providers, updatedAt: now };
    this.cache.set(tenantId, { topology, expiresAt: now + this.cacheTtlMs });
    return topology;
  }

  /** Invalidate cached topology for a tenant. Call after DB write. */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  /** Clear the entire cache. */
  clearCache(): void {
    this.cache.clear();
  }

  cacheSize(): number {
    return this.cache.size;
  }
}
