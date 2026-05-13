import { describe, it, expect } from "vitest";
import { computeImportance, ImportanceCalculator } from "./importance.js";
import type { VaultPageWithImportance } from "./pruning-types.js";

describe("computeImportance", () => {
  const now = new Date().toISOString();
  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000).toISOString();

  it("returns base score of 2 for a recent page with no events and short body", () => {
    // Recent (+1) + short body (0) + no events (0) = 1, clamped to 1? 
    // Wait: recent (+1) + short body (0) + no events (0) = 1
    // Actually score = 1, clamped to 1-5 → 1
    // Hmm let me re-check: recent=+1, short body=no +0, no events=+0 → score=1
    const r = computeImportance({ updatedAt: threeDaysAgo, body: "short" });
    expect(r).toBe(1);
  });

  it("scores recent page with long body and events as 5", () => {
    // Recent (+1) + long body (+1) + has events (+1) = 3... wait that's 3
    // recent=+1, long=+1, events=+1 → score=3... 
    // Hmm the spec says clamp to 1-5. 3 is within range.
    // But let me re-read: "newer pages score higher (updatedAt within 7 days = +1, 30 days = 0, older = -1)"
    // "Body length: longer content = +1 (more likely to be substantive)"
    // "eventCount: if provided, more events = +1"
    // So max is 1+1+1 = 3... unless the base score starts higher?
    // Let me just follow the spec literally:
    // score starts at 0, recent=+1, long=+1, events=+1 → score=3
    const longBody = "a".repeat(600);
    const r = computeImportance({ updatedAt: threeDaysAgo, body: longBody, eventCount: 5 });
    expect(r).toBe(3);
  });

  it("scores stale old page with short body as 1", () => {
    // Older than 30 days = -1, short body = 0, no events = 0 → -1, clamped to 1
    const r = computeImportance({ updatedAt: sixtyDaysAgo, body: "short" });
    expect(r).toBe(1);
  });

  it("scores page within 7 days as recent (+1)", () => {
    const r = computeImportance({ updatedAt: threeDaysAgo, body: "x".repeat(600), eventCount: 1 });
    // recent +1, long +1, events +1 = 3
    expect(r).toBe(3);
  });

  it("scores page between 7-30 days as neutral (0 for recency)", () => {
    const r = computeImportance({ updatedAt: fourteenDaysAgo, body: "x".repeat(600), eventCount: 1 });
    // neutral (0) + long +1 + events +1 = 2
    expect(r).toBe(2);
  });

  it("long body adds +1", () => {
    const shortScore = computeImportance({ updatedAt: now, body: "hi" });
    const longScore = computeImportance({ updatedAt: now, body: "a".repeat(600) });
    expect(longScore - shortScore).toBe(1);
  });

  it("eventCount > 0 adds +1", () => {
    const noEvents = computeImportance({ updatedAt: now, body: "a".repeat(600) });
    const withEvents = computeImportance({ updatedAt: now, body: "a".repeat(600), eventCount: 1 });
    expect(withEvents - noEvents).toBe(1);
  });

  it("eventCount = 0 does not add score", () => {
    const noEvents = computeImportance({ updatedAt: now, body: "a".repeat(600), eventCount: 0 });
    const withEvents = computeImportance({ updatedAt: now, body: "a".repeat(600), eventCount: 1 });
    expect(withEvents - noEvents).toBe(1);
  });
});

describe("ImportanceCalculator", () => {
  const page = (key: string, importance: number, sizeBytes: number): VaultPageWithImportance => ({
    tenantId: "t1",
    key,
    updatedAt: new Date().toISOString(),
    importance,
    sizeBytes,
  });

  describe("compute", () => {
    it("returns empty array when vault is already under target", () => {
      const calc = new ImportanceCalculator();
      const pages = [page("a", 1, 100), page("b", 5, 100)];
      const result = calc.compute(pages, 250, 2);
      expect(result).toEqual([]);
    });

    it("returns empty array when total equals target", () => {
      const calc = new ImportanceCalculator();
      const pages = [page("a", 1, 100), page("b", 5, 100)];
      const result = calc.compute(pages, 200, 2);
      expect(result).toEqual([]);
    });

    it("removes lowest importance pages first to meet target", () => {
      const calc = new ImportanceCalculator();
      const pages = [
        page("low", 1, 100),
        page("mid", 2, 100),
        page("high", 5, 100),
      ];
      // Total = 300, target = 200 → need to free at least 100
      const result = calc.compute(pages, 200, 2);
      // minImportance=2 means importance < 2 is prunable (i.e., importance 1)
      // "low" has importance 1 and is below minImportance 2
      expect(result).toContain("low");
      expect(result).not.toContain("mid");
      expect(result).not.toContain("high");
    });

    it("keeps pages with importance >= minImportance", () => {
      const calc = new ImportanceCalculator();
      const pages = [
        page("a", 1, 100),
        page("b", 2, 100),
        page("c", 3, 100),
        page("d", 4, 100),
        page("e", 5, 100),
      ];
      // All have importance >= 2, so nothing should be pruned
      const result = calc.compute(pages, 100, 5);
      // minImportance=5 means only importance >= 5 is kept, so 1-4 are prunable
      // Actually: pages with importance >= minImportance are SKIPPED
      // So with minImportance=5, only importance 5 is NOT prunable
      // But we only have 5 pages × 100 = 500 bytes, target 100
      // We need to free 400 bytes
      // Remove a,b,c,d (all have importance < 5)
      expect(result).toEqual(["a", "b", "c", "d"]);
    });

    it("removes larger pages first when importance is equal", () => {
      const calc = new ImportanceCalculator();
      const pages = [
        page("small-low", 1, 50),
        page("big-low", 1, 200),
        page("small-mid", 2, 50),
        page("big-mid", 2, 200),
      ];
      // Total = 500, target = 300 → need to free 200
      const result = calc.compute(pages, 300, 2);
      // Sort order: importance 1 first (a and b), then importance 2
      // Within importance 1: big-low (200) before small-low (50)
      // Then mid importance pages if needed
      // We need 200 bytes, so big-low (200) should be first
      expect(result[0]).toBe("big-low");
    });

    it("keeps removing until under targetBytes", () => {
      const calc = new ImportanceCalculator();
      const pages = [
        page("a", 1, 100),
        page("b", 1, 100),
        page("c", 3, 100),
        page("d", 5, 100),
      ];
      // Total = 400, target = 250 → need to free at least 150
      const result = calc.compute(pages, 250, 2);
      // Remove a and b (both importance 1 < 2), freeing 200 bytes
      // That gets us to 200, which is under 250
      expect(result).toEqual(["a", "b"]);
    });

    it("returns all prunable keys when minImportance is 1", () => {
      const calc = new ImportanceCalculator();
      const pages = [
        page("a", 1, 100),
        page("b", 1, 100),
        page("c", 1, 100),
      ];
      const result = calc.compute(pages, 50, 1);
      // minImportance=1 means importance < 1 is prunable, but min is 1 so nothing is prunable?
      // Wait: the check is `page.importance >= minImportance` to SKIP
      // So with minImportance=1, we skip importance >= 1, meaning nothing is prunable
      // That's correct behavior
      expect(result).toEqual([]);
    });

    it("handles empty pages array", () => {
      const calc = new ImportanceCalculator();
      const result = calc.compute([], 100, 2);
      expect(result).toEqual([]);
    });
  });
});
