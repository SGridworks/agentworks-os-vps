import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileVaultStore } from "./file-store.js";
import { UsageTracker } from "./usage-tracker.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const AGENT_1 = "704c0f26-757a-4e4d-922f-3695895bc95c";
const AGENT_2 = "8c3e9fa1-4b91-4c2a-9f12-6e8d4f2c1a03";
const AGENT_3 = "9f7b2c4d-1e8f-4a5b-9c2d-3f4e5a6b7c8d";

describe("UsageTracker", () => {
  let root: string;
  let store: FileVaultStore;
  let usageTracker: UsageTracker;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vault-usage-test-"));
    store = new FileVaultStore({ root });
    usageTracker = new UsageTracker(store, {
      batchSize: 10,
      flushIntervalMs: 100, // Fast flush for testing
    });
  });

  afterEach(() => {
    usageTracker.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  it("should track usage and update lastUsedBy", async () => {
    // Create a document
    await store.write(TENANT_A, "test-page", "Test content");
    
    // Record usage
    usageTracker.recordUsage(TENANT_A, "test-page", AGENT_1);
    
    // Wait for flush
    await new Promise(resolve => setTimeout(resolve, 150));
    
    // Check that lastUsedBy was updated
    const result = await store.read(TENANT_A, "test-page");
    expect(result.lastUsedBy).toBeDefined();
    expect(result.lastUsedBy).toHaveLength(1);
    expect(result.lastUsedBy![0].agentId).toBe(AGENT_1);
  });

  it("should deduplicate same agent and keep most recent", async () => {
    // Create a document
    await store.write(TENANT_A, "test-page", "Test content");
    
    // Record usage multiple times for same agent
    usageTracker.recordUsage(TENANT_A, "test-page", AGENT_1);
    await new Promise(resolve => setTimeout(resolve, 10));
    usageTracker.recordUsage(TENANT_A, "test-page", AGENT_1);
    
    // Wait for flush
    await new Promise(resolve => setTimeout(resolve, 150));
    
    // Check that only one entry exists for the agent
    const result = await store.read(TENANT_A, "test-page");
    expect(result.lastUsedBy).toBeDefined();
    expect(result.lastUsedBy).toHaveLength(1);
    expect(result.lastUsedBy![0].agentId).toBe(AGENT_1);
  });

  it("should track multiple agents", async () => {
    // Create a document
    await store.write(TENANT_A, "test-page", "Test content");
    
    // Record usage for multiple agents
    usageTracker.recordUsage(TENANT_A, "test-page", AGENT_1);
    usageTracker.recordUsage(TENANT_A, "test-page", AGENT_2);
    usageTracker.recordUsage(TENANT_A, "test-page", AGENT_3);
    
    // Wait for flush
    await new Promise(resolve => setTimeout(resolve, 150));
    
    // Check that all agents are tracked
    const result = await store.read(TENANT_A, "test-page");
    expect(result.lastUsedBy).toBeDefined();
    expect(result.lastUsedBy).toHaveLength(3);
    
    const agentIds = result.lastUsedBy!.map(entry => entry.agentId).sort();
    expect(agentIds).toEqual([AGENT_1, AGENT_2, AGENT_3].sort());
  });

  it("should cap lastUsedBy at 10 entries", async () => {
    // Create a document
    await store.write(TENANT_A, "test-page", "Test content");
    
    // Create 15 different agents
    const agents = Array.from({ length: 15 }, (_, i) => `agent-${i}`);
    
    // Record usage for all agents
    agents.forEach(agentId => {
      usageTracker.recordUsage(TENANT_A, "test-page", agentId);
    });
    
    // Wait for flush
    await new Promise(resolve => setTimeout(resolve, 150));
    
    // Check that only 10 entries are kept
    const result = await store.read(TENANT_A, "test-page");
    expect(result.lastUsedBy).toBeDefined();
    expect(result.lastUsedBy).toHaveLength(10);
  });

  it("should handle non-existent documents gracefully", async () => {
    // Try to track usage for non-existent document
    usageTracker.recordUsage(TENANT_A, "non-existent", AGENT_1);
    
    // Wait for flush
    await new Promise(resolve => setTimeout(resolve, 150));
    
    // Should not throw, document should still not exist
    const result = await store.read(TENANT_A, "non-existent");
    expect(result.existed).toBe(false);
  });

  it("should isolate tenants", async () => {
    // Create documents in different tenants
    await store.write(TENANT_A, "shared-page", "Tenant A content");
    await store.write(TENANT_B, "shared-page", "Tenant B content");
    
    // Record usage for different agents in each tenant
    usageTracker.recordUsage(TENANT_A, "shared-page", AGENT_1);
    usageTracker.recordUsage(TENANT_B, "shared-page", AGENT_2);
    
    // Wait for flush
    await new Promise(resolve => setTimeout(resolve, 150));
    
    // Check that usage is isolated per tenant
    const resultA = await store.read(TENANT_A, "shared-page");
    const resultB = await store.read(TENANT_B, "shared-page");
    
    expect(resultA.lastUsedBy).toBeDefined();
    expect(resultA.lastUsedBy).toHaveLength(1);
    expect(resultA.lastUsedBy![0].agentId).toBe(AGENT_1);
    
    expect(resultB.lastUsedBy).toBeDefined();
    expect(resultB.lastUsedBy).toHaveLength(1);
    expect(resultB.lastUsedBy![0].agentId).toBe(AGENT_2);
  });

  it("should batch updates efficiently", async () => {
    // Create multiple documents
    await store.write(TENANT_A, "page1", "Content 1");
    await store.write(TENANT_A, "page2", "Content 2");
    await store.write(TENANT_A, "page3", "Content 3");
    
    // Record many usage events
    for (let i = 0; i < 30; i++) {
      usageTracker.recordUsage(TENANT_A, "page1", `agent-${i}`);
      usageTracker.recordUsage(TENANT_A, "page2", `agent-${i}`);
      usageTracker.recordUsage(TENANT_A, "page3", `agent-${i}`);
    }
    
    // Wait for flush
    await new Promise(resolve => setTimeout(resolve, 150));
    
    // Check that all pages were updated
    const result1 = await store.read(TENANT_A, "page1");
    const result2 = await store.read(TENANT_A, "page2");
    const result3 = await store.read(TENANT_A, "page3");
    
    expect(result1.lastUsedBy).toBeDefined();
    expect(result1.lastUsedBy).toHaveLength(10); // Capped at 10
    
    expect(result2.lastUsedBy).toBeDefined();
    expect(result2.lastUsedBy).toHaveLength(10);
    
    expect(result3.lastUsedBy).toBeDefined();
    expect(result3.lastUsedBy).toHaveLength(10);
  });

  it("should handle manual flush correctly", async () => {
    // Create a document
    await store.write(TENANT_A, "test-page", "Test content");
    
    // Record usage
    usageTracker.recordUsage(TENANT_A, "test-page", AGENT_1);
    
    // Manually flush
    await usageTracker.flush();
    
    // Check that lastUsedBy was updated immediately
    const result = await store.read(TENANT_A, "test-page");
    expect(result.lastUsedBy).toBeDefined();
    expect(result.lastUsedBy).toHaveLength(1);
    expect(result.lastUsedBy![0].agentId).toBe(AGENT_1);
  });

  it("should preserve existing lastUsedBy when updating", async () => {
    // Create a document with existing lastUsedBy
    await store.write(TENANT_A, "test-page", "Test content", {
      lastUsedBy: [{ agentId: AGENT_1, usedAt: "2023-01-01T00:00:00.000Z" }],
    });
    
    // Record new usage
    usageTracker.recordUsage(TENANT_A, "test-page", AGENT_2);
    
    // Wait for flush
    await new Promise(resolve => setTimeout(resolve, 150));
    
    // Check that both entries are preserved (with newer one first)
    const result = await store.read(TENANT_A, "test-page");
    expect(result.lastUsedBy).toBeDefined();
    expect(result.lastUsedBy).toHaveLength(2);
    
    // The newer usage should be first (most recent)
    expect(result.lastUsedBy![0].agentId).toBe(AGENT_2);
    expect(result.lastUsedBy![1].agentId).toBe(AGENT_1);
  });
});