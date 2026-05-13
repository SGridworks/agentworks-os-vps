import { describe, it, expect, vi } from "vitest";
import { buildCriticalPath, sortInboxLite, type IssueNode } from "./critical-path.js";

function makeIssue(overrides: Partial<IssueNode> & { id: string }): IssueNode {
  return {
    status: "todo",
    parentId: null,
    blockedOn: [],
    priority: "medium",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("buildCriticalPath", () => {
  it("linear chain (A → B → C): A=1, B=1, C=0", () => {
    const issues: IssueNode[] = [
      makeIssue({ id: "A", status: "blocked" }),
      makeIssue({ id: "B", status: "blocked", blockedOn: ["A"] }),
      makeIssue({ id: "C", status: "blocked", blockedOn: ["B"] }),
    ];
    const counts = buildCriticalPath(issues);
    // A unblocks B directly. C remains blocked on B, so A does not count C.
    expect(counts.get("A")).toBe(1);
    expect(counts.get("B")).toBe(1);
    expect(counts.get("C")).toBe(0);
  });

  it("fan-out parent (P with 3 children): closing P unblocks 0", () => {
    const issues: IssueNode[] = [
      makeIssue({ id: "P", status: "todo" }),
      makeIssue({ id: "c1", status: "todo", parentId: "P" }),
      makeIssue({ id: "c2", status: "in_progress", parentId: "P" }),
      makeIssue({ id: "c3", status: "done", parentId: "P" }),
    ];
    const counts = buildCriticalPath(issues);
    expect(counts.get("P")).toBe(0);
    expect(counts.get("c1")).toBe(0);
    expect(counts.get("c2")).toBe(0);
    expect(counts.get("c3")).toBe(0);
  });

  it("blocked grandchild (A → B → C, all blocked): A=1", () => {
    const issues: IssueNode[] = [
      makeIssue({ id: "A", status: "blocked" }),
      makeIssue({ id: "B", status: "blocked", blockedOn: ["A"] }),
      makeIssue({ id: "C", status: "blocked", blockedOn: ["B"] }),
    ];
    const counts = buildCriticalPath(issues);
    // A unblocks B directly. C remains blocked on B, so A does not count C.
    expect(counts.get("A")).toBe(1);
    expect(counts.get("B")).toBe(1);
    expect(counts.get("C")).toBe(0);
  });

  it("cycle detection: logs warning and skips cycle contributions", () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const issues: IssueNode[] = [
      makeIssue({ id: "X", status: "blocked", blockedOn: ["Z"] }),
      makeIssue({ id: "Y", status: "blocked", blockedOn: ["X"] }),
      makeIssue({ id: "Z", status: "blocked", blockedOn: ["Y"] }),
    ];
    const counts = buildCriticalPath(issues);
    expect(counts.get("X")).toBe(0);
    expect(counts.get("Y")).toBe(0);
    expect(counts.get("Z")).toBe(0);
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy.mock.calls[0][0]).toContain("cycle detected");
    consoleSpy.mockRestore();
  });

  it("empty graph: returns empty result without error", () => {
    const counts = buildCriticalPath([]);
    expect(counts.size).toBe(0);
  });

  it("counts every open dependent regardless of literal status", () => {
    // Both B (blocked) and C (in_progress) point at A via blockedOn — both are
    // operationally waiting on A even if C hasn't been flipped to "blocked".
    const issues: IssueNode[] = [
      makeIssue({ id: "A", status: "todo" }),
      makeIssue({ id: "B", status: "blocked", blockedOn: ["A"] }),
      makeIssue({ id: "C", status: "in_progress", blockedOn: ["A"] }),
    ];
    const counts = buildCriticalPath(issues);
    expect(counts.get("A")).toBe(2);
    expect(counts.get("B")).toBe(0);
    expect(counts.get("C")).toBe(0);
  });

  it("done dependents do not count as unblocks", () => {
    const issues: IssueNode[] = [
      makeIssue({ id: "A", status: "todo" }),
      makeIssue({ id: "B", status: "blocked", blockedOn: ["A"] }),
      makeIssue({ id: "C", status: "done", blockedOn: ["A"] }),
    ];
    const counts = buildCriticalPath(issues);
    expect(counts.get("A")).toBe(1);
  });

  it("parent relationship counts when child is blocked", () => {
    const issues: IssueNode[] = [
      makeIssue({ id: "P", status: "todo" }),
      makeIssue({ id: "c1", status: "blocked", parentId: "P" }),
      makeIssue({ id: "c2", status: "blocked", parentId: "P" }),
    ];
    const counts = buildCriticalPath(issues);
    expect(counts.get("P")).toBe(2);
    expect(counts.get("c1")).toBe(0);
    expect(counts.get("c2")).toBe(0);
  });
});

describe("sortInboxLite", () => {
  const base = new Date("2026-04-29T12:00:00Z");

  it("sorts by critical first, then unblockCount desc, then priority, then recency", () => {
    const issues: IssueNode[] = [
      makeIssue({ id: "low-old", status: "todo", priority: "low", createdAt: new Date(base.getTime() - 10000).toISOString() }),
      makeIssue({ id: "med-new", status: "todo", priority: "medium", createdAt: new Date(base.getTime() - 5000).toISOString() }),
      makeIssue({ id: "crit", status: "todo", priority: "critical", createdAt: new Date(base.getTime() - 8000).toISOString() }),
      makeIssue({ id: "high", status: "todo", priority: "high", createdAt: new Date(base.getTime() - 7000).toISOString() }),
    ];
    const counts = new Map<string, number>([
      ["low-old", 5],
      ["med-new", 2],
      ["crit", 0],
      ["high", 3],
    ]);
    const sorted = sortInboxLite(issues, counts).map((i) => i.id);
    // critical first regardless of count
    expect(sorted[0]).toBe("crit");
    // then unblockCount descending
    expect(sorted[1]).toBe("low-old");
    expect(sorted[2]).toBe("high");
    expect(sorted[3]).toBe("med-new");
  });

  it("ties on unblockCount fall through to priority then recency", () => {
    const issues: IssueNode[] = [
      makeIssue({ id: "med-old", status: "todo", priority: "medium", createdAt: new Date(base.getTime() - 10000).toISOString() }),
      makeIssue({ id: "high-new", status: "todo", priority: "high", createdAt: new Date(base.getTime() - 5000).toISOString() }),
      makeIssue({ id: "high-old", status: "todo", priority: "high", createdAt: new Date(base.getTime() - 8000).toISOString() }),
    ];
    const counts = new Map<string, number>([
      ["med-old", 1],
      ["high-new", 1],
      ["high-old", 1],
    ]);
    const sorted = sortInboxLite(issues, counts).map((i) => i.id);
    // high beats medium
    expect(sorted[0]).toBe("high-new"); // newer high
    expect(sorted[1]).toBe("high-old"); // older high
    expect(sorted[2]).toBe("med-old");
  });
});
