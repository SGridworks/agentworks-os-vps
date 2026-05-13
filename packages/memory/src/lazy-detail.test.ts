import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FileVaultStore } from "./file-store.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const TMP = `/tmp/file-store-lazy-detail-${randomUUID()}`;

let store: FileVaultStore;

beforeEach(async () => {
  store = new FileVaultStore({ root: TMP, maxBytes: 10_000_000 });
  await fs.mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("lazy detail storage", () => {
  it("writes detail_body to .details dir and surfaces detail_key in read result", async () => {
    const tenant = "tenant-1";
    const key = "test/lazy-page";
    const body = "# Summary only";
    const detailBody = "# Full detailed content with code examples and long text...";

    await store.write(tenant, key, body, {
      summary: "A summary",
      trigger: "When I need the full details",
      detail_body: detailBody,
    });

    const result = await store.read(tenant, key);
    expect(result.existed).toBe(true);
    expect(result.summary).toBe("A summary");
    expect(result.trigger).toBe("When I need the full details");
    expect(result.detail_key).toBeDefined();
    expect(result.detail_key).toMatch(/^detail-\d+-[a-z0-9]+$/);

    // Read detail via readDetail
    const detail = await store.readDetail(tenant, result.detail_key!);
    expect(detail).toBe(detailBody);
  });

  it("detail_key persists across rewrite without detail_body", async () => {
    const tenant = "tenant-1";
    const key = "test/persist-detail";
    const body1 = "# Version 1";
    const detailBody = "# Very detailed content";

    await store.write(tenant, key, body1, { detail_body: detailBody });
    const r1 = await store.read(tenant, key);
    const firstKey = r1.detail_key!;

    // Rewrite without detail_body — should preserve the existing detail_key
    await store.write(tenant, key, "# Version 2", { trigger: "Updated trigger" });
    const r2 = await store.read(tenant, key);
    expect(r2.detail_key).toBe(firstKey);

    // Detail still accessible
    const detail = await store.readDetail(tenant, firstKey);
    expect(detail).toBe(detailBody);
  });

  it("rejects detailKey with path traversal", async () => {
    const tenant = "tenant-1";
    await expect(
      store.readDetail(tenant, "../../../etc/passwd"),
    ).rejects.toThrow("Invalid detailKey");
  });

  it("rejects detailKey with special characters", async () => {
    const tenant = "tenant-1";
    await expect(store.readDetail(tenant, "foo/bar")).rejects.toThrow("Invalid detailKey");
    await expect(store.readDetail(tenant, "foo\x00bar")).rejects.toThrow("Invalid detailKey");
  });

  it("throws when detail file not found", async () => {
    const tenant = "tenant-1";
    await expect(store.readDetail(tenant, "nonexistent-detail-key")).rejects.toThrow(
      "Detail not found",
    );
  });

  it("deleting a page removes its detail file", async () => {
    const tenant = "tenant-1";
    const key = "test/delete-with-detail";
    await store.write(tenant, key, "# Body", { detail_body: "# Detail body" });
    const r = await store.read(tenant, key);
    const dk = r.detail_key!;

    // Detail file exists
    await store.readDetail(tenant, dk);

    // Delete the page
    await store.delete(tenant, key);

    // Detail file gone
    await expect(store.readDetail(tenant, dk)).rejects.toThrow("Detail not found");
  });
});
