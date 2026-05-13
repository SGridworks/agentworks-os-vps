// packages/agentos-d/src/services/process-watcher/checks/checkFailedRunNotRetried.ts
import type { CheckResult, Finding } from "../types.js";

export interface FailedRunInput {
  // Agents and their most recent run
  agentLastRuns: Array<{
    agentId: string;
    agentName: string;
    lastRunId: string;
    lastRunStatus: string; // "failed" | "success" | "queued" | ...
    lastRunFinishedAt: string | null;
    hasSubsequentRun: boolean;
  }>;
  thresholdHrs: number;
}

export function checkFailedRunNotRetried(input: FailedRunInput): CheckResult {
  const { agentLastRuns, thresholdHrs } = input;
  const findings: Finding[] = [];
  const errors: CheckResult["errors"] = [];
  const now = Date.now();

  for (const agent of agentLastRuns) {
    if (agent.lastRunStatus !== "failed") continue;
    if (agent.hasSubsequentRun) continue;
    if (!agent.lastRunFinishedAt) continue;

    const finishedAt = new Date(agent.lastRunFinishedAt).getTime();
    const staleHrs = (now - finishedAt) / 1000 / 60 / 60;
    if (staleHrs < thresholdHrs) continue;

    findings.push({
      checkId: "failed_run_not_retried",
      severity: "warn",
      targetIssueId: null,
      agentId: agent.agentId,
      explanation: `Agent ${agent.agentName}'s last run (${agent.lastRunId}) failed ${Math.round(staleHrs)}h ago and has not been retried within the ${thresholdHrs}h threshold.`,
      suggestedAction: "Investigate the failure. If the root cause is fixed, trigger a manual retry. If the run is blocked on external dependency, mark the responsible issue blocked instead of letting it spin.",
      dedupKey: `checkFailedRunNotRetried:${agent.agentId}:${agent.lastRunId}`,
    });
  }

  return { findings, errors };
}
