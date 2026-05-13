import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "./config.js";
import { initDb, getSqlite } from "./db/index.js";
import { migrate } from "./db/migrations/index.js";
import { startAuditLogRetentionScheduler } from "./retention.js";
import { startWebSocketServer } from "./websocket-server.js";
import { EvidenceReportCron } from "./services/evidence-report-cron.js";
import { startHotMdBuilder } from "./services/hot-md-builder.js";
import {
  DispatchConsumer,
  dispatchConsumerEnabled,
  dispatchConsumerOptionsFromEnv,
  type AgentAdapter,
} from "./services/dispatch-consumer.js";
import { KimiAdapter } from "./adapters/kimi-adapter.js";
import { RouterAdapter } from "./adapters/router-adapter.js";
import { FakePdfEngine, PuppeteerPdfEngine } from "@agentworks/pdf";
import { createApp } from "./app.js";
import { runBackup } from "./bin/backup.js";
import { runRestore } from "./bin/restore.js";
import { isPaused, pause, resume } from "./pause-service.js";
import { createProcessWatcher, ProcessWatcher } from "./services/process-watcher/index.js";
import type { ProcessWatcherConfig } from "./services/process-watcher/index.js";

function buildAdapter(sqlite: ReturnType<typeof getSqlite>): AgentAdapter | undefined {
  const choice = (process.env.AWOS_ADAPTER ?? "router").toLowerCase();
  if (choice === "stub" || choice === "off" || choice === "none") {
    console.log("[dispatch-consumer] AWOS_ADAPTER=stub — using no-op stub adapter");
    return undefined;
  }
  try {
    if (choice === "spec" || choice === "kimi") {
      const adapter = new KimiAdapter({ sqlite });
      console.log("[dispatch-consumer] kimi-adapter (spec only) wired");
      return adapter;
    }
    const adapter = new RouterAdapter({ sqlite });
    console.log("[dispatch-consumer] router-adapter wired (spec + tool)");
    return adapter;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[dispatch-consumer] adapter init failed (${msg}); falling back to stub`);
    return undefined;
  }
}

function createPdfEngine(): any {
  const engineType = process.env.PDF_ENGINE;
  if (engineType === "puppeteer" && process.env.PDF_ENGINE_EXECUTABLE_PATH) {
    return new PuppeteerPdfEngine({ executablePath: process.env.PDF_ENGINE_EXECUTABLE_PATH });
  }
  return new FakePdfEngine();
}

function main(): void {
  const config = loadConfig();
  initDb({ config, migrations: migrate });
  const pdfEngine = createPdfEngine();
  const evidenceCron = new EvidenceReportCron({ engine: pdfEngine });
  evidenceCron.start();
  (global as any).evidenceCronRunning = true;
  const hotMdStop = startHotMdBuilder({ config });
  // Wire pdfEngine into config so createComplianceRouter can find it
  (config as any).pdfEngine = pdfEngine;
  const watcherConfig: ProcessWatcherConfig = {
    staleInProgressThresholdMin: 45,
    prematureDoneWindowSec: 60,
    queueDepthWatermark: 8,
    failedRunThresholdHrs: 2,
    blockedStuckThresholdHrs: 4,
    commitScopeLogPath: join(homedir(), ".agentworks/scripts/commit-scope.log"),
    awosApiUrl: process.env.AGENTOS_API_URL ?? "http://127.0.0.1:7710",
    awosApiKey: process.env.AGENTOS_API_KEY ?? "local-trusted",
    companyId: config.companyId,
    criticalMentionTarget: "ceo",
    standingIssueId: config.standingIssueId ?? "standing",
    heartbeatIntervalMin: 30,
    digestTargetIssueId: config.standingIssueId ?? "standing",
  };
  const watcher = createProcessWatcher(watcherConfig);
  void watcher.start();
  const retentionTimer = startAuditLogRetentionScheduler(config.auditLogRetentionDays);

  let dispatchConsumer: DispatchConsumer | null = null;
  if (dispatchConsumerEnabled()) {
    const opts = dispatchConsumerOptionsFromEnv();
    const adapter = buildAdapter(getSqlite());
    const consumerOpts: ConstructorParameters<typeof DispatchConsumer>[0] = {
      sqlite: getSqlite(),
      intervalMs: opts.intervalMs,
      batchSize: opts.batchSize,
      logger: {
        info: (m, c) => console.log(`[dispatch-consumer] ${m}`, c ?? ""),
        warn: (m, c) => console.warn(`[dispatch-consumer] ${m}`, c ?? ""),
        error: (m, c) => console.error(`[dispatch-consumer] ${m}`, c ?? ""),
      },
    };
    if (adapter) consumerOpts.adapter = adapter;
    dispatchConsumer = new DispatchConsumer(consumerOpts);
    dispatchConsumer.start();
  }

  const app = createApp(config);
  const server = app.listen({ host: config.host, port: config.port } as any, () => {
    console.log(`[agentos-d] listening on http://${config.host}:${config.port} (awcp=${config.awcpVersion}) retention=${config.auditLogRetentionDays}d`);
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.log(`[agentos-d] received ${signal}, shutting down`);
      hotMdStop();
      dispatchConsumer?.stop();
      if (retentionTimer) clearInterval(retentionTimer);
      if ((global as any).evidenceCronRunning) {
        evidenceCron.stop();
        (global as any).evidenceCronRunning = false;
      }
      server.close(() => process.exit(0));
    });
  }
}

function runPause(): void {
  const config = loadConfig();
  initDb({ config, migrations: migrate });
  const current = isPaused();
  if (current) {
    console.log("Substrate is already paused.");
  } else {
    pause("cli", "manual");
    console.log("Substrate paused.");
  }
}

function runResume(): void {
  const config = loadConfig();
  initDb({ config, migrations: migrate });
  const current = isPaused();
  if (!current) {
    console.log("Substrate is already running.");
  } else {
    resume();
    console.log("Substrate resumed.");
  }
}

const cmd = process.argv[2];
if (cmd === "backup") {
  // Remaining args after "backup": [--out PATH] [--key KEY]
  runBackup(process.argv.slice(3))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
} else if (cmd === "restore") {
  // Pass all args after "restore" to runRestore so parseArgs handles them correctly
  const restoreArgs = process.argv.slice(3);
  if (restoreArgs.length === 0 || restoreArgs[0]!.startsWith("--")) {
    console.error("Usage: agentos restore <backup-file> [--key KEY]");
    process.exit(1);
  }
  runRestore(restoreArgs)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
} else if (cmd === "pause") {
  runPause();
  process.exit(0);
} else if (cmd === "resume") {
  runResume();
  process.exit(0);
} else {
  main();
}
