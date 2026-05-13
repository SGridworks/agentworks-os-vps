import { describe, it, expect } from "vitest";
import { FileVaultStore } from "./file-store.js";
import { VaultPageSchema } from "./types.js";

describe("FrontmatterMeta fields", () => {
  it("should parse and serialize new provenance fields", async () => {
    const store = new FileVaultStore({ root: "/tmp/test-vault" });
    const tenantId = "test-tenant";
    const key = "test-page";
    
    // Write a page with the new frontmatter fields
    const body = "# Test content";
    const result = await store.write(tenantId, key, body, {
      summary: "Test summary",
      trigger: "test trigger",
    });

    // Read it back and verify the fields are preserved
    const readResult = await store.read(tenantId, key);
    
    // Verify the schema validation works with new fields
    const validatedPage = VaultPageSchema.parse(readResult);
    expect(validatedPage.tenantId).toBe(tenantId);
    expect(validatedPage.key).toBe(key);
    // The body will have a newline prefix due to frontmatter serialization
    expect(validatedPage.body).toContain("# Test content");
    expect(validatedPage.summary).toBe("Test summary");
    expect(validatedPage.trigger).toBe("test trigger");
    
    // The new fields should be undefined initially since we haven't set them
    expect(validatedPage.authoringAgent).toBeUndefined();
    expect(validatedPage.lastUpdatedBy).toBeUndefined();
    expect(validatedPage.lastUpdatedAt).toBeUndefined();
    expect(validatedPage.lastUsedBy).toBeUndefined();
  });

  it("should validate UUID fields correctly", async () => {
    const validUuid = "704c0f26-757a-4e4d-922f-3695895bc95c";
    const invalidUuid = "not-a-uuid";
    
    // Valid UUID should pass
    const validPage = {
      tenantId: "test",
      key: "test-key",
      body: "test",
      updatedAt: new Date().toISOString(),
      sha256: "abc123",
      authoringAgent: validUuid,
      lastUpdatedBy: validUuid,
    };
    
    expect(() => VaultPageSchema.parse(validPage)).not.toThrow();
    
    // Invalid UUID should fail
    const invalidPage = {
      ...validPage,
      authoringAgent: invalidUuid,
    };
    
    expect(() => VaultPageSchema.parse(invalidPage)).toThrow();
  });

  it("should validate lastUsedBy array correctly", async () => {
    const validPage = {
      tenantId: "test",
      key: "test-key", 
      body: "test",
      updatedAt: new Date().toISOString(),
      sha256: "abc123",
      lastUsedBy: [
        { agentId: "704c0f26-757a-4e4d-922f-3695895bc95c", usedAt: "2026-05-19T15:00:00.000Z" },
        { agentId: "8c3e9fa1-4b91-4c2a-9f12-6e8d4f2c1a03", usedAt: "2026-05-19T15:05:12.050Z" }
      ]
    };
    
    expect(() => VaultPageSchema.parse(validPage)).not.toThrow();
    
    // Invalid agentId should fail
    const invalidPage = {
      ...validPage,
      lastUsedBy: [
        { agentId: "invalid-uuid", usedAt: "2026-05-19T15:00:00.000Z" }
      ]
    };
    
    expect(() => VaultPageSchema.parse(invalidPage)).toThrow();
  });
});