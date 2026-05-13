/**
 * Test: Mission Map Service
 *
 * Verifies the mission map service functions work correctly
 * and handle tenant-scoped queries properly.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, resetDb, getDb } from "../db/client.js";
import { migrate } from "../db/migrations/index.js";
import { createNode, createEdge, getGraph } from "./mission-map.js";
import type { NodeKind, EdgeKind } from "./mission-map.js";

let tmpRoot: string;
const testTenantId = "test-tenant-123";

beforeEach(() => {
  resetDb();
  tmpRoot = mkdtempSync(join(tmpdir(), "awo-mission-map-"));
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

describe("Mission Map Service", () => {
  it("creates and retrieves nodes", () => {
    const node = createNode({
      tenantId: testTenantId,
      kind: "company",
      title: "Test Company",
      status: "active",
      meta: {
        domain: "test.com",
        plan_tier: "premium",
        seats: 10
      }
    });

    expect(node.id).toBeDefined();
    expect(node.kind).toBe("company");
    expect(node.title).toBe("Test Company");
    expect(node.status).toBe("active");
    expect(node.meta.domain).toBe("test.com");
    expect(node.color).toBe("#0ea5e9"); // company default color
  });

  it("creates and retrieves edges", () => {
    const companyNode = createNode({
      tenantId: testTenantId,
      kind: "company",
      title: "Parent Company"
    });

    const projectNode = createNode({
      tenantId: testTenantId,
      kind: "project",
      title: "Test Project"
    });

    const edge = createEdge({
      tenantId: testTenantId,
      fromNodeId: companyNode.id,
      toNodeId: projectNode.id,
      kind: "owns",
      meta: { weight: 1.0 }
    });

    expect(edge.id).toBeDefined();
    expect(edge.kind).toBe("owns");
    expect(edge.from_node_id).toBe(companyNode.id);
    expect(edge.to_node_id).toBe(projectNode.id);
    expect(edge.meta.weight).toBe(1.0);
  });

  it("validates node existence when creating edges", () => {
    expect(() => {
      createEdge({
        tenantId: testTenantId,
        fromNodeId: "nonexistent-1",
        toNodeId: "nonexistent-2",
        kind: "owns"
      });
    }).toThrow("One or both nodes not found or do not belong to tenant");
  });

  it("computes node colors correctly", () => {
    const activeCompany = createNode({
      tenantId: testTenantId,
      kind: "company",
      title: "Active Company"
    });
    expect(activeCompany.color).toBe("#0ea5e9"); // company default

    const doneIssue = createNode({
      tenantId: testTenantId,
      kind: "issue",
      title: "Done Issue",
      status: "done"
    });
    expect(doneIssue.color).toBe("#10b981"); // green for done issues

    const blockedIssue = createNode({
      tenantId: testTenantId,
      kind: "issue",
      title: "Blocked Issue",
      status: "blocked"
    });
    expect(blockedIssue.color).toBe("#ef4444"); // red for blocked issues

    const failedRun = createNode({
      tenantId: testTenantId,
      kind: "run",
      title: "Failed Run",
      status: "failed"
    });
    expect(failedRun.color).toBe("#ef4444"); // red for failed runs

    const blockEvidence = createNode({
      tenantId: testTenantId,
      kind: "evidence",
      title: "Block Evidence",
      meta: { severity: "block" }
    });
    expect(blockEvidence.color).toBe("#991b1b"); // dark red for block severity
  });

  it("retrieves full graph for tenant", () => {
    // Create test data
    const company = createNode({
      tenantId: testTenantId,
      kind: "company",
      title: "Graph Test Company"
    });

    const project = createNode({
      tenantId: testTenantId,
      kind: "project",
      title: "Graph Test Project"
    });

    const issue = createNode({
      tenantId: testTenantId,
      kind: "issue",
      title: "Graph Test Issue"
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

    const graph = getGraph({ tenantId: testTenantId });

    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toHaveLength(2);

    const nodeIds = new Set(graph.nodes.map(n => n.id));
    expect(nodeIds.has(company.id)).toBe(true);
    expect(nodeIds.has(project.id)).toBe(true);
    expect(nodeIds.has(issue.id)).toBe(true);

    const edgeKinds = graph.edges.map(e => e.kind);
    expect(edgeKinds).toContain("owns");
  });

  it("retrieves subgraph rooted at node", () => {
    const rootNode = createNode({
      tenantId: testTenantId,
      kind: "project",
      title: "Root Project"
    });

    const child1 = createNode({
      tenantId: testTenantId,
      kind: "issue",
      title: "Child Issue 1"
    });

    const child2 = createNode({
      tenantId: testTenantId,
      kind: "issue",
      title: "Child Issue 2"
    });

    createEdge({
      tenantId: testTenantId,
      fromNodeId: rootNode.id,
      toNodeId: child1.id,
      kind: "owns"
    });

    createEdge({
      tenantId: testTenantId,
      fromNodeId: rootNode.id,
      toNodeId: child2.id,
      kind: "owns"
    });

    const subgraph = getGraph({
      tenantId: testTenantId,
      root: rootNode.id,
      depth: 1
    });

    // Should include root and its direct children
    const nodeIds = new Set(subgraph.nodes.map(n => n.id));
    expect(nodeIds.has(rootNode.id)).toBe(true);
    expect(nodeIds.has(child1.id)).toBe(true);
    expect(nodeIds.has(child2.id)).toBe(true);
  });

  it("handles empty graph gracefully", () => {
    const emptyTenantId = "empty-tenant-456";
    const graph = getGraph({ tenantId: emptyTenantId });
    
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });

  it("handles nonexistent root node gracefully", () => {
    const graph = getGraph({
      tenantId: testTenantId,
      root: "nonexistent-root"
    });
    
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });
});