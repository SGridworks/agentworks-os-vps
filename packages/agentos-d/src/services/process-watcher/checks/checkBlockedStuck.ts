// packages/agentos-d/src/services/process-watcher/checks/checkBlockedStuck.ts
import type { CheckResult, Finding } from "../types.js";

export interface BlockedStuckInput {
  issues: Array<{
    id: string;
    identifier: string;
    status: string;
    updatedAt: string;
    assigneeAgentId: string | null;
    latestCommentAt: string | null;
  }>;
  thresholdHrs: number;
}

export function checkBlockedStuck(input: BlockedStuckInput): CheckResult {
  const { issues, thresholdHrs } = input;
  const findings: Finding[] = [];
  const errors: CheckResult["errors"] = [];
  const now = Date.now();

  for (const issue of issues) {
    if (issue.status !== "blocked") continue;

    const updatedAt = new Date(issue.updatedAt).getTime();
    const staleHrs = (now - updatedAt) / 1000 / 60 / 60;
    if (staleHrs < thresholdHrs) continue;

    // Also check last comment time if available
    const commentTime = issue.latestCommentAt
      ? new Date(issue.latestCommentAt).getTime()
      : updatedAt;
    const commentStaleHrs = (now - commentTime) / 1000 / 60 / 60;

    if (commentStaleHrs < thresholdHrs) continue;

    findings.push({
      checkId: "blocked_ticket_stuck",
      severity: "warn",
      targetIssueId: issue.id,
      agentId: issue.assigneeAgentId,
      explanation: `Issue ${issue.identifier} has been blocked for ${Math.round(staleHrs)}h with no comment activity in ${Math.round(commentStaleHrs)}h (threshold=${thresholdHrs}h).`,
      suggestedAction: "Either unblock the issue (resolve the dependency and flip to todo/in_progress) or post a comment explaining what is needed to unblock. If the blocker is external, @-mention the responsible party.",
      dedupKey: `checkBlockedStuck:${issue.id}`,
    });
  }

  return { findings, errors };
}
