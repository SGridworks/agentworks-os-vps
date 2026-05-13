import { randomUUID } from "node:crypto";
import { Router, type NextFunction } from "express";
import { z } from "zod";
import type { Config } from "../config.js";
import { getSqlite } from "../db/index.js";
import { EmbedClient } from "../services/embed-client.js";
import { maybeRecordEpisodeFromRun } from "../services/episode-from-run.js";
import { getInsightExtractor, type InsightExtractor } from "../services/insight-extractor.js";
import { resolveDefaultInstructionsPath } from "../services/instructions-resolver.js";

let _embedClientForRuntimeState: EmbedClient | null = null;
function getRuntimeEmbedClient(): EmbedClient {
  if (_embedClientForRuntimeState) return _embedClientForRuntimeState;
  _embedClientForRuntimeState = new EmbedClient();
  return _embedClientForRuntimeState;
}

let _insightExtractor: InsightExtractor | null = null;
function getRuntimeInsightExtractor(): InsightExtractor {
  if (_insightExtractor) return _insightExtractor;
  _insightExtractor = getInsightExtractor();
  return _insightExtractor;
}

/** Test-only escape hatch — vitest swaps in a fake EmbedClient. */
export function _setExecutionEmbedClientForTesting(client: EmbedClient | null): void {
  _embedClientForRuntimeState = client;
}

/** Test-only escape hatch — vitest swaps in a fake/null extractor. */
export function _setExecutionInsightExtractorForTesting(x: InsightExtractor | null): void {
  _insightExtractor = x;
}

function deriveCompanySlugBase(name: string, slug: string | null): string {
  const source = (name || slug || "").trim();
  if (!source) return "ISS";
  const words = source
    .split(/[\s_-]+/)
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ""))
    .filter((w) => w.length > 0);
  if (words.length >= 2) {
    const init = words.map((w) => w[0]!.toUpperCase()).join("").slice(0, 4);
    if (init.length >= 2) return init;
  }
  return source.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 3) || "ISS";
}

function allocateCompanySlugPrefix(
  sqlite: ReturnType<typeof getSqlite>,
  name: string,
  slug: string | null
): string {
  const base = deriveCompanySlugBase(name, slug);
  let candidate = base;
  let i = 2;
  while (
    sqlite
      .prepare("SELECT 1 FROM execution_companies WHERE slug_prefix = ?")
      .get(candidate)
  ) {
    candidate = `${base}${i++}`;
  }
  return candidate;
}

const IdSchema = z.string().uuid();
const JsonObjectSchema = z.record(z.unknown()).default({});

const CreateCompanySchema = z.object({
  tenantId: IdSchema,
  name: z.string().min(1).max(180),
  slug: z.string().min(1).max(180).optional(),
  metadata: JsonObjectSchema.optional(),
});

const CreateProjectSchema = z.object({
  tenantId: IdSchema,
  name: z.string().min(1).max(180),
  status: z.enum(["active", "paused", "completed", "archived"]).optional(),
  metadata: JsonObjectSchema.optional(),
});

// Validate the nested shape callers actually use today. Unknown keys are
// preserved (passthrough) so future config keys don't require a schema bump,
// but the structured columns we copy out at insert time are constrained:
//   - adapterType non-empty when present
//   - adapterConfig.model non-empty when present
//   - heartbeat.intervalSec finite int >= 0
//   - heartbeat.wakeOnDemand strictly boolean
const AgentConfigSchema = z
  .object({
    adapterType: z.string().min(1).max(120).optional(),
    model: z.string().min(1).max(180).optional(),
    instructionsPath: z.string().min(1).max(500).optional(),
    capabilities: z.string().max(2000).optional(),
    adapterConfig: z
      .object({
        model: z.string().min(1).max(180).optional(),
      })
      .passthrough()
      .optional(),
    runtimeConfig: z
      .object({
        heartbeat: z
          .object({
            intervalSec: z.number().int().min(0).max(86400).optional(),
            wakeOnDemand: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const CreateAgentSchema = z.object({
  tenantId: IdSchema,
  companyId: IdSchema.optional(),
  name: z.string().min(1).max(180),
  role: z.string().min(1).max(120).optional(),
  status: z.enum(["active", "paused", "retired"]).optional(),
  config: AgentConfigSchema.optional(),
});

const IssueStatusSchema = z.enum(["todo", "in_progress", "blocked", "review", "done", "closed"]);
const IssuePrioritySchema = z.enum(["critical", "high", "medium", "low"]);

const CreateIssueSchema = z.object({
  tenantId: IdSchema,
  projectId: IdSchema,
  title: z.string().min(1).max(240),
  description: z.string().max(20000).optional(),
  priority: IssuePrioritySchema.optional(),
  assigneeAgentId: IdSchema.nullable().optional(),
  parentIssueId: IdSchema.nullable().optional(),
  blockedOn: z.array(IdSchema).optional(),
  metadata: JsonObjectSchema.optional(),
});

const UpdateIssueSchema = z.object({
  tenantId: IdSchema.optional(),
  title: z.string().min(1).max(240).optional(),
  description: z.string().max(20000).nullable().optional(),
  status: IssueStatusSchema.optional(),
  priority: IssuePrioritySchema.optional(),
  assigneeAgentId: IdSchema.nullable().optional(),
  blockedOn: z.array(IdSchema).optional(),
  metadata: JsonObjectSchema.optional(),
  comment: z.string().min(1).max(20000).optional(),
});

const CommentSchema = z.object({
  tenantId: IdSchema.optional(),
  authorId: z.string().max(180).optional(),
  authorLabel: z.string().min(1).max(180).default("Operator"),
  body: z.string().min(1).max(20000),
});

const RunSchema = z.object({
  tenantId: IdSchema,
  companyId: IdSchema,
  projectId: IdSchema.optional(),
  issueId: IdSchema.optional(),
  agentId: IdSchema.optional(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]).optional(),
  summary: z.string().max(4000).optional(),
});

const RunEventSchema = z.object({
  tenantId: IdSchema,
  eventType: z.string().min(1).max(120),
  message: z.string().max(4000).optional(),
  data: JsonObjectSchema.optional(),
});

const WakeupSchema = z.object({
  source: z.string().max(120).optional(),
  triggerDetail: z.string().max(120).optional(),
  reason: z.string().max(4000).optional(),
  payload: JsonObjectSchema.optional(),
  idempotencyKey: z.string().max(240).optional(),
});

const ListAgentsQuerySchema = z.object({
  tenantId: IdSchema,
  companyId: IdSchema.optional(),
  status: z.enum(["active", "paused", "retired"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const ResumeAgentSchema = z
  .object({
    clearLastError: z.boolean().optional(),
    actorKind: z.enum(["operator", "agent", "system", "import"]).optional(),
    actorId: z.string().max(180).optional(),
    source: z.string().max(120).optional(),
  })
  .partial()
  .default({});

const UpdateAgentSchema = z.object({
  name: z.string().min(1).max(180).optional(),
  role: z.string().min(1).max(120).nullable().optional(),
  status: z.enum(["active", "paused", "retired"]).optional(),
  adapterType: z.string().max(120).nullable().optional(),
  model: z.string().max(180).nullable().optional(),
  instructionsPath: z.string().max(500).nullable().optional(),
  capabilities: z.string().max(2000).nullable().optional(),
  heartbeatIntervalSec: z.number().int().min(0).max(86400).nullable().optional(),
  wakeOnDemand: z.boolean().nullable().optional(),
  pauseReason: z.string().max(2000).nullable().optional(),
  reportsTo: z.string().nullable().optional(),
  budgetMonthlyCents: z.number().int().min(0).max(1_000_000_000).optional(),
  config: AgentConfigSchema.optional(),
  // Audit context — clients can identify themselves
  actorKind: z.enum(["operator", "agent", "system", "import"]).optional(),
  actorId: z.string().max(180).optional(),
  source: z.string().max(120).optional(),
});

const RuntimeStateSchema = z.object({
  sessionId: z.string().max(240).nullable().optional(),
  lastRunId: z.string().nullable().optional(),
  lastRunStatus: z.string().max(60).nullable().optional(),
  lastRunAt: z.string().max(40).nullable().optional(),
  totalInputTokens: z.number().int().min(0).optional(),
  totalOutputTokens: z.number().int().min(0).optional(),
  totalCachedInputTokens: z.number().int().min(0).optional(),
  totalCostCents: z.number().int().min(0).optional(),
  lastError: z.string().max(4000).nullable().optional(),
  lastErrorAt: z.string().max(40).nullable().optional(),
  /** When true, monotonic counters are added (default). When false, fields replace. */
  accumulate: z.boolean().optional(),
});

// Status vocab matches runtime-state: running | succeeded | failed | blocked.
// "open" / "closed" remain accepted as legacy aliases for "running" / "succeeded"
// so older clients don't break; the upsert layer normalizes them to the runtime
// vocab before persisting.
const TaskSessionStatusSchema = z
  .enum(["running", "succeeded", "failed", "blocked", "open", "closed"])
  .transform((v) => (v === "open" ? "running" : v === "closed" ? "succeeded" : v));

const TaskSessionUpsertSchema = z.object({
  taskKey: z.string().min(1).max(240),
  issueId: IdSchema.nullable().optional(),
  adapterType: z.string().max(120).nullable().optional(),
  sessionParams: JsonObjectSchema.optional(),
  sessionDisplayId: z.string().max(240).nullable().optional(),
  lastRunId: z.string().nullable().optional(),
  lastError: z.string().max(4000).nullable().optional(),
  status: TaskSessionStatusSchema.optional(),
});

const CostEventSchema = z.object({
  tenantId: IdSchema,
  runId: IdSchema.optional(),
  issueId: IdSchema.optional(),
  provider: z.string().max(120).optional(),
  model: z.string().max(120).optional(),
  units: z.number().nonnegative().optional(),
  amountUsd: z.number().nonnegative().optional(),
  metadata: JsonObjectSchema.optional(),
});

const WebhookIntakeSchema = z.object({
  tenantId: IdSchema,
  eventType: z.string().min(1).max(120).default("automation.webhook"),
}).passthrough();

interface IssueView {
  id: string;
  tenantId: string;
  companyId: string;
  projectId: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  parentIssueId: string | null;
  blockedOn: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  executionRunId: string | null;
  latestCommentAt: string | null;
}

// Subquery columns appended to execution_issues SELECTs so ProcessWatcher
// checks (premature_done, auto_commit_close_mismatch, blocked_ticket_stuck)
// see the latest run + comment activity per issue.
const ISSUE_LIST_PROJECTION = `
  i.*,
  (SELECT id FROM execution_runs WHERE issue_id = i.id ORDER BY created_at DESC LIMIT 1) AS latest_run_id,
  (SELECT MAX(created_at) FROM execution_issue_comments WHERE issue_id = i.id) AS latest_comment_at
`;

export function createExecutionRouter(_config: Config): Router {
  const router = Router();

  router.get("/companies", (req, res) => {
    const tenantId = String(req.query.tenantId ?? "");
    if (!IdSchema.safeParse(tenantId).success) return invalid(res, "tenantId");
    const rows = getSqlite()
      .prepare("SELECT * FROM execution_companies WHERE tenant_id = ? ORDER BY created_at DESC")
      .all(tenantId);
    res.json({ items: rows.map(mapCompany) });
  });

  router.post("/companies", (req, res) => {
    const parsed = CreateCompanySchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error.flatten());
    const now = new Date().toISOString();
    const sqlite = getSqlite();
    const slugPrefix = allocateCompanySlugPrefix(sqlite, parsed.data.name, parsed.data.slug ?? null);
    const row = {
      id: randomUUID(),
      tenantId: parsed.data.tenantId,
      name: parsed.data.name,
      slug: parsed.data.slug ?? null,
      slugPrefix,
      status: "active",
      metadata: parsed.data.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    sqlite.prepare(`
      INSERT INTO execution_companies
      (id, tenant_id, name, slug, slug_prefix, status, metadata_json, created_at, updated_at)
      VALUES (@id, @tenantId, @name, @slug, @slugPrefix, @status, @metadataJson, @createdAt, @updatedAt)
    `).run(bindJson(row));
    sqlite
      .prepare("INSERT OR IGNORE INTO execution_company_issue_seq (company_id, next_seq) VALUES (?, 1)")
      .run(row.id);
    res.status(201).json(row);
  });

  router.post("/companies/:companyId/projects", (req, res, next: NextFunction) => {
    const companyId = req.params.companyId;
    if (!IdSchema.safeParse(companyId).success) return next();
    const parsed = CreateProjectSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error.flatten());
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      tenantId: parsed.data.tenantId,
      companyId,
      name: parsed.data.name,
      status: parsed.data.status ?? "active",
      metadata: parsed.data.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    getSqlite().prepare(`
      INSERT INTO execution_projects
      (id, tenant_id, company_id, name, status, metadata_json, created_at, updated_at)
      VALUES (@id, @tenantId, @companyId, @name, @status, @metadataJson, @createdAt, @updatedAt)
    `).run(bindJson(row));
    res.status(201).json(row);
  });

  router.get("/companies/:companyId/projects", (req, res, next: NextFunction) => {
    const companyId = req.params.companyId;
    if (!IdSchema.safeParse(companyId).success) return next();
    const rows = getSqlite()
      .prepare("SELECT * FROM execution_projects WHERE company_id = ? ORDER BY created_at DESC")
      .all(companyId);
    res.json({ items: rows.map(mapProject) });
  });

  router.get("/companies/:companyId/agents", (req, res, next: NextFunction) => {
    const companyId = req.params.companyId;
    if (!IdSchema.safeParse(companyId).success) return next();
    const rows = getSqlite()
      .prepare("SELECT * FROM execution_agents WHERE company_id = ? ORDER BY name ASC")
      .all(companyId);
    res.json({ items: rows.map(mapAgent) });
  });

  router.get("/companies/:companyId/issues", (req, res, next: NextFunction) => {
    const companyId = req.params.companyId;
    if (!IdSchema.safeParse(companyId).success) return next();
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const limit = Number(req.query.limit ?? 300);
    const sql = status
      ? `SELECT ${ISSUE_LIST_PROJECTION} FROM execution_issues i WHERE i.company_id = ? AND i.status = ? ORDER BY i.created_at DESC LIMIT ?`
      : `SELECT ${ISSUE_LIST_PROJECTION} FROM execution_issues i WHERE i.company_id = ? ORDER BY i.created_at DESC LIMIT ?`;
    const args = status ? [companyId, status, safeLimit(limit)] : [companyId, safeLimit(limit)];
    const rows = getSqlite().prepare(sql).all(...args);
    res.json({ items: rows.map(mapIssue) });
  });

  router.post("/companies/:companyId/issues", (req, res, next: NextFunction) => {
    const companyId = req.params.companyId;
    if (!IdSchema.safeParse(companyId).success) return next();
    const parsed = CreateIssueSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error.flatten());
    const now = new Date().toISOString();
    const sqlite = getSqlite();
    const company = sqlite
      .prepare("SELECT slug_prefix FROM execution_companies WHERE id = ?")
      .get(companyId) as { slug_prefix: string | null } | undefined;
    let identifier: string | null = null;
    if (company?.slug_prefix) {
      sqlite
        .prepare(
          "INSERT OR IGNORE INTO execution_company_issue_seq (company_id, next_seq) VALUES (?, 1)"
        )
        .run(companyId);
      const seqRow = sqlite
        .prepare("SELECT next_seq FROM execution_company_issue_seq WHERE company_id = ?")
        .get(companyId) as { next_seq: number };
      identifier = `${company.slug_prefix}-${seqRow.next_seq}`;
      sqlite
        .prepare(
          "UPDATE execution_company_issue_seq SET next_seq = next_seq + 1 WHERE company_id = ?"
        )
        .run(companyId);
    }
    const row = {
      id: randomUUID(),
      tenantId: parsed.data.tenantId,
      companyId,
      projectId: parsed.data.projectId,
      identifier,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      status: "todo",
      priority: parsed.data.priority ?? "medium",
      assigneeAgentId: parsed.data.assigneeAgentId ?? null,
      parentIssueId: parsed.data.parentIssueId ?? null,
      blockedOn: parsed.data.blockedOn ?? [],
      metadata: parsed.data.metadata ?? {},
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    getSqlite().prepare(`
      INSERT INTO execution_issues
      (id, tenant_id, company_id, project_id, identifier, title, description, status,
       priority, assignee_agent_id, parent_issue_id, blocked_on_json, metadata_json,
       created_at, updated_at, completed_at)
      VALUES (@id, @tenantId, @companyId, @projectId, @identifier, @title, @description,
       @status, @priority, @assigneeAgentId, @parentIssueId, @blockedOnJson,
       @metadataJson, @createdAt, @updatedAt, @completedAt)
    `).run(bindJson(row));
    res.status(201).json(row);
  });

  router.patch("/issues/:issueId", (req, res, next: NextFunction) => {
    const issueId = req.params.issueId;
    if (!IdSchema.safeParse(issueId).success) return next();
    const parsed = UpdateIssueSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error.flatten());
    const existing = getSqlite().prepare("SELECT * FROM execution_issues WHERE id = ?").get(issueId);
    if (!existing) return res.status(404).json({ error: "not_found" });
    const current = mapIssue(existing);
    const status = parsed.data.status ?? current.status;
    const row = {
      id: issueId,
      title: parsed.data.title ?? current.title,
      description: parsed.data.description === undefined ? current.description : parsed.data.description,
      status,
      priority: parsed.data.priority ?? current.priority,
      assigneeAgentId: parsed.data.assigneeAgentId === undefined ? current.assigneeAgentId : parsed.data.assigneeAgentId,
      blockedOn: parsed.data.blockedOn ?? current.blockedOn,
      metadata: parsed.data.metadata ?? current.metadata,
      updatedAt: new Date().toISOString(),
      completedAt: ["done", "closed"].includes(status) ? new Date().toISOString() : null,
    };
    getSqlite().prepare(`
      UPDATE execution_issues SET title = @title, description = @description,
      status = @status, priority = @priority, assignee_agent_id = @assigneeAgentId,
      blocked_on_json = @blockedOnJson, metadata_json = @metadataJson,
      updated_at = @updatedAt, completed_at = @completedAt WHERE id = @id
    `).run(bindJson(row));
    if (parsed.data.comment) {
      insertComment({
        tenantId: current.tenantId,
        issueId,
        authorLabel: "Coordinator",
        body: parsed.data.comment,
      });
    }
    const transitions: Record<string, unknown> = {};
    if (parsed.data.status && parsed.data.status !== current.status) {
      transitions.status = { from: current.status, to: parsed.data.status };
    }
    if (
      parsed.data.assigneeAgentId !== undefined &&
      parsed.data.assigneeAgentId !== current.assigneeAgentId
    ) {
      transitions.assigneeAgentId = {
        from: current.assigneeAgentId,
        to: parsed.data.assigneeAgentId,
      };
    }
    if (parsed.data.priority && parsed.data.priority !== current.priority) {
      transitions.priority = { from: current.priority, to: parsed.data.priority };
    }
    if (Object.keys(transitions).length > 0) {
      appendExecutionAudit({
        tenantId: current.tenantId,
        actorId:
          (parsed.data.assigneeAgentId === undefined ? current.assigneeAgentId : parsed.data.assigneeAgentId) ??
          issueId,
        actorType: "system",
        actorLabel: "Coordinator",
        actionKind: "issue.update",
        payload: { issueId, identifier: current.identifier, ...transitions },
        projectRefs: [current.projectId],
      });
    }
    const updated = getSqlite().prepare("SELECT * FROM execution_issues WHERE id = ?").get(issueId);
    res.json(mapIssue(updated));
  });

  router.post("/issues/:issueId/comments", (req, res, next: NextFunction) => {
    const issueId = resolveIssueIdParam(req.params.issueId);
    if (!issueId) return next();
    const parsed = CommentSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error.flatten());
    const issue = getSqlite().prepare("SELECT tenant_id FROM execution_issues WHERE id = ?").get(issueId) as
      | { tenant_id: string }
      | undefined;
    if (!issue) return res.status(404).json({ error: "not_found" });
    const row = {
      id: randomUUID(),
      issueId,
      ...parsed.data,
      tenantId: parsed.data.tenantId ?? issue.tenant_id,
      createdAt: new Date().toISOString(),
    };
    getSqlite().prepare(`
      INSERT INTO execution_issue_comments
      (id, tenant_id, issue_id, author_id, author_label, body, created_at)
      VALUES (@id, @tenantId, @issueId, @authorId, @authorLabel, @body, @createdAt)
    `).run({ ...row, authorId: row.authorId ?? null });
    appendExecutionAudit({
      tenantId: row.tenantId,
      actorId: row.authorId ?? issueId,
      actorType: row.authorId ? "agent" : "human",
      actorLabel: row.authorLabel,
      actionKind: "issue.comment",
      payload: { issueId, commentId: row.id, bodyPreview: row.body.slice(0, 240) },
    });
    res.status(201).json(row);
  });

  router.get("/issues/:issueId/comments", (req, res, next: NextFunction) => {
    const issueId = resolveIssueIdParam(req.params.issueId);
    if (!issueId) return next();
    const limit = Number(req.query.limit ?? 50);
    const rows = getSqlite()
      .prepare(`
        SELECT * FROM execution_issue_comments
        WHERE issue_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(issueId, Number.isFinite(limit) ? limit : 50);
    res.json({ items: rows.map(mapComment) });
  });

  router.get("/agents", (req, res) => {
    const parsed = ListAgentsQuerySchema.safeParse(req.query);
    if (!parsed.success) return badRequest(res, parsed.error.flatten());
    const { tenantId, companyId, status, limit } = parsed.data;
    const sqlite = getSqlite();
    const filters: string[] = ["tenant_id = ?"];
    const args: Array<string | number> = [tenantId];
    if (companyId) {
      filters.push("company_id = ?");
      args.push(companyId);
    }
    if (status) {
      filters.push("status = ?");
      args.push(status);
    }
    args.push(safeLimit(limit ?? 100));
    const rows = sqlite
      .prepare(
        `SELECT * FROM execution_agents WHERE ${filters.join(" AND ")} ORDER BY name ASC LIMIT ?`
      )
      .all(...args);
    res.json({ items: rows.map(mapAgent) });
  });

  router.post("/agents", (req, res) => {
    const parsed = CreateAgentSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error.flatten());
    const now = new Date().toISOString();
    const config = (parsed.data.config ?? {}) as Record<string, unknown>;
    const adapterCfg = (config.adapterConfig ?? {}) as Record<string, unknown>;
    const runtimeCfg = (config.runtimeConfig ?? {}) as Record<string, unknown>;
    const heartbeat = (runtimeCfg.heartbeat ?? {}) as Record<string, unknown>;
    const adapterType =
      typeof config.adapterType === "string" ? config.adapterType : null;
    const model =
      typeof adapterCfg.model === "string"
        ? adapterCfg.model
        : typeof config.model === "string"
        ? config.model
        : null;
    const explicitInstructionsPath =
      typeof config.instructionsPath === "string" ? config.instructionsPath : null;
    const instructionsPath =
      explicitInstructionsPath ??
      resolveDefaultInstructionsPath(parsed.data.name, parsed.data.role ?? null, _config.agentsRoot);
    const capabilities =
      typeof config.capabilities === "string" ? config.capabilities : null;
    const heartbeatIntervalSec =
      typeof heartbeat.intervalSec === "number" ? heartbeat.intervalSec : null;
    const wakeOnDemand =
      heartbeat.wakeOnDemand === true ? 1 : heartbeat.wakeOnDemand === false ? 0 : null;

    const row = {
      id: randomUUID(),
      tenantId: parsed.data.tenantId,
      companyId: parsed.data.companyId ?? null,
      name: parsed.data.name,
      role: parsed.data.role ?? null,
      status: parsed.data.status ?? "active",
      adapterType,
      model,
      instructionsPath,
      capabilities,
      heartbeatIntervalSec,
      wakeOnDemand,
      configJson: JSON.stringify(config),
      createdAt: now,
      updatedAt: now,
    };
    getSqlite()
      .prepare(
        `INSERT INTO execution_agents
         (id, tenant_id, company_id, name, role, status,
          adapter_type, model, instructions_path, capabilities,
          heartbeat_interval_sec, wake_on_demand,
          config_json, created_at, updated_at)
         VALUES (@id, @tenantId, @companyId, @name, @role, @status,
          @adapterType, @model, @instructionsPath, @capabilities,
          @heartbeatIntervalSec, @wakeOnDemand,
          @configJson, @createdAt, @updatedAt)`
      )
      .run(row);
    const fresh = getSqlite()
      .prepare("SELECT * FROM execution_agents WHERE id = ?")
      .get(row.id);
    res.status(201).json(mapAgent(fresh));
  });

  router.get("/agents/:agentId", (req, res, next: NextFunction) => {
    const agentId = req.params.agentId;
    if (!IdSchema.safeParse(agentId).success) return next();
    const row = getSqlite().prepare("SELECT * FROM execution_agents WHERE id = ?").get(agentId);
    if (!row) return res.status(404).json({ error: "not_found" });
    res.json(mapAgent(row));
  });

  router.patch("/agents/:agentId", (req, res, next: NextFunction) => {
    const agentId = req.params.agentId;
    if (!IdSchema.safeParse(agentId).success) return next();
    const parsed = UpdateAgentSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error.flatten());
    const sqlite = getSqlite();
    const existing = sqlite.prepare("SELECT * FROM execution_agents WHERE id = ?").get(agentId) as any;
    if (!existing) return res.status(404).json({ error: "not_found" });

    const d = parsed.data;
    const now = new Date().toISOString();
    if (d.reportsTo) {
      // reports_to must be a real agent id; reject self-reference
      if (d.reportsTo === agentId) return badRequest(res, { reportsTo: ["cannot self-reference"] });
      const exists = sqlite
        .prepare("SELECT 1 FROM execution_agents WHERE id = ?")
        .get(d.reportsTo);
      if (!exists) return badRequest(res, { reportsTo: ["unknown agent id"] });
    }

    const nextName = d.name ?? existing.name;
    const nextRole = d.role !== undefined ? d.role : existing.role;
    let nextInstructionsPath =
      d.instructionsPath !== undefined ? d.instructionsPath : existing.instructions_path;
    // If name/role changed and the path is empty, try to resolve from disk.
    if (
      nextInstructionsPath == null &&
      ((d.name !== undefined && d.name !== existing.name) ||
        (d.role !== undefined && d.role !== existing.role))
    ) {
      const resolved = resolveDefaultInstructionsPath(nextName, nextRole, _config.agentsRoot);
      if (resolved) nextInstructionsPath = resolved;
    }

    const upd: Record<string, unknown> = {
      id: agentId,
      updatedAt: now,
      name: nextName,
      role: nextRole,
      status: d.status ?? existing.status,
      adapterType: d.adapterType !== undefined ? d.adapterType : existing.adapter_type,
      model: d.model !== undefined ? d.model : existing.model,
      instructionsPath: nextInstructionsPath,
      capabilities: d.capabilities !== undefined ? d.capabilities : existing.capabilities,
      heartbeatIntervalSec:
        d.heartbeatIntervalSec !== undefined
          ? d.heartbeatIntervalSec
          : existing.heartbeat_interval_sec,
      wakeOnDemand:
        d.wakeOnDemand === true
          ? 1
          : d.wakeOnDemand === false
          ? 0
          : d.wakeOnDemand === null
          ? null
          : existing.wake_on_demand,
      pauseReason:
        d.pauseReason !== undefined ? d.pauseReason : existing.pause_reason,
      pausedAt:
        d.status === "paused"
          ? existing.paused_at ?? now
          : d.status
          ? null
          : existing.paused_at,
      reportsTo: d.reportsTo !== undefined ? d.reportsTo : existing.reports_to,
      budgetMonthlyCents:
        d.budgetMonthlyCents !== undefined
          ? d.budgetMonthlyCents
          : existing.budget_monthly_cents,
      configJson:
        d.config !== undefined ? JSON.stringify(d.config) : existing.config_json,
    };

    sqlite
      .prepare(
        `UPDATE execution_agents SET
          name = @name,
          role = @role,
          status = @status,
          adapter_type = @adapterType,
          model = @model,
          instructions_path = @instructionsPath,
          capabilities = @capabilities,
          heartbeat_interval_sec = @heartbeatIntervalSec,
          wake_on_demand = @wakeOnDemand,
          pause_reason = @pauseReason,
          paused_at = @pausedAt,
          reports_to = @reportsTo,
          budget_monthly_cents = @budgetMonthlyCents,
          config_json = @configJson,
          updated_at = @updatedAt
        WHERE id = @id`
      )
      .run(upd);

    recordConfigRevision(existing, upd, {
      actorKind: d.actorKind ?? "operator",
      actorId: d.actorId ?? null,
      source: d.source ?? null,
    });

    const fresh = sqlite.prepare("SELECT * FROM execution_agents WHERE id = ?").get(agentId);
    res.json(mapAgent(fresh));
  });

  router.get("/agents/:agentId/revisions", (req, res, next: NextFunction) => {
    const agentId = req.params.agentId;
    if (!IdSchema.safeParse(agentId).success) return next();
    const limit = safeLimit(Number(req.query.limit ?? 50));
    const rows = getSqlite()
      .prepare(
        "SELECT * FROM execution_agent_config_revisions WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?"
      )
      .all(agentId, limit);
    res.json({ items: rows.map(mapRevision) });
  });

  // --- runtime state ---
  router.get("/agents/:agentId/runtime-state", (req, res, next: NextFunction) => {
    const agentId = req.params.agentId;
    if (!IdSchema.safeParse(agentId).success) return next();
    const row = getSqlite()
      .prepare("SELECT * FROM execution_agent_runtime_state WHERE agent_id = ?")
      .get(agentId);
    res.json(row ? mapRuntimeState(row) : null);
  });

  router.post("/agents/:agentId/runtime-state", (req, res, next: NextFunction) => {
    const agentId = req.params.agentId;
    if (!IdSchema.safeParse(agentId).success) return next();
    const parsed = RuntimeStateSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error.flatten());
    const sqlite = getSqlite();
    const agent = sqlite
      .prepare("SELECT id, tenant_id FROM execution_agents WHERE id = ?")
      .get(agentId) as { id: string; tenant_id: string } | undefined;
    if (!agent) return res.status(404).json({ error: "not_found" });

    // Snapshot prev status before the upsert so we can detect a transition
    // to a terminal state and persist an episode. Done synchronously so the
    // memory-arch hook fires off the same DB read path as the upsert.
    const before = sqlite
      .prepare("SELECT last_run_status FROM execution_agent_runtime_state WHERE agent_id = ?")
      .get(agentId) as { last_run_status: string | null } | undefined;
    const prevStatus = before?.last_run_status ?? null;

    const fresh = upsertRuntimeState(agent.tenant_id, agentId, parsed.data);
    // Stamp last_heartbeat_at on the agent — this is the natural ingress point
    sqlite
      .prepare("UPDATE execution_agents SET last_heartbeat_at = ? WHERE id = ?")
      .run(new Date().toISOString(), agentId);

    // Fire-and-forget episode write on terminal-status transition. We don't
    // block the runtime-state response on embedding latency; failures are
    // logged but not surfaced — the row would still be written with a NULL
    // embedding via recordEpisode's own fallback.
    const nextStatus = (fresh as { last_run_status: string | null }).last_run_status;
    const lastRunId = (fresh as { last_run_id: string | null }).last_run_id;
    // Many callers post runtime-state without ever creating a corresponding
    // execution_runs row (the runtime-state path is the heartbeat ingress;
    // POST /api/runs is the explicit-run ingress). The episode hook reads
    // execution_runs to assemble the session brief — so synthesize a minimal
    // row here when the lastRunId points nowhere. Without this, every
    // heartbeat-only agent silently fails to produce episodes.
    if (lastRunId) {
      const runExists = sqlite
        .prepare("SELECT 1 FROM execution_runs WHERE id = ?")
        .get(lastRunId);
      if (!runExists) {
        const agentRow = sqlite
          .prepare("SELECT company_id FROM execution_agents WHERE id = ?")
          .get(agentId) as { company_id: string | null } | undefined;
        if (agentRow?.company_id) {
          const nowIso = new Date().toISOString();
          sqlite
            .prepare(
              `INSERT INTO execution_runs
                (id, tenant_id, company_id, agent_id, status, started_at, ended_at, summary, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              lastRunId,
              agent.tenant_id,
              agentRow.company_id,
              agentId,
              nextStatus ?? "running",
              (parsed.data.lastRunAt ?? nowIso) as string,
              (parsed.data.lastRunAt ?? nowIso) as string,
              parsed.data.lastError ?? null,
              nowIso,
              nowIso,
            );
        }
      }
    }
    if (
      nextStatus &&
      prevStatus !== nextStatus &&
      ["succeeded", "failed", "cancelled", "blocked"].includes(nextStatus)
    ) {
      appendExecutionAudit({
        tenantId: agent.tenant_id,
        actorId: agentId,
        actorType: "agent",
        actorLabel: "Runtime",
        actionKind: `run.${nextStatus}`,
        payload: {
          lastRunId,
          lastRunAt: parsed.data.lastRunAt ?? null,
          prevStatus,
          nextStatus,
          lastError: parsed.data.lastError ?? null,
        },
      });
    }
    void maybeRecordEpisodeFromRun(sqlite, {
      prevStatus,
      nextStatus,
      lastRunId,
      agentId,
      embedClient: getRuntimeEmbedClient(),
      insightExtractor: getRuntimeInsightExtractor(),
    }).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("episode-write hook failed", { agentId, err: String(err) });
    });

    res.json(mapRuntimeState(fresh));
  });

  // --- task sessions ---
  router.get("/agents/:agentId/task-sessions", (req, res, next: NextFunction) => {
    const agentId = req.params.agentId;
    if (!IdSchema.safeParse(agentId).success) return next();
    const rows = getSqlite()
      .prepare(
        "SELECT * FROM execution_agent_task_sessions WHERE agent_id = ? ORDER BY updated_at DESC"
      )
      .all(agentId);
    res.json({ items: rows.map(mapTaskSession) });
  });

  router.post("/agents/:agentId/task-sessions", (req, res, next: NextFunction) => {
    const agentId = req.params.agentId;
    if (!IdSchema.safeParse(agentId).success) return next();
    const parsed = TaskSessionUpsertSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error.flatten());
    const sqlite = getSqlite();
    const agent = sqlite
      .prepare("SELECT id, tenant_id FROM execution_agents WHERE id = ?")
      .get(agentId) as { id: string; tenant_id: string } | undefined;
    if (!agent) return res.status(404).json({ error: "not_found" });
    const fresh = upsertTaskSession(agent.tenant_id, agentId, parsed.data);
    res.status(201).json(mapTaskSession(fresh));
  });

  router.post("/agents/:agentId/wakeup", (req, res, next: NextFunction) => {
    const agentId = req.params.agentId;
    if (!IdSchema.safeParse(agentId).success) return next();
    const parsed = WakeupSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error.flatten());
    const sqlite = getSqlite();
    const agent = sqlite.prepare("SELECT * FROM execution_agents WHERE id = ?").get(agentId) as
      | { tenant_id: string; status: string; pause_reason: string | null }
      | undefined;
    if (!agent) return res.status(404).json({ error: "not_found" });
    // Pause is a hard control: paused/retired agents must not enqueue dispatches.
    // Operators expect /resume (or PATCH status=active) before wakeups flow again.
    if (agent.status === "paused" || agent.status === "retired") {
      return res.status(409).json({
        error: agent.status === "paused" ? "agent_paused" : "agent_retired",
        agentStatus: agent.status,
        pauseReason: agent.pause_reason ?? null,
      });
    }

    const dispatch = insertWakeupDispatch(agent.tenant_id, agentId, parsed.data);
    const audit = recordWakeupAudit(agent.tenant_id, agentId, parsed.data, dispatch.id);
    if (!audit.coalesced) {
      appendExecutionAudit({
        tenantId: agent.tenant_id,
        actorId: agentId,
        actorType: "agent",
        actorLabel: parsed.data.source ?? "Wakeup",
        actionKind: "agent.wakeup",
        payload: {
          wakeupId: audit.id,
          dispatchId: dispatch.id,
          source: parsed.data.source ?? null,
          reason: parsed.data.reason ?? null,
        },
      });
    }
    res.status(202).json({ wakeupId: audit.id, dispatchId: dispatch.id, status: audit.coalesced ? "coalesced" : "queued" });
  });

  router.post("/agents/:agentId/resume", (req, res, next: NextFunction) => {
    const agentId = req.params.agentId;
    if (!IdSchema.safeParse(agentId).success) return next();
    const parsed = ResumeAgentSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(res, parsed.error.flatten());

    const sqlite = getSqlite();
    const existing = sqlite
      .prepare("SELECT * FROM execution_agents WHERE id = ?")
      .get(agentId) as any;
    if (!existing) return res.status(404).json({ error: "not_found" });

    const now = new Date().toISOString();
    const upd: Record<string, unknown> = {
      id: agentId,
      updatedAt: now,
      name: existing.name,
      role: existing.role,
      status: "active",
      adapterType: existing.adapter_type,
      model: existing.model,
      instructionsPath: existing.instructions_path,
      capabilities: existing.capabilities,
      heartbeatIntervalSec: existing.heartbeat_interval_sec,
      wakeOnDemand: existing.wake_on_demand,
      pauseReason: null,
      pausedAt: null,
      reportsTo: existing.reports_to,
      budgetMonthlyCents: existing.budget_monthly_cents,
      configJson: existing.config_json,
    };

    sqlite
      .prepare(
        `UPDATE execution_agents SET
          status = @status,
          pause_reason = @pauseReason,
          paused_at = @pausedAt,
          updated_at = @updatedAt
        WHERE id = @id`
      )
      .run(upd);

    if (parsed.data.clearLastError !== false) {
      sqlite
        .prepare(
          `UPDATE execution_agent_runtime_state
           SET last_error = NULL, last_error_at = NULL, updated_at = ?
           WHERE agent_id = ?`
        )
        .run(now, agentId);
    }

    recordConfigRevision(existing, upd, {
      actorKind: parsed.data.actorKind ?? "operator",
      actorId: parsed.data.actorId ?? null,
      source: parsed.data.source ?? "resume",
    });

    const fresh = sqlite.prepare("SELECT * FROM execution_agents WHERE id = ?").get(agentId);
    res.json(mapAgent(fresh));
  });

  router.get("/agents/:agentId/wakeups", (req, res, next: NextFunction) => {
    const agentId = req.params.agentId;
    if (!IdSchema.safeParse(agentId).success) return next();
    const limit = safeLimit(Number(req.query.limit ?? 50));
    const rows = getSqlite()
      .prepare(
        "SELECT * FROM execution_agent_wakeups WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?"
      )
      .all(agentId, limit);
    res.json({ items: rows.map(mapWakeup) });
  });

  router.post("/runs", (req, res) => {
    const parsed = RunSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error.flatten());
    const now = new Date().toISOString();
    const row = { id: randomUUID(), ...parsed.data, status: parsed.data.status ?? "queued", createdAt: now, updatedAt: now };
    getSqlite().prepare(`
      INSERT INTO execution_runs
      (id, tenant_id, company_id, project_id, issue_id, agent_id, status, summary, created_at, updated_at)
      VALUES (@id, @tenantId, @companyId, @projectId, @issueId, @agentId, @status, @summary, @createdAt, @updatedAt)
    `).run({ ...row, projectId: row.projectId ?? null, issueId: row.issueId ?? null, agentId: row.agentId ?? null, summary: row.summary ?? null });
    res.status(201).json(row);
  });

  router.get("/companies/:companyId/heartbeat-runs", (req, res, next: NextFunction) => {
    const companyId = req.params.companyId;
    if (!IdSchema.safeParse(companyId).success) return next();
    const limit = safeLimit(Number(req.query.limit ?? 50));
    const rows = getSqlite()
      .prepare("SELECT * FROM execution_runs WHERE company_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(companyId, limit);
    res.json({ items: rows.map(mapRun) });
  });

  router.post("/runs/:runId/events", (req, res) => {
    const runId = req.params.runId;
    if (!IdSchema.safeParse(runId).success) return invalid(res, "runId");
    const parsed = RunEventSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error.flatten());
    const row = { id: randomUUID(), runId, ...parsed.data, data: parsed.data.data ?? {}, createdAt: new Date().toISOString() };
    getSqlite().prepare(`
      INSERT INTO execution_run_events
      (id, tenant_id, run_id, event_type, message, data_json, created_at)
      VALUES (@id, @tenantId, @runId, @eventType, @message, @dataJson, @createdAt)
    `).run(bindJson({ ...row, message: row.message ?? null }));
    res.status(201).json(row);
  });

  router.post("/companies/:companyId/cost-events", (req, res, next: NextFunction) => {
    const companyId = req.params.companyId;
    if (!IdSchema.safeParse(companyId).success) return next();
    const parsed = CostEventSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error.flatten());
    const row = { id: randomUUID(), companyId, ...parsed.data, units: parsed.data.units ?? 0, amountUsd: parsed.data.amountUsd ?? 0, createdAt: new Date().toISOString() };
    getSqlite().prepare(`
      INSERT INTO execution_cost_events
      (id, tenant_id, company_id, run_id, issue_id, provider, model, units, amount_usd, metadata_json, created_at)
      VALUES (@id, @tenantId, @companyId, @runId, @issueId, @provider, @model, @units, @amountUsd, @metadataJson, @createdAt)
    `).run(bindJson({ ...row, runId: row.runId ?? null, issueId: row.issueId ?? null, provider: row.provider ?? null, model: row.model ?? null, metadata: row.metadata ?? {} }));
    res.status(201).json(row);
  });

  router.post("/webhooks/intake", (req, res) => {
    const parsed = WebhookIntakeSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error.flatten());
    const row = { id: randomUUID(), tenantId: parsed.data.tenantId, eventType: parsed.data.eventType, payload: req.body, receivedAt: new Date().toISOString() };
    getSqlite().prepare(`
      INSERT INTO execution_webhook_intakes (id, tenant_id, event_type, payload_json, received_at)
      VALUES (@id, @tenantId, @eventType, @payloadJson, @receivedAt)
    `).run(bindJson(row));
    res.status(202).json({ id: row.id, accepted: true });
  });

  return router;
}

