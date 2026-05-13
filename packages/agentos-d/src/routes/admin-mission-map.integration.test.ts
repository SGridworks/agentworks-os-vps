/**
 * Integration test: GET /api/admin/mission-map
 *
 * Verifies the mission map endpoint returns the expected shape
 * and handles tenant-scoped queries correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, resetDb } from "../db/client.js";
import { migrate } from "../db/migrations/index.js";
import { createNode, createEdge } from "../services/mission-map.js";
import request from "supertest";
import { createApp } from "../app.js";
import type { Config } from "../config.js";

let tmpRoot: string;
let app: ReturnType<typeof createApp>;
const testTenantId = "test-tenant-123";

function testConfig(port: number): Config {
  return {
    host: "127.0.0.1",
    port,
    logLevel: "warn",
    awcpVersion: "awcp/v0.1",
    dataDir: tmpRoot,
    scannerSidecarUrl: "http://127.0.0.1:0",
    scannerPollIntervalMs: 30_000,
    auditLogRetentionDays: 30,
  };
}

beforeEach(() => {
  resetDb();
  tmpRoot = mkdtempSync(join(tmpdir(), "awo-mission-map-api-"));
  initDb({ config: testConfig(0), migrations: migrate });
  app = createApp(testConfig(0));
});

afterEach(() => {
  resetDb();
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("GET /api/admin/mission-map", () => {
  it("returns empty graph for tenant with no data", async () => {
    const res = await request(app)
      .get("/api/admin/mission-map")
      .query({ tenantId: "empty-tenant" })
      .expect(200);

    expect(res.body).toEqual({
      nodes: [],
      edges: []
    });
  });

  it("returns graph with nodes and edges", async () => {
    // Create test data
    const company = createNode({
      tenantId: testTenantId,
      kind: "company",
      title: "Test Company",
      status: "active",
      meta: {
        domain: "test.com",
        plan_tier: "premium"
      }
    });

    const project = createNode({
      tenantId: testTenantId,
      kind: "project",
      title: "Test Project"
    });

    const issue = createNode({
      tenantId: testTenantId,
      kind: "issue",
      title: "Test Issue",
      status: "in_progress"
    });

    createEdge({
      tenantId: testTenantId,
      fromNodeId: company.id,
      toNodeId: project.id,
      kind: "owns"
    });

    createEdge({
      tenantId: testTenantId,
      fromNodeId: project.id,
      toNodeId: issue.id,
      kind: "owns"
    });

    const res = await request(app)
      .get("/api/admin/mission-map")
      .query({ tenantId: testTenantId })
      .expect(200);

    expect(res.body.nodes).toHaveLength(3);
    expect(res.body.edges).toHaveLength(2);

    // Verify node structure
    const companyNode = res.body.nodes.find((n: any) => n.id === company.id);
    expect(companyNode).toBeDefined();
    expect(companyNode.kind).toBe("company");
    expect(companyNode.title).toBe("Test Company");
    expect(companyNode.status).toBe("active");
    expect(companyNode.meta.domain).toBe("test.com");
    expect(companyNode.color).toBe("#0ea5e9"); // company default color

    const issueNode = res.body.nodes.find((n: any) => n.id === issue.id);
    expect(issueNode).toBeDefined();
    expect(issueNode.kind).toBe("issue");
    expect(issueNode.status).toBe("in_progress");
    expect(issueNode.color).toBe("#f59e0b"); // issue default color

    // Verify edge structure
    const edge = res.body.edges.find((e: any) => e.from_node_id === company.id && e.to_node_id === project.id);
    expect(edge).toBeDefined();
    expect(edge.kind).toBe("owns");
  });

  it("returns subgraph when root parameter is provided", async () => {
    // Create test data
    const rootProject = createNode({
      tenantId: testTenantId,
      kind: "project",
      title: "Root Project"
    });

    const childIssue = createNode({
      tenantId: testTenantId,
      kind: "issue",
      title: "Child Issue"
    });

    const unrelatedNode = createNode({
      tenantId: testTenantId,
      kind: "agent",
      title: "Unrelated Agent"
    });

    createEdge({
      tenantId: testTenantId,
      fromNodeId: rootProject.id,
      toNodeId: childIssue.id,
      kind: "owns"
    });

    const res = await request(app)
      .get("/api/admin/mission-map")
      .query({ 
        tenantId: testTenantId,
        root: rootProject.id,
        depth: 1
      })
      .expect(200);

    // Should include root and its direct child
    const nodeIds = new Set(res.body.nodes.map((n: any) => n.id));
    expect(nodeIds.has(rootProject.id)).toBe(true);
    expect(nodeIds.has(childIssue.id)).toBe(true);
    expect(nodeIds.has(unrelatedNode.id)).toBe(false); // should not include unrelated node
  });

  it("returns 400 when tenantId is missing", async () => {
    const res = await request(app)
      .get("/api/admin/mission-map")
      .expect(400);

    expect(res.body).toEqual({
      error: "tenantId required"
    });
  });

  it("handles depth parameter correctly", async () => {
    // Create test data
    const company = createNode({
      tenantId: testTenantId,
      kind: "company",
      title: "Test Company"
    });

    const res = await request(app)
      .get("/api/admin/mission-map")
      .query({ 
        tenantId: testTenantId,
        depth: 2
      })
      .expect(200);

    expect(res.body.nodes).toBeDefined();
    expect(res.body.edges).toBeDefined();
  });

  it("computes node colors correctly", async () => {
    // Create nodes with different statuses
    const doneIssue = createNode({
      tenantId: testTenantId,
      kind: "issue",
      title: "Done Issue",
      status: "done"
    });

    const blockedIssue = createNode({
      tenantId: testTenantId,
      kind: "issue",
      title: "Blocked Issue",
      status: "blocked"
    });

    const failedRun = createNode({
      tenantId: testTenantId,
      kind: "run",
      title: "Failed Run",
      status: "failed"
    });

    const blockEvidence = createNode({
      tenantId: testTenantId,
      kind: "evidence",
      title: "Block Evidence",
      meta: { severity: "block" }
    });

    const res = await request(app)
      .get("/api/admin/mission-map")
      .query({ tenantId: testTenantId })
      .expect(200);

    const nodes = res.body.nodes;
    
    const doneNode = nodes.find((n: any) => n.id === doneIssue.id);
    expect(doneNode.color).toBe("#10b981"); // green for done issues

    const blockedNode = nodes.find((n: any) => n.id === blockedIssue.id);
    expect(blockedNode.color).toBe("#ef4444"); // red for blocked issues

    const failedNode = nodes.find((n: any) => n.id === failedRun.id);
    expect(failedNode.color).toBe("#ef4444"); // red for failed runs

    const evidenceNode = nodes.find((n: any) => n.id === blockEvidence.id);
    expect(evidenceNode.color).toBe("#991b1b"); // dark red for block severity
  });
});