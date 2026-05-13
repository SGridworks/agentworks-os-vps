// packages/agentos-d/src/services/process-watcher/types.ts
// Shared types for the ProcessWatcher supervisor service.

export type CheckId =
  | "stale_in_progress"
  | "premature_done"
  | "off_lane_commits"
  | "auto_commit_close_mismatch"
  | "queue_depth"
  | "failed_run_not_retried"
  | "blocked_ticket_stuck";

export type Severity = "info" | "warn" | "critical";

export interface Finding {
  checkId: string;
  severity: Severity;
  targetIssueId: string | null;
  agentId?: string | null;
  targetIdentifier?: string;
  /** Only used by off-lane commit findings */
  commitHash?: string;
  explanation: string;
  suggestedAction: string;
  dedupKey: string;
}

export interface CheckResult {
  findings: Finding[];
  errors: Array<{ checkId: string; message: string }>;
}

// CheckInput — consumed by checks.ts (the canonical check implementations)
export interface CheckInput {
  issues: AwosIssue[];
  comments: Map<string, AwosComment[]>;
  runs: AwosRun[];
  offLaneEntries: OffLaneEntry[];
  now: number;
  config: CheckConfig;
}

// CheckConfig — thresholds + IDs for checks.ts
export interface CheckConfig {
  staleInProgressThresholdMin: number;
  prematureDoneWindowSec: number;
  queueDepthWatermark: number;
  failedRunRetryThresholdHrs: number;
  blockedTicketThresholdHrs: number;
  companyId: string;
  standingIssueId: string;
}

// OffLaneEntry — parsed from commit-scope.log
export interface OffLaneEntry {
  timestamp: string;
  hash: string;
  role: string;
  files: string[];
}

export interface AwosIssue {
  id: string;
  identifier: string;
  status: string;
  updatedAt: string;
  completedAt: string | null;
  startedAt?: string;
  assigneeAgentId: string | null;
  executionRunId: string | null;
  latestCommentAt: string | null;
}

export interface AwosRun {
  id: string;
  issueId?: string;
  status: string;
  agentId: string;
  finishedAt: string | null;
  createdAt?: string;
}

export interface AwosComment {
  id: string;
  createdAt: string;
  body: string;
  authorAgentId?: string;
  authorUserId?: string;
}

// Legacy alias for types that imported OffLaneEntry from here
export interface CommitScopeEntry {
  timestamp: string;
  status: "PASS" | "OFF-LANE" | "SKIP";
  commitHash: string;
  role: string;
  files?: string[];
  reason?: string;
}

export interface ProcessWatcherConfig {
  staleInProgressThresholdMin: number;
  prematureDoneWindowSec: number;
  queueDepthWatermark: number;
  failedRunThresholdHrs: number;
  blockedStuckThresholdHrs: number;
  commitScopeLogPath: string;
  awosApiUrl: string;
  awosApiKey: string;
  companyId: string;
  criticalMentionTarget: string;
  standingIssueId: string;
  /** How often to run the heartbeat, in minutes. Default 30. */
  heartbeatIntervalMin?: number;
  /**
   * Issue ID for the daily digest summary. When set, one aggregated digest
   * comment per calendar day is posted here in addition to per-violation comments.
   */
  digestTargetIssueId?: string;
  /** agentos-d API URL for cross-service calls (resolve-lane-assignment). */
  agentosApiUrl?: string;
  /** agentos-d API key for cross-service calls. */
  agentosApiKey?: string;
  /**
   * INTERNAL — injectable for tests only. Controls the return value of
   * checkAutoCommitCloseMismatch.hasAutoCommit without requiring a real
   * auto-commit log file. Not set in production.
   */
  _hasAutoCommit?: (issueId: string, runId: string) => Promise<boolean>;
  /**
   * INTERNAL — injectable for tests only. Replaces todayGitLog which searches
   * the real git history and can collide with test fixture identifiers.
   * Not set in production.
   */
  _commitsSince?: (issueId: string, sinceMin: number) => Promise<string[]>;
  /**
   * INTERNAL — injectable for tests only. Replaces the on-disk dedup state
   * file so tests run with a clean, isolated dedup state regardless of what
   * the real production dedup file contains.
   */
  _dedupState?: DedupState;
}

export interface DedupState {
  seenFindings: Record<string, string>;
  lastRunAt: string;
  /** ISO date string (YYYY-MM-DD) of the last posted daily digest */
  lastDigestDate?: string;
  /** Issue IDs that have already been resolved. Prevents repeated lane-resolution calls. */
  resolvedIssueIds: Record<string, string>;
}
