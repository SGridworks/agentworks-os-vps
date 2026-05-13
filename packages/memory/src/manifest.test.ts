/**
 * Manifest delta-tracking tests.
 *
 *   - load: missing file returns empty
 *   - load: corrupt file throws (operator must see corruption)
 *   - setEntry/getEntry/removeEntry round-trip
 *   - isUnchanged: hash match, hash mismatch, missing entry
 *   - save → load survives a process boundary
 *   - atomic: an interrupted save leaves the previous file intact
 *   - tenant scoping: each tenant has its own manifest
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadManifest,
  saveManifest,
  setEntry,
  getEntry,
  removeEntry,
  isUnchanged,
  sha256OfContent,
  MANIFEST_FILENAME,
} from "./manifest.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "awo-manifest-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadManifest", () => {
  it("returns an empty manifest when the file is missing", async () => {
    const m = await loadManifest(root, TENANT_A);
    expect(m).toEqual({ version: 1, sources: {} });
  });

  it("throws on corrupt JSON (operator must see corruption)", async () => {
    const path = join(root, TENANT_A);
    require("node:fs").mkdirSync(path, { recursive: true });
    writeFileSync(join(path, MANIFEST_FILENAME), "{ not json", "utf8");
    await expect(loadManifest(root, TENANT_A)).rejects.toThrow();
  });
});

describe("setEntry / getEntry / removeEntry", () => {
  it("inserts and retrieves an entry by source path", () => {
    let m = { version: 1, sources: {} };
    m = setEntry(m, "raw-sources/foo.md", {
      hash: "h1",
      pagesCreated: ["wiki/foo.md"],
      pagesUpdated: ["index.md"],
    });
    const entry = getEntry(m, "raw-sources/foo.md");
    expect(entry).not.toBeNull();
    expect(entry?.hash).toBe("h1");
    expect(entry?.pagesCreated).toEqual(["wiki/foo.md"]);
    expect(entry?.ingestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("setEntry is pure: returns a new manifest, doesn't mutate the input", () => {
    const before = { version: 1, sources: {} };
    setEntry(before, "raw-sources/foo.md", {
      hash: "h1",
      pagesCreated: [],
      pagesUpdated: [],
    });
    expect(before.sources).toEqual({});
  });

  it("removeEntry deletes a tracked source", () => {
    let m = { version: 1, sources: {} };
    m = setEntry(m, "a.md", { hash: "h", pagesCreated: [], pagesUpdated: [] });
    m = setEntry(m, "b.md", { hash: "h", pagesCreated: [], pagesUpdated: [] });
    m = removeEntry(m, "a.md");
    expect(getEntry(m, "a.md")).toBeNull();
    expect(getEntry(m, "b.md")).not.toBeNull();
  });

  it("removeEntry on a missing source is a no-op", () => {
    const m = { version: 1, sources: {} };
    const out = removeEntry(m, "missing.md");
    expect(out).toEqual(m);
  });
});

describe("isUnchanged", () => {
  it("returns true when the stored hash matches", () => {
    const h = sha256OfContent("hello world");
    let m = { version: 1, sources: {} };
    m = setEntry(m, "src.md", { hash: h, pagesCreated: [], pagesUpdated: [] });
    expect(isUnchanged(m, "src.md", h)).toBe(true);
  });

  it("returns false when the source isn't tracked", () => {
    const m = { version: 1, sources: {} };
    expect(isUnchanged(m, "src.md", "anything")).toBe(false);
  });

  it("returns false when the hash differs", () => {
    let m = { version: 1, sources: {} };
    m = setEntry(m, "src.md", { hash: "old", pagesCreated: [], pagesUpdated: [] });
    expect(isUnchanged(m, "src.md", "new")).toBe(false);
  });
});

describe("save → load round-trip", () => {
  it("persists and reloads a manifest", async () => {
    const initial = await loadManifest(root, TENANT_A);
    const updated = setEntry(initial, "raw-sources/foo.md", {
      hash: sha256OfContent("foo"),
      pagesCreated: ["wiki/summaries/foo.md", "wiki/people/Bob.md"],
      pagesUpdated: ["index.md"],
    });
    await saveManifest(root, TENANT_A, updated);

    const reloaded = await loadManifest(root, TENANT_A);
    expect(reloaded.sources["raw-sources/foo.md"]?.hash).toBe(
      sha256OfContent("foo"),
    );
    expect(reloaded.sources["raw-sources/foo.md"]?.pagesCreated).toEqual([
      "wiki/summaries/foo.md",
      "wiki/people/Bob.md",
    ]);
  });

  it("is tenant-scoped (Tenant A's manifest doesn't bleed into Tenant B)", async () => {
    const aInit = await loadManifest(root, TENANT_A);
    const aUpdated = setEntry(aInit, "a-only.md", {
      hash: "ha",
      pagesCreated: [],
      pagesUpdated: [],
    });
    await saveManifest(root, TENANT_A, aUpdated);

    const bLoaded = await loadManifest(root, TENANT_B);
    expect(bLoaded.sources).toEqual({});
  });

  it("atomic: a partial .tmp doesn't clobber the real manifest", async () => {
    const m = setEntry(
      { version: 1, sources: {} },
      "src.md",
      { hash: "v1", pagesCreated: [], pagesUpdated: [] },
    );
    await saveManifest(root, TENANT_A, m);

    // Simulate an interrupted save: a .tmp left behind. The next read should
    // ignore it and return the committed manifest.
    const path = join(root, TENANT_A, MANIFEST_FILENAME);
    writeFileSync(`${path}.tmp.zombie`, "{ partial...", "utf8");

    const reloaded = await loadManifest(root, TENANT_A);
    expect(reloaded.sources["src.md"]?.hash).toBe("v1");
  });
});
