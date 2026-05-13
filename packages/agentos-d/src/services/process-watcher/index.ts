// packages/agentos-d/src/services/process-watcher/index.ts
// Re-exports the canonical check implementations and the ProcessWatcher worker.

export { checkStaleInProgress } from "./checks/checkStaleInProgress.js";
export { checkPrematureDone } from "./checks/checkPrematureDone.js";
export { checkOffLaneCommits } from "./checks/checkOffLaneCommits.js";
export { checkAutoCommitCloseMismatch } from "./checks/checkAutoCommitCloseMismatch.js";
export { checkQueueDepth } from "./checks/checkQueueDepth.js";
export { checkFailedRunNotRetried } from "./checks/checkFailedRunNotRetried.js";
export { checkBlockedStuck } from "./checks/checkBlockedStuck.js";

export type {
  CheckId,
  Severity,
  Finding,
  CheckResult,
  CheckInput,
  CheckConfig,
  OffLaneEntry,
  AwosIssue,
  AwosRun,
  AwosComment,
  CommitScopeEntry,
  ProcessWatcherConfig,
  DedupState,
} from "./types.js";

export { createProcessWatcher, ProcessWatcher } from "./processWatcher.js";
