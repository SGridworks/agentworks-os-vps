// packages/agentos-d/src/services/process-watcher/checks/checkPrematureDone.ts
import type { CheckResult, Finding } from "../types.js";

export interface PrematureDoneInput {
  issues: Array<{
    id: string;
    identifier: string;
    status: string;
    completedAt: string | null;
    updatedAt: string;
    assigneeAgentId: string | null;
    executionRunId?: string | null;
  }>;
  // Returns commits for an issue identifier within the lookback window (expressed in minutes).
  // Used only to provide supplemental context in the explanation; NOT for severity determination.
  commitsNear: (issueId: string, sinceMinutes: number) => Promise<string[]>;
  // Returns true if an auto-commit was captured for this issue during its last run.
  // Determines severity: "critical" when an auto-commit exists (WIP not reviewed), "warn" otherwise.
  hasAutoCommit: (issueId: string, runId: string) => Promise<boolean>;
  // Returns whether the issue's last comment meets close-comment hygiene and was posted after completedAt.
  // Receives completedAt so it can verify the comment is truly a close comment, not a pre-existing one.
  lastCommentMatchesHygiene: (issueId: string, completedAt: number) => Promise<boolean>;
  windowSec: number;
}

export async function checkPrematureDone(
  input: PrematureDoneInput
): Promise<CheckResult> {
  const { issues, commitsNear, hasAutoCommit, lastCommentMatchesHygiene, windowSec } = input;
  const findings: Finding[] = [];
  const errors: CheckResult["errors"] = [];
  const now = Date.now();

  for (const issue of issues) {
    if (issue.status !== "done" || !issue.completedAt) continue;

    const completedAt = new Date(issue.completedAt).getTime();
    const windowMs = windowSec * 1000;

    // Skip issues closed outside the lookback window (only flag recent closures)
    if (now - completedAt > windowMs * 3) continue;

    // Check if the close comment meets hygiene standards and was posted after completion
    const hasHygieneComment = await lastCommentMatchesHygiene(issue.id, completedAt);
    if (hasHygieneComment) continue; // hygiene satisfied — no finding

    // Supplemental: collect git commits for context in the explanation
    const sinceMin = Math.max(1, Math.round(windowMs / 60_000));
    const commits = await commitsNear(issue.identifier, sinceMin);

    // Severity: "critical" when an auto-commit exists (WIP not reviewed), "warn" otherwise.
    // runId is optional in the interface — treat missing/null runId as no auto-commit available.
    const hadAutoCommit = issue.executionRunId
      ? await hasAutoCommit(issue.id, issue.executionRunId)
      : false;

    // Flag: no hygiene comment (primary violation), optionally annotated with auto-commit evidence
    const secondsFromNow = Math.round((now - completedAt) / 1000);
    findings.push({
      checkId: "premature_done",
      severity: hadAutoCommit ? "critical" : "warn",
      targetIssueId: issue.id,
      targetIdentifier: issue.identifier,
      agentId: issue.assigneeAgentId,
      explanation:
        `Issue ${issue.identifier} was closed ${secondsFromNow}s ago but its last comment does not cite file paths or verification output (close-comment hygiene).` +
        (hadAutoCommit
          ? ` Auto-commit captured during this run (${commits.length} commit(s) referencing the identifier).`
          : commits.length > 0
            ? ` ${commits.length} commit(s) referencing the identifier found near close time but no auto-commit on record.`
            : ""),
      suggestedAction:
        "Reopen the issue, write a proper close comment citing deliverables and verification, then close again.",
      dedupKey: `premature_done:${issue.id}:${windowSec}`,
    });
  }

  return { findings, errors };
}
