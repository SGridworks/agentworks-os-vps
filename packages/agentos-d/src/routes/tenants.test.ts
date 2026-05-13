import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { getDb, initDb, resetDb } from "../db/index.js";
import { migrate } from "../db/migrations/index.js";
import { policyDecisions, tenantRulePackAssignments, tenants } from "../db/schema.js";

describe("tenant routes", () => {
  let vaultRoot: string;
  let dataDir: string;
  let originalVaultRoot: string | undefined;
  let originalDataDir: string | undefined;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), "awo-tenants-vault-"));
    dataDir = mkdtempSync(join(tmpdir(), "awo-tenants-data-"));
    originalVaultRoot = process.env.VAULT_ROOT;
    originalDataDir = process.env.AGENTOS_DATA_DIR;
    process.env.VAULT_ROOT = vaultRoot;
    process.env.AGENTOS_DATA_DIR = dataDir;
    resetDb();
    const config = loadConfig({});
    initDb({ config, migrations: migrate });
    app = createApp(config);
  });

  afterEach(() => {
    if (originalVaultRoot === undefined) delete process.env.VAULT_ROOT;
    else process.env.VAULT_ROOT = originalVaultRoot;
    if (originalDataDir === undefined) delete process.env.AGENTOS_DATA_DIR;
    else process.env.AGENTOS_DATA_DIR = originalDataDir;
    resetDb();
    rmSync(vaultRoot, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("creates and deletes a disposable tenant registry row", async () => {
    const create = await request(app)
      .post("/api/tenants")
      .send({ name: "Smoke Tenant", industry: "other" });
    expect(create.status).toBe(201);
    expect(typeof create.body.id).toBe("string");
    expect(existsSync(join(vaultRoot, create.body.id))).toBe(true);

    const policy = await request(app)
      .post("/api/policy/check")
      .send({
        tenantId: create.body.id,
        actionKind: "smoke.test",
        payload: { sample: "value" },
        actorId: "tenant-test",
        actorLabel: "tenant route test",
        actorType: "system",
        summary: "tenant cleanup policy row",
      });
    expect(policy.status).toBe(200);
    const decisionsBeforeDelete = getDb()
      .select({ id: policyDecisions.id })
      .from(policyDecisions)
      .where(eq(policyDecisions.tenantId, create.body.id))
      .all();
    expect(decisionsBeforeDelete.length).toBeGreaterThan(0);

    const remove = await request(app).delete(`/api/tenants/${create.body.id}`);
    expect(remove.status).toBe(204);
    expect(existsSync(join(vaultRoot, create.body.id))).toBe(false);

    const row = getDb()
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, create.body.id))
      .get();
    expect(row).toBeUndefined();
    const assignments = getDb()
      .select({ id: tenantRulePackAssignments.id })
      .from(tenantRulePackAssignments)
      .where(eq(tenantRulePackAssignments.tenantId, create.body.id))
      .all();
    expect(assignments).toEqual([]);
    const decisionsAfterDelete = getDb()
      .select({ id: policyDecisions.id })
      .from(policyDecisions)
      .where(eq(policyDecisions.tenantId, create.body.id))
      .all();
    expect(decisionsAfterDelete).toEqual([]);
  });
});
