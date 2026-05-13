// tests/unit/process-watcher.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkStaleInProgress } from "../../packages/agentos-d/src/services/process-watcher/checks/checkStaleInProgress.js";
import { checkPrematureDone } from "../../packages/agentos-d/src/services/process-watcher/checks/checkPrematureDone.js";
import { checkOffLaneCommits } from "../../packages/agentos-d/src/services/process-watcher/checks/checkOffLaneCommits.js";
import { checkAutoCommitCloseMismatch } from "../../packages/agentos-d/src/services/process-watcher/checks/checkAutoCommitCloseMismatch.js";
import { checkQueueDepth } from "../../packages/agentos-d/src/services/process-watcher/checks/checkQueueDepth.js";
import { checkFailedRunNotRetried } from "../../packages/agentos-d/src/services/process-watcher/checks/checkFailedRunNotRetried.js";
import { checkBlockedStuck } from "../../packages/agentos-d/src/services/process-watcher/checks/checkBlockedStuck.js";

// ---------------------------------------------------------------------------
// checkStaleInProgress
// ---------------------------------------------------------------------------
describe("checkStaleInProgress", () => {
  it("flags in_progress issue with no recent commits past threshold", async () => {
    const updatedAt = new Date(Date.now() - 50 * 60 * 1000).toISOString(); // 50 min ago
    const result = await checkStaleInProgress({
      issues: [
        {
          id: "issue-1",
          identifier: "AWO-100",
          status: "in_progress",
          updatedAt,
          assigneeAgentId: "agent-1",
        },
      ],
      commitsSince: async () => [],
      thresholdMin: 45,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].checkId).toBe("stale_in_progress");
    expect(result.findings[0].severity).toBe("warn");
    expect(result.findings[0].targetIssueId).toBe("issue-1");
  });

  it("does not flag in_progress issue with recent commit", async () => {
    const updatedAt = new Date(Date.now() - 50 * 60 * 1000).toISOString();
    const result = await checkStaleInProgress({
      issues: [
        {
          id: "issue-1",
          identifier: "AWO-100",
          status: "in_progress",
          updatedAt,
          assigneeAgentId: "agent-1",
        },
      ],
      commitsSince: async () => ["abc123"],
      thresholdMin: 45,
    });
    expect(result.findings).toHaveLength(0);
  });

  it("does not flag in_progress issue not yet past threshold", async () => {
    const updatedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    const result = await checkStaleInProgress({
      issues: [
        {
          id: "issue-1",
          identifier: "AWO-100",
          status: "in_progress",
          updatedAt,
          assigneeAgentId: "agent-1",
        },
      ],
      commitsSince: async () => [],
      thresholdMin: 45,
    });
    expect(result.findings).toHaveLength(0);
  });

  it("ignores non-in_progress issues", async () => {
    const result = await checkStaleInProgress({
      issues: [
        { id: "issue-1", identifier: "AWO-100", status: "done", updatedAt: new Date(0).toISOString(), assigneeAgentId: null },
        { id: "issue-2", identifier: "AWO-101", status: "todo", updatedAt: new Date(0).toISOString(), assigneeAgentId: null },
      ],
      commitsSince: async () => [],
      thresholdMin: 45,
    });
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// checkPrematureDone
// ---------------------------------------------------------------------------
describe("checkPrematureDone", () => {
  it("flags done issue with close-comment hygiene violation", async () => {
    const completedAt = new Date(Date.now() - 30 * 1000).toISOString(); // 30s ago
    const result = await checkPrematureDone({
      issues: [
        {
          id: "issue-1",
          identifier: "AWO-100",
          status: "done",
          completedAt,
          updatedAt: completedAt,
          assigneeAgentId: "agent-1",
          executionRunId: "run-1",
        },
      ],
      commitsNear: async () => ["abc123"],
      hasAutoCommit: async (_id, _runId) => true, // auto-commit present → critical
      lastCommentMatchesHygiene: async (_id, _completedAt) => false,
      windowSec: 60,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].checkId).toBe("premature_done");
    expect(result.findings[0].severity).toBe("critical");
  });

  it("does not flag done issue with hygiene-compliant close comment", async () => {
    const completedAt = new Date(Date.now() - 30 * 1000).toISOString();
    const result = await checkPrematureDone({
      issues: [
        {
          id: "issue-1",
          identifier: "AWO-100",
          status: "done",
          completedAt,
          updatedAt: completedAt,
          assigneeAgentId: "agent-1",
          executionRunId: null,
        },
      ],
      commitsNear: async () => ["abc123"],
      hasAutoCommit: async () => false,
      lastCommentMatchesHygiene: async (_id, _completedAt) => true,
      windowSec: 60,
    });
    expect(result.findings).toHaveLength(0);
  });

  it("flags done issue with no hygiene and no nearby commits at warn severity", async () => {
    // No auto-commit in auto-commit log → severity is warn, not critical
    const completedAt = new Date(Date.now() - 30 * 1000).toISOString();
    const result = await checkPrematureDone({
      issues: [
        {
          id: "issue-1",
          identifier: "AWO-100",
          status: "done",
          completedAt,
          updatedAt: completedAt,
          assigneeAgentId: "agent-1",
          executionRunId: null,
        },
      ],
      commitsNear: async () => [], // no git commits referencing identifier
      hasAutoCommit: async () => false, // no auto-commit in log → warn
      lastCommentMatchesHygiene: async (_id, _completedAt) => false, // no hygiene
      windowSec: 60,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].checkId).toBe("premature_done");
    expect(result.findings[0].severity).toBe("warn"); // warn when no auto-commit
  });

  it("does not flag done issue with no nearby commits but has hygiene", async () => {
    const completedAt = new Date(Date.now() - 30 * 1000).toISOString();
    const result = await checkPrematureDone({
      issues: [
        {
          id: "issue-1",
          identifier: "AWO-100",
          status: "done",
          completedAt,
          updatedAt: completedAt,
          assigneeAgentId: "agent-1",
          executionRunId: null,
        },
      ],
      commitsNear: async () => [], // no auto-commit
      hasAutoCommit: async () => false, // no auto-commit in log
      lastCommentMatchesHygiene: async (_id, _completedAt) => true, // has hygiene
      windowSec: 60,
    });
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// checkQueueDepth
// ---------------------------------------------------------------------------
describe("checkQueueDepth", () => {
  it("flags agent exceeding watermark", () => {
    const result = checkQueueDepth({
      agentTodoCounts: new Map([["agent-1", 10]]),
      agentNames: new Map([["agent-1", "BackendEngineer"]]),
      watermark: 8,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].checkId).toBe("queue_depth");
    expect(result.findings[0].severity).toBe("info");
    expect(result.findings[0].agentId).toBe("agent-1");
  });

  it("does not flag agent at or below watermark", () => {
    const result = checkQueueDepth({
      agentTodoCounts: new Map([["agent-1", 8], ["agent-2", 3]]),
      agentNames: new Map([["agent-1", "BackendEngineer"], ["agent-2", "FrontendEngineer"]]),
      watermark: 8,
    });
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// checkFailedRunNotRetried
// ---------------------------------------------------------------------------
describe("checkFailedRunNotRetried", () => {
  it("flags agent with stale failed run and no retry", () => {
    const finishedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3h ago
    const result = checkFailedRunNotRetried({
      agentLastRuns: [
        {
          agentId: "agent-1",
          agentName: "BackendEngineer",
          lastRunId: "run-1",
          lastRunStatus: "failed",
          lastRunFinishedAt: finishedAt,
          hasSubsequentRun: false,
        },
      ],
      thresholdHrs: 2,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].checkId).toBe("failed_run_not_retried");
    expect(result.findings[0].severity).toBe("warn");
    expect(result.findings[0].agentId).toBe("agent-1");
  });

  it("does not flag agent with failed run but subsequent run exists", () => {
    const finishedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const result = checkFailedRunNotRetried({
      agentLastRuns: [
        {
          agentId: "agent-1",
          agentName: "BackendEngineer",
          lastRunId: "run-1",
          lastRunStatus: "failed",
          lastRunFinishedAt: finishedAt,
          hasSubsequentRun: true,
        },
      ],
      thresholdHrs: 2,
    });
    expect(result.findings).toHaveLength(0);
  });

  it("does not flag agent with failed run within threshold", () => {
    const finishedAt = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
    const result = checkFailedRunNotRetried({
      agentLastRuns: [
        {
          agentId: "agent-1",
          agentName: "BackendEngineer",
          lastRunId: "run-1",
          lastRunStatus: "failed",
          lastRunFinishedAt: finishedAt,
          hasSubsequentRun: false,
        },
      ],
      thresholdHrs: 2,
    });
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// checkBlockedStuck
// ---------------------------------------------------------------------------
describe("checkBlockedStuck", () => {
  it("flags blocked issue with stale update and comment", () => {
    const updatedAt = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(); // 30h ago
    const result = checkBlockedStuck({
      issues: [
        {
          id: "issue-1",
          identifier: "AWO-100",
          status: "blocked",
          updatedAt,
          assigneeAgentId: "agent-1",
          latestCommentAt: updatedAt,
        },
      ],
      thresholdHrs: 24,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].checkId).toBe("blocked_ticket_stuck");
    expect(result.findings[0].severity).toBe("warn");
  });

  it("does not flag blocked issue with recent comment", () => {
    const updatedAt = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    const recentComment = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
    const result = checkBlockedStuck({
      issues: [
        {
          id: "issue-1",
          identifier: "AWO-100",
          status: "blocked",
          updatedAt,
          assigneeAgentId: "agent-1",
          latestCommentAt: recentComment,
        },
      ],
      thresholdHrs: 24,
    });
    expect(result.findings).toHaveLength(0);
  });

  it("does not flag blocked issue not yet past threshold", () => {
    const updatedAt = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(); // 12h ago
    const result = checkBlockedStuck({
      issues: [
        {
          id: "issue-1",
          identifier: "AWO-100",
          status: "blocked",
          updatedAt,
          assigneeAgentId: "agent-1",
          latestCommentAt: updatedAt,
        },
      ],
      thresholdHrs: 24,
    });
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// checkOffLaneCommits (needs real fs — skip in unit, covered by integration)
// ---------------------------------------------------------------------------
describe("checkOffLaneCommits", () => {
  it("returns empty findings when log is empty", async () => {
    const result = await checkOffLaneCommits({
      logPath: "/nonexistent/path.log",
      reportedCommits: new Set(),
      standingIssueId: "standing-001",
    });
    // ENOENT = log doesn't exist yet (commit-scope hasn't run). Expected state, not an error.
    expect(result.errors).toHaveLength(0);
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// checkAutoCommitCloseMismatch
// ---------------------------------------------------------------------------
describe("checkAutoCommitCloseMismatch", () => {
  it("flags issue with auto-commit and no hygiene comment", async () => {
    const completedAt = new Date(Date.now() - 30 * 1000).toISOString();
    const result = await checkAutoCommitCloseMismatch({
      issues: [
        {
          id: "issue-1",
          identifier: "AWO-100",
          status: "done",
          completedAt,
          executionRunId: "run-1",
          assigneeAgentId: "agent-1",
        },
      ],
      hasAutoCommit: async (_id, _completedAt) => true,
      windowSec: 60,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].checkId).toBe("auto_commit_close_mismatch");
    expect(result.findings[0].severity).toBe("critical");
  });

  it("does not flag issue without auto-commit", async () => {
    const completedAt = new Date(Date.now() - 30 * 1000).toISOString();
    const result = await checkAutoCommitCloseMismatch({
      issues: [
        {
          id: "issue-1",
          identifier: "AWO-100",
          status: "done",
          completedAt,
          executionRunId: "run-1",
          assigneeAgentId: "agent-1",
        },
      ],
      hasAutoCommit: async (_id, _completedAt) => false,
      windowSec: 60,
    });
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Smoke replay — simulate AWO-148 and AWO-152 patterns from 2026-04-28
// These tests replay the exact conditions that should fire checkPrematureDone
// and checkAutoCommitCloseMismatch for tickets closed without hygiene.
// ---------------------------------------------------------------------------
describe("smoke: AWO-148 and AWO-152 replay", () => {
  it("AWO-148 pattern: done with auto-commit nearby, no close-comment hygiene fires checkPrematureDone", async () => {
    // Simulate: issue closed 45s ago, auto-commit recorded in auto-commit log, last comment has no verification
    const completedAt = new Date(Date.now() - 45 * 1000).toISOString();
    const result = await checkPrematureDone({
      issues: [
        {
          id: "awo-148",
          identifier: "AWO-148",
          status: "done",
          completedAt,
          updatedAt: completedAt,
          assigneeAgentId: "backend-engineer-id",
          executionRunId: "run-148",
        },
      ],
      // git log: commits referencing identifier found near close time
      commitsNear: async () => ["abc123def"],
      // auto-commit recorded in auto-commit log → critical severity
      hasAutoCommit: async (_id, _runId) => true,
      // no hygiene in last comment
      lastCommentMatchesHygiene: async (_id, _completedAt) => false,
      windowSec: 60,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].checkId).toBe("premature_done");
    expect(result.findings[0].severity).toBe("critical");
    expect(result.findings[0].targetIdentifier).toBe("AWO-148");
  });

  it("AWO-148 pattern: done with hygiene comment does NOT fire checkPrematureDone", async () => {
    const completedAt = new Date(Date.now() - 45 * 1000).toISOString();
    const result = await checkPrematureDone({
      issues: [
        {
          id: "awo-148",
          identifier: "AWO-148",
          status: "done",
          completedAt,
          updatedAt: completedAt,
          assigneeAgentId: "backend-engineer-id",
          executionRunId: "run-148",
        },
      ],
      commitsNear: async () => ["abc123def"],
      hasAutoCommit: async () => false,
      // hygiene present — should suppress
      lastCommentMatchesHygiene: async (_id, _completedAt) => true,
      windowSec: 60,
    });
    expect(result.findings).toHaveLength(0);
  });

  it("AWO-152 pattern: auto-commit + done within 60s fires checkAutoCommitCloseMismatch", async () => {
    const completedAt = new Date(Date.now() - 30 * 1000).toISOString();
    const result = await checkAutoCommitCloseMismatch({
      issues: [
        {
          id: "awo-152",
          identifier: "AWO-152",
          status: "done",
          completedAt,
          executionRunId: "run-awo-152",
          assigneeAgentId: "frontend-engineer-id",
        },
      ],
      // auto-commit was captured
      hasAutoCommit: async (_id, _completedAt) => true,
      windowSec: 60,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].checkId).toBe("auto_commit_close_mismatch");
    expect(result.findings[0].severity).toBe("critical");
    expect(result.findings[0].targetIdentifier).toBe("AWO-152");
  });

  it("AWO-152 pattern: no auto-commit does NOT fire checkAutoCommitCloseMismatch", async () => {
    const completedAt = new Date(Date.now() - 30 * 1000).toISOString();
    const result = await checkAutoCommitCloseMismatch({
      issues: [
        {
          id: "awo-152",
          identifier: "AWO-152",
          status: "done",
          completedAt,
          executionRunId: "run-awo-152",
          assigneeAgentId: "frontend-engineer-id",
        },
      ],
      hasAutoCommit: async (_id, _completedAt) => false,
      windowSec: 60,
    });
    expect(result.findings).toHaveLength(0);
  });

  it("AWO-148 + AWO-152 both fire simultaneously from same heartbeat", async () => {
    const now = Date.now();
    const completedAt = new Date(now - 30 * 1000).toISOString();

    const [prematureResult, mismatchResult] = await Promise.all([
      checkPrematureDone({
        issues: [
          {
            id: "awo-148",
            identifier: "AWO-148",
            status: "done",
            completedAt,
            updatedAt: completedAt,
            assigneeAgentId: "backend-engineer-id",
            executionRunId: "run-148",
          },
        ],
        commitsNear: async () => ["abc123"],
        hasAutoCommit: async () => true, // auto-commit on record
        lastCommentMatchesHygiene: async (_id, _completedAt) => false,
        windowSec: 60,
      }),
      checkAutoCommitCloseMismatch({
        issues: [
          {
            id: "awo-152",
            identifier: "AWO-152",
            status: "done",
            completedAt,
            executionRunId: "run-152",
            assigneeAgentId: "frontend-engineer-id",
          },
        ],
        hasAutoCommit: async (_id, _completedAt) => true,
        windowSec: 60,
      }),
    ]);

    expect(prematureResult.findings).toHaveLength(1);
    expect(prematureResult.findings[0].targetIdentifier).toBe("AWO-148");
    expect(mismatchResult.findings).toHaveLength(1);
    expect(mismatchResult.findings[0].targetIdentifier).toBe("AWO-152");
  });
});
