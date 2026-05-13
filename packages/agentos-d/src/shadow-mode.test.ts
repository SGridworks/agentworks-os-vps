/**
 * Tenant shadow-mode resolver tests.
 *
 * Covers:
 *  - missing tenant → safe default (shadowMode=true)
 *  - explicit shadowMode=true with no clock → returns true
 *  - shadow_until in the future → returns shadowMode value, no flip
 *  - shadow_until in the past → auto-flips to enforce, persists, clears clock
 *  - explicit shadowMode=false → returns false (no flip needed)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { initDb, resetDb, getDb } from "./db/client.js";
import { migrate } from "./db/migrations/index.js";
import { tenants } from "./db/schema.js";
import { resolveTenantShadowMode, defaultShadowUntilIso } from "./shadow-mode.js";

let tmpRoot: string;

const TENANT = "11111111-1111-1111-1111-111111111111";

function seedTenant(opts: { shadowMode: boolean; shadowUntil?: string | null }) {
  const db = getDb();
  const now = new Date().toISOString();
  db.insert(tenants).values({
    id: TENANT,
    name: "Test Tenant",
    description: null,
    industry: null,
    vaultRoot: "<default>",
    shadowMode: opts.shadowMode,
    shadowUntil: opts.shadowUntil ?? null,
    createdAt: now,
    updatedAt: now,
  }).run();
}

beforeEach(() => {
  resetDb();
  tmpRoot = mkdtempSync(join(tmpdir(), "awo-shadow-"));
  initDb({
    config: {
      host: "127.0.0.1",
      port: 0,
      logLevel: "warn",
      awcpVersion: "awcp/v0.1",
      dataDir: tmpRoot,
      scannerSidecarUrl: "http://127.0.0.1:0",
      scannerPollIntervalMs: 30_000,
      auditLogRetentionDays: 30,
    },
    migrations: migrate,
  });
});

afterEach(() => {
  resetDb();
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("resolveTenantShadowMode", () => {
  it("returns safe default (shadowMode=true) when tenant row is missing", () => {
    const result = resolveTenantShadowMode("99999999-9999-9999-9999-999999999999");
    expect(result.shadowMode).toBe(true);
    expect(result.shadowUntil).toBeNull();
    expect(result.autoFlipped).toBe(false);
  });

  it("returns the tenant's shadowMode when no clock is set", () => {
    seedTenant({ shadowMode: true });
    const result = resolveTenantShadowMode(TENANT);
    expect(result.shadowMode).toBe(true);
    expect(result.shadowUntil).toBeNull();
    expect(result.autoFlipped).toBe(false);
  });

  it("returns shadowMode value when shadowUntil is in the future", () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    seedTenant({ shadowMode: true, shadowUntil: future });
    const result = resolveTenantShadowMode(TENANT);
    expect(result.shadowMode).toBe(true);
    expect(result.shadowUntil).toBe(future);
    expect(result.autoFlipped).toBe(false);
  });

  it("auto-flips shadowMode=false and clears shadowUntil when clock has passed", () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    seedTenant({ shadowMode: true, shadowUntil: past });

    const result = resolveTenantShadowMode(TENANT);
    expect(result.shadowMode).toBe(false);
    expect(result.shadowUntil).toBeNull();
    expect(result.autoFlipped).toBe(true);

    // Persistence check: a second call must NOT auto-flip again.
    const second = resolveTenantShadowMode(TENANT);
    expect(second.autoFlipped).toBe(false);
    expect(second.shadowMode).toBe(false);

    const persisted = getDb()
      .select({ shadowMode: tenants.shadowMode, shadowUntil: tenants.shadowUntil })
      .from(tenants)
      .where(eq(tenants.id, TENANT))
      .get();
    expect(persisted?.shadowMode).toBe(false);
    expect(persisted?.shadowUntil).toBeNull();
  });

  it("does not flip when shadowMode is already false (clock is moot)", () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    seedTenant({ shadowMode: false, shadowUntil: past });
    const result = resolveTenantShadowMode(TENANT);
    expect(result.shadowMode).toBe(false);
    expect(result.autoFlipped).toBe(false);
  });

  it("defaultShadowUntilIso returns 7 days out", () => {
    const fixedNow = new Date("2026-04-28T00:00:00Z");
    const iso = defaultShadowUntilIso(fixedNow);
    expect(iso).toBe("2026-05-05T00:00:00.000Z");
  });
});