// Export action-log query helpers for use by other routes and services
export { 
  actionLogSince, 
  countActionLogSince, 
  getDistinctActionKindsSince, 
  getActionLogSummaryByKind,
  type ActionLogQueryOptions,
  type ActionLogRow
} from "../services/action-log-query.js";

function badRequest(res: { status: (code: number) => { json: (body: unknown) => void } }, details: unknown): void {
  res.status(400).json({ error: "invalid_request", details });
}

function invalid(res: { status: (code: number) => { json: (body: unknown) => void } }, field: string): void {
  res.status(400).json({ error: "invalid_request", message: `${field} must be a UUID` });
}

// Lifecycle audit hook — surfaces execution events in /api/admin/activity-log,
// which only reads from action_log. Without these, transitions/comments/wakeups
// never appear on the Activity Log page even though the underlying state writes
// landed in execution_* tables.
function appendExecutionAudit(input: {
  tenantId: string;
  actorId: string;
  actorType: "human" | "agent" | "system";
  actorLabel: string;
  actionKind: string;
  payload: Record<string, unknown>;
  projectRefs?: string[];
}): void {
  const now = new Date().toISOString();
  getSqlite()
    .prepare(
      `INSERT INTO action_log
       (id, tenant_id, actor_id, actor_type, actor_label, action_kind,
        payload_snapshot, vault_refs, conversation_refs, project_refs,
        policy_decision_id, proposed_at, logged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, NULL, ?, ?)`
    )
    .run(
      randomUUID(),
      input.tenantId,
      input.actorId,
      input.actorType,
      input.actorLabel,
      input.actionKind,
      JSON.stringify(input.payload),
      JSON.stringify(input.projectRefs ?? []),
      now,
      now,
    );
}

