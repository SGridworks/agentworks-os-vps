import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FileVaultStore } from "./file-store.js";
import { consolidateVault } from "./consolidate.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import os from "node:os";

describe("consolidateVault", () => {
  let root: string;
  let store: FileVaultStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(os.tmpdir(), "aw-consolidate-test-"));
    store = new FileVaultStore({ root });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true });
  });

  it("calls snapshot before returning", async () => {
    await store.write("t1", "key1", "# Hello");
    const snapshotSpy = vi.spyOn(store, "snapshot");

    await consolidateVault("t1", store);

    expect(snapshotSpy).toHaveBeenCalledWith("t1");
  });

  it("returns a snapshotId", async () => {
    await store.write("t1", "key1", "# Hello");
    const result = await consolidateVault("t1", store);
    expect(result.snapshotId).toBeTruthy();
    expect(typeof result.snapshotId).toBe("string");
  });

  it("returns compacted and pruned counts", async () => {
    await store.write("t1", "key1", "# Hello");
    const result = await consolidateVault("t1", store);
    expect(result.compacted).toBeTypeOf("number");
    expect(result.pruned).toBeTypeOf("number");
  });
});
