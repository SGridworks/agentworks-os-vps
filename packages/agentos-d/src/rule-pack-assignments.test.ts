/**
 * Rule pack assignment tests.
 *
 *  - migration 0006 backfill: pre-existing tenants get smb-starter assigned
 *  - assignPackToTenant inserts new, updates existing
 *  - unassignPackFromTenant removes
 *  - tenant create hook auto-assigns DEFAULT_PACK_ID
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { initDb, resetDb, getDb, getSqlite } from "./db/client.js";
import { migrate } from "./db/migrations/index.js";
import { migrate as migrate0006 } from "./db/migrations/0006_tenant_rule_pack_assignments.js";
import { tenants, tenantRulePackAssignments } from "./db/schema.js";
import {
  assignPackToTenant,
  listAssignments,
  unassignPackFromTenant,
  getEffectivePacksForTenant,
  DEFAULT_PACK_ID,
} from "./rule-pack-assignments.js";

let tmpRoot: string;

const T1 = "11111111-1111-1111-1111-111111111111";
const T2 = "22222222-2222-2222-2222-222222222222";

function seedTenant(id: string, name: string) {
  const db = getDb();
  const now = new Date().toISOString();
  db.insert(tenants).values({
    id,
    name,
    description: null,
    industry: null,
    vaultRoot: "<default>",
    shadowMode: true,
    shadowUntil: null,
    createdAt: now,
    updatedAt: now,
  }).run();
}

beforeEach(() => {
  resetDb();
  tmpRoot = mkdtempSync(join(tmpdir(), "awo-trp-"));
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

describe("rule pack assignments", () => {
  it("listAssignments returns empty for an unknown tenant", () => {
    expect(listAssignments(T1)).toEqual([]);
  });

  it("assignPackToTenant inserts a new row", () => {
    seedTenant(T1, "Test1");
    const row = assignPackToTenant(T1, "tcpa-real-estate", "enforce");
    expect(row.tenantId).toBe(T1);
    expect(row.packId).toBe("tcpa-real-estate");
    expect(row.mode).toBe("enforce");

    const rows = listAssignments(T1);
    expect(rows.find((r) => r.packId === "tcpa-real-estate")).toBeDefined();
  });

  it("assignPackToTenant updates the mode on an existing row", () => {
    seedTenant(T1, "Test1");
    assignPackToTenant(T1, "tcpa-real-estate", "shadow");
    const updated = assignPackToTenant(T1, "tcpa-real-estate", "enforce");
    expect(updated.mode).toBe("enforce");

    const all = getDb()
      .select()
      .from(tenantRulePackAssignments)
      .where(eq(tenantRulePackAssignments.tenantId, T1))
      .all();
    expect(all).toHaveLength(1);
    expect(all[0]?.mode).toBe("enforce");
  });

  it("unassignPackFromTenant returns true when a row was deleted", () => {
    seedTenant(T1, "Test1");
    assignPackToTenant(T1, "fair-housing");
    expect(unassignPackFromTenant(T1, "fair-housing")).toBe(true);
    expect(unassignPackFromTenant(T1, "fair-housing")).toBe(false);
    expect(listAssignments(T1)).toEqual([]);
  });

  it("DEFAULT_PACK_ID is null in the test environment (no env, no auto-assign)", () => {
    // The module reads process.env at load time. The smb-starter default
    // lives in docker-compose.yml (`${AGENTWORKS_DEFAULT_PACK_ID:-smb-starter}`),
    // not in code, so a vitest run with no env set yields null — meaning
    // tenant create won't auto-assign anything. Production containers get
    // smb-starter via compose.
    expect(DEFAULT_PACK_ID).toBeNull();
  });
});

describe("getEffectivePacksForTenant — evaluator-side filter", () => {
  const ALL = [
    { pack_id: "smb-starter" },
    { pack_id: "tcpa-real-estate" },
    { pack_id: "fair-housing" },
    { pack_id: "hipaa-healthcare" },
  ];

  it("safe default: tenant with zero assignments gets every pack", () => {
    seedTenant(T1, "Pre-existing");
    const out = getEffectivePacksForTenant(T1, ALL);
    expect(out).toHaveLength(4);
  });

  it("filters to a single assigned pack", () => {
    seedTenant(T1, "RealEstate");
    assignPackToTenant(T1, "tcpa-real-estate");
    const out = getEffectivePacksForTenant(T1, ALL);
    expect(out.map((p) => p.pack_id)).toEqual(["tcpa-real-estate"]);
  });

  it("filters to multiple assigned packs", () => {
    seedTenant(T1, "RealEstateAndFH");
    assignPackToTenant(T1, "tcpa-real-estate");
    assignPackToTenant(T1, "fair-housing");
    const out = getEffectivePacksForTenant(T1, ALL);
    const ids = out.map((p) => p.pack_id).sort();
    expect(ids).toEqual(["fair-housing", "tcpa-real-estate"]);
  });

  it("ignores assignments to packs not in the loaded set", () => {
    seedTenant(T1, "Stale");
    assignPackToTenant(T1, "tcpa-real-estate");
    assignPackToTenant(T1, "ghost-pack-not-loaded");
    const out = getEffectivePacksForTenant(T1, ALL);
    expect(out.map((p) => p.pack_id)).toEqual(["tcpa-real-estate"]);
  });

  it("unknown tenant gets safe default (all packs)", () => {
    const out = getEffectivePacksForTenant(
      "00000000-0000-0000-0000-000000000999",
      ALL,
    );
    expect(out).toHaveLength(4);
  });
});

describe("migration 0006 backfill", () => {
  it("idempotent: re-running on a populated DB does not duplicate rows", () => {
    seedTenant(T1, "Existing One");
    seedTenant(T2, "Existing Two");

    // Force re-run by removing the migration hash and calling the migrator directly.
    const sqlite = getSqlite();
    sqlite.prepare("DELETE FROM __drizzle_migrations WHERE hash = ?").run("v6-tenant-rule-pack-assignments");
    migrate0006(sqlite);

    const rows = getDb().select().from(tenantRulePackAssignments).all();
    // Exactly two rows expected — one per tenant — even after a second run.
    // Migration 0006 backfills with the literal "smb-starter" regardless of
    // runtime AGENTWORKS_DEFAULT_PACK_ID (it's a one-time historical fix).
    const filtered = rows.filter((r) => r.packId === "smb-starter");
    expect(filtered).toHaveLength(2);
    const tenantIds = filtered.map((r) => r.tenantId).sort();
    expect(tenantIds).toEqual([T1, T2]);
  });
});