function bindJson(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  if ("metadata" in out) out.metadataJson = JSON.stringify(out.metadata ?? {});
  if ("blockedOn" in out) out.blockedOnJson = JSON.stringify(out.blockedOn ?? []);
  if ("config" in out) out.configJson = JSON.stringify(out.config ?? {});
  if ("data" in out) out.dataJson = JSON.stringify(out.data ?? {});
  if ("payload" in out) out.payloadJson = JSON.stringify(out.payload ?? {});
  return out;
}

function insertComment(input: {
  tenantId: string;
  issueId: string;
  authorLabel: string;
  body: string;
}): void {
  getSqlite().prepare(`
    INSERT INTO execution_issue_comments
    (id, tenant_id, issue_id, author_id, author_label, body, created_at)
    VALUES (@id, @tenantId, @issueId, NULL, @authorLabel, @body, @createdAt)
  `).run({ id: randomUUID(), ...input, createdAt: new Date().toISOString() });
}

function insertWakeupDispatch(
  tenantId: string,
  agentId: string,
  input: z.infer<typeof WakeupSchema>,
): { id: string } {
  const row = { id: randomUUID(), tenantId, agentId, input: JSON.stringify(input), createdAt: new Date().toISOString() };
  getSqlite().prepare(`
    INSERT INTO dispatch_queue
    (id, tenant_id, task_kind, target_agent_id, input, status, created_at)
    VALUES (@id, @tenantId, 'agent.wakeup', @agentId, @input, 'queued', @createdAt)
  `).run(row);
  return { id: row.id };
}

