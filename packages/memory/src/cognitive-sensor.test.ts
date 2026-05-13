import { describe, expect, it } from "vitest";
import {
  CognitiveBudget,
  CompactionTrigger,
  DEFAULT_WORD_BUDGET,
  STALE_PAGE_DAYS,
  BUDGET_WARNING_THRESHOLD,
} from "./types.js";

describe("CognitiveBudget", () => {
  it("can be constructed with all fields", () => {
    const budget: CognitiveBudget = {
      activePages: 10,
      warmPages: 8,
      stalePages: 2,
      warmWordCount: 12000,
      wordBudget: 50000,
      lastCompactedAt: "2026-04-01T00:00:00Z",
    };

    expect(budget.activePages).toBe(10);
    expect(budget.warmPages).toBe(8);
    expect(budget.stalePages).toBe(2);
    expect(budget.warmWordCount).toBe(12000);
    expect(budget.wordBudget).toBe(50000);
    expect(budget.lastCompactedAt).toBe("2026-04-01T00:00:00Z");
  });

  it("lastCompactedAt is optional", () => {
    const budget: CognitiveBudget = {
      activePages: 0,
      warmPages: 0,
      stalePages: 0,
      warmWordCount: 0,
      wordBudget: 50000,
    };

    expect(budget.lastCompactedAt).toBeUndefined();
  });
});

describe("CompactionTrigger", () => {
  it("reason is correctly typed as word_budget_exceeded", () => {
    const trigger: CompactionTrigger = {
      reason: "word_budget_exceeded",
      budget: {
        activePages: 10,
        warmPages: 8,
        stalePages: 2,
        warmWordCount: 60000,
        wordBudget: 50000,
      },
      triggeredAt: "2026-04-30T12:00:00Z",
    };

    expect(trigger.reason).toBe("word_budget_exceeded");
  });

  it("reason is correctly typed as stale_pages_threshold", () => {
    const trigger: CompactionTrigger = {
      reason: "stale_pages_threshold",
      budget: {
        activePages: 100,
        warmPages: 20,
        stalePages: 80,
        warmWordCount: 10000,
        wordBudget: 50000,
      },
      triggeredAt: "2026-04-30T12:00:00Z",
    };

    expect(trigger.reason).toBe("stale_pages_threshold");
  });

  it("reason is correctly typed as manual", () => {
    const trigger: CompactionTrigger = {
      reason: "manual",
      budget: {
        activePages: 5,
        warmPages: 5,
        stalePages: 0,
        warmWordCount: 500,
        wordBudget: 50000,
      },
      triggeredAt: "2026-04-30T12:00:00Z",
    };

    expect(trigger.reason).toBe("manual");
  });
});

describe("constants", () => {
  it("DEFAULT_WORD_BUDGET equals 50000", () => {
    expect(DEFAULT_WORD_BUDGET).toBe(50000);
  });

  it("STALE_PAGE_DAYS equals 30", () => {
    expect(STALE_PAGE_DAYS).toBe(30);
  });

  it("BUDGET_WARNING_THRESHOLD equals 0.8", () => {
    expect(BUDGET_WARNING_THRESHOLD).toBe(0.8);
  });
});
