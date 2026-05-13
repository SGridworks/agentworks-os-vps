/**
 * Vault-ingest tests.
 *
 *   - slug derivation: file path basename, URL last segment, edge cases
 *   - planIngest: skips when unchanged, ingests on new content or hash mismatch
 *   - recordIngest: writes manifest, prepends to log.md (newest at top)
 *   - log entry shape matches the vault-ingest contract
 *   - tenant isolation: A's ingest doesn't bleed into B's manifest or log
 *   - frontmatter rendering round-trip
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  slugFromPath,
  slugFromUrl,
  renderSourceFrontmatter,
  planIngest,
  recordIngest,
  prependLogEntry,
  LOG_FILENAME,
} from "./ingest.js";
import { loadManifest, MANIFEST_FILENAME } from "./manifest.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "awo-ingest-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("slugFromPath", () => {
  it("strips extension and lowercases", () => {
    expect(slugFromPath("raw-sources/articles/Foo-Bar.md")).toBe("foo-bar");
  });

  it("collapses non-alphanumeric runs to hyphens", () => {
    expect(slugFromPath("My File (v2).pdf")).toBe("my-file-v2");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugFromPath("--weird--name--.md")).toBe("weird-name");
  });

  it("caps length at 80 chars", () => {
    const long = "a".repeat(120) + ".md";
    expect(slugFromPath(long).length).toBe(80);
  });
});

describe("slugFromUrl", () => {
  it("uses the last path segment", () => {
    expect(slugFromUrl("https://example.com/articles/great-post")).toBe("great-post");
  });

  it("strips file extension on the last segment", () => {
    expect(slugFromUrl("https://example.com/foo/bar.html")).toBe("bar");
  });

  it("ignores query string and fragment", () => {
    expect(slugFromUrl("https://x.com/post?utm=email#section-2")).toBe("post");
  });

  it("falls back to host when path is empty", () => {
    expect(slugFromUrl("https://example.com/")).toBe("example-com");
  });

  it("handles invalid URLs by slugifying the raw input", () => {
    expect(slugFromUrl("not a url")).toBe("not-a-url");
  });
});

describe("renderSourceFrontmatter", () => {
  it("emits a minimal frontmatter block with title only", () => {
    const text = renderSourceFrontmatter({ title: "Hello" });
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toContain("title: Hello");
    expect(text.trimEnd().endsWith("---")).toBe(true);
  });

  it("quotes titles with spaces and special chars", () => {
    const text = renderSourceFrontmatter({ title: "Hello: world & friends" });
    expect(text).toContain('title: "Hello: world & friends"');
  });

  it("renders tags inline and sources as a bullet list", () => {
    const text = renderSourceFrontmatter({
      title: "X",
      tags: ["compliance", "tcpa"],
      sources: ["[[raw-sources/articles/foo.md]]"],
    });
    expect(text).toContain("tags: [compliance, tcpa]");
    expect(text).toMatch(/sources:\n  - \[\[raw-sources\/articles\/foo\.md\]\]/);
  });

  it("emits extra fields verbatim", () => {
    const text = renderSourceFrontmatter({
      title: "X",
      extra: { source_url: "https://example.com" },
    });
    expect(text).toContain('source_url: "https://example.com"');
  });
});

describe("planIngest", () => {
  it("returns ingest=true on a fresh source", async () => {
    const plan = await planIngest(root, TENANT_A, "raw-sources/articles/foo.md", "body");
    expect(plan.action).toBe("ingest");
    expect(plan.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.slug).toBe("foo");
  });

  it("returns skip when content hash matches manifest entry", async () => {
    const sourcePath = "raw-sources/articles/foo.md";
    await recordIngest(root, TENANT_A, {
      sourcePath,
      contentHash: "deadbeef".repeat(8),
      pagesCreated: ["wiki/summaries/foo.md"],
      pagesUpdated: [],
      summary: "first ingest",
    });
    const plan = await planIngest(root, TENANT_A, sourcePath, "anything");
    // The manifest hash from recordIngest is "deadbeef..."; plan computes a
    // real sha256 of "anything", which won't match — so this still ingests.
    expect(plan.action).toBe("ingest");

    // Now record under the actual hash to verify skip.
    await recordIngest(root, TENANT_A, {
      sourcePath,
      contentHash: plan.contentHash,
      pagesCreated: [],
      pagesUpdated: [],
      summary: "second ingest",
    });
    const replan = await planIngest(root, TENANT_A, sourcePath, "anything");
    expect(replan.action).toBe("skip");
  });
});

describe("recordIngest", () => {
  it("writes a manifest entry under the source path", async () => {
    await recordIngest(root, TENANT_A, {
      sourcePath: "raw-sources/articles/foo.md",
      contentHash: "abc123",
      pagesCreated: ["wiki/summaries/foo.md", "wiki/people/Alice.md"],
      pagesUpdated: ["index.md"],
      summary: "Alice published a thing",
    });
    const m = await loadManifest(root, TENANT_A);
    const entry = m.sources["raw-sources/articles/foo.md"];
    expect(entry).toBeDefined();
    expect(entry?.hash).toBe("abc123");
    expect(entry?.pagesCreated).toEqual([
      "wiki/summaries/foo.md",
      "wiki/people/Alice.md",
    ]);
    expect(existsSync(join(root, TENANT_A, MANIFEST_FILENAME))).toBe(true);
  });

  it("prepends to log.md so the newest entry is at the top", async () => {
    await recordIngest(root, TENANT_A, {
      sourcePath: "raw-sources/articles/first.md",
      contentHash: "h1",
      pagesCreated: ["wiki/summaries/first.md"],
      pagesUpdated: [],
      summary: "First insight.",
      date: "2026-04-01",
      title: "First Source",
    });
    await recordIngest(root, TENANT_A, {
      sourcePath: "raw-sources/articles/second.md",
      contentHash: "h2",
      pagesCreated: ["wiki/summaries/second.md"],
      pagesUpdated: [],
      summary: "Second insight.",
      date: "2026-04-02",
      title: "Second Source",
    });
    const log = readFileSync(join(root, TENANT_A, LOG_FILENAME), "utf8");
    const firstIdx = log.indexOf("First Source");
    const secondIdx = log.indexOf("Second Source");
    expect(secondIdx).toBeGreaterThanOrEqual(0);
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeLessThan(firstIdx);
  });

  it("log entry includes source, pages, and key insight", async () => {
    await recordIngest(root, TENANT_A, {
      sourcePath: "raw-sources/articles/foo.md",
      contentHash: "h",
      pagesCreated: ["wiki/summaries/foo.md"],
      pagesUpdated: ["index.md"],
      summary: "Key insight in one sentence.",
      date: "2026-04-28",
      title: "Foo",
    });
    const log = readFileSync(join(root, TENANT_A, LOG_FILENAME), "utf8");
    expect(log).toContain("## [2026-04-28] ingest | Foo");
    expect(log).toContain("- Source: raw-sources/articles/foo.md");
    expect(log).toContain("- Pages created: [[wiki/summaries/foo.md]]");
    expect(log).toContain("- Pages updated: [[index.md]]");
    expect(log).toContain("- Key insight: Key insight in one sentence.");
  });
});

describe("prependLogEntry", () => {
  it("creates log.md if it doesn't exist yet", async () => {
    await prependLogEntry(root, TENANT_A, {
      sourcePath: "x.md",
      contentHash: "h",
      pagesCreated: [],
      pagesUpdated: [],
      summary: "hi",
    });
    expect(existsSync(join(root, TENANT_A, LOG_FILENAME))).toBe(true);
  });

  it("preserves existing log content beneath the new entry", async () => {
    await prependLogEntry(root, TENANT_A, {
      sourcePath: "old.md",
      contentHash: "h1",
      pagesCreated: [],
      pagesUpdated: [],
      summary: "old",
      title: "Old",
      date: "2026-04-01",
    });
    await prependLogEntry(root, TENANT_A, {
      sourcePath: "new.md",
      contentHash: "h2",
      pagesCreated: [],
      pagesUpdated: [],
      summary: "new",
      title: "New",
      date: "2026-04-02",
    });
    const log = readFileSync(join(root, TENANT_A, LOG_FILENAME), "utf8");
    expect(log).toContain("Old");
    expect(log).toContain("New");
    expect(log.indexOf("New")).toBeLessThan(log.indexOf("Old"));
  });
});

describe("tenant isolation", () => {
  it("recording for A leaves B's manifest and log empty", async () => {
    await recordIngest(root, TENANT_A, {
      sourcePath: "a.md",
      contentHash: "h",
      pagesCreated: [],
      pagesUpdated: [],
      summary: "hi",
    });
    const mb = await loadManifest(root, TENANT_B);
    expect(Object.keys(mb.sources)).toEqual([]);
    expect(existsSync(join(root, TENANT_B, LOG_FILENAME))).toBe(false);
  });
});
