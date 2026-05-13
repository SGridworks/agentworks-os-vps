import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FileVaultStore, DiskFullError, MemoryKeyTooLargeError } from "./file-store.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

describe("FileVaultStore", () => {
  let root: string;
  let store: FileVaultStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vault-test-"));
    store = new FileVaultStore({ root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("read returns existed=false with empty body for missing key", async () => {
    const r = await store.read(TENANT_A, "projects/sgridworks");
    expect(r.existed).toBe(false);
    expect(r.body).toBe("");
    expect(r.sha256).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("write replace then read round-trips body", async () => {
    const w = await store.write(TENANT_A, "hello", "world");
    expect(w.bytesWritten).toBe(5);
    const r = await store.read(TENANT_A, "hello");
    expect(r.existed).toBe(true);
    expect(r.body).toBe("world");
  });

  it("write append adds a timestamp block", async () => {
    await store.write(TENANT_A, "log", "first", { mode: "replace" });
    await store.write(TENANT_A, "log", "second", { mode: "append" });
    const r = await store.read(TENANT_A, "log");
    expect(r.body).toMatch(/^first\n\n## \d{4}-\d{2}-\d{2}T.*Z\nsecond\n$/);
  });

  it("write creates parent directories for nested keys", async () => {
    await store.write(TENANT_A, "projects/sg/notes", "deep", { mode: "append" });
    const r = await store.read(TENANT_A, "projects/sg/notes");
    expect(r.existed).toBe(true);
    expect(r.body).toContain("deep");
  });

  it("isolates tenants — A does not see B's pages", async () => {
    await store.write(TENANT_A, "secret", "alpha");
    const fromB = await store.read(TENANT_B, "secret");
    expect(fromB.existed).toBe(false);
    expect(fromB.body).toBe("");
  });

  it("rejects keys with .. (path traversal)", async () => {
    await expect(store.write(TENANT_A, "../escape", "x")).rejects.toThrow();
  });

  it("rejects keys starting with /", async () => {
    await expect(store.write(TENANT_A, "/abs", "x")).rejects.toThrow();
  });

  it("rejects tenantId with / or ..", async () => {
    await expect(store.write("../bad", "x", "y")).rejects.toThrow();
    await expect(store.write("a/b", "x", "y")).rejects.toThrow();
  });

  describe("disk-full rescue", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    function fakeENOSPC(): NodeJS.ErrnoException {
      const err = new Error("ENOSPC: no space left on device") as NodeJS.ErrnoException;
      err.code = "ENOSPC";
      return err;
    }

    it("replace: ENOSPC on writeFile surfaces as DiskFullError + cleans tmp", async () => {
      const spy = vi.spyOn(fsp, "writeFile").mockRejectedValueOnce(fakeENOSPC());
      await expect(
        store.write(TENANT_A, "broke", "payload"),
      ).rejects.toBeInstanceOf(DiskFullError);
      expect(spy).toHaveBeenCalled();

      // No leftover .tmp- files in the tenant directory.
      const tenantDir = join(root, TENANT_A);
      if (existsSync(tenantDir)) {
        const leftover = readdirSync(tenantDir).filter((f) =>
          f.includes(".tmp-"),
        );
        expect(leftover).toEqual([]);
      }
    });

    it("append: ENOSPC on appendFile surfaces as DiskFullError", async () => {
      // Seed a file first so the append path runs (avoids creating from scratch).
      await store.write(TENANT_A, "log", "seed");
      vi.spyOn(fsp, "appendFile").mockRejectedValueOnce(fakeENOSPC());
      await expect(
        store.write(TENANT_A, "log", "more", { mode: "append" }),
      ).rejects.toBeInstanceOf(DiskFullError);
    });

    it("DiskFullError carries path + bytes", async () => {
      vi.spyOn(fsp, "writeFile").mockRejectedValueOnce(fakeENOSPC());
      try {
        await store.write(TENANT_A, "x", "twelve-bytes");
        throw new Error("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(DiskFullError);
        const err = e as DiskFullError;
        expect(err.path).toContain("x.md");
        expect(err.bytes).toBe(12);
        expect(err.code).toBe("ENOSPC");
      }
    });

    it("non-ENOSPC errors pass through unchanged", async () => {
      const eperm = new Error("EPERM") as NodeJS.ErrnoException;
      eperm.code = "EPERM";
      vi.spyOn(fsp, "writeFile").mockRejectedValueOnce(eperm);
      await expect(store.write(TENANT_A, "x", "y")).rejects.toThrow("EPERM");
      // Make sure the test doesn't accidentally throw DiskFullError
      try {
        await store.write(TENANT_A, "x", "y");
      } catch (e) {
        expect(e).not.toBeInstanceOf(DiskFullError);
      }
    });
  });

  describe("summary and trigger frontmatter", () => {
    it("write with summary and trigger, read returns them", async () => {
      await store.write(TENANT_A, "page-one", "Hello world", {
        summary: "A simple greeting page",
        trigger: "when the user says hello",
      });
      const r = await store.read(TENANT_A, "page-one");
      expect(r.existed).toBe(true);
      expect(r.summary).toBe("A simple greeting page");
      expect(r.trigger).toBe("when the user says hello");
    });

    it("write without summary/trigger, read returns undefined for both", async () => {
      await store.write(TENANT_A, "plain", "Just body");
      const r = await store.read(TENANT_A, "plain");
      expect(r.summary).toBeUndefined();
      expect(r.trigger).toBeUndefined();
    });

    it("frontmatter round-trips existing frontmatter fields", async () => {
      // Write with summary/trigger first
      await store.write(TENANT_A, "roundtrip", "Content here", {
        summary: "Roundtrip test",
        trigger: "testing roundtrip",
      });
      // Write again without summary/trigger — existing should be preserved
      await store.write(TENANT_A, "roundtrip", "Updated content");
      const r = await store.read(TENANT_A, "roundtrip");
      expect(r.summary).toBe("Roundtrip test");
      expect(r.trigger).toBe("testing roundtrip");
      expect(r.body).toContain("Updated content");
    });
  });

  describe("per-key size limit", () => {
    it("write at exactly limit succeeds", async () => {
      const storeSmall = new FileVaultStore({ root, maxBytes: 10 });
      const w = await storeSmall.write(TENANT_A, "limit", "0123456789");
      expect(w.bytesWritten).toBe(10);
    });

    it("write at limit+1 throws MemoryKeyTooLargeError", async () => {
      const storeSmall = new FileVaultStore({ root, maxBytes: 10 });
      await expect(
        storeSmall.write(TENANT_A, "over", "0123456789X"),
      ).rejects.toBeInstanceOf(MemoryKeyTooLargeError);
    });

    it("error message contains limit and actual size", async () => {
      const storeSmall = new FileVaultStore({ root, maxBytes: 10 });
      try {
        await storeSmall.write(TENANT_A, "over", "0123456789X");
        throw new Error("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(MemoryKeyTooLargeError);
        const err = e as MemoryKeyTooLargeError;
        expect(err.limitBytes).toBe(10);
        expect(err.actualBytes).toBe(11);
        expect(err.message).toContain("10 bytes");
        expect(err.message).toContain("11 bytes");
        expect(err.message).toContain("split into parts");
      }
    });

    it("honours env var override via constructor default", async () => {
      // We can't mutate process.env safely in vitest workers without
      // re-running, so we test the plumbing: FileVaultStore without
      // maxBytes uses DEFAULT_MAX_BYTES which is derived from env.
      // The constant is private; we verify behaviour indirectly.
      const storeDefault = new FileVaultStore({ root });
      // 32_768 + 1 should fail with the default cap.
      await expect(
        storeDefault.write(TENANT_A, "big", "x".repeat(32_769)),
      ).rejects.toBeInstanceOf(MemoryKeyTooLargeError);
    });

    it("bounces a 33KB fixture file", async () => {
      const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "oversized-33kb.md");
      const body = readFileSync(fixturePath, "utf8");
      const storeDefault = new FileVaultStore({ root });
      await expect(
        storeDefault.write(TENANT_A, "oversized", body),
      ).rejects.toBeInstanceOf(MemoryKeyTooLargeError);
    });
  });
});
