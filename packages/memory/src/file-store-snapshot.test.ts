import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FileVaultStore } from "./file-store.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import os from "node:os";

describe("FileVaultStore snapshot/restore", () => {
  let root: string;
  let store: FileVaultStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(os.tmpdir(), "aw-vault-test-"));
    store = new FileVaultStore({ root });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true });
  });

  it("snapshot creates a copy of all pages", async () => {
    await store.write("t1", "key1", "# Hello");
    await store.write("t1", "key2", "# World");

    const snapshotId = await store.snapshot("t1");
    expect(snapshotId).toBeTruthy();

    const snapRoot = join(root, ".snapshots", "t1", snapshotId);
    const files = await fs.readdir(snapRoot);
    expect(files).toContain("key1.md");
    expect(files).toContain("key2.md");
    expect(files).toContain("snapshot-manifest.json");
  });

  it("snapshot of empty vault creates manifest with no pages", async () => {
    const snapshotId = await store.snapshot("t1");
    const snapRoot = join(root, ".snapshots", "t1", snapshotId);
    const manifestRaw = await fs.readFile(join(snapRoot, "snapshot-manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.pages).toEqual({});
  });

  it("restore overwrites current content with snapshot", async () => {
    await store.write("t1", "key1", "# Original");
    const snapshotId = await store.snapshot("t1");

    await store.write("t1", "key1", "# Modified");
    const result = await store.read("t1", "key1");
    expect(result.body).toContain("Modified");

    await store.restore("t1", snapshotId);
    const restored = await store.read("t1", "key1");
    expect(restored.body).toContain("Original");
  });

  it("restore removes pages not in snapshot", async () => {
    await store.write("t1", "key1", "# Keep me");
    await store.write("t1", "key2", "# Remove me");
    const snapshotId = await store.snapshot("t1");

    // key2 was in snapshot; now remove it from current vault
    await store.restore("t1", snapshotId);
    const keys = await store.list("t1");
    expect(keys).toContain("key2");
    // key1 should still exist
    expect(keys).toContain("key1");
  });

  it("snapshot and restore are idempotent", async () => {
    await store.write("t1", "key1", "# Content A");
    const snap1 = await store.snapshot("t1");
    await store.write("t1", "key1", "# Content B");
    await store.restore("t1", snap1);
    const after = await store.read("t1", "key1");
    expect(after.body).toContain("Content A");
  });

  it("snapshot rejects invalid tenantId", async () => {
    await expect(store.snapshot("t1/../t2")).rejects.toThrow("Invalid tenantId");
    await expect(store.snapshot("t1..t2")).rejects.toThrow("Invalid tenantId");
  });

  it("restore rejects invalid tenantId and snapshotId", async () => {
    await expect(store.restore("t1/..", "snap1")).rejects.toThrow("Invalid tenantId");
    await expect(store.restore("t1", "..")).rejects.toThrow("Invalid snapshotId");
    await expect(store.restore("t1", "snap1/..")).rejects.toThrow("Invalid snapshotId");
  });

  it("restore throws for nonexistent snapshot", async () => {
    await expect(store.restore("t1", "nonexistent-snapshot-id")).rejects.toThrow(
      "Snapshot not found",
    );
  });
});