const WAKEUP_COALESCE_WINDOW_MS = 60_000;

function recordWakeupAudit(
  tenantId: string,
  agentId: string,
  input: z.infer<typeof WakeupSchema>,
  dispatchId: string,
): { id: string; coalesced: boolean } {
  const sqlite = getSqlite();
  // Coalesce: if the same idempotency_key was seen within the window, bump count
  if (input.idempotencyKey) {
    const cutoff = new Date(Date.now() - WAKEUP_COALESCE_WINDOW_MS).toISOString();
    const prior = sqlite
      .prepare(
        `SELECT id, coalesced_count FROM execution_agent_wakeups
         WHERE agent_id = ? AND idempotency_key = ? AND created_at >= ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(agentId, input.idempotencyKey, cutoff) as
      | { id: string; coalesced_count: number }
      | undefined;
    if (prior) {
      sqlite
        .prepare(
          "UPDATE execution_agent_wakeups SET coalesced_count = coalesced_count + 1 WHERE id = ?"
        )
        .run(prior.id);
      return { id: prior.id, coalesced: true };
    }
  }
  const row = {
    id: randomUUID(),
    tenantId,
    agentId,
    source: input.source ?? null,
    triggerDetail: input.triggerDetail ?? null,
    reason: input.reason ?? null,
    payloadJson: input.payload ? JSON.stringify(input.payload) : null,
    idempotencyKey: input.idempotencyKey ?? null,
    dispatchId,
    createdAt: new Date().toISOString(),
  };
  sqlite
    .prepare(
      `INSERT INTO execution_agent_wakeups
       (id, tenant_id, agent_id, source, trigger_detail, reason, payload_json, idempotency_key, dispatch_id, created_at)
       VALUES (@id, @tenantId, @agentId, @source, @triggerDetail, @reason, @payloadJson, @idempotencyKey, @dispatchId, @createdAt)`
    )
    .run(row);
  return { id: row.id, coalesced: false };
}

// Subset of agent fields that participate in revision tracking
const TRACKED_KEYS = [
  "name",
  "role",
  "status",
  "adapter_type",
  "model",
  "instructions_path",
  "capabilities",
  "heartbeat_interval_sec",
  "wake_on_demand",
  "pause_reason",
  "reports_to",
  "budget_monthly_cents",
  "config_json",
] as const;

function recordConfigRevision(
  before: any,
  after: Record<string, unknown>,
  actor: { actorKind: string; actorId: string | null; source: string | null }
): void {
  // Map camelCase update fields back to snake_case for comparison
  const afterSnake: Record<string, unknown> = {
    name: after.name,
    role: after.role,
    status: after.status,
    adapter_type: after.adapterType,
    model: after.model,
    instructions_path: after.instructionsPath,
    capabilities: after.capabilities,
    heartbeat_interval_sec: after.heartbeatIntervalSec,
    wake_on_demand: after.wakeOnDemand,
    pause_reason: after.pauseReason,
    reports_to: after.reportsTo,
    budget_monthly_cents: after.budgetMonthlyCents,
    config_json: after.configJson,
  };

  const changed: string[] = [];
  const beforeProj: Record<string, unknown> = {};
  const afterProj: Record<string, unknown> = {};
  for (const k of TRACKED_KEYS) {
    const a = afterSnake[k];
    const b = before[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changed.push(k);
      beforeProj[k] = b ?? null;
      afterProj[k] = a ?? null;
    }
  }
  if (changed.length === 0) return;

  getSqlite()
    .prepare(
      `INSERT INTO execution_agent_config_revisions
       (id, tenant_id, agent_id, actor_kind, actor_id, source, changed_keys_json, before_json, after_json, created_at)
       VALUES (@id, @tenantId, @agentId, @actorKind, @actorId, @source, @changedKeys, @before, @after, @createdAt)`
    )
    .run({
      id: randomUUID(),
      tenantId: before.tenant_id,
      agentId: before.id,
      actorKind: actor.actorKind,
      actorId: actor.actorId,
      source: actor.source,
      changedKeys: JSON.stringify(changed),
      before: JSON.stringify(beforeProj),
      after: JSON.stringify(afterProj),
      createdAt: new Date().toISOString(),
    });
}

function upsertRuntimeState(
  tenantId: string,
  agentId: string,
  input: z.infer<typeof RuntimeStateSchema>,
): any {
  const sqlite = getSqlite();
  const accumulate = input.accumulate !== false;
  const existing = sqlite
    .prepare("SELECT * FROM execution_agent_runtime_state WHERE agent_id = ?")
    .get(agentId) as any;

  const merge = (newVal: number | undefined, oldVal: number) => {
    if (newVal === undefined) return oldVal;
    return accumulate ? oldVal + newVal : newVal;
  };

  const now = new Date().toISOString();
  const next = {
    agentId,
    tenantId,
    sessionId: input.sessionId !== undefined ? input.sessionId : existing?.session_id ?? null,
    lastRunId: input.lastRunId !== undefined ? input.lastRunId : existing?.last_run_id ?? null,
    lastRunStatus:
      input.lastRunStatus !== undefined ? input.lastRunStatus : existing?.last_run_status ?? null,
    lastRunAt: input.lastRunAt !== undefined ? input.lastRunAt : existing?.last_run_at ?? null,
    totalInputTokens: merge(input.totalInputTokens, existing?.total_input_tokens ?? 0),
    totalOutputTokens: merge(input.totalOutputTokens, existing?.total_output_tokens ?? 0),
    totalCachedInputTokens: merge(
      input.totalCachedInputTokens,
      existing?.total_cached_input_tokens ?? 0
    ),
    totalCostCents: merge(input.totalCostCents, existing?.total_cost_cents ?? 0),
    lastError: input.lastError !== undefined ? input.lastError : existing?.last_error ?? null,
    lastErrorAt:
      input.lastErrorAt !== undefined
        ? input.lastErrorAt
        : input.lastError
        ? now
        : existing?.last_error_at ?? null,
    updatedAt: now,
  };

  sqlite
    .prepare(
      `INSERT INTO execution_agent_runtime_state
       (agent_id, tenant_id, session_id, last_run_id, last_run_status, last_run_at,
        total_input_tokens, total_output_tokens, total_cached_input_tokens, total_cost_cents,
        last_error, last_error_at, updated_at)
       VALUES (@agentId, @tenantId, @sessionId, @lastRunId, @lastRunStatus, @lastRunAt,
        @totalInputTokens, @totalOutputTokens, @totalCachedInputTokens, @totalCostCents,
        @lastError, @lastErrorAt, @updatedAt)
       ON CONFLICT(agent_id) DO UPDATE SET
        session_id = excluded.session_id,
        last_run_id = excluded.last_run_id,
        last_run_status = excluded.last_run_status,
        last_run_at = excluded.last_run_at,
        total_input_tokens = excluded.total_input_tokens,
        total_output_tokens = excluded.total_output_tokens,
        total_cached_input_tokens = excluded.total_cached_input_tokens,
        total_cost_cents = excluded.total_cost_cents,
        last_error = excluded.last_error,
        last_error_at = excluded.last_error_at,
        updated_at = excluded.updated_at`
    )
    .run(next);

  // Roll spend into the agent record so budget views are O(1)
  if (input.totalCostCents !== undefined && accumulate) {
    sqlite
      .prepare(
        "UPDATE execution_agents SET spent_monthly_cents = spent_monthly_cents + ? WHERE id = ?"
      )
      .run(input.totalCostCents, agentId);
  }

  return sqlite
    .prepare("SELECT * FROM execution_agent_runtime_state WHERE agent_id = ?")
    .get(agentId);
}

function upsertTaskSession(
  tenantId: string,
  agentId: string,
  input: z.infer<typeof TaskSessionUpsertSchema>,
): any {
  const sqlite = getSqlite();
  const existing = sqlite
    .prepare(
      "SELECT * FROM execution_agent_task_sessions WHERE agent_id = ? AND task_key = ?"
    )
    .get(agentId, input.taskKey) as any;

  const now = new Date().toISOString();
  if (existing) {
    sqlite
      .prepare(
        `UPDATE execution_agent_task_sessions SET
           issue_id = COALESCE(@issueId, issue_id),
           adapter_type = COALESCE(@adapterType, adapter_type),
           session_params_json = COALESCE(@sessionParams, session_params_json),
           session_display_id = COALESCE(@sessionDisplayId, session_display_id),
           last_run_id = COALESCE(@lastRunId, last_run_id),
           last_error = @lastError,
           status = COALESCE(@status, status),
           updated_at = @updatedAt
         WHERE id = @id`
      )
      .run({
        id: existing.id,
        issueId: input.issueId ?? null,
        adapterType: input.adapterType ?? null,
        sessionParams: input.sessionParams ? JSON.stringify(input.sessionParams) : null,
        sessionDisplayId: input.sessionDisplayId ?? null,
        lastRunId: input.lastRunId ?? null,
        lastError: input.lastError ?? null,
        status: input.status ?? null,
        updatedAt: now,
      });
    return sqlite
      .prepare("SELECT * FROM execution_agent_task_sessions WHERE id = ?")
      .get(existing.id);
  }
  const row = {
    id: randomUUID(),
    tenantId,
    agentId,
    issueId: input.issueId ?? null,
    taskKey: input.taskKey,
    adapterType: input.adapterType ?? null,
    sessionParams: input.sessionParams ? JSON.stringify(input.sessionParams) : null,
    sessionDisplayId: input.sessionDisplayId ?? null,
    lastRunId: input.lastRunId ?? null,
    lastError: input.lastError ?? null,
    status: input.status ?? "open",
    createdAt: now,
    updatedAt: now,
  };
  sqlite
    .prepare(
      `INSERT INTO execution_agent_task_sessions
       (id, tenant_id, agent_id, issue_id, task_key, adapter_type, session_params_json,
        session_display_id, last_run_id, last_error, status, created_at, updated_at)
       VALUES (@id, @tenantId, @agentId, @issueId, @taskKey, @adapterType, @sessionParams,
        @sessionDisplayId, @lastRunId, @lastError, @status, @createdAt, @updatedAt)`
    )
    .run(row);
  return sqlite
    .prepare("SELECT * FROM execution_agent_task_sessions WHERE id = ?")
    .get(row.id);
}

function safeLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) return 50;
  return Math.min(Math.trunc(limit), 500);
}

function resolveIssueIdParam(issueId: string): string | null {
  if (IdSchema.safeParse(issueId).success) return issueId;
  if (issueId !== "standing") return null;
  const row = getSqlite()
    .prepare("SELECT id FROM execution_issues WHERE identifier = 'AWOS-STANDING' LIMIT 1")
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

function mapCompany(row: any): Record<string, unknown> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    slug: row.slug,
    slugPrefix: row.slug_prefix ?? null,
    status: row.status,
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProject(row: any): Record<string, unknown> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    companyId: row.company_id,
    name: row.name,
    status: row.status,
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAgent(row: any): Record<string, unknown> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    companyId: row.company_id,
    name: row.name,
    role: row.role,
    title: row.role ?? row.name,
    status: row.status,
    adapterType: row.adapter_type ?? null,
    model: row.model ?? null,
    instructionsPath: row.instructions_path ?? null,
    capabilities: row.capabilities ?? null,
    heartbeatIntervalSec: row.heartbeat_interval_sec ?? null,
    wakeOnDemand:
      row.wake_on_demand === 1 ? true : row.wake_on_demand === 0 ? false : null,
    lastHeartbeatAt: row.last_heartbeat_at ?? null,
    pauseReason: row.pause_reason ?? null,
    pausedAt: row.paused_at ?? null,
    reportsTo: row.reports_to ?? null,
    budgetMonthlyCents: row.budget_monthly_cents ?? 0,
    spentMonthlyCents: row.spent_monthly_cents ?? 0,
    budgetPeriodStart: row.budget_period_start ?? null,
    config: parseJson(row.config_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRevision(row: any): Record<string, unknown> {
  return {
    id: row.id,
    agentId: row.agent_id,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    source: row.source,
    changedKeys: parseJson(row.changed_keys_json),
    before: parseJson(row.before_json),
    after: parseJson(row.after_json),
    createdAt: row.created_at,
  };
}

function mapRuntimeState(row: any): Record<string, unknown> {
  return {
    agentId: row.agent_id,
    sessionId: row.session_id,
    lastRunId: row.last_run_id,
    lastRunStatus: row.last_run_status,
    lastRunAt: row.last_run_at,
    totalInputTokens: row.total_input_tokens ?? 0,
    totalOutputTokens: row.total_output_tokens ?? 0,
    totalCachedInputTokens: row.total_cached_input_tokens ?? 0,
    totalCostCents: row.total_cost_cents ?? 0,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    updatedAt: row.updated_at,
  };
}

function mapTaskSession(row: any): Record<string, unknown> {
  return {
    id: row.id,
    agentId: row.agent_id,
    issueId: row.issue_id,
    taskKey: row.task_key,
    adapterType: row.adapter_type,
    sessionParams: parseJson(row.session_params_json),
    sessionDisplayId: row.session_display_id,
    lastRunId: row.last_run_id,
    lastError: row.last_error,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWakeup(row: any): Record<string, unknown> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    source: row.source,
    triggerDetail: row.trigger_detail,
    reason: row.reason,
    payload: parseJson(row.payload_json),
    idempotencyKey: row.idempotency_key,
    coalescedCount: row.coalesced_count,
    dispatchId: row.dispatch_id,
    createdAt: row.created_at,
  };
}

function mapComment(row: any): Record<string, unknown> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    issueId: row.issue_id,
    authorId: row.author_id,
    authorAgentId: row.author_id,
    authorLabel: row.author_label,
    body: row.body,
    createdAt: row.created_at,
  };
}

function mapRun(row: any): Record<string, unknown> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    companyId: row.company_id,
    projectId: row.project_id,
    issueId: row.issue_id,
    agentId: row.agent_id,
    status: row.status,
    summary: row.summary,
    contextSnapshot: { agentworksWorkspace: { cwd: null } },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapIssue(row: any): IssueView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    companyId: row.company_id,
    projectId: row.project_id,
    identifier: row.identifier,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assigneeAgentId: row.assignee_agent_id,
    parentIssueId: row.parent_issue_id,
    blockedOn: parseArray(row.blocked_on_json),
    metadata: parseRecord(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    executionRunId: row.latest_run_id ?? null,
    latestCommentAt: row.latest_comment_at ?? null,
  };
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseArray(value: string | null): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
}

function parseRecord(value: string | null): Record<string, unknown> {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}
