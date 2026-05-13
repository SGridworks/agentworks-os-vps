/**
 * Hot cache tests.
 *
 *   - parseHotCache: full round-trip from canonical render
 *   - parseHotCache: missing frontmatter still parses with sensible defaults
 *   - parseHotCache: empty sections come back as empty arrays
 *   - renderHotCache: empty cache renders with placeholder bullets
 *   - readHotCache: missing file returns empty cache
 *   - writeHotCache + readHotCache round-trip
 *   - tenant-scoped: A's cache doesn't bleed into B's
 *   - isOverWordBudget: 500-word ceiling honored
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseHotCache,
  renderHotCache,
  readHotCache,
  writeHotCache,
  emptyHotCache,
  isOverWordBudget,
  wordCount,
  HOT_CACHE_KEY,
} from "./hot-cache.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "awo-hotcache-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("parseHotCache", () => {
  it("parses the canonical shape produced by renderHotCache", () => {
    const original = {
      updated: "2026-04-28T01:00:00.000Z",
      lastUpdatedNote: "2026-04-28. Shipped AWO-19 disk-full rescue.",
      keyFacts: ["TCPA pack blocks DNC SMS", "8 substrate-e2e tests pass"],
      recentChanges: ["Created: [[manifest.ts]]", "Updated: index.md"],
      activeThreads: ["Auditing webhook signature flow"],
    };
    const text = renderHotCache(original);
    const parsed = parseHotCache(text);
    expect(parsed.updated).toBe(original.updated);
    expect(parsed.lastUpdatedNote).toBe(original.lastUpdatedNote);
    expect(parsed.keyFacts).toEqual(original.keyFacts);
    expect(parsed.recentChanges).toEqual(original.recentChanges);
    expect(parsed.activeThreads).toEqual(original.activeThreads);
  });

  it("missing frontmatter still parses (updated stamped to now)", () => {
    const text = `# Recent Context\n\n## Last Updated\n2026-04-27. seed.\n\n## Key Recent Facts\n- one\n- two\n`;
    const parsed = parseHotCache(text);
    expect(parsed.lastUpdatedNote).toBe("2026-04-27. seed.");
    expect(parsed.keyFacts).toEqual(["one", "two"]);
    expect(parsed.updated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("empty sections come back as empty arrays", () => {
    const text = renderHotCache(emptyHotCache(new Date("2026-04-28T00:00:00Z")));
    const parsed = parseHotCache(text);
    expect(parsed.keyFacts).toEqual([]);
    expect(parsed.recentChanges).toEqual([]);
    expect(parsed.activeThreads).toEqual([]);
  });

  it("ignores non-bullet lines inside a section", () => {
    const text = `---\nupdated: 2026-04-28T00:00:00Z\n---\n\n## Key Recent Facts\nThis is a paragraph that should be ignored.\n- real fact\n`;
    const parsed = parseHotCache(text);
    expect(parsed.keyFacts).toEqual(["real fact"]);
  });
});

describe("renderHotCache", () => {
  it("placeholders empty sections so the file is always shaped", () => {
    const text = renderHotCache(emptyHotCache(new Date("2026-04-28T00:00:00Z")));
    expect(text).toContain("## Key Recent Facts");
    expect(text).toContain("- (none recorded yet)");
    expect(text).toContain("type: meta");
    expect(text).toContain("title: \"Hot Cache\"");
  });

  it("emits the updated timestamp from the cache", () => {
    const text = renderHotCache({
      ...emptyHotCache(),
      updated: "2026-04-28T12:00:00.000Z",
    });
    expect(text).toContain("updated: 2026-04-28T12:00:00.000Z");
  });
});

describe("readHotCache / writeHotCache", () => {
  it("missing file returns an empty cache", async () => {
    const cache = await readHotCache(root, TENANT_A);
    expect(cache.keyFacts).toEqual([]);
    expect(cache.lastUpdatedNote).toBe("");
  });

  it("writes and reloads survives a process boundary", async () => {
    const cache = {
      updated: "2026-04-28T03:00:00.000Z",
      lastUpdatedNote: "2026-04-28. Built hot-cache module.",
      keyFacts: ["13 tickets closed in this session"],
      recentChanges: ["Created: [[hot-cache.ts]]"],
      activeThreads: ["Substrate self-attack pattern recurring"],
    };
    await writeHotCache(root, TENANT_A, cache);

    const reloaded = await readHotCache(root, TENANT_A);
    expect(reloaded).toEqual(cache);
  });

  it("writes the file at <root>/<tenant>/wiki/hot.md", async () => {
    await writeHotCache(root, TENANT_A, {
      ...emptyHotCache(),
      lastUpdatedNote: "exists",
    });
    const path = join(root, TENANT_A, HOT_CACHE_KEY);
    expect(readFileSync(path, "utf8")).toContain("exists");
  });

  it("tenant-scoped: A's cache doesn't bleed into B's", async () => {
    await writeHotCache(root, TENANT_A, {
      ...emptyHotCache(),
      lastUpdatedNote: "tenant-A only",
    });
    const b = await readHotCache(root, TENANT_B);
    expect(b.lastUpdatedNote).toBe("");
  });
});

describe("word budget", () => {
  it("isOverWordBudget=false for a typical cache", () => {
    const cache = {
      ...emptyHotCache(),
      lastUpdatedNote: "2026-04-28. Routine update.",
      keyFacts: ["fact 1", "fact 2"],
      recentChanges: ["Created: [[Page]]"],
      activeThreads: ["question A"],
    };
    expect(isOverWordBudget(cache)).toBe(false);
  });

  it("isOverWordBudget=true when keyFacts blow past 500 words", () => {
    const filler = Array.from({ length: 700 }, (_, i) => `word${i}`).join(" ");
    const cache = {
      ...emptyHotCache(),
      keyFacts: [filler],
    };
    expect(isOverWordBudget(cache)).toBe(true);
  });

  it("wordCount counts words by whitespace", () => {
    expect(wordCount("hello world")).toBe(2);
    expect(wordCount("  many   spaces between  ")).toBe(3);
    expect(wordCount("")).toBe(0);
  });
});
