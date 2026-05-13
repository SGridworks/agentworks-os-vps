// packages/agentos-d/src/services/process-watcher/checks/checkAutoCommitCloseMismatch.ts
import type { CheckResult, Finding } from "../types.js";

export interface AutoCommitCloseInput {
  // Issues that have an executionRunId and a recent auto-commit
  issues: Array<{
    id: string;
    identifier: string;
    status: string;
    completedAt: string | null;
    executionRunId: string | null;
    assigneeAgentId: string | null;
  }>;
  // Returns true if an auto-commit was made for this issue during its last run.
  // In production this reads the auto-commit log; in tests it is injected so
  // return values can be controlled without filesystem dependencies.
  hasAutoCommit: (issueId: string, runId: string) => Promise<boolean>;
  windowSec: number;
}

export async function checkAutoCommitCloseMismatch(
  input: AutoCommitCloseInput
): Promise<CheckResult> {
  const { issues, hasAutoCommit, windowSec } = input;
  const findings: Finding[] = [];
  const errors: CheckResult["errors"] = [];
  const now = Date.now();

  for (const issue of issues) {
    if (issue.status !== "done" || !issue.completedAt || !issue.executionRunId) continue;

    const completedAt = new Date(issue.completedAt).getTime();
    const windowMs = windowSec * 1000;

    // Only flag if closed within the broader lookback window (3x the
    // auto-commit close window to stay consistent with checkPrematureDone)
    const lookbackMs = windowMs * 3;
    if (now - completedAt > lookbackMs) continue;

    const hadAutoCommit = await hasAutoCommit(issue.id, issue.executionRunId);
    if (!hadAutoCommit) continue;

    // This issue: auto-commit captured WIP AND agent flipped done within windowSec
    const secondsFromNow = Math.round((now - completedAt) / 1000);
    findings.push({
      checkId: "auto_commit_close_mismatch",
      severity: "critical",
      targetIssueId: issue.id,
      targetIdentifier: issue.identifier,
      agentId: issue.assigneeAgentId,
      explanation: `Issue ${issue.identifier} was closed ${secondsFromNow}s ago and an auto-commit was captured for its run, but no verified close-comment was found. This matches the auto-commit close-mismatch pattern from LEARNINGS §19.`,
      suggestedAction: "Reopen the issue, write a proper close comment citing file paths and verification output, then close again. Do not rely on auto-commit as a substitute for manual verification.",
      dedupKey: `auto_commit_close_mismatch:${issue.id}:${windowSec}`,
    });
  }

  return { findings, errors };
}
