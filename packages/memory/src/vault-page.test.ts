import { describe, it, expect } from "vitest";
import { z } from "zod";
import { VaultPageSchema } from "./types.js";

describe("VaultPageSchema", () => {
  it("accepts summary and trigger fields", () => {
    const page: z.infer<typeof VaultPageSchema> = {
      tenantId: "tenant-1",
      key: "test/key",
      body: "# Hello",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sha256: "abc123",
      summary: "A brief indexable description",
      trigger: "When I need to know about test topics",
    };
    const result = VaultPageSchema.safeParse(page);
    expect(result.success).toBe(true);
  });

  it("accepts page without summary and trigger (backwards compatible)", () => {
    const page: z.infer<typeof VaultPageSchema> = {
      tenantId: "tenant-1",
      key: "test/key",
      body: "# Hello",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sha256: "abc123",
    };
    const result = VaultPageSchema.safeParse(page);
    expect(result.success).toBe(true);
  });

  it("summary field is optional string", () => {
    const page = {
      tenantId: "tenant-1",
      key: "test/key",
      body: "# Hello",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sha256: "abc123",
      summary: 42 as unknown,
    };
    const result = VaultPageSchema.safeParse(page);
    expect(result.success).toBe(false);
  });

  it("trigger field is optional string", () => {
    const page = {
      tenantId: "tenant-1",
      key: "test/key",
      body: "# Hello",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sha256: "abc123",
      trigger: 123 as unknown,
    };
    const result = VaultPageSchema.safeParse(page);
    expect(result.success).toBe(false);
  });
});
