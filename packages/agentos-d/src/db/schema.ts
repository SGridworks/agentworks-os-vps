/**
 * AgentWorks OS — Local SQLite schema via Drizzle + better-sqlite3.
 *
 * Tables:
 * - policy_decisions  — every policy engine evaluation result (append-only, hash-chained)
 * - scanner_findings  — AgentGuard scan findings surfaced as issues
 * - approval_queue     — actions routed to human review
 * - action_log        — append-only log of all agent actions crossing the substrate
 *
 * Migrations live in migrations/ and are run on daemon boot.
 */

import { sqliteTable, text, integer, real, blob } from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// policy_decisions
// ---------------------------------------------------------------------------
export const policyDecisions = sqliteTable("policy_decisions", {
  id: text("id").primaryKey(), // UUID
  actionId: text("action_id").notNull(), // maps to ActionEnvelope.requestId
  tenantId: text("tenant_id").notNull(), // UUID

  // Actor
  actorId: text("actor_id").notNull(),
  actorType: text("actor_type", { enum: ["human", "agent", "system"] }).notNull(),
  actorLabel: text("actor_label").notNull(),

  // Contact (optional — not all action kinds have a contact)
  contactType: text("contact_type", { enum: ["person", "business"] }),
  contactLabel: text("contact_label"),
  contactAddress: text("contact_address"),

  channel: text("channel", {
    enum: ["sms", "email", "voice", "chat", "api", "crm", "other"],
  }),
  jurisdiction: text("jurisdiction"),

  // Consent
  consentSource: text("consent_source", {
    enum: ["written", "verbal", "inferred", "none", "unknown"],
  }),
  consentRecordRef: text("consent_record_ref"),
  consentVerified: integer("consent_verified", { mode: "boolean" }).default(false),

  // Purpose
  purpose: text("purpose"),
  rulePackId: text("rule_pack_id"),
  rulePackVersion: text("rule_pack_version"),

  // Proposed action
  proposedActionKind: text("proposed_action_kind").notNull(),
  proposedActionSummary: text("proposed_action_summary").notNull(),

  // Evidence snapshot (JSON string)
  evidenceSnapshot: text("evidence_snapshot").notNull(), // JSON

  // Decision
  decision: text("decision", {
    enum: ["allow", "block", "route_to_review"],
  }).notNull(),
  decisionReason: text("decision_reason").notNull(),
  shadowMode: integer("shadow_mode", { mode: "boolean" }).notNull().default(false),

  // Override (optional)
  overriddenBy: text("overridden_by"),
  overriddenByLabel: text("overridden_by_label"),
  originalDecision: text("original_decision", {
    enum: ["allow", "block", "route_to_review"],
  }),
  overrideReason: text("override_reason"),
  overriddenAt: text("overridden_at"), // ISO datetime

  // Review (optional — for route_to_review decisions)
  reviewedBy: text("reviewed_by"),
  reviewedByLabel: text("reviewed_by_label"),
  reviewDecision: text("review_decision", {
    enum: ["approve", "reject", "return_to_author"],
  }),
  reviewNote: text("review_note"),
  reviewedAt: text("reviewed_at"), // ISO datetime

  // Hash chain
  prevDecisionHash: text("prev_decision_hash"),
  decisionHash: text("decision_hash").notNull(),

  // Timestamps
  proposedAt: text("proposed_at").notNull(), // ISO datetime
  decidedAt: text("decided_at").notNull(), // ISO datetime
  createdAt: text("created_at").notNull(), // ISO datetime
  updatedAt: text("updated_at").notNull(), // ISO datetime — last update (overrides, reviews)
});

// ---------------------------------------------------------------------------
// scanner_findings
// ---------------------------------------------------------------------------
export const scannerFindings = sqliteTable("scanner_findings", {
  id: text("id").primaryKey(), // finding ID from scanner-worker
  tenantId: text("tenant_id").notNull(), // UUID

  // Origin tracking
  originKind: text("origin_kind", {
    enum: ["scanner_finding"],
  })
    .notNull()
    .default("scanner_finding"),
  originId: text("origin_id").notNull(), // maps to scanner-worker finding.id

  // Severity
  severity: text("severity", {
    enum: ["critical", "high", "medium", "low", "info"],
  }).notNull(),

  // Rule metadata
  ruleId: text("rule_id"), // scanner check rule ID
  title: text("title").notNull(),
  description: text("description").notNull(),
  remediation: text("remediation"),

  // Location
  affectedEndpoint: text("affected_endpoint"), // file path or URL

  // Status (open = not yet resolved, resolved = fixed)
  status: text("status", { enum: ["open", "resolved"] })
    .notNull()
    .default("open"),

  // Resolution
  resolvedBy: text("resolved_by"),
  resolvedAt: text("resolved_at"), // ISO datetime
  resolutionNote: text("resolution_note"),

  // Timestamps
  createdAt: text("created_at").notNull(), // ISO datetime
  updatedAt: text("updated_at").notNull(), // ISO datetime
});

// ---------------------------------------------------------------------------
// approval_queue
// ---------------------------------------------------------------------------
export const approvalQueue = sqliteTable("approval_queue", {
  id: text("id").primaryKey(), // UUID

  // Links back to the policy decision
  policyDecisionId: text("policy_decision_id").notNull(),

  // Quick summary fields (denormalized for queue display)
  tenantId: text("tenant_id").notNull(),
  actorLabel: text("actor_label").notNull(),
  proposedActionKind: text("proposed_action_kind").notNull(),
  proposedActionSummary: text("proposed_action_summary").notNull(),
  decisionReason: text("decision_reason").notNull(),

  // Status
  status: text("status", { enum: ["pending", "approved", "rejected", "returned"] })
    .notNull()
    .default("pending"),

  // Reviewer
  reviewedBy: text("reviewed_by"),
  reviewedByLabel: text("reviewed_by_label"),
  reviewNote: text("review_note"),
  reviewedAt: text("reviewed_at"), // ISO datetime

  // Autopilot fields
  autopilotDecision: text("autopilot_decision", { enum: ["allow", "needsApproval", "risky"] }),
  riskScore: real("risk_score"), // 0.0 to 1.0
  reasons: text("reasons"), // JSON array of canonical reason strings
  idempotencyKey: text("idempotency_key"),
  dispatchedAt: text("dispatched_at"), // ISO datetime when auto-dispatched

  // Timestamps
  createdAt: text("created_at").notNull(), // ISO datetime
  updatedAt: text("updated_at").notNull(), // ISO datetime
});

// ---------------------------------------------------------------------------
// action_log
// ---------------------------------------------------------------------------
export const actionLog = sqliteTable("action_log", {
  id: text("id").primaryKey(), // UUID — also used as requestId

  tenantId: text("tenant_id").notNull(),

  // Actor
  actorId: text("actor_id").notNull(),
  actorType: text("actor_type", { enum: ["human", "agent", "system"] }).notNull(),
  actorLabel: text("actor_label").notNull(),

  actionKind: text("action_kind").notNull(),
  payloadSnapshot: text("payload_snapshot").notNull(), // JSON

  // Context refs
  vaultRefs: text("vault_refs").notNull(), // JSON array
  conversationRefs: text("conversation_refs").notNull(), // JSON array
  projectRefs: text("project_refs").notNull(), // JSON array

  // Policy decision
  policyDecisionId: text("policy_decision_id"), // FK to policy_decisions.id

  // Timestamps
  proposedAt: text("proposed_at").notNull(), // ISO datetime
  loggedAt: text("logged_at").notNull(), // ISO datetime — when we wrote this row
});

// ---------------------------------------------------------------------------
// policy_rules
// ---------------------------------------------------------------------------
export const policyRules = sqliteTable("policy_rules", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),

  // Identity
  name: text("name").notNull(),
  version: text("version").notNull(),
  description: text("description"),

  // Source
  source: text("source", { enum: ["tcpa", "odessa_rule", "custom"] }).notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),

  // Rule content (JSON snapshot)
  rulesSnapshot: text("rules_snapshot").notNull(),

  // Metadata
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// policy_violations
// ---------------------------------------------------------------------------
export const policyViolations = sqliteTable("policy_violations", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),

  // Source decision
  policyDecisionId: text("policy_decision_id").notNull(),
  policyRuleId: text("policy_rule_id").notNull(),

  // Violation details
  violationKind: text("violation_kind", {
    enum: [
      "unverified_consent",
      "no_consent_record",
      "wrong_channel",
      "wrong_jurisdiction",
      "purpose_mismatch",
      "missing_required_field",
      "rate_limit_exceeded",
      "other",
    ],
  }).notNull(),
  message: text("message").notNull(),

  // Severity at decision time
  severity: text("severity", {
    enum: ["critical", "high", "medium", "low", "info"],
  }).notNull(),

  // Status
  status: text("status", {
    enum: ["open", "acknowledged", "resolved", "waived"],
  })
    .notNull()
    .default("open"),

  // Resolution
  resolvedBy: text("resolved_by"),
  resolvedAt: text("resolved_at"),
  resolutionNote: text("resolution_note"),

  // Timestamps
  createdAt: text("created_at").notNull(),
});

// ---------------------------------------------------------------------------
// tenants
// One row per registered tenant. Most other tables carry tenant_id as a free
// UUID — this table is the source-of-truth for what tenants exist, used by
// the onboarding wizard and admin UI.
// ---------------------------------------------------------------------------
export const tenants = sqliteTable("tenants", {
  id: text("id").primaryKey(), // UUID
  name: text("name").notNull(),
  description: text("description"), // free-text from onboarding wizard
  industry: text("industry"), // real estate | healthcare | finance | other
  vaultRoot: text("vault_root").notNull(), // Filesystem path or "<default>"
  /**
   * Tenant-level effective policy mode. When true, every policy.check is
   * advisory only (decisions logged but not enforced); when false, decisions
   * enforce. Per-request shadowMode arg always wins; this is the fallback.
   */
  shadowMode: integer("shadow_mode", { mode: "boolean" }).notNull().default(true),
  /**
   * When set, the tenant is in shadow mode until this ISO datetime, then auto-
   * flips to enforce on the next policy.check. NULL means no clock — mode is
   * pinned to whatever shadowMode says.
   */
  shadowUntil: text("shadow_until"),
  createdAt: text("created_at").notNull(), // ISO datetime
  updatedAt: text("updated_at").notNull(), // ISO datetime
});

// ---------------------------------------------------------------------------
// tenant_webhooks
// Per-tenant outbound notification targets. Substrate fires JSON POSTs on
// events the operator has subscribed to (initially: approval_queue.enqueued).
// No outbound email by design — webhooks are the operator's bridge to their
// own messaging system (Slack, Mattermost, custom, etc.).
// ---------------------------------------------------------------------------
export const tenantWebhooks = sqliteTable("tenant_webhooks", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  url: text("url").notNull(),
  events: text("events").notNull(), // JSON array of event names
  secret: text("secret"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// tenant_rule_pack_assignments
// Per-tenant rule pack subscription. Replaces "every tenant gets every pack"
// with explicit subscription. mode: enforce (default) | shadow (advisory).
// ---------------------------------------------------------------------------
export const tenantRulePackAssignments = sqliteTable("tenant_rule_pack_assignments", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  packId: text("pack_id").notNull(),
  mode: text("mode", { enum: ["enforce", "shadow"] }).notNull().default("enforce"),
  assignedAt: text("assigned_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// Dispatch queue — substrate-initiated tasks bound for a target agent.
// Rows sit at status='queued' until an adapter picks them up; status moves
// through 'dispatched' to 'completed' or 'failed'. v1 has no built-in
// worker — adapters poll, or webhooks fan out, or an operator drains.
// ---------------------------------------------------------------------------
export const dispatchQueue = sqliteTable("dispatch_queue", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  taskKind: text("task_kind").notNull(),
  targetAgentId: text("target_agent_id").notNull(),
  input: text("input").notNull(), // JSON-stringified payload
  status: text("status", {
    enum: ["queued", "dispatched", "completed", "failed"],
  })
    .notNull()
    .default("queued"),
  policyDecisionId: text("policy_decision_id"),
  createdAt: text("created_at").notNull(),
  dispatchedAt: text("dispatched_at"),
  completedAt: text("completed_at"),
  error: text("error"),
});

// ---------------------------------------------------------------------------
// evidence_reports — persisted compliance evidence reports (AWO-81).
// One row per (tenantId, periodStart, periodEnd). Stores both the rendered
// PDF and a JSON snapshot of the underlying summary so the admin UI can
// render cards without re-aggregating.
// ---------------------------------------------------------------------------
export const evidenceReports = sqliteTable("evidence_reports", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  reportId: text("report_id").notNull(),
  periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(),
  generatedAt: text("generated_at").notNull(),
  engineName: text("engine_name").notNull(),
  htmlSize: integer("html_size").notNull().default(0),
  pdfByteLength: integer("pdf_byte_length").notNull().default(0),
  pdfBase64: text("pdf_base64"),
  summaryJson: text("summary_json").notNull(),
  status: text("status", { enum: ["complete", "failed"] })
    .notNull()
    .default("complete"),
  error: text("error"),
  /** SHA-256 of the raw (pre-trailer) PDF bytes, hex-encoded. */
  pdfHash: text("pdf_hash"),
  /** HMAC-SHA256 over the signature metadata block, hex-encoded. */
  hmac: text("hmac"),
  /** ISO-8601 timestamp when the PDF was signed. */
  signedAt: text("signed_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// -------------------------------------------------------------------------
// tenant_provider_configs
// Per-tenant LLM provider chain — primary + ordered fallbacks.
// Consumed by the cost-meter proxy at request time to know which providers
// to route through for a given tenant.
// -------------------------------------------------------------------------
export const tenantProviderConfigs = sqliteTable("tenant_provider_configs", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  /** Provider name as registered in the cost-meter (e.g. "openai", "anthropic") */
  providerName: text("provider_name").notNull(),
  /**
   * Order in the fallback chain. Lower number = tried first.
   * Primary provider has order=0. Fallbacks are 1,2,...
   * Duplicates (same tenant+provider) are prevented by the unique constraint.
   */
  fallbackOrder: integer("fallback_order").notNull().default(0),
  /** When false, provider is disabled for this tenant but kept in the chain */
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** Optional override of the global API endpoint */
  endpointOverride: text("endpoint_override"),
  /** Optional override API key — if absent, falls back to env-var lookup */
  apiKeyOverride: text("api_key_override"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// -------------------------------------------------------------------------
// TypeScript types
// ---------------------------------------------------------------------------
export type TenantProviderConfigRow = typeof tenantProviderConfigs.$inferSelect;
export type NewTenantProviderConfigRow = typeof tenantProviderConfigs.$inferInsert;

// ---------------------------------------------------------------------------
// TypeScript types (existing)
// ---------------------------------------------------------------------------
export type PolicyDecisionRow = typeof policyDecisions.$inferSelect;
export type NewPolicyDecisionRow = typeof policyDecisions.$inferInsert;
export type ScannerFindingRow = typeof scannerFindings.$inferSelect;
export type NewScannerFindingRow = typeof scannerFindings.$inferInsert;
export type ApprovalQueueRow = typeof approvalQueue.$inferSelect;
export type NewApprovalQueueRow = typeof approvalQueue.$inferInsert;
export type ActionLogRow = typeof actionLog.$inferSelect;
export type NewActionLogRow = typeof actionLog.$inferInsert;
export type TenantWebhookRow = typeof tenantWebhooks.$inferSelect;
export type NewTenantWebhookRow = typeof tenantWebhooks.$inferInsert;
export type TenantRulePackAssignmentRow = typeof tenantRulePackAssignments.$inferSelect;
export type NewTenantRulePackAssignmentRow = typeof tenantRulePackAssignments.$inferInsert;
export type PolicyRuleRow = typeof policyRules.$inferSelect;
export type NewPolicyRuleRow = typeof policyRules.$inferInsert;
export type PolicyViolationRow = typeof policyViolations.$inferSelect;
export type NewPolicyViolationRow = typeof policyViolations.$inferInsert;
export type TenantRow = typeof tenants.$inferSelect;
export type NewTenantRow = typeof tenants.$inferInsert;
export type DispatchQueueRow = typeof dispatchQueue.$inferSelect;
export type NewDispatchQueueRow = typeof dispatchQueue.$inferInsert;
export type EvidenceReportRow = typeof evidenceReports.$inferSelect;
export type NewEvidenceReportRow = typeof evidenceReports.$inferInsert;

// ---------------------------------------------------------------------------
// daemon_paused_state
// Singleton table — one row (id=1) controls substrate-wide pause.
// While paused: dispatch returns 503, policy.check returns 503 with
// reason="substrate_paused", and cron ticks are skipped.
// ---------------------------------------------------------------------------
export const daemonPausedState = sqliteTable("daemon_paused_state", {
  id: integer("id").primaryKey().notNull(), // always 1
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  pausedAt: text("paused_at"), // ISO datetime
  pausedBy: text("paused_by"), // agent/user who paused
  reason: text("reason"), // free-text reason
});

export type DaemonPausedStateRow = typeof daemonPausedState.$inferSelect;
export type NewDaemonPausedStateRow = typeof daemonPausedState.$inferInsert;

// ---------------------------------------------------------------------------
// scope_violations
// Append-only log of scope-guard revert events.
// Written by scope-guard daemon via POST /api/admin/scope-violations.
// Read via GET /api/admin/scope-violations for health metrics.
// ---------------------------------------------------------------------------
export const scopeViolations = sqliteTable("scope_violations", {
  id: text("id").primaryKey(), // UUID
  revertedFromCommit: text("reverted_from_commit").notNull(),
  agentRunId: text("agent_run_id"),
  agentId: text("agent_id"),
  agentRole: text("agent_role"),
  files: text("files").notNull(), // JSON array
  reason: text("reason"),
  revertedAt: text("reverted_at").notNull(), // ISO datetime
  createdAt: text("created_at").notNull(),
});

export type ScopeViolationRow = typeof scopeViolations.$inferSelect;
export type NewScopeViolationRow = typeof scopeViolations.$inferInsert;
// ---------------------------------------------------------------------------
// lane_assignments — append-only trace of every auto-assign pipeline run.
// Written by POST /api/issues/auto-assign; resolved when issue → done/closed.
// ---------------------------------------------------------------------------
export const laneAssignments = sqliteTable("lane_assignments", {
  id: text("id").primaryKey(), // UUID
  issueId: text("issue_id").notNull(),
  tenantId: text("tenant_id").notNull(),

  // Input
  issueDescription: text("issue_description").notNull(),
  extractedPaths: text("extracted_paths").notNull().default("[]"), // JSON string

  // Lane match result
  matchedRole: text("matched_role"),
  laneMatchReason: text("lane_match_reason").notNull(),
  ambiguous: integer("ambiguous", { mode: "boolean" }).notNull().default(false),
  triage: integer("triage", { mode: "boolean" }).notNull().default(false),

  // Assignment
  assignedAgentId: text("assigned_agent_id"),
  assignedAt: text("assigned_at"), // ISO datetime

  // Resolution (filled in when issue done/closed/escalated)
  resolvedAt: text("resolved_at"), // ISO datetime
  resolution: text("resolution", {
    enum: ["completed", "closed", "escalated"],
  }),

  // Timestamps
  createdAt: text("created_at").notNull(), // ISO datetime
});

export type LaneAssignmentRow = typeof laneAssignments.$inferSelect;
export type NewLaneAssignmentRow = typeof laneAssignments.$inferInsert;

// ---------------------------------------------------------------------------
// compat_proxy_events
// Append-only trace of legacy API calls forwarded through agentos-d during
// the execution transition window.
// ---------------------------------------------------------------------------
export const compatProxyEvents = sqliteTable("compat_proxy_events", {
  id: text("id").primaryKey(),
  method: text("method").notNull(),
  path: text("path").notNull(),
  statusCode: integer("status_code"),
  requestHash: text("request_hash").notNull(),
  responseHash: text("response_hash"),
  requestBytes: integer("request_bytes").notNull().default(0),
  responseBytes: integer("response_bytes").notNull().default(0),
  runId: text("run_id"),
  forwardedTo: text("forwarded_to").notNull(),
  error: text("error"),
  createdAt: text("created_at").notNull(),
});

export type CompatProxyEventRow = typeof compatProxyEvents.$inferSelect;
export type NewCompatProxyEventRow = typeof compatProxyEvents.$inferInsert;

// ---------------------------------------------------------------------------
// episodes
// Persistent record of one closed session/work-unit. Holds the LLM-generated
// summary, an importance score, and an embedding of the summary for hybrid
// retrieval (paired with episodes_fts FTS5 virtual table — created in
// migration 0024 but not exposed via Drizzle).
// ---------------------------------------------------------------------------
export const episodes = sqliteTable("episodes", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  agentId: text("agent_id"),
  sessionId: text("session_id"),

  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at").notNull(),
  durationSec: integer("duration_sec").notNull(),

  role: text("role"),
  taskType: text("task_type"),
  outcome: text("outcome", {
    enum: ["success", "failure", "blocked"],
  }),

  summary: text("summary").notNull(),
  embedding: blob("embedding"),
  embeddingModel: text("embedding_model"),

  importance: integer("importance").notNull().default(1),
  lifecycle: text("lifecycle", {
    enum: ["active", "archived", "invalidated"],
  })
    .notNull()
    .default("active"),

  createdAt: text("created_at").notNull(),
});

export type EpisodeRow = typeof episodes.$inferSelect;
export type NewEpisodeRow = typeof episodes.$inferInsert;

// ---------------------------------------------------------------------------
// insights
// Atomic, frame-typed extracted facts from episodes (or directly-posted
// feedback). Frame types: preference, fact, plan, constraint, feedback,
// error_pattern. Paired with insights_fts FTS5 virtual table — created in
// migration 0025 but not exposed via Drizzle.
// ---------------------------------------------------------------------------
export const insights = sqliteTable("insights", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  episodeId: text("episode_id"),

  frameType: text("frame_type", {
    enum: [
      "preference",
      "fact",
      "plan",
      "constraint",
      "feedback",
      "error_pattern",
    ],
  }).notNull(),
  subject: text("subject"),
  content: text("content").notNull(),

  embedding: blob("embedding"),
  embeddingModel: text("embedding_model"),

  importance: integer("importance").notNull().default(1),
  source: text("source", {
    enum: ["agent_reflection", "user_correction", "task_outcome", "manual"],
  }).notNull(),
  validated: integer("validated").notNull().default(0),
  lifecycle: text("lifecycle", {
    enum: ["active", "archived", "invalidated"],
  })
    .notNull()
    .default("active"),

  createdAt: text("created_at").notNull(),
});

export type InsightRow = typeof insights.$inferSelect;
export type NewInsightRow = typeof insights.$inferInsert;
