/**
 * Backup manifest schema and types.
 * The manifest is stored as MANIFEST.json inside the backup tarball and
 * is validated on restore before any data is written to disk.
 */

export const BACKUP_VERSION = "1.0.0" as const;

export interface BackupManifest {
  version: string;
  createdAt: string; // ISO-8601
  hostname: string;
  dbTables: string[]; // e.g. ["policy_decisions","action_log","tenants",...]
  vaults: string[]; // tenant IDs whose vault dirs are included
  rulePackAssignments: boolean; // whether tenant_rule_pack_assignments data is included
  tenantConfigs: string[]; // tenant IDs whose config is included
  checksumSha256: string; // SHA-256 of payload/agentworks.db
}

/**
 * Lists all DB table names managed by agentos-d.
 * Used to produce the manifest at backup time. The sqlite3 .backup
 * command itself copies all tables — this list is metadata for the
 * manifest and the restore-time integrity check.
 */
export function listDbTables(): string[] {
  return [
    "policy_decisions",
    "scanner_findings",
    "approval_queue",
    "action_log",
    "policy_rules",
    "policy_violations",
    "policy_pack_mode",
    "rule_pack_drafts",
    "tenants",
    "tenant_webhooks",
    "tenant_rule_pack_assignments",
    "tenant_provider_configs",
    "dispatch_queue",
    "evidence_reports",
    "compat_proxy_events",
    "daemon_paused_state",
    "scope_violations",
    "lane_assignments",
    "process_watcher_dedup",
    "execution_companies",
    "execution_company_issue_seq",
    "execution_projects",
    "execution_agents",
    "execution_agent_config_revisions",
    "execution_agent_runtime_state",
    "execution_agent_task_sessions",
    "execution_agent_wakeups",
    "execution_issues",
    "execution_issue_comments",
    "execution_runs",
    "execution_run_events",
    "execution_cost_events",
    "execution_webhook_intakes",
    "episodes",
    "insights",
  ];
}
