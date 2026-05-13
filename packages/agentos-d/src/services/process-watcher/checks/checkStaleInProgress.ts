// packages/agentos-d/src/services/process-watcher/checks/checkStaleInProgress.ts
import type { CheckResult, Finding } from "../types.js";

export interface StaleInProgressInput {
  issues: Array<{
    id: string;
    identifier: string;
    status: string;
    updatedAt: string;
    assigneeAgentId: string | null;
  }>;
  commitsSince: (issueId: string, sinceMinutes: number) => Promise<string[]>;
  thresholdMin: number;
}

export async function checkStaleInProgress(
  input: StaleInProgressInput
): Promise<CheckResult> {
  const { issues, commitsSince, thresholdMin } = input;
  const findings: Finding[] = [];
  const errors: CheckResult["errors"] = [];
  const now = Date.now();

  for (const issue of issues) {
    if (issue.status !== "in_progress") continue;

    const updatedAt = new Date(issue.updatedAt).getTime();
    const staleMinutes = (now - updatedAt) / 1000 / 60;
    if (staleMinutes < thresholdMin) continue;

    // Check for a recent commit referencing this issue's identifier
    const commits = await commitsSince(issue.identifier, thresholdMin);
    if (commits.length > 0) {
      // Commit happened after stale threshold — not actually stale
      continue;
    }

    findings.push({
      checkId: "stale_in_progress",
      severity: "warn",
      targetIssueId: issue.id,
      agentId: issue.assigneeAgentId,
      explanation: `Issue ${issue.identifier} has been in_progress for ${Math.round(staleMinutes)} min with no commit referencing its identifier and no comment.`,
      suggestedAction: "Post a progress comment, mark blocked if waiting on dependency, or close if done.",
      dedupKey: `stale_in_progress:${issue.id}:${thresholdMin}`,
    });
  }

  return { findings, errors };
}
