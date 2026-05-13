/**
 * Critical-path DAG builder for inbox-lite ordering.
 *
 * Computes unblockCount per open issue: the number of currently-open
 * issues that would become unblocked if this one closed.
 *
 * "Open" = status !== done/closed. We deliberately do NOT require
 * dependents to be in literal status="blocked" — a todo issue whose
 * blockedOn list points at issue Y is operationally waiting on Y
 * regardless of whether the operator manually flipped the status.
 *
 * v1: rebuilds on every call (O(N+E)). Acceptable for N<1k.
 */

export interface IssueNode {
  id: string;
  status: "todo" | "in_progress" | "blocked" | "done";
  parentId: string | null;
  /** IDs of issues that are explicitly marked as blocked-on this one. */
  blockedOn: string[];
  priority: string;
  createdAt: string;
}

export interface CriticalPathResult {
  id: string;
  unblockCount: number;
}

export function buildCriticalPath(issues: IssueNode[]): Map<string, number> {
  const graph = new Map<string, IssueNode>();
  const unblockCount = new Map<string, number>();

  // Index nodes
  for (const issue of issues) {
    graph.set(issue.id, issue);
    unblockCount.set(issue.id, 0);
  }

  // Build adjacency: issue -> list of issues it directly unblocks
  // An issue A directly unblocks B if B is blocked and (B.parentId === A or B.blockedOn includes A)
  const adjacency = new Map<string, string[]>();
  for (const issue of issues) {
    adjacency.set(issue.id, []);
  }

  for (const issue of issues) {
    // Skip terminal dependents — they don't count as "would unblock".
    if (issue.status === "done") continue;

    // parent relationship: parent unblocks the child sub-task on close.
    // We only add this edge when the child is in status="blocked" because a
    // todo child of an open parent isn't necessarily waiting on the parent.
    if (issue.status === "blocked" && issue.parentId && graph.has(issue.parentId)) {
      const list = adjacency.get(issue.parentId)!;
      if (!list.includes(issue.id)) list.push(issue.id);
    }

    // Explicit blocked-on relationships: any open issue with a blockedOn
    // edge pointing at Y is effectively waiting on Y, regardless of its
    // declared status.
    for (const blockerId of issue.blockedOn) {
      if (graph.has(blockerId)) {
        const list = adjacency.get(blockerId)!;
        if (!list.includes(issue.id)) list.push(issue.id);
      }
    }
  }

  // Detect cycles using Tarjan SCC and zero out SCCs with >1 node.
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let idx = 0;
  const cycleNodes = new Set<string>();

  function strongconnect(v: string) {
    index.set(v, idx);
    lowlink.set(v, idx);
    idx++;
    stack.push(v);
    onStack.add(v);

    for (const w of adjacency.get(v) ?? []) {
      if (!graph.has(w)) continue;
      if (!index.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);

      if (scc.length > 1) {
        for (const node of scc) cycleNodes.add(node);
      }
    }
  }

  for (const issue of issues) {
    if (!index.has(issue.id)) strongconnect(issue.id);
  }

  // Also detect self-loops
  for (const issue of issues) {
    const children = adjacency.get(issue.id) ?? [];
    if (children.includes(issue.id)) cycleNodes.add(issue.id);
  }

  if (cycleNodes.size > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[critical-path] cycle detected involving ${Array.from(cycleNodes).join(", ")}; skipping cycle contributions`,
    );
  }

  // Compute direct unblock counts. Each adjacency entry is already an open
  // (non-done) dependent — see graph builder above — so we just count them,
  // skipping cycle members.
  for (const issue of issues) {
    if (cycleNodes.has(issue.id)) {
      unblockCount.set(issue.id, 0);
      continue;
    }
    const children = adjacency.get(issue.id) ?? [];
    let count = 0;
    for (const childId of children) {
      if (cycleNodes.has(childId)) continue;
      const child = graph.get(childId);
      if (child && child.status !== "done") count++;
    }
    unblockCount.set(issue.id, count);
  }

  return unblockCount;
}

export function sortInboxLite(
  issues: IssueNode[],
  unblockCounts: Map<string, number>,
): IssueNode[] {
  const priorityOrder: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  return [...issues].sort((a, b) => {
    // 1. critical first
    const aCrit = a.priority === "critical" ? 0 : 1;
    const bCrit = b.priority === "critical" ? 0 : 1;
    if (aCrit !== bCrit) return aCrit - bCrit;

    // 2. unblockCount descending
    const aCount = unblockCounts.get(a.id) ?? 0;
    const bCount = unblockCounts.get(b.id) ?? 0;
    if (bCount !== aCount) return bCount - aCount;

    // 3. original priority order
    const aPrio = priorityOrder[a.priority] ?? 99;
    const bPrio = priorityOrder[b.priority] ?? 99;
    if (aPrio !== bPrio) return aPrio - bPrio;

    // 4. recency descending (newer first)
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}
