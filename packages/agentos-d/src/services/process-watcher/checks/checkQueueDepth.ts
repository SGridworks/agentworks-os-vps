// packages/agentos-d/src/services/process-watcher/checks/checkQueueDepth.ts
import type { CheckResult, Finding } from "../types.js";

export interface QueueDepthInput {
  // Map from agentId -> number of open (todo) issues assigned
  agentTodoCounts: Map<string, number>;
  // Map from agentId -> agent name/identifier for display
  agentNames: Map<string, string>;
  watermark: number;
}

export function checkQueueDepth(input: QueueDepthInput): CheckResult {
  const { agentTodoCounts, agentNames, watermark } = input;
  const findings: Finding[] = [];
  const errors: CheckResult["errors"] = [];

  const entries = Array.from(agentTodoCounts.entries());
  for (let i = 0; i < entries.length; i++) {
    const [agentId, count] = entries[i]!;
    if (count <= watermark) continue;
    findings.push({
      checkId: "queue_depth",
      severity: "info",
      targetIssueId: null,
      agentId: agentId,
      explanation: `Agent ${agentNames.get(agentId) ?? agentId} has ${count} open todo items (watermark=${watermark}).`,
      suggestedAction: "Consider picking up items from the backlog or having the Coordinator reassign excess items.",
      dedupKey: `checkQueueDepth:${agentId}:${count}`,
    });
  }

  return { findings, errors };
}
