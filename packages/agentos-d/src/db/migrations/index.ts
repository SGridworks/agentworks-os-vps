/**
 * Migration registry — runs all migrations in order.
 * Each migration is idempotent (checks its hash before applying).
 */

import type { Database } from "better-sqlite3";
import { migrate as migrateInit } from "./0000_init.js";
import { migrate as migratePolicyTables } from "./0001_policy_tables.js";
import { migrate as migratePolicyDecisionsUpdatedAt } from "./0002_policy_decisions_updated_at.js";
import { migrate as migrateTenants } from "./0003_tenants.js";
import { migrate as migrateTenantWebhooks } from "./0004_tenant_webhooks.js";
import { migrate as migrateTenantShadowMode } from "./0005_tenant_shadow_mode.js";
import { migrate as migrateTenantRulePackAssignments } from "./0006_tenant_rule_pack_assignments.js";
import { migrate as migrateDispatchQueue } from "./0007_dispatch_queue.js";
import { migrate as migrateEvidenceReports } from "./0008_evidence_reports.js";
import { migrate as migrateDaemonPausedState } from "./0009_daemon_paused_state.js";
import { migrate as migrateTenantProviderConfigs } from "./0010_tenant_provider_configs.js";
import { migrate as migrateProcessWatcherDedup } from "./0011_process_watcher_dedup.js";
import { migrate as migrateScopeViolations } from "./0012_scope_violations.js";
import { migrate as migrateLaneAssignments } from "./0013_lane_assignments.js";
import { migrate as migrateContactConsentFields } from "./0014_contact_consent_fields.js";
import { migrate as migrateApprovalQueue } from "./0015_approval_queue.js";
import { migrate as migrateEvidenceReportsSigningCols } from "./0016_evidence_reports_signing_cols.js";
import { migrate as migratePolicyPackMode } from "./0017_policy_pack_mode.js";
import { migrate as migrateRulePackDrafts } from "./0018_rule_pack_drafts.js";
import { migrate as migrateCompatProxyEvents } from "./0019_compat_proxy_events.js";
import { migrate as migrateExecutionCore } from "./0020_execution_core.js";
import { migrate as migrateExecutionIndexes } from "./0021_execution_indexes.js";
import { migrate as migrateAgentColumns } from "./0022_agent_columns.js";
import { migrate as migrateAgentTier2 } from "./0023_agent_tier2.js";
import { migrate as migrateEpisodes } from "./0024_episodes.js";
import { migrate as migrateInsights } from "./0025_insights.js";
import { migrate as migrateEpisodeSession } from "./0026_episode_session.js";
import { migrate as migrateAgentInstructionsBackfill } from "./0027_agent_instructions_backfill.js";
import { migrate as migrateAgentInstructionsNameAlias } from "./0029_agent_instructions_name_alias.js";
import { migrate as migrateAgentInstructionsStub } from "./0030_agent_instructions_stub.js";
import { migrate as migrateCompanyIssuePrefix } from "./0031_company_issue_prefix.js";
import { migrate as migrateTaskSessionStatusAlign } from "./0032_task_session_status_align.js";
import { migrate as migrateAutopilotFields } from "./0033_autopilot_fields.js";
import { migrate as migrateMissionMap } from "./0034_mission_map.js";

export function migrate(sqlite: Database): void {
  migrateInit(sqlite);
  migratePolicyTables(sqlite);
  migratePolicyDecisionsUpdatedAt(sqlite);
  migrateTenants(sqlite);
  migrateTenantWebhooks(sqlite);
  migrateTenantShadowMode(sqlite);
  migrateTenantRulePackAssignments(sqlite);
  migrateDispatchQueue(sqlite);
  migrateEvidenceReports(sqlite);
  migrateDaemonPausedState(sqlite);
  migrateTenantProviderConfigs(sqlite);
  migrateProcessWatcherDedup(sqlite);
  migrateScopeViolations(sqlite);
  migrateLaneAssignments(sqlite);
  migrateContactConsentFields(sqlite);
  migrateApprovalQueue(sqlite);
  migrateEvidenceReportsSigningCols(sqlite);
  migratePolicyPackMode(sqlite);
  migrateRulePackDrafts(sqlite);
  migrateCompatProxyEvents(sqlite);
  migrateExecutionCore(sqlite);
  migrateExecutionIndexes(sqlite);
  migrateAgentColumns(sqlite);
  migrateAgentTier2(sqlite);
  migrateEpisodes(sqlite);
  migrateInsights(sqlite);
  migrateEpisodeSession(sqlite);
  migrateAgentInstructionsBackfill(sqlite);
  migrateAgentInstructionsNameAlias(sqlite);
  migrateAgentInstructionsStub(sqlite);
  migrateCompanyIssuePrefix(sqlite);
  migrateTaskSessionStatusAlign(sqlite);
  migrateAutopilotFields(sqlite);
  migrateMissionMap(sqlite);
}
