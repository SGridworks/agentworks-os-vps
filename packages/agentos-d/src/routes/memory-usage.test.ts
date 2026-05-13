import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { initDb, resetDb } from "../db/index.js";
import { migrate } from "../db/migrations/index.js";
import { _resetVaultStoreForTesting } from "./memory.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const AGENT_1 = "704c0f26-757a-4e4d-922f-3695895bc95c";
const AGENT_2 = "8c3e9fa1-4b91-4c2a-9f12-6e8d4f2c1a03";

describe("Memory Routes - Usage Tracking", () => {
  let root: string;
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let originalVaultRoot: string | undefined;
  let originalDataDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memory-routes-usage-test-"));
    dataDir = mkdtempSync(join(tmpdir(), "memory-routes-usage-db-"));
    originalVaultRoot = process.env.VAULT_ROOT;
    originalDataDir = process.env.AGENTOS_DATA_DIR;
    process.env.VAULT_ROOT = root;
    process.env.AGENTOS_DATA_DIR = dataDir;
    _resetVaultStoreForTesting();
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
    _resetVaultStoreForTesting();
    resetDb();
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("should track usage when reading with actorId", async () => {
    const writeResponse = await request(app)
      .post("/api/memory/write")
      .send({
        tenantId: TENANT_A,
        key: "test-page",
        body: "Test content for usage tracking",
      });

    expect(writeResponse.status).toBe(201);

    const readResponse = await request(app)
      .post("/api/memory/read")
      .send({
        tenantId: TENANT_A,
        key: "test-page",
        actorId: AGENT_1,
      });

    expect(readResponse.status).toBe(200);
    expect(readResponse.body.ok).toBe(true);
    expect(readResponse.body.data.existed).toBe(true);

    await new Promise(resolve => setTimeout(resolve, 3500));

    const checkResponse = await request(app)
      .post("/api/memory/read")
      .send({
        tenantId: TENANT_A,
        key: "test-page",
      });

    expect(checkResponse.status).toBe(200);
    expect(checkResponse.body.ok).toBe(true);

    const provenanceResponse = await request(app)
      .get("/api/memory/provenance")
      .query({ tenantId: TENANT_A, key: "test-page" });
    expect(provenanceResponse.status).toBe(200);

    const provenanceData = provenanceResponse.body;
    expect(provenanceData.ok).toBe(true);
    expect(provenanceData.data.frontmatter.lastUsedBy).toBeDefined();
    expect(provenanceData.data.frontmatter.lastUsedBy).toHaveLength(1);
    expect(provenanceData.data.frontmatter.lastUsedBy[0].agentId).toBe(AGENT_1);
  });

  it("should not track usage when reading without actorId", async () => {
    const writeResponse = await request(app)
      .post("/api/memory/write")
      .send({
        tenantId: TENANT_A,
        key: "test-page-no-actor",
        body: "Test content without actor tracking",
      });

    expect(writeResponse.status).toBe(201);

    const readResponse = await request(app)
      .post("/api/memory/read")
      .send({
        tenantId: TENANT_A,
        key: "test-page-no-actor",
      });

    expect(readResponse.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 3500));

    const provenanceResponse = await request(app)
      .get("/api/memory/provenance")
      .query({ tenantId: TENANT_A, key: "test-page-no-actor" });
    expect(provenanceResponse.status).toBe(200);

    const provenanceData = provenanceResponse.body;
    expect(provenanceData.ok).toBe(true);
    expect(provenanceData.data.frontmatter.lastUsedBy).toBeUndefined();
  });

  it("should not track usage for non-existent documents", async () => {
    const readResponse = await request(app)
      .post("/api/memory/read")
      .send({
        tenantId: TENANT_A,
        key: "non-existent-page",
        actorId: AGENT_1,
      });

    expect(readResponse.status).toBe(200);
    expect(readResponse.body.ok).toBe(true);
    expect(readResponse.body.data.existed).toBe(false);

    await new Promise(resolve => setTimeout(resolve, 3500));

    const checkResponse = await request(app)
      .post("/api/memory/read")
      .send({
        tenantId: TENANT_A,
        key: "non-existent-page",
      });

    expect(checkResponse.status).toBe(200);
    expect(checkResponse.body.ok).toBe(true);
    expect(checkResponse.body.data.existed).toBe(false);
  });

  it("should handle multiple actors reading the same document", async () => {
    const writeResponse = await request(app)
      .post("/api/memory/write")
      .send({
        tenantId: TENANT_A,
        key: "multi-actor-page",
        body: "Content for multiple actors",
      });

    expect(writeResponse.status).toBe(201);

    await request(app)
      .post("/api/memory/read")
      .send({
        tenantId: TENANT_A,
        key: "multi-actor-page",
        actorId: AGENT_1,
      });

    await request(app)
      .post("/api/memory/read")
      .send({
        tenantId: TENANT_A,
        key: "multi-actor-page",
        actorId: AGENT_2,
      });

    await new Promise(resolve => setTimeout(resolve, 3500));

    const provenanceResponse = await request(app)
      .get("/api/memory/provenance")
      .query({ tenantId: TENANT_A, key: "multi-actor-page" });
    expect(provenanceResponse.status).toBe(200);

    const provenanceData = provenanceResponse.body;
    expect(provenanceData.ok).toBe(true);
    expect(provenanceData.data.frontmatter.lastUsedBy).toBeDefined();
    expect(provenanceData.data.frontmatter.lastUsedBy).toHaveLength(2);

    const agentIds = provenanceData.data.frontmatter.lastUsedBy.map((entry: any) => entry.agentId).sort();
    expect(agentIds).toEqual([AGENT_1, AGENT_2].sort());
  });
});
