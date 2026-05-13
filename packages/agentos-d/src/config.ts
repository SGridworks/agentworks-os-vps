import path from "node:path";
import { z } from "zod";
import { pino, Logger } from "pino";

const EnvBooleanSchema = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());

const ConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().positive().default(7710),
  logLevel: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  awcpVersion: z.string().default("awcp/v0.1"),
  dataDir: z.string().default("./data"),
  scannerSidecarUrl: z.string().default("http://127.0.0.1:3101"),
  scannerPollIntervalMs: z.coerce.number().int().positive().default(30_000),
  /**
   * Audit log retention in days. action_log rows older than this are deleted
   * by the daily retention sweep. Default 30. Set to 0 to disable retention
   * (rows kept forever).
   *
   * policy_decisions are NOT subject to retention — they are hash-chained for
   * tamper-evidence and the chain must not be broken. Compliance evidence
   * reports aggregate over policy_decisions counts, not action_log payloads.
   */
  auditLogRetentionDays: z.coerce.number().int().min(0).default(30),
  companyId: z.string().default(""),
  standingIssueId: z.string().default("standing"),
  legacyAdapterUrl: z.string().url().default("http://127.0.0.1:3100"),
  legacyAdapterApiKey: z.string().default("local-trusted"),
  legacyAdapterEnabled: EnvBooleanSchema.default(false),
  executionDatabaseUrl: z.string().url().optional(),
  agentsRoot: z.string().default(""),
});

export type Config = z.infer<typeof ConfigSchema> & {
  logger: Logger;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const raw = ConfigSchema.parse({
    host: env.AGENTOS_HOST,
    port: env.AGENTOS_PORT,
    logLevel: env.AGENTOS_LOG_LEVEL,
    awcpVersion: env.AGENTOS_AWCP_VERSION,
    dataDir: env.AGENTOS_DATA_DIR ?? "./data",
    scannerSidecarUrl: env.SCANNER_SIDECAR_URL,
    scannerPollIntervalMs: env.SCANNER_POLL_INTERVAL_MS,
    auditLogRetentionDays: env.AGENTOS_AUDIT_LOG_RETENTION_DAYS,
    legacyAdapterUrl: env.AGENTOS_LEGACY_ADAPTER_URL,
    legacyAdapterApiKey: env.AGENTOS_LEGACY_ADAPTER_API_KEY,
    legacyAdapterEnabled: env.AGENTOS_LEGACY_ADAPTER_ENABLED,
    executionDatabaseUrl: env.AGENTOS_EXECUTION_DATABASE_URL,
    agentsRoot: env.AWOS_AGENTS_ROOT ?? path.resolve(process.cwd(), "..", "..", "agents"),
  });

  const logger = pino({ level: raw.logLevel });

  return {
    ...raw,
    logger,
    companyId: env.AGENTOS_COMPANY_ID ?? raw.companyId,
    standingIssueId: env.AGENTOS_STANDING_ISSUE_ID ?? raw.standingIssueId,
  };
}
