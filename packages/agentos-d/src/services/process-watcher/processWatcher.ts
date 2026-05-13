// packages/agentos-d/src/services/process-watcher/processWatcher.ts
// Heartbeat orchestrator — runs all seven supervisor checks, dedupes, posts comments,
// and fires a daily digest to the standing digest issue.

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type {
  CheckResult,
  DedupState,
  Finding,
  ProcessWatcherConfig,
} from "./types.js";
import { AwosApiClient } from "./awosApiClient.js";
import { checkStaleInProgress } from "./checks/checkStaleInProgress.js";
import { checkPrematureDone } from "./checks/checkPrematureDone.js";
import { checkOffLaneCommits } from "./checks/checkOffLaneCommits.js";
import { checkAutoCommitCloseMismatch } from "./checks/checkAutoCommitCloseMismatch.js";
import { checkQueueDepth } from "./checks/checkQueueDepth.js";
import { checkFailedRunNotRetried } from "./checks/checkFailedRunNotRetried.js";
import { checkBlockedStuck } from "./checks/checkBlockedStuck.js";

// Lazy: read env at call time so tests can override per-run via process.env.
function getDedupStatePath(): string {
  return process.env.PW_DEDUP_STATE_PATH ?? join(
    process.env.HOME ?? "~/",
    ".agentworks/process-watcher-dedup.json"
  );
}

function getReportedCommitsPath(): string {
  return process.env.PW_REPORTED_COMMITS_PATH ?? join(
    process.env.HOME ?? "~/",
    ".agentworks/process-watcher-reported-commits.json"
  );
}

function getAutoCommitLogPath(): string {
  return process.env.PW_AUTO_COMMIT_LOG_PATH ?? join(
    process.env.HOME ?? "~/",
    ".agentworks/auto-commit.log"
  );
}

