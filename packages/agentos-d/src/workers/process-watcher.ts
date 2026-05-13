// packages/agentos-d/src/workers/process-watcher.ts
// Standalone CLI entrypoint for the ProcessWatcher heartbeat worker.
// Can be run independently from the full agentos-d server.
// Usage: npx tsx src/workers/process-watcher.ts

import { join } from "node:path";
import { homedir } from "node:os";
import { createProcessWatcher } from "../services/process-watcher/processWatcher.js";
import type { ProcessWatcherConfig } from "../services/process-watcher/types.js";

function getEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function getEnvInt(key: string, fallback: number): number {
  const val = process.env[key];
  return val !== undefined ? parseInt(val, 10) : fallback;
}

function buildConfig(): ProcessWatcherConfig {
  const home = homedir();
  return {
    staleInProgressThresholdMin: getEnvInt("PW_STALE_THRESHOLD_MIN", 45),
    prematureDoneWindowSec: getEnvInt("PW_PREMATURE_WINDOW_SEC", 60),
    queueDepthWatermark: getEnvInt("PW_QUEUE_WATERMARK", 8),
    failedRunThresholdHrs: getEnvInt("PW_FAILED_RUN_HRS", 2),
    blockedStuckThresholdHrs: getEnvInt("PW_BLOCKED_STUCK_HRS", 4),
    commitScopeLogPath: getEnv(
      "PW_COMMIT_SCOPE_LOG",
      join(home, ".agentworks/scripts/commit-scope.log")
    ),
    awosApiUrl: getEnv("AGENTOS_API_URL", "http://127.0.0.1:7710"),
    awosApiKey: getEnv("AGENTOS_API_KEY", "local-trusted"),
    companyId: getEnv("AGENTOS_COMPANY_ID", ""),
    criticalMentionTarget: getEnv("PW_CRITICAL_MENTION", "ceo"),
    standingIssueId: getEnv("AGENTOS_STANDING_ISSUE_ID", "standing"),
    heartbeatIntervalMin: getEnvInt("PW_HEARTBEAT_INTERVAL_MIN", 30),
    digestTargetIssueId: getEnv("PW_DIGEST_ISSUE_ID", ""),
    agentosApiUrl: getEnv("AGENTOS_API_URL", "http://127.0.0.1:7710"),
    agentosApiKey: getEnv("AGENTOS_API_KEY", "local-trusted"),
  };
}

async function main(): Promise<void> {
  const config = buildConfig();
  const runOnce = process.argv.includes("--once");

  console.log("[ProcessWatcher] Starting with config:");
  console.log(`  companyId: ${config.companyId}`);
  console.log(`  awosApiUrl: ${config.awosApiUrl}`);
  console.log(`  heartbeatIntervalMin: ${config.heartbeatIntervalMin}`);
  console.log(`  staleInProgressThresholdMin: ${config.staleInProgressThresholdMin}`);
  console.log(`  prematureDoneWindowSec: ${config.prematureDoneWindowSec}`);
  console.log(`  queueDepthWatermark: ${config.queueDepthWatermark}`);
  console.log(`  failedRunThresholdHrs: ${config.failedRunThresholdHrs}`);
  console.log(`  blockedStuckThresholdHrs: ${config.blockedStuckThresholdHrs}`);
  console.log(`  commitScopeLogPath: ${config.commitScopeLogPath}`);

  const watcher = createProcessWatcher(config);

  if (runOnce) {
    // Cron mode: run once on schedule and exit
    console.log("[ProcessWatcher] Running single heartbeat (--once mode)...");
    const result = await watcher.runHeartbeat();
    console.log(
      `[ProcessWatcher] Heartbeat complete: ${result.newFindings.length} new findings, ${result.errors.length} errors`
    );
    watcher.stop();
    return;
  }

  // Standalone mode: self-schedule heartbeats
  console.log("[ProcessWatcher] Running initial heartbeat...");
  const result = await watcher.runHeartbeat();
  console.log(
    `[ProcessWatcher] Initial heartbeat complete: ${result.newFindings.length} new findings, ${result.errors.length} errors`
  );

  const shutdown = (signal: string) => {
    console.log(`[ProcessWatcher] Received ${signal}, shutting down...`);
    watcher.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await watcher.start();
  console.log(
    `[ProcessWatcher] Heartbeat scheduled every ${config.heartbeatIntervalMin} minutes`
  );
}

main().catch((err) => {
  console.error("[ProcessWatcher] Fatal error:", err);
  process.exit(1);
});