function todayGitLog(identifier: string, sinceMinutes: number): Promise<string[]> {
  return new Promise((resolve) => {
    console.log(`[DEBUG] todayGitLog called: identifier=${identifier}, sinceMinutes=${sinceMinutes}`);
    const { execFileSync } = require("child_process");
    try {
      // Use execFileSync (no shell) to avoid word-splitting the --since value.
      // Redirect stderr to /dev/null to suppress "ambiguous argument" errors
      // when the repo has no matching commits — those are expected and not errors.
      const out = execFileSync(
        "git",
        ["log", `--since=${sinceMinutes} minutes ago`, "--format=%H", "--all", "--grep", identifier],
        { cwd: process.cwd(), encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
      );
      resolve(out.trim().split("\n").filter(Boolean));
    } catch {
      resolve([]);
    }
  });
}

function autoCommitLog(issueId: string, runId: string): Promise<boolean> {
  const autoCommitLogPath = getAutoCommitLogPath();
  if (!existsSync(autoCommitLogPath)) return Promise.resolve(false);
  return readFile(autoCommitLogPath, "utf-8").then((content) =>
    content.includes(`issue=${issueId}`) && content.includes(`run=${runId}`)
  );
}

function lastCommentHygiene(client: AwosApiClient, issueId: string, completedAt: number): Promise<boolean> {
  return client.getLastComment(issueId).then((comment) => {
    if (!comment) return false;
    // Comment must have been posted after the issue was closed to qualify as close-comment hygiene
    const commentAt = new Date(comment.createdAt).getTime();
    if (commentAt <= completedAt) return false;
    const body = comment.body;
    return body.includes("/") && (
      body.includes("pnpm") ||
      body.includes("test") ||
      body.includes("pass") ||
      body.includes("fail") ||
      body.includes("verify")
    );
  });
}

function todayDateStr(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

export class ProcessWatcher {
  private client: AwosApiClient;
  private dedupState: DedupState;
  private running = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Findings from the most recent heartbeat run, used for the daily digest */
  private lastFindings: Finding[] = [];

  /**
   * @param config - ProcessWatcher configuration
   * @param apiClient - Optional. Allows injection of a mock client in tests.
   *                    Defaults to a real AwosApiClient using config.
   */
  constructor(
    private readonly config: ProcessWatcherConfig,
    apiClient?: AwosApiClient
  ) {
    this.client = apiClient ?? new AwosApiClient(
      config.awosApiUrl,
      config.awosApiKey
    );
    this.dedupState = {
      seenFindings: {},
      lastRunAt: new Date(0).toISOString(),
      resolvedIssueIds: {},
    };
  }

  /**
   * Start the periodic heartbeat. Runs immediately, then again every
   * `config.heartbeatIntervalMin` minutes.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.runHeartbeat();
    const intervalMs = (this.config.heartbeatIntervalMin ?? 30) * 60_000;
    this.timer = setInterval(() => {
      void this.runHeartbeat();
    }, intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async loadDedupState(): Promise<void> {
    if (this.config._dedupState !== undefined) {
      // Test mode: use injected state directly, no file I/O
      this.dedupState = this.config._dedupState;
      return;
    }
    try {
      if (existsSync(getDedupStatePath())) {
        const raw = await readFile(getDedupStatePath(), "utf-8");
        const parsed = JSON.parse(raw) as Partial<DedupState>;
        // Normalize legacy "seen" key to "seenFindings"
        const { seenFindings: _legacySeen, lastDigestDate: _ldd, ...rest } = parsed as Record<string, unknown>;
        this.dedupState = {
          seenFindings: (_legacySeen as Record<string, string>) ?? parsed.seenFindings ?? {},
          lastRunAt: parsed.lastRunAt ?? new Date(0).toISOString(),
          ...(parsed.lastDigestDate !== undefined && { lastDigestDate: parsed.lastDigestDate }),
          resolvedIssueIds: parsed.resolvedIssueIds ?? {},
        };
      }
    } catch {
      // Start fresh on parse error
    }
  }

  async saveDedupState(): Promise<void> {
    if (this.config._dedupState !== undefined) {
      // Test mode: no file I/O for injected state
      return;
    }
    try {
      await writeFile(getDedupStatePath(), JSON.stringify(this.dedupState, null, 2));
    } catch (e) {
      console.error("[ProcessWatcher] Could not save dedup state:", e);
    }
  }

  /**
   * Call PATCH /api/issues/:issueId/resolve-lane-assignment for terminal-state
   * issues that have not yet been resolved. Idempotent — safe to call repeatedly.
   * Resolved IDs are persisted via dedupState.resolvedIssueIds so they survive restarts.
   */
  private async maybeResolveLaneAssignment(
    doneIssues: Array<{ id: string; identifier: string; status: string }>,
    closedIssues: Array<{ id: string; identifier: string; status: string }>
  ): Promise<void> {
    const { agentosApiUrl, agentosApiKey } = this.config;
    if (!agentosApiUrl || !agentosApiKey) return;

    const terminalIssues = [...doneIssues, ...closedIssues];
    if (terminalIssues.length === 0) return; // Nothing to resolve — avoids spurious API errors on empty board

    const errors: Array<{ issueId: string; message: string }> = [];

    for (const issue of terminalIssues) {
      if (issue.id in this.dedupState.resolvedIssueIds) continue;

      try {
        const url = `${agentosApiUrl}/api/issues/${issue.id}/resolve-lane-assignment`;
        const res = await fetch(url, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${agentosApiKey}`,
          },
          body: JSON.stringify({}),
        });

        if (res.ok || res.status === 404) {
          // 404 = no lane assignment for this issue — count as resolved anyway
          this.dedupState.resolvedIssueIds[issue.id] = new Date().toISOString();
          console.log(
            `[ProcessWatcher] Resolved lane assignment for ${issue.identifier} (${issue.status})`
          );
        } else {
          const body = await res.text();
          errors.push({ issueId: issue.id, message: `HTTP ${res.status}: ${body}` });
        }
      } catch (e) {
        errors.push({
          issueId: issue.id,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (errors.length > 0) {
      console.warn("[ProcessWatcher] resolve-lane-assignment errors:", errors);
    }
  }

  async runHeartbeat(): Promise<{ newFindings: Finding[]; errors: CheckResult["errors"] }> {
    await this.loadDedupState();
    const { companyId } = this.config;

    let inProgressIssues: Awaited<ReturnType<typeof this.client.getIssues>> = [];
    let doneIssues: Awaited<ReturnType<typeof this.client.getIssues>> = [];
    let blockedIssues: Awaited<ReturnType<typeof this.client.getIssues>> = [];
    let closedIssues: Awaited<ReturnType<typeof this.client.getIssues>> = [];
    let agents: Awaited<ReturnType<typeof this.client.getAgents>> = [];

    try {
      ([inProgressIssues, doneIssues, blockedIssues, closedIssues, agents] = await Promise.all([
        this.client.getIssues(companyId, ["in_progress"]),
        this.client.getIssues(companyId, ["done"]),
        this.client.getIssues(companyId, ["blocked"]),
        this.client.getIssues(companyId, ["closed"]),
        this.client.getAgents(companyId),
      ]));
    } catch (e) {
      console.warn(`[ProcessWatcher] AWOS API unreachable (${this.config.awosApiUrl}): ${e instanceof Error ? e.message : String(e)}. Skipping heartbeat.`);
      return { newFindings: [], errors: [] };
    }

    const agentNameMap = new Map(agents.map((a) => [a.id, a.name]));

    // Build todo counts per agent
    const todoIssues = await this.client.getIssues(companyId, ["todo"]);
    const agentTodoCounts = new Map<string, number>();
    for (const issue of todoIssues) {
      if (!issue.assigneeAgentId) continue;
      agentTodoCounts.set(
        issue.assigneeAgentId,
        (agentTodoCounts.get(issue.assigneeAgentId) ?? 0) + 1
      );
    }

    // Agent last runs are deferred until a native per-agent runs endpoint lands.
    const agentLastRuns: Array<{
      agentId: string;
      agentName: string;
      lastRunId: string;
      lastRunStatus: string;
      lastRunFinishedAt: string | null;
      hasSubsequentRun: boolean;
    }> = [];

    // Load reported commits for off-lane dedup and merge dedup state.
    let reportedCommits: string[] = [];
    try {
      const reportedPath = getReportedCommitsPath();
      if (existsSync(reportedPath)) {
        reportedCommits = JSON.parse(await readFile(reportedPath, "utf-8")) as string[];
      }
    } catch {
      // Ignore
    }
    // Also pull off-lane commit hashes that are already in seenFindings
    for (const key of Object.keys(this.dedupState.seenFindings)) {
      if (key.startsWith("off_lane_commits:")) {
        const hash = key.replace("off_lane_commits:", "");
        if (!reportedCommits.includes(hash)) reportedCommits.push(hash);
      }
    }

    const [
      staleResult,
      prematureResult,
      offLaneResult,
      mismatchResult,
      queueResult,
      failedRunResult,
      blockedStuckResult,
    ] = await Promise.all([
      checkStaleInProgress({
        issues: inProgressIssues.map((i) => ({
          id: i.id,
          identifier: i.identifier,
          status: i.status,
          updatedAt: i.updatedAt,
          assigneeAgentId: i.assigneeAgentId,
        })),
        commitsSince: this.config._commitsSince ?? ((id, sinceMin) => todayGitLog(id, sinceMin)),
        thresholdMin: this.config.staleInProgressThresholdMin,
      }),
      checkPrematureDone({
        issues: doneIssues.map((i) => ({
          id: i.id,
          identifier: i.identifier,
          status: i.status,
          completedAt: i.completedAt,
          updatedAt: i.updatedAt,
          assigneeAgentId: i.assigneeAgentId,
          executionRunId: i.executionRunId,
        })),
        commitsNear: this.config._commitsSince ?? ((id) => todayGitLog(id, Math.ceil(this.config.prematureDoneWindowSec / 60))),
        hasAutoCommit: this.config._hasAutoCommit ?? autoCommitLog,
        lastCommentMatchesHygiene: (issueId, completedAt) => lastCommentHygiene(this.client, issueId, completedAt),
        windowSec: this.config.prematureDoneWindowSec,
      }),
      checkOffLaneCommits({
        logPath: this.config.commitScopeLogPath,
        reportedCommits: new Set(reportedCommits),
        standingIssueId: this.config.standingIssueId,
      }),
      checkAutoCommitCloseMismatch({
        issues: doneIssues.map((i) => ({
          id: i.id,
          identifier: i.identifier,
          status: i.status,
          completedAt: i.completedAt,
          executionRunId: i.executionRunId,
          assigneeAgentId: i.assigneeAgentId,
        })),
        hasAutoCommit: this.config._hasAutoCommit ?? ((issueId, runId) => autoCommitLog(issueId, runId)),
        windowSec: this.config.prematureDoneWindowSec,
      }),
      checkQueueDepth({
        agentTodoCounts,
        agentNames: agentNameMap,
        watermark: this.config.queueDepthWatermark,
      }),
      checkFailedRunNotRetried({
        agentLastRuns: agentLastRuns.filter(Boolean) as Exclude<typeof agentLastRuns[number], null>[],
        thresholdHrs: this.config.failedRunThresholdHrs,
      }),
      checkBlockedStuck({
        issues: blockedIssues.map((i) => ({
          id: i.id,
          identifier: i.identifier,
          status: i.status,
          updatedAt: i.updatedAt,
          assigneeAgentId: i.assigneeAgentId,
          latestCommentAt: i.latestCommentAt,
        })),
        thresholdHrs: this.config.blockedStuckThresholdHrs,
      }),
    ]);

    const allResults: CheckResult[] = [
      staleResult,
      prematureResult,
      offLaneResult,
      mismatchResult,
      queueResult,
      failedRunResult,
      blockedStuckResult,
    ];

    const allErrors = allResults.flatMap((r) => r.errors);
    const allFindings = allResults.flatMap((r) => r.findings);

    // Deduplicate against seen findings
    const newFindings: Finding[] = [];
    const now = new Date().toISOString();
    for (const finding of allFindings) {
      const lastSeen = this.dedupState.seenFindings[finding.dedupKey];
      if (lastSeen) continue; // Already reported
      newFindings.push(finding);
      this.dedupState.seenFindings[finding.dedupKey] = now;
    }

    // Update off-lane reported commits — extract hash from dedupKey
    // (dedupKey format: "off_lane_commits:<hash>")
    const newOffLaneCommits: string[] = [];
    for (const f of offLaneResult.findings) {
      const parts = f.dedupKey.split(":");
      if (parts.length >= 2) newOffLaneCommits.push(parts[1]!);
    }
    if (newOffLaneCommits.length > 0) {
      const reportedPath = getReportedCommitsPath();
      const merged: string[] = [...reportedCommits];
      for (const c of newOffLaneCommits) {
        if (!merged.includes(c)) merged.push(c);
      }
      await writeFile(reportedPath, JSON.stringify(merged));
    }

    // Post individual comments for new findings
    const commentErrors: CheckResult["errors"] = [];
    for (const finding of newFindings) {
      const mention =
        finding.severity === "critical"
          ? `@${this.config.criticalMentionTarget} `
          : "";
      const body =
        `${mention}[ProcessWatcher] **${finding.checkId}** (${finding.severity})\n\n` +
        `${finding.explanation}\n\n` +
        `**Suggested action:** ${finding.suggestedAction}`;

      if (finding.targetIssueId) {
        const ok = await this.client.postComment(finding.targetIssueId, body);
        if (!ok) {
          commentErrors.push({ checkId: finding.checkId, message: `Failed to post comment on ${finding.targetIssueId}` });
        }
      }
    }

    // Store findings for digest, then handle daily digest
    this.lastFindings = newFindings;
    await this.maybePostDigest(newFindings);

    // Resolve lane assignments for terminal-state issues
    await this.maybeResolveLaneAssignment(doneIssues, closedIssues);

    this.dedupState.lastRunAt = now;
    await this.saveDedupState();

    return { newFindings, errors: [...allErrors, ...commentErrors] };
  }

  /**
   * Post the daily digest to the configured digest target issue if we haven't
   * already posted one today. Only posts when there are findings to report.
   */
  private async maybePostDigest(findings: Finding[]): Promise<void> {
    const digestIssueId = this.config.digestTargetIssueId;
    if (!digestIssueId || findings.length === 0) return;

    const today = todayDateStr();
    if (this.dedupState.lastDigestDate === today) return; // Already posted today

    // Group by checkId
    const byCheck: Record<string, Finding[]> = {};
    for (const f of findings) {
      if (!byCheck[f.checkId]) byCheck[f.checkId] = [];
      byCheck[f.checkId]!.push(f);
    }

    const lines: string[] = [
      `## ProcessWatcher Daily Digest — ${today}`,
      "",
      `Found ${findings.length} new violation(s) this heartbeat:`,
      "",
    ];

    for (const [checkId, checkFindings] of Object.entries(byCheck)) {
      lines.push(`### ${checkId} (${checkFindings[0]!.severity})`);
      // Top offenders: sort by severity (critical first), take 3
      const top = [...checkFindings]
        .sort((a, b) => {
          const order = { critical: 0, warn: 1, info: 2 };
          return (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
        })
        .slice(0, 3);

      for (const f of top) {
        if (f.targetIdentifier) {
          lines.push(`- **${f.targetIdentifier}**: ${f.explanation.split("\n")[0]}`);
        } else if (f.agentId) {
          lines.push(`- Agent \`${f.agentId}\`: ${f.explanation.split("\n")[0]}`);
        }
      }
      if (checkFindings.length > 3) {
        lines.push(`  +${checkFindings.length - 3} more`);
      }
      lines.push("");
    }

    const body = lines.join("\n");
    try {
      await this.client.postComment(digestIssueId, body);
      this.dedupState.lastDigestDate = today;
    } catch (e) {
      console.error("[ProcessWatcher] Digest post failed:", e instanceof Error ? e.message : String(e));
    }
  }
}

export function createProcessWatcher(config: ProcessWatcherConfig): ProcessWatcher {
  return new ProcessWatcher(config);
}
