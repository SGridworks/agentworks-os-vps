import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import OpenAI from "openai";
import { loadAwosProviderKey, readAwosProviderBaseUrl } from "../adapters/awos-secrets.js";
import type { Config } from "../config.js";
import { getSqlite } from "../db/index.js";
import { callPolicyCheck } from "../routes/mcp.js";
import { getVaultStore } from "../routes/memory.js";

export type NativeAutomationStepType =
  | "schedule.cron"
  | "schedule.interval"
  | "issue.created"
  | "issue.updated"
  | "approval.decided"
  | "agent.completed"
  | "dispatch.failed"
  | "vault.changed"
  | "webhook.response"
  | "policy.check"
  | "approval.enqueue"
  | "vault.read"
  | "vault.write"
  | "issue.create"
  | "issue.update"
  | "dispatch"
  | "scanner.finding"
  | "webhook.intake"
  | "condition.if"
  | "branch.switch"
  | "loop.each"
  | "merge.join"
  | "delay.wait"
  | "error.catch"
  | "data.set"
  | "data.transform"
  | "data.filter"
  | "data.dedupe"
  | "data.extract"
  | "json.parse"
  | "http.request"
  | "email.send"
  | "message.send"
  | "adapter.call"
  | "rss.read"
  | "file.read"
  | "file.write"
  | "ai.classify"
  | "ai.summarize"
  | "ai.extract"
  | "ai.route"
  | "ai.generate"
  | "ai.review"
  | "operator.brief"
  | "friction.detect"
  | "evidence.pack"
  | "agent.panel"
  | "workflow.self_heal";

export interface NativeAutomationStep {
  id: string;
  name: string;
  type: NativeAutomationStepType;
  params: Record<string, unknown>;
}

export interface NativeAutomationDefinition {
  trigger: "manual" | "webhook" | "event";
  steps: NativeAutomationStep[];
}

export interface NativeAutomationWorkflow {
  id: string;
  tenantId: string;
  companyId: string;
  name: string;
  trigger: string;
  status: "active" | "paused";
  description: string | null;
  definition: NativeAutomationDefinition;
  sourceTemplateId: string | null;
  externalEngine: string | null;
  externalWorkflowId: string | null;
  externalSyncStatus: string | null;
  externalSyncedAt: string | null;
  externalSyncError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NativeAutomationRunStep {
  id: string;
  name: string;
  type: NativeAutomationStepType;
  status: "succeeded" | "failed" | "skipped";
  startedAt: string;
  finishedAt: string;
  output: Record<string, unknown>;
  error: string | null;
}

export interface NativeAutomationRun {
  id: string;
  workflowId: string;
  tenantId: string;
  companyId: string;
  status: "running" | "succeeded" | "failed";
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  steps: NativeAutomationRunStep[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface NativeAutomationTemplate {
  id: string;
  name: string;
  trigger: "Manual" | "Webhook" | "Event";
  status: "available" | "installed";
  description: string;
  definition: NativeAutomationDefinition;
  source?: "bundled" | "custom";
  createdAt?: string;
  updatedAt?: string;
}

export interface N8nBridgeSyncResult {
  status: "synced" | "not_configured" | "offline" | "failed";
  baseUrl: string;
  workflowId: string;
  externalWorkflowId: string | null;
  error: string | null;
  exportJson: Record<string, unknown>;
}

export interface AiAutomationDraft {
  prompt: string;
  title: string;
  rationale: string;
  confidence: "low" | "medium" | "high";
  model: string | null;
  provider: string | null;
  fallbackUsed: boolean;
  template: NativeAutomationTemplate;
}

export interface AiRunExplanation {
  runId: string;
  status: NativeAutomationRun["status"];
  summary: string;
  friction: string[];
  model: string | null;
  provider: string | null;
  fallbackUsed: boolean;
  recommendedTemplate: {
    name: string;
    description: string;
    definition: NativeAutomationDefinition;
  };
}

const DEFAULT_TENANT_ID = process.env.AGENTWORKS_DEFAULT_TENANT_ID ?? "default";
const DEFAULT_COMPANY_ID = process.env.AGENTWORKS_DEFAULT_COMPANY_ID ?? "default";

/**
 * Step types exposed through the public REST schema. Templates that use
 * step types outside this set are hidden from list responses unless the
 * operator sets AWOS_AUTOMATION_EXPERIMENTAL_STEPS=1. The runtime can
 * still execute any step type defined in NativeAutomationStepType.
 */
const PUBLIC_STEP_TYPES: ReadonlySet<NativeAutomationStepType> = new Set([
  "policy.check",
  "approval.enqueue",
  "vault.read",
  "vault.write",
  "issue.create",
  "issue.update",
  "dispatch",
  "scanner.finding",
  "webhook.intake",
]);

function definitionUsesOnlyPublicSteps(definition: NativeAutomationDefinition): boolean {
  if (!definition || !Array.isArray(definition.steps)) return true;
  return definition.steps.every((step) => PUBLIC_STEP_TYPES.has(step.type));
}

function experimentalStepsEnabled(): boolean {
  return process.env.AWOS_AUTOMATION_EXPERIMENTAL_STEPS === "1";
}

const TEMPLATE_DEFINITIONS: Omit<NativeAutomationTemplate, "status">[] = [
  {
    id: "policy-gated-dispatch",
    name: "Policy-gated dispatch",
    trigger: "Webhook",
    description:
      "Evaluate an inbound action, route exceptions to approval, and dispatch allowed work to the agent fleet.",
    definition: {
      trigger: "webhook",
      steps: [
        {
          id: "policy",
          name: "Policy check",
          type: "policy.check",
          params: {
            actionKind: "workflow.dispatch",
            actorId: "native-automation",
            actorLabel: "Native Automation",
            summary: "Policy gate before dispatch",
          },
        },
        {
          id: "dispatch",
          name: "Dispatch approved work",
          type: "dispatch",
          params: {
            taskKind: "workflow.dispatch",
            targetAgentId: "d02218d7-7ace-4493-9303-e6e998f9368d",
            input: { source: "native-automation" },
            requiresPolicyDecision: "allow",
          },
        },
        {
          id: "review",
          name: "Route non-allow decisions",
          type: "approval.enqueue",
          params: {
            proposedActionKind: "workflow.dispatch",
            proposedActionSummary: "Dispatch needs review",
            decisionReason: "Policy gate did not return allow",
            requiresPolicyDecisionNot: "allow",
          },
        },
      ],
    },
  },
  {
    id: "vault-intake",
    name: "Vault intake",
    trigger: "Manual",
    description: "Normalize inbound notes into the local vault with tenant and company context preserved.",
    definition: {
      trigger: "manual",
      steps: [
        {
          id: "write",
          name: "Write intake note",
          type: "vault.write",
          params: {
            key: "automations/native-intake",
            body: "# Native Automation Intake\n\nCreated by AWOS native automations.",
            mode: "append",
          },
        },
      ],
    },
  },
  {
    id: "scanner-finding-triage",
    name: "Scanner finding triage",
    trigger: "Event",
    description: "Convert high-signal scanner findings into reviewable issues with evidence attached.",
    definition: {
      trigger: "event",
      steps: [
        {
          id: "issue",
          name: "Create scanner triage issue",
          type: "issue.create",
          params: {
            projectId: "aac73df5-2b98-4a58-9546-984a4c73cba5",
            title: "Native automation scanner triage",
            description: "Created from the native scanner-finding triage workflow.",
            priority: "high",
          },
        },
      ],
    },
  },
  {
    id: "outbound-review-demo",
    name: "Outbound review demo",
    trigger: "Manual",
    description: "Preview an outbound action, record the policy decision, and route reviewable work.",
    definition: {
      trigger: "manual",
      steps: [
        {
          id: "policy",
          name: "Outbound policy check",
          type: "policy.check",
          params: {
            actionKind: "outbound.email",
            actorId: "native-automation",
            actorLabel: "Native Automation",
            summary: "Outbound review demo",
            shadowMode: true,
          },
        },
        {
          id: "audit",
          name: "Write audit note",
          type: "vault.write",
          params: {
            key: "automations/outbound-review-demo",
            body: "# Outbound Review Demo\n\nNative automation recorded an outbound review decision.",
            mode: "append",
          },
        },
      ],
    },
  },
  {
    id: "issue-stuck-escalator",
    name: "Issue stuck escalator",
    trigger: "Event",
    description: "Create a reviewable escalation when an assigned issue sits in progress without fresh activity.",
    definition: {
      trigger: "event",
      steps: [
        {
          id: "escalation",
          name: "Create stuck-work escalation",
          type: "issue.create",
          params: {
            projectId: "694d990f-4f18-4245-b67c-12bd7c8db293",
            title: "Native automation stuck-work escalation",
            description: "Review stale in-progress work and decide whether to unblock, reassign, or close.",
            priority: "high",
          },
        },
      ],
    },
  },
  {
    id: "failed-dispatch-recovery",
    name: "Failed dispatch recovery",
    trigger: "Event",
    description: "Turn failed dispatch rows into visible repair work with the original failure attached.",
    definition: {
      trigger: "event",
      steps: [
        {
          id: "repair",
          name: "Create dispatch repair issue",
          type: "issue.create",
          params: {
            projectId: "904ed1c9-76bb-4bfd-96ac-68cda6fb6e89",
            title: "Native automation failed-dispatch repair",
            description: "Investigate failed dispatch row and post recovery evidence.",
            priority: "high",
          },
        },
      ],
    },
  },
  {
    id: "vault-health-cleanup-batcher",
    name: "Vault health cleanup batcher",
    trigger: "Manual",
    description: "Create a safe cleanup batch issue for Vault Health findings, with backup/review requirements.",
    definition: {
      trigger: "manual",
      steps: [
        {
          id: "batch",
          name: "Create vault cleanup batch",
          type: "issue.create",
          params: {
            projectId: "55773fd4-4a9d-4448-bc93-27ff64b50ee9",
            title: "Native automation vault-health cleanup batch",
            description: "Group Vault Health findings into a reviewable cleanup batch with backup required.",
            priority: "medium",
          },
        },
      ],
    },
  },
  {
    id: "provider-degradation-watch",
    name: "Provider degradation watch",
    trigger: "Event",
    description: "Record degraded provider health and route operator-visible repair work before agents stall.",
    definition: {
      trigger: "event",
      steps: [
        {
          id: "provider_issue",
          name: "Create provider repair issue",
          type: "issue.create",
          params: {
            projectId: "694d990f-4f18-4245-b67c-12bd7c8db293",
            title: "Native automation provider degradation repair",
            description: "Provider health degraded. Verify credentials, fallback, and agent impact.",
            priority: "critical",
          },
        },
      ],
    },
  },
  {
    id: "approval-sla-watchdog",
    name: "Approval SLA watchdog",
    trigger: "Event",
    description: "Escalate stale approval queue items before they block operator hours.",
    definition: {
      trigger: "event",
      steps: [
        {
          id: "approval_sla",
          name: "Create approval SLA issue",
          type: "issue.create",
          params: {
            projectId: "468566ae-27c3-4638-927c-1c6949d4fa34",
            title: "Native automation approval SLA escalation",
            description: "Approval queue item is aging. Review, approve, reject, or return with requested changes.",
            priority: "high",
          },
        },
      ],
    },
  },
  {
    id: "autoresearch-workflow-optimizer",
    name: "Autoresearch workflow optimizer",
    trigger: "Manual",
    description:
      "Apply a Karpathy-style propose, test, measure, keep-or-revert loop to existing AWOS workflows with evidence and operator review.",
    definition: {
      trigger: "manual",
      steps: [
        {
          id: "extract-history",
          name: "Extract workflow run history",
          type: "data.extract",
          params: {
            fields: ["workflowId", "runStatus", "stepFailures", "latencyMs", "operatorFriction"],
            source: "recentRuns",
          },
        },
        {
          id: "research-review",
          name: "Review workflow bottlenecks",
          type: "ai.review",
          params: {
            instruction:
              "Review recent workflow runs and identify one measurable improvement experiment. Prefer a small reversible change with a clear success metric.",
            schema: {
              hypothesis: "string",
              metric: "string",
              proposedChange: "string",
              rollbackPlan: "string",
            },
          },
        },
        {
          id: "candidate-change",
          name: "Generate candidate workflow change",
          type: "ai.generate",
          params: {
            instruction:
              "Draft a candidate AWOS workflow change that can be tested in one short run and kept only if the metric improves.",
            schema: {
              workflowPatch: "object",
              testInput: "object",
              successThreshold: "string",
            },
          },
        },
        {
          id: "policy-gate",
          name: "Gate experiment through policy",
          type: "policy.check",
          params: {
            actionKind: "workflow.autoresearch_experiment",
            actorId: "native-automation",
            actorLabel: "Native Automation",
            summary: "Autoresearch workflow-improvement experiment",
            shadowMode: true,
          },
        },
        {
          id: "research-issue",
          name: "Create workflow experiment issue",
          type: "issue.create",
          params: {
            projectId: "904ed1c9-76bb-4bfd-96ac-68cda6fb6e89",
            title: "Autoresearch workflow improvement experiment",
            description:
              "Run a short, measurable workflow-improvement experiment. Keep the change only if the selected metric improves; otherwise document and revert.",
            priority: "medium",
          },
        },
        {
          id: "evidence",
          name: "Pack experiment evidence",
          type: "evidence.pack",
          params: {
            include: ["workflow", "runs", "metric", "candidate-change", "policy-decision"],
          },
        },
        {
          id: "research-log",
          name: "Write research log",
          type: "vault.write",
          params: {
            key: "automations/autoresearch-workflow-optimizer",
            body:
              "# Autoresearch Workflow Optimizer\n\nExperiment drafted. Record hypothesis, metric, result, keep/revert decision, and next idea here.",
            mode: "append",
          },
        },
      ],
    },
  },
];

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stringify(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function mapWorkflow(row: any): NativeAutomationWorkflow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    companyId: row.company_id,
    name: row.name,
    trigger: row.trigger_kind,
    status: row.status,
    description: row.description ?? null,
    definition: parseJson<NativeAutomationDefinition>(row.definition_json, {
      trigger: "manual",
      steps: [],
    }),
    sourceTemplateId: row.source_template_id ?? null,
    externalEngine: row.external_engine ?? null,
    externalWorkflowId: row.external_workflow_id ?? null,
    externalSyncStatus: row.external_sync_status ?? null,
    externalSyncedAt: row.external_sync_at ?? null,
    externalSyncError: row.external_sync_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRun(row: any): NativeAutomationRun {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    tenantId: row.tenant_id,
    companyId: row.company_id,
    status: row.status,
    input: parseJson<Record<string, unknown>>(row.input_json, {}),
    output: parseJson<Record<string, unknown>>(row.output_json, {}),
    steps: parseJson<NativeAutomationRunStep[]>(row.steps_json, []),
    error: row.error ?? null,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
  };
}

function mapTemplate(row: any, installed: Set<string>): NativeAutomationTemplate {
  return {
    id: row.id,
    name: row.name,
    trigger: toTemplateTrigger(row.trigger_kind),
    status: installed.has(row.id) ? "installed" : "available",
    description: row.description,
    definition: parseJson<NativeAutomationDefinition>(row.definition_json, {
      trigger: "manual",
      steps: [],
    }),
    source: "custom",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTemplateTrigger(trigger: string): "Manual" | "Webhook" | "Event" {
  if (trigger.toLowerCase() === "webhook") return "Webhook";
  if (trigger.toLowerCase() === "event") return "Event";
  return "Manual";
}

function fromTemplateTrigger(trigger: string): "manual" | "webhook" | "event" {
  const normalized = trigger.toLowerCase();
  if (normalized === "webhook") return "webhook";
  if (normalized === "event") return "event";
  return "manual";
}

export function listNativeAutomationTemplates(companyId = DEFAULT_COMPANY_ID): NativeAutomationTemplate[] {
  const installed = new Set(
    getSqlite()
      .prepare(
        "SELECT source_template_id FROM native_automation_workflows WHERE company_id = ? AND source_template_id IS NOT NULL",
      )
      .all(companyId)
      .map((r: any) => r.source_template_id as string),
  );
  const experimentalOn = experimentalStepsEnabled();
  const bundled: NativeAutomationTemplate[] = TEMPLATE_DEFINITIONS
    .filter((template) => experimentalOn || definitionUsesOnlyPublicSteps(template.definition))
    .map((template) => {
      const status: "installed" | "available" = installed.has(template.id) ? "installed" : "available";
      return {
        ...template,
        source: "bundled" as const,
        status,
      };
    });
  const custom = getSqlite()
    .prepare("SELECT * FROM native_automation_templates WHERE company_id = ? ORDER BY created_at DESC")
    .all(companyId)
    .map((row: any) => mapTemplate(row, installed));
  return [...bundled, ...custom];
}

export function listNativeAutomationWorkflows(companyId = DEFAULT_COMPANY_ID): NativeAutomationWorkflow[] {
  return getSqlite()
    .prepare(
      "SELECT * FROM native_automation_workflows WHERE company_id = ? ORDER BY created_at DESC",
    )
    .all(companyId)
    .map(mapWorkflow);
}

export function listNativeAutomationRuns(companyId = DEFAULT_COMPANY_ID, limit = 12): NativeAutomationRun[] {
  return getSqlite()
    .prepare(
      "SELECT * FROM native_automation_runs WHERE company_id = ? ORDER BY started_at DESC LIMIT ?",
    )
    .all(companyId, limit)
    .map(mapRun);
}

export function getNativeAutomationRun(runId: string): NativeAutomationRun | null {
  const row = getSqlite().prepare("SELECT * FROM native_automation_runs WHERE id = ?").get(runId);
  return row ? mapRun(row) : null;
}

export function createNativeAutomationTemplate(input: {
  tenantId?: string;
  companyId?: string;
  name: string;
  trigger: string;
  description: string;
  definition: NativeAutomationDefinition;
}): NativeAutomationTemplate {
  const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
  const companyId = input.companyId ?? DEFAULT_COMPANY_ID;
  const now = new Date().toISOString();
  const row = {
    id: randomUUID(),
    tenantId,
    companyId,
    name: input.name,
    triggerKind: fromTemplateTrigger(input.trigger),
    description: input.description,
    definitionJson: stringify(input.definition),
    createdAt: now,
    updatedAt: now,
  };
  getSqlite()
    .prepare(
      `INSERT INTO native_automation_templates
       (id, tenant_id, company_id, name, trigger_kind, description, definition_json,
        source, created_at, updated_at)
       VALUES (@id, @tenantId, @companyId, @name, @triggerKind, @description,
        @definitionJson, 'custom', @createdAt, @updatedAt)`,
    )
    .run(row);
  return mapTemplate(
    getSqlite().prepare("SELECT * FROM native_automation_templates WHERE id = ?").get(row.id),
    new Set(),
  );
}

export function createNativeAutomationWorkflow(input: {
  tenantId?: string;
  companyId?: string;
  name: string;
  trigger: string;
  description?: string;
  definition: NativeAutomationDefinition;
  status?: "active" | "paused";
  sourceTemplateId?: string | null;
  externalEngine?: string | null;
  externalWorkflowId?: string | null;
  externalSyncStatus?: string | null;
}): NativeAutomationWorkflow {
  const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
  const companyId = input.companyId ?? DEFAULT_COMPANY_ID;
  const now = new Date().toISOString();
  const row = {
    id: randomUUID(),
    tenantId,
    companyId,
    name: input.name,
    trigger: fromTemplateTrigger(input.trigger),
    status: input.status ?? "paused",
    description: input.description ?? null,
    definitionJson: stringify(input.definition),
    sourceTemplateId: input.sourceTemplateId ?? null,
    externalEngine: input.externalEngine ?? null,
    externalWorkflowId: input.externalWorkflowId ?? null,
    externalSyncStatus: input.externalSyncStatus ?? null,
    createdAt: now,
    updatedAt: now,
  };
  getSqlite()
    .prepare(
      `INSERT INTO native_automation_workflows
       (id, tenant_id, company_id, name, trigger_kind, status, description, definition_json,
        source_template_id, external_engine, external_workflow_id, external_sync_status,
        external_sync_at, external_sync_error, created_at, updated_at)
       VALUES (@id, @tenantId, @companyId, @name, @trigger, @status, @description,
        @definitionJson, @sourceTemplateId, @externalEngine, @externalWorkflowId,
        @externalSyncStatus, NULL, NULL, @createdAt, @updatedAt)`,
    )
    .run(row);
  return mapWorkflow(getSqlite().prepare("SELECT * FROM native_automation_workflows WHERE id = ?").get(row.id));
}

export function exportNativeWorkflowToN8n(workflowId: string): Record<string, unknown> {
  const row = getSqlite().prepare("SELECT * FROM native_automation_workflows WHERE id = ?").get(workflowId);
  if (!row) throw new Error("workflow_not_found");
  const workflow = mapWorkflow(row);
  const nodes = workflow.definition.steps.map((step, index) => ({
    parameters: {
      operation: step.type,
      params: step.params,
    },
    id: step.id,
    name: step.name,
    type: "CUSTOM.agentworks.automation",
    typeVersion: 1,
    position: [240 + index * 260, 300],
  }));
  const connections: Record<string, unknown> = {};
  for (let i = 0; i < nodes.length - 1; i += 1) {
    const current = nodes[i] as { name: string };
    const next = nodes[i + 1] as { name: string };
    connections[current.name] = {
      main: [[{ node: next.name, type: "main", index: 0 }]],
    };
  }
  return {
    name: `AWOS Native - ${workflow.name}`,
    active: false,
    nodes,
    connections,
    settings: {
      awosNativeWorkflowId: workflow.id,
      awosSourceTemplateId: workflow.sourceTemplateId,
      executionOrder: "v1",
    },
    tags: ["awos-native", "agentworks"],
  };
}

export function importN8nWorkflow(input: {
  tenantId?: string;
  companyId?: string;
  workflowJson: Record<string, unknown>;
  mode?: "template" | "workflow";
  status?: "active" | "paused";
}): { kind: "template"; template: NativeAutomationTemplate } | { kind: "workflow"; workflow: NativeAutomationWorkflow } {
  const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
  const companyId = input.companyId ?? DEFAULT_COMPANY_ID;
  const name = asString(input.workflowJson.name, "Imported n8n workflow");
  const externalWorkflowId = asString(input.workflowJson.id, null) || null;
  const definition = convertN8nWorkflowToNativeDefinition(input.workflowJson);
  const description = `Imported from n8n-compatible JSON with ${definition.steps.length} native step(s).`;

  if ((input.mode ?? "template") === "workflow") {
    return {
      kind: "workflow",
      workflow: createNativeAutomationWorkflow({
        tenantId,
        companyId,
        name,
        trigger: definition.trigger,
        status: input.status ?? "paused",
        description,
        definition,
        externalEngine: "n8n",
        externalWorkflowId,
        externalSyncStatus: "imported",
      }),
    };
  }

  return {
    kind: "template",
    template: createNativeAutomationTemplate({
      tenantId,
      companyId,
      name,
      trigger: definition.trigger,
      description,
      definition,
    }),
  };
}

export async function syncNativeWorkflowToN8n(workflowId: string, config: Config): Promise<N8nBridgeSyncResult> {
  const sqlite = getSqlite();
  const existing = sqlite.prepare("SELECT * FROM native_automation_workflows WHERE id = ?").get(workflowId);
  if (!existing) throw new Error("workflow_not_found");
  const workflow = mapWorkflow(existing);
  const exportJson = exportNativeWorkflowToN8n(workflowId);
  const baseUrl = n8nBaseUrl();
  const apiKey = process.env.N8N_API_KEY || process.env.AUTOMATION_ENGINE_API_KEY || "";
  const bridge = await checkN8nBridge(config);
  const now = new Date().toISOString();

  if (!apiKey) {
    updateExternalSync(sqlite, workflowId, {
      status: "not_configured",
      externalWorkflowId: workflow.externalWorkflowId,
      error: "N8N_API_KEY is not configured; export JSON returned for manual import.",
      syncedAt: now,
    });
    return {
      status: "not_configured",
      baseUrl,
      workflowId,
      externalWorkflowId: workflow.externalWorkflowId,
      error: "N8N_API_KEY is not configured; export JSON returned for manual import.",
      exportJson,
    };
  }

  if (bridge.state !== "online") {
    updateExternalSync(sqlite, workflowId, {
      status: "offline",
      externalWorkflowId: workflow.externalWorkflowId,
      error: bridge.error ?? "n8n bridge is offline",
      syncedAt: now,
    });
    return {
      status: "offline",
      baseUrl,
      workflowId,
      externalWorkflowId: workflow.externalWorkflowId,
      error: bridge.error ?? "n8n bridge is offline",
      exportJson,
    };
  }

  try {
    const endpoint = workflow.externalWorkflowId
      ? `${baseUrl}/api/v1/workflows/${workflow.externalWorkflowId}`
      : `${baseUrl}/api/v1/workflows`;
    const response = await fetch(endpoint, {
      method: workflow.externalWorkflowId ? "PUT" : "POST",
      headers: {
        "Content-Type": "application/json",
        "X-N8N-API-KEY": apiKey,
      },
      body: JSON.stringify(exportJson),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`n8n sync returned ${response.status}: ${body.slice(0, 240)}`);
    }
    const synced = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const externalWorkflowId = asString(synced.id, workflow.externalWorkflowId);
    updateExternalSync(sqlite, workflowId, {
      status: "synced",
      externalWorkflowId,
      error: null,
      syncedAt: now,
    });
    return { status: "synced", baseUrl, workflowId, externalWorkflowId, error: null, exportJson };
  } catch (error) {
    const message = error instanceof Error ? error.message : "n8n sync failed";
    updateExternalSync(sqlite, workflowId, {
      status: "failed",
      externalWorkflowId: workflow.externalWorkflowId,
      error: message,
      syncedAt: now,
    });
    return { status: "failed", baseUrl, workflowId, externalWorkflowId: workflow.externalWorkflowId, error: message, exportJson };
  }
}

export async function draftAutomationTemplateFromPrompt(input: {
  tenantId?: string;
  companyId?: string;
  prompt: string;
  issueId?: string;
}): Promise<AiAutomationDraft> {
  const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
  const companyId = input.companyId ?? DEFAULT_COMPANY_ID;
  const issueContext = input.issueId ? lookupIssueContext(input.issueId) : null;
  const prompt = [input.prompt, issueContext?.title, issueContext?.description].filter(Boolean).join("\n");
  const lowered = prompt.toLowerCase();
  const fallback = buildFallbackAiDraft(input.prompt || issueContext?.title || "AI drafted automation", lowered, issueContext);
  const modelDraft = await callAutomationAiModel<{
    title?: string;
    rationale?: string;
    confidence?: "low" | "medium" | "high";
    definition?: NativeAutomationDefinition;
  }>({
    companyId,
    purpose: "draft",
    system:
      `You draft safe AWOS native automation templates. Return strict JSON only. Use only these step types: ${Array.from(SUPPORTED_STEP_TYPES).join(", ")}. Prefer AWOS-native evidence, approval, issue, agent, and AI nodes over generic external calls. Use http.request only when the operator asks to call an outside API. Avoid destructive actions. Default new templates to reviewable evidence capture, AI review, or issue creation unless the prompt explicitly requests dispatch.`,
    user: JSON.stringify({
      prompt: input.prompt,
      issueContext,
      requiredShape: {
        title: "short template title",
        rationale: "why this workflow is useful",
        confidence: "low|medium|high",
        definition: {
          trigger: "manual|webhook|event",
          steps: [{ id: "slug", name: "step name", type: "vault.write", params: {} }],
        },
      },
    }),
  });
  const title = sanitizeTitle(modelDraft.data?.title, fallback.title);
  const rationale = sanitizeSentence(modelDraft.data?.rationale, fallback.rationale);
  const confidence = modelDraft.data?.confidence ?? fallback.confidence;
  const definition = sanitizeDefinition(modelDraft.data?.definition, fallback.definition);
  const template = createNativeAutomationTemplate({
    tenantId,
    companyId,
    name: `AI draft: ${title}`,
    trigger: definition.trigger,
    description: `${rationale} Created by ${modelDraft.fallbackUsed ? "local fallback" : modelDraft.provider} model; review before installing.`,
    definition,
  });
  return {
    prompt: input.prompt,
    title,
    rationale,
    confidence,
    model: modelDraft.model,
    provider: modelDraft.provider,
    fallbackUsed: modelDraft.fallbackUsed,
    template,
  };
}

export async function explainNativeAutomationRun(runId: string): Promise<AiRunExplanation> {
  const run = getNativeAutomationRun(runId);
  if (!run) throw new Error("run_not_found");
  const fallback = buildFallbackRunExplanation(run);
  const modelExplanation = await callAutomationAiModel<{
    summary?: string;
    friction?: string[];
    recommendedTemplate?: {
      name?: string;
      description?: string;
      definition?: NativeAutomationDefinition;
    };
  }>({
    companyId: run.companyId,
    purpose: "explain",
    system:
      "You explain AWOS native automation runs for an operator. Return strict JSON only with a short summary, concrete friction array, and one safe recommended native automation template. Use only supported native step types. Avoid destructive actions.",
    user: JSON.stringify({
      run: {
        id: run.id,
        status: run.status,
        input: run.input,
        output: run.output,
        steps: run.steps,
        error: run.error,
      },
    }),
  });
  const recommended = modelExplanation.data?.recommendedTemplate;
  return {
    runId,
    status: run.status,
    summary: sanitizeSentence(modelExplanation.data?.summary, fallback.summary),
    friction: sanitizeStringArray(modelExplanation.data?.friction, fallback.friction),
    model: modelExplanation.model,
    provider: modelExplanation.provider,
    fallbackUsed: modelExplanation.fallbackUsed,
    recommendedTemplate: {
      name: sanitizeTitle(recommended?.name, fallback.recommendedTemplate.name),
      description: sanitizeSentence(recommended?.description, fallback.recommendedTemplate.description),
      definition: sanitizeDefinition(recommended?.definition, fallback.recommendedTemplate.definition),
    },
  };
}

function n8nBaseUrl(): string {
  return (process.env.AUTOMATION_ENGINE_URL || process.env.N8N_BASE_URL || "http://127.0.0.1:5678").replace(/\/$/, "");
}

function updateExternalSync(
  sqlite: Database,
  workflowId: string,
  input: { status: string; externalWorkflowId: string | null; error: string | null; syncedAt: string },
): void {
  sqlite
    .prepare(
      `UPDATE native_automation_workflows
       SET external_engine = 'n8n',
           external_workflow_id = ?,
           external_sync_status = ?,
           external_sync_at = ?,
           external_sync_error = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .run(input.externalWorkflowId, input.status, input.syncedAt, input.error, input.syncedAt, workflowId);
}

function convertN8nWorkflowToNativeDefinition(workflowJson: Record<string, unknown>): NativeAutomationDefinition {
  const nodes = Array.isArray(workflowJson.nodes) ? workflowJson.nodes : [];
  const steps = nodes
    .map((raw, index): NativeAutomationStep | null => {
      if (!isRecord(raw)) return null;
      const parameters = isRecord(raw.parameters) ? raw.parameters : {};
      const operation = asString(parameters.operation, "");
      const nativeType = SUPPORTED_STEP_TYPES.has(operation as NativeAutomationStepType)
        ? (operation as NativeAutomationStepType)
        : inferStepTypeFromN8nNode(asString(raw.type, ""), asString(raw.name, ""));
      return {
        id: slugify(asString(raw.id, asString(raw.name, `step-${index + 1}`))),
        name: asString(raw.name, `Step ${index + 1}`),
        type: nativeType,
        params: isRecord(parameters.params) ? parameters.params : parameters,
      };
    })
    .filter((step): step is NativeAutomationStep => Boolean(step));
  return {
    trigger: steps.some((step) => step.type === "webhook.intake") ? "webhook" : "manual",
    steps: steps.length > 0 ? steps : [defaultVaultWriteStep("imported-n8n-workflow")],
  };
}

const SUPPORTED_STEP_TYPES = new Set<NativeAutomationStepType>([
  "schedule.cron",
  "schedule.interval",
  "issue.created",
  "issue.updated",
  "approval.decided",
  "agent.completed",
  "dispatch.failed",
  "vault.changed",
  "webhook.response",
  "policy.check",
  "approval.enqueue",
  "vault.read",
  "vault.write",
  "issue.create",
  "issue.update",
  "dispatch",
  "scanner.finding",
  "webhook.intake",
  "condition.if",
  "branch.switch",
  "loop.each",
  "merge.join",
  "delay.wait",
  "error.catch",
  "data.set",
  "data.transform",
  "data.filter",
  "data.dedupe",
  "data.extract",
  "json.parse",
  "http.request",
  "email.send",
  "message.send",
  "adapter.call",
  "rss.read",
  "file.read",
  "file.write",
  "ai.classify",
  "ai.summarize",
  "ai.extract",
  "ai.route",
  "ai.generate",
  "ai.review",
  "operator.brief",
  "friction.detect",
  "evidence.pack",
  "agent.panel",
  "workflow.self_heal",
]);

function inferStepTypeFromN8nNode(type: string, name: string): NativeAutomationStepType {
  const combined = `${type} ${name}`.toLowerCase();
  if (combined.includes("webhook")) return "webhook.intake";
  if (combined.includes("schedule") || combined.includes("cron")) return "schedule.cron";
  if (combined.includes("http")) return "http.request";
  if (combined.includes("email")) return "email.send";
  if (combined.includes("rss")) return "rss.read";
  if (combined.includes("if")) return "condition.if";
  if (combined.includes("switch")) return "branch.switch";
  if (combined.includes("merge")) return "merge.join";
  if (combined.includes("code") || combined.includes("set")) return "data.transform";
  if (combined.includes("approval")) return "approval.enqueue";
  if (combined.includes("issue")) return "issue.create";
  if (combined.includes("dispatch") || combined.includes("agent")) return "dispatch";
  if (combined.includes("scanner")) return "scanner.finding";
  if (combined.includes("read")) return "vault.read";
  return "vault.write";
}

function defaultVaultWriteStep(slug: string): NativeAutomationStep {
  return {
    id: "write-note",
    name: "Write vault note",
    type: "vault.write",
    params: {
      key: `automations/${slug}`,
      body: "# Automation Note\n\nCreated by AWOS native automations.",
      mode: "append",
    },
  };
}

function lookupIssueContext(issueId: string): { id: string; title: string; description: string | null; priority: string | null } | null {
  const row = getSqlite()
    .prepare("SELECT id, title, description, priority FROM execution_issues WHERE id = ? OR identifier = ?")
    .get(issueId, issueId) as { id: string; title: string; description: string | null; priority: string | null } | undefined;
  return row ?? null;
}

function buildFallbackAiDraft(
  source: string,
  lowered: string,
  issueContext: { id: string; title: string; description: string | null; priority: string | null } | null,
): { title: string; rationale: string; confidence: AiAutomationDraft["confidence"]; definition: NativeAutomationDefinition } {
  const title = titleFromPrompt(source);
  const slug = slugify(source || title);
  if (lowered.includes("approval")) {
    return {
      title,
      rationale: "Creates an approval guard so reviewable automation work does not bypass the operator.",
      confidence: "high",
      definition: {
        trigger: "event",
        steps: [
          {
            id: "approval",
            name: "Queue approval",
            type: "approval.enqueue",
            params: {
              proposedActionKind: "workflow.review",
              proposedActionSummary: issueContext?.title ?? title,
              decisionReason: "AI-assisted automation requested approval routing.",
            },
          },
        ],
      },
    };
  }
  if (lowered.includes("issue") || lowered.includes("repair") || lowered.includes("friction")) {
    return {
      title,
      rationale: "Creates visible AWOS repair work from recurring operational friction.",
      confidence: "high",
      definition: {
        trigger: "event",
        steps: [
          {
            id: "create-issue",
            name: "Create repair issue",
            type: "issue.create",
            params: {
              projectId: "904ed1c9-76bb-4bfd-96ac-68cda6fb6e89",
              title: issueContext?.title ?? title,
              description: issueContext?.description ?? "AI-assisted automation created reviewable repair work.",
              priority: issueContext?.priority ?? "medium",
            },
          },
        ],
      },
    };
  }
  return {
    title,
    rationale: "Captures repeatable operator work as a reviewable vault-backed native automation.",
    confidence: lowered.includes("vault") || lowered.includes("note") ? "high" : "medium",
    definition: { trigger: "manual", steps: [defaultVaultWriteStep(slug)] },
  };
}

function buildFallbackRunExplanation(run: NativeAutomationRun): AiRunExplanation {
  const failed = run.steps.find((step) => step.status === "failed");
  const skipped = run.steps.filter((step) => step.status === "skipped");
  const friction: string[] = [];
  if (failed) friction.push(`${failed.name} failed: ${failed.error ?? "unknown error"}`);
  if (skipped.length > 0) friction.push(`${skipped.length} step(s) skipped by conditional guard.`);
  if (run.status === "succeeded" && friction.length === 0) {
    friction.push("No runtime friction detected in recorded native steps.");
  }
  return {
    runId: run.id,
    status: run.status,
    summary:
      run.status === "failed"
        ? `Run failed after ${run.steps.length} recorded step(s).`
        : `Run ${run.status} with ${run.steps.length} recorded step(s).`,
    friction,
    model: null,
    provider: null,
    fallbackUsed: true,
    recommendedTemplate: {
      name: run.status === "failed" ? "AI draft: failed automation repair" : "AI draft: run evidence capture",
      description:
        run.status === "failed"
          ? "Create a repair issue whenever a native automation run fails."
          : "Write a vault note summarizing successful native automation runs for operator review.",
      definition:
        run.status === "failed"
          ? {
              trigger: "event",
              steps: [
                {
                  id: "repair-issue",
                  name: "Create automation repair issue",
                  type: "issue.create",
                  params: {
                    projectId: "904ed1c9-76bb-4bfd-96ac-68cda6fb6e89",
                    title: "Native automation run repair",
                    description: `Review failed automation run ${run.id}.`,
                    priority: "high",
                  },
                },
              ],
            }
          : {
              trigger: "event",
              steps: [
                {
                  id: "write-run-note",
                  name: "Write run evidence note",
                  type: "vault.write",
                  params: {
                    key: "automations/run-evidence",
                    body: `# Automation Run Evidence\n\nRun ${run.id} completed with status ${run.status}.`,
                    mode: "append",
                  },
                },
              ],
            },
    },
  };
}

async function callAutomationAiModel<T>(input: {
  companyId: string;
  purpose: "draft" | "explain";
  system: string;
  user: string;
}): Promise<{ data: T | null; model: string | null; provider: string | null; fallbackUsed: boolean }> {
  const route = resolveAutomationAiRoute(input.companyId);
  if (!route) return { data: null, model: null, provider: null, fallbackUsed: true };
  try {
    const client = new OpenAI({ apiKey: route.apiKey, baseURL: route.baseUrl });
    const response = await client.chat.completions.create({
      model: route.model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
    });
    const text = response.choices[0]?.message?.content ?? "";
    return { data: parseJson<T | null>(text, null), model: route.model, provider: route.provider, fallbackUsed: false };
  } catch {
    return { data: null, model: route.model, provider: route.provider, fallbackUsed: true };
  }
}

function resolveAutomationAiRoute(companyId: string): { provider: string; model: string; baseUrl: string; apiKey: string } | null {
  const overrideProvider = process.env.AWOS_AUTOMATION_AI_PROVIDER;
  const overrideModel = process.env.AWOS_AUTOMATION_AI_MODEL;

  if (overrideProvider && overrideModel) {
    const route = providerRoute(overrideProvider, overrideModel);
    if (route) return route;
  }

  const row = getSqlite()
    .prepare(
      `SELECT adapter_type, model
       FROM execution_agents
       WHERE company_id = ? AND status IN ('active','idle','paused')
         AND model IS NOT NULL AND length(model) > 0
       ORDER BY CASE WHEN role = 'CEO' THEN 0 ELSE 1 END, updated_at DESC
       LIMIT 1`,
    )
    .get(companyId) as { adapter_type: string | null; model: string } | undefined;
  return providerRoute(row?.adapter_type ?? "ollama_cloud", row?.model ?? "qwen3-coder:480b");
}

function providerRoute(provider: string, model: string): { provider: string; model: string; baseUrl: string; apiKey: string } | null {
  const normalized = provider.toLowerCase();

  try {
    if (normalized.includes("minimax")) {
      return {
        provider: "minimax",
        model,
        baseUrl: readAwosProviderBaseUrl("minimax") ?? "https://api.minimax.io/v1",
        apiKey: loadAwosProviderKey({ envNames: ["MINIMAX_API_KEY"] }),
      };
    }
    if (normalized.includes("kimi") || normalized.includes("moonshot")) {
      return {
        provider: "kimi",
        model,
        baseUrl: readAwosProviderBaseUrl("kimi") ?? "https://api.moonshot.ai/v1",
        apiKey: loadAwosProviderKey({ envNames: ["KIMI_API_KEY", "MOONSHOT_API_KEY"] }),
      };
    }
    if (normalized.includes("openai")) {
      return {
        provider: "openai",
        model,
        baseUrl: readAwosProviderBaseUrl("openai") ?? "https://api.openai.com/v1",
        apiKey: loadAwosProviderKey({ envNames: ["OPENAI_API_KEY"] }),
      };
    }
    return {
      provider: "ollama_cloud",
      model,
      baseUrl: readAwosProviderBaseUrl("ollama") ?? "https://ollama.com/v1",
      apiKey: loadAwosProviderKey({ envNames: ["OLLAMA_API_KEY"] }),
    };
  } catch {
    return null;
  }
}

function sanitizeDefinition(value: unknown, fallback: NativeAutomationDefinition): NativeAutomationDefinition {
  if (!isRecord(value)) return fallback;
  const trigger = value.trigger === "webhook" || value.trigger === "event" ? value.trigger : "manual";
  const rawSteps = Array.isArray(value.steps) ? value.steps : [];
  const steps = rawSteps
    .map((raw, index): NativeAutomationStep | null => {
      if (!isRecord(raw)) return null;
      const type = asString(raw.type, "") as NativeAutomationStepType;
      if (!SUPPORTED_STEP_TYPES.has(type)) return null;
      return {
        id: slugify(asString(raw.id, `step-${index + 1}`)),
        name: sanitizeTitle(raw.name, `Step ${index + 1}`),
        type,
        params: isRecord(raw.params) ? raw.params : {},
      };
    })
    .filter((step): step is NativeAutomationStep => Boolean(step))
    .slice(0, 20);
  return { trigger, steps: steps.length > 0 ? steps : fallback.steps };
}

function sanitizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const cleaned = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 8);
  return cleaned.length > 0 ? cleaned : fallback;
}

function sanitizeTitle(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 120) : fallback;
}

function sanitizeSentence(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 600) : fallback;
}

function titleFromPrompt(prompt: string): string {
  const words = prompt.replace(/[^A-Za-z0-9 ]+/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 6);
  if (words.length === 0) return "AI drafted automation";
  return words.map((word) => word[0]?.toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return slug || "step";
}

export function installNativeAutomationTemplate(
  templateId: string,
  opts: { tenantId?: string; companyId?: string } = {},
): NativeAutomationWorkflow {
  const template =
    TEMPLATE_DEFINITIONS.find((t) => t.id === templateId) ??
    listNativeAutomationTemplates(opts.companyId ?? DEFAULT_COMPANY_ID).find((t) => t.id === templateId);
  if (!template) throw new Error("template_not_found");
  if (!experimentalStepsEnabled() && !definitionUsesOnlyPublicSteps(template.definition)) {
    throw new Error("template_uses_experimental_steps");
  }

  const tenantId = opts.tenantId ?? DEFAULT_TENANT_ID;
  const companyId = opts.companyId ?? DEFAULT_COMPANY_ID;
  const sqlite = getSqlite();
  const existing = sqlite
    .prepare(
      "SELECT * FROM native_automation_workflows WHERE company_id = ? AND source_template_id = ?",
    )
    .get(companyId, templateId);
  if (existing) return mapWorkflow(existing);

  return createNativeAutomationWorkflow({
    tenantId,
    companyId,
    name: template.name,
    trigger: template.definition.trigger,
    status: "active",
    description: template.description,
    definition: template.definition,
    sourceTemplateId: template.id,
  });
}

export function setNativeAutomationWorkflowStatus(
  workflowId: string,
  status: "active" | "paused",
): NativeAutomationWorkflow {
  const sqlite = getSqlite();
  const existing = sqlite.prepare("SELECT * FROM native_automation_workflows WHERE id = ?").get(workflowId);
  if (!existing) throw new Error("workflow_not_found");
  sqlite
    .prepare("UPDATE native_automation_workflows SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, new Date().toISOString(), workflowId);
  return mapWorkflow(sqlite.prepare("SELECT * FROM native_automation_workflows WHERE id = ?").get(workflowId));
}

export function updateNativeAutomationWorkflow(
  workflowId: string,
  input: {
    name?: string;
    description?: string | null;
    status?: "active" | "paused";
    definition?: NativeAutomationDefinition;
  },
): NativeAutomationWorkflow {
  const sqlite = getSqlite();
  const existing = sqlite.prepare("SELECT * FROM native_automation_workflows WHERE id = ?").get(workflowId);
  if (!existing) throw new Error("workflow_not_found");
  const current = mapWorkflow(existing);
  const nextDefinition = input.definition ?? current.definition;
  sqlite
    .prepare(
      `UPDATE native_automation_workflows
       SET name = ?,
           description = ?,
           status = ?,
           trigger_kind = ?,
           definition_json = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .run(
      input.name ?? current.name,
      input.description === undefined ? current.description : input.description,
      input.status ?? current.status,
      nextDefinition.trigger,
      stringify(nextDefinition),
      new Date().toISOString(),
      workflowId,
    );
  return mapWorkflow(sqlite.prepare("SELECT * FROM native_automation_workflows WHERE id = ?").get(workflowId));
}

export async function runNativeAutomationWorkflow(
  workflowId: string,
  input: Record<string, unknown>,
  config: Config,
): Promise<NativeAutomationRun> {
  const sqlite = getSqlite();
  const workflowRow = sqlite.prepare("SELECT * FROM native_automation_workflows WHERE id = ?").get(workflowId);
  if (!workflowRow) throw new Error("workflow_not_found");
  const workflow = mapWorkflow(workflowRow);
  if (workflow.status !== "active") throw new Error("workflow_not_active");

  const now = new Date().toISOString();
  const runId = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO native_automation_runs
       (id, workflow_id, tenant_id, company_id, status, input_json, output_json, steps_json,
        error, started_at, finished_at)
       VALUES (?, ?, ?, ?, 'running', ?, '{}', '[]', NULL, ?, NULL)`,
    )
    .run(runId, workflow.id, workflow.tenantId, workflow.companyId, stringify(input), now);

  const steps: NativeAutomationRunStep[] = [];
  const context: Record<string, unknown> = { input };
  let status: "succeeded" | "failed" = "succeeded";
  let error: string | null = null;

  for (const step of workflow.definition.steps) {
    const startedAt = new Date().toISOString();
    try {
      if (shouldSkipStep(step, context)) {
        steps.push({
          id: step.id,
          name: step.name,
          type: step.type,
          status: "skipped",
          startedAt,
          finishedAt: new Date().toISOString(),
          output: { reason: "condition_not_met" },
          error: null,
        });
        continue;
      }
      const output = await executeStep(sqlite, workflow, step, input, context, config);
      context[step.id] = output;
      steps.push({
        id: step.id,
        name: step.name,
        type: step.type,
        status: "succeeded",
        startedAt,
        finishedAt: new Date().toISOString(),
        output,
        error: null,
      });
    } catch (err) {
      status = "failed";
      error = err instanceof Error ? err.message : "step failed";
      steps.push({
        id: step.id,
        name: step.name,
        type: step.type,
        status: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        output: {},
        error,
      });
      break;
    }
  }

  const finishedAt = new Date().toISOString();
  const output = { workflowId: workflow.id, status, steps: steps.length };
  sqlite
    .prepare(
      `UPDATE native_automation_runs
       SET status = ?, output_json = ?, steps_json = ?, error = ?, finished_at = ?
       WHERE id = ?`,
    )
    .run(status, stringify(output), stringify(steps), error, finishedAt, runId);

  return getNativeAutomationRun(runId)!;
}

function shouldSkipStep(step: NativeAutomationStep, context: Record<string, unknown>): boolean {
  const required = step.params["requiresPolicyDecision"];
  const forbidden = step.params["requiresPolicyDecisionNot"];
  const lastDecision = context["lastPolicyDecision"];
  if (typeof required === "string" && lastDecision !== required) return true;
  if (typeof forbidden === "string" && lastDecision === forbidden) return true;
  return false;
}

async function executeStep(
  sqlite: Database,
  workflow: NativeAutomationWorkflow,
  step: NativeAutomationStep,
  input: Record<string, unknown>,
  context: Record<string, unknown>,
  config: Config,
): Promise<Record<string, unknown>> {
  switch (step.type) {
    case "policy.check":
      return executePolicyCheck(workflow, step, input, context, config);
    case "approval.enqueue":
      return executeApprovalEnqueue(sqlite, workflow, step);
    case "vault.read":
      return executeVaultRead(workflow, step);
    case "vault.write":
      return executeVaultWrite(workflow, step);
    case "issue.create":
      return executeIssueCreate(sqlite, workflow, step);
    case "issue.update":
      return executeIssueUpdate(sqlite, step);
    case "dispatch":
      return executeDispatch(sqlite, workflow, step);
    case "scanner.finding":
      return executeScannerFinding(sqlite, workflow, step);
    case "webhook.intake":
      return { accepted: true, receivedKeys: Object.keys(input) };
    case "http.request":
      return executeHttpRequest(step, context);
    case "adapter.call":
      return executeAdapterCall(workflow, step, input, context);
    case "ai.classify":
    case "ai.summarize":
    case "ai.extract":
    case "ai.route":
    case "ai.generate":
    case "ai.review":
      return executeAiStep(workflow, step, input, context);
    default:
      return executeUtilityStep(step, input, context);
  }
}

async function executePolicyCheck(
  workflow: NativeAutomationWorkflow,
  step: NativeAutomationStep,
  input: Record<string, unknown>,
  context: Record<string, unknown>,
  config: Config,
): Promise<Record<string, unknown>> {
  const result = await callPolicyCheck(
    {
      tenantId: workflow.tenantId,
      actor: {
        id: asString(step.params.actorId, "native-automation"),
        type: "system",
        label: asString(step.params.actorLabel, "Native Automation"),
      },
      proposedAction: {
        kind: asString(step.params.actionKind, "workflow.step"),
        summary: asString(step.params.summary, step.name),
      },
      evidenceSnapshot: {
        workflowId: workflow.id,
        stepId: step.id,
        input,
        ...(isRecord(step.params.payload) ? step.params.payload : {}),
      },
      shadowMode: typeof step.params.shadowMode === "boolean" ? step.params.shadowMode : undefined,
    },
    config,
  );
  const parsed = parseJson<Record<string, unknown>>(result.content[0]?.text, {});
  context["lastPolicyDecision"] = parsed.decision;
  context["lastPolicyDecisionId"] = parsed.decisionId;
  return parsed;
}

function executeApprovalEnqueue(
  sqlite: Database,
  workflow: NativeAutomationWorkflow,
  step: NativeAutomationStep,
): Record<string, unknown> {
  const now = new Date().toISOString();
  const policyDecisionId = randomUUID();
  const approvalId = randomUUID();
  const decisionHash = createHash("sha256")
    .update(`${policyDecisionId}:${workflow.tenantId}:${now}`)
    .digest("hex");
  const proposedActionKind = asString(step.params.proposedActionKind, "workflow.review");
  const proposedActionSummary = asString(step.params.proposedActionSummary, step.name);
  const decisionReason = asString(step.params.decisionReason, "Queued by native automation");

  sqlite
    .prepare(
      `INSERT INTO policy_decisions
       (id, action_id, tenant_id, actor_id, actor_type, actor_label,
        proposed_action_kind, proposed_action_summary, evidence_snapshot, decision,
        decision_reason, shadow_mode, decision_hash, proposed_at, decided_at,
        created_at, updated_at)
       VALUES (?, ?, ?, 'native-automation', 'system', 'Native Automation',
        ?, ?, '{}', 'route_to_review', ?, 0, ?, ?, ?, ?, ?)`,
    )
    .run(
      policyDecisionId,
      policyDecisionId,
      workflow.tenantId,
      proposedActionKind,
      proposedActionSummary,
      decisionReason,
      decisionHash,
      now,
      now,
      now,
      now,
    );
  sqlite
    .prepare(
      `INSERT INTO approval_queue
       (id, policy_decision_id, tenant_id, actor_label, proposed_action_kind,
        proposed_action_summary, decision_reason, status, created_at, updated_at)
       VALUES (?, ?, ?, 'Native Automation', ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      approvalId,
      policyDecisionId,
      workflow.tenantId,
      proposedActionKind,
      proposedActionSummary,
      decisionReason,
      now,
      now,
    );
  return { approvalQueueId: approvalId, policyDecisionId, status: "pending" };
}

async function executeVaultRead(
  workflow: NativeAutomationWorkflow,
  step: NativeAutomationStep,
): Promise<Record<string, unknown>> {
  const key = asString(step.params.key, "");
  if (!key) throw new Error("vault.read key required");
  const r = await getVaultStore().read(workflow.tenantId, key);
  return { key: r.key, existed: r.existed, sha256: r.sha256, updatedAt: r.updatedAt };
}

async function executeVaultWrite(
  workflow: NativeAutomationWorkflow,
  step: NativeAutomationStep,
): Promise<Record<string, unknown>> {
  const key = asString(step.params.key, "");
  const body = asString(step.params.body, "");
  const mode = step.params.mode === "append" ? "append" : "replace";
  if (!key) throw new Error("vault.write key required");
  const w = await getVaultStore().write(workflow.tenantId, key, body, {
    mode,
    lastUpdatedBy: "native-automation",
    lastUpdatedAt: new Date().toISOString(),
  });
  return { key: w.key, bytesWritten: w.bytesWritten, sha256: w.sha256, updatedAt: w.updatedAt, mode };
}

function executeIssueCreate(
  sqlite: Database,
  workflow: NativeAutomationWorkflow,
  step: NativeAutomationStep,
): Record<string, unknown> {
  const now = new Date().toISOString();
  const companyId = workflow.companyId;
  const company = sqlite
    .prepare("SELECT slug_prefix FROM execution_companies WHERE id = ?")
    .get(companyId) as { slug_prefix: string | null } | undefined;
  sqlite
    .prepare("INSERT OR IGNORE INTO execution_company_issue_seq (company_id, next_seq) VALUES (?, 1)")
    .run(companyId);
  const seqRow = sqlite
    .prepare("SELECT next_seq FROM execution_company_issue_seq WHERE company_id = ?")
    .get(companyId) as { next_seq: number } | undefined;
  const identifier = company?.slug_prefix && seqRow ? `${company.slug_prefix}-${seqRow.next_seq}` : null;
  if (identifier) {
    sqlite
      .prepare("UPDATE execution_company_issue_seq SET next_seq = next_seq + 1 WHERE company_id = ?")
      .run(companyId);
  }
  const issueId = randomUUID();
  const row = {
    id: issueId,
    tenantId: workflow.tenantId,
    companyId,
    projectId: asString(step.params.projectId, ""),
    identifier,
    title: asString(step.params.title, step.name),
    description: asString(step.params.description, ""),
    priority: asString(step.params.priority, "medium"),
    metadataJson: stringify({ source: "native-automation", workflowId: workflow.id, stepId: step.id }),
    createdAt: now,
    updatedAt: now,
  };
  if (!row.projectId) throw new Error("issue.create projectId required");
  sqlite
    .prepare(
      `INSERT INTO execution_issues
       (id, tenant_id, company_id, project_id, identifier, title, description,
        status, priority, assignee_agent_id, parent_issue_id, blocked_on_json,
        metadata_json, created_at, updated_at, completed_at)
       VALUES (@id, @tenantId, @companyId, @projectId, @identifier, @title,
        @description, 'todo', @priority, NULL, NULL, '[]', @metadataJson,
        @createdAt, @updatedAt, NULL)`,
    )
    .run(row);
  return { issueId, identifier, title: row.title, status: "todo" };
}

function executeIssueUpdate(sqlite: Database, step: NativeAutomationStep): Record<string, unknown> {
  const issueId = asString(step.params.issueId, "");
  if (!issueId) throw new Error("issue.update issueId required");
  const status = asString(step.params.status, "");
  const priority = asString(step.params.priority, "");
  const existing = sqlite.prepare("SELECT status, priority FROM execution_issues WHERE id = ?").get(issueId) as
    | { status: string; priority: string }
    | undefined;
  if (!existing) throw new Error("issue_not_found");
  sqlite
    .prepare(
      `UPDATE execution_issues
       SET status = ?, priority = ?, updated_at = ?, completed_at = CASE WHEN ? IN ('done','closed') THEN ? ELSE completed_at END
       WHERE id = ?`,
    )
    .run(
      status || existing.status,
      priority || existing.priority,
      new Date().toISOString(),
      status || existing.status,
      new Date().toISOString(),
      issueId,
    );
  return { issueId, status: status || existing.status, priority: priority || existing.priority };
}

function executeDispatch(
  sqlite: Database,
  workflow: NativeAutomationWorkflow,
  step: NativeAutomationStep,
): Record<string, unknown> {
  const now = new Date().toISOString();
  const taskId = randomUUID();
  const taskKind = asString(step.params.taskKind, "workflow.dispatch");
  const targetAgentId = asString(step.params.targetAgentId, "");
  if (!targetAgentId) throw new Error("dispatch targetAgentId required");
  sqlite
    .prepare(
      `INSERT INTO dispatch_queue
       (id, tenant_id, task_kind, target_agent_id, input, status,
        policy_decision_id, created_at, dispatched_at, completed_at, error)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, NULL, NULL, NULL)`,
    )
    .run(
      taskId,
      workflow.tenantId,
      taskKind,
      targetAgentId,
      stringify(isRecord(step.params.input) ? step.params.input : {}),
      asString(step.params.policyDecisionId, null),
      now,
    );
  return { taskId, status: "queued", taskKind, targetAgentId, createdAt: now };
}

function executeScannerFinding(
  sqlite: Database,
  workflow: NativeAutomationWorkflow,
  step: NativeAutomationStep,
): Record<string, unknown> {
  const now = new Date().toISOString();
  const findingId = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO scanner_findings
       (id, tenant_id, origin_kind, origin_id, severity, rule_id, title, description,
        remediation, affected_endpoint, status, created_at, updated_at)
       VALUES (?, ?, 'scanner_finding', ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    )
    .run(
      findingId,
      workflow.tenantId,
      findingId,
      asString(step.params.severity, "medium"),
      asString(step.params.ruleId, "native-automation"),
      asString(step.params.title, step.name),
      asString(step.params.description, "Created by native automation"),
      asString(step.params.remediation, null),
      asString(step.params.affectedEndpoint, null),
      now,
      now,
    );
  return { findingId, status: "open" };
}

async function executeHttpRequest(step: NativeAutomationStep, context: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = asString(step.params.url, "");
  if (!url) throw new Error("http.request url required");
  const method = asString(step.params.method, "GET").toUpperCase();
  const headers = isRecord(step.params.headers) ? Object.fromEntries(Object.entries(step.params.headers).map(([key, value]) => [key, String(value)])) : {};
  const body = step.params.body === undefined ? undefined : JSON.stringify(step.params.body);
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", ...headers },
  };
  if (method !== "GET" && method !== "HEAD" && body !== undefined) init.body = body;
  const response = await fetch(url, init);
  const text = await response.text();
  return {
    url,
    method,
    status: response.status,
    ok: response.ok,
    body: parseJson(text, text.slice(0, 4000)),
    contextKeys: Object.keys(context),
  };
}

async function executeAiStep(
  workflow: NativeAutomationWorkflow,
  step: NativeAutomationStep,
  input: Record<string, unknown>,
  context: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const modelResult = await callAutomationAiModel<Record<string, unknown>>({
    companyId: workflow.companyId,
    purpose: "draft",
    system:
      "You are an AWOS workflow step. Return strict JSON only. Keep outputs concise, auditable, and safe. Do not claim actions were taken unless the input shows they were.",
    user: JSON.stringify({
      stepType: step.type,
      instruction: asString(step.params.instruction, step.name),
      schema: step.params.schema ?? null,
      input,
      context,
    }),
  });
  return {
    provider: modelResult.provider,
    model: modelResult.model,
    fallbackUsed: modelResult.fallbackUsed,
    result: modelResult.data ?? {
      summary: `${step.type} could not reach a configured model; local fallback preserved the workflow run.`,
    },
  };
}

async function executeAdapterCall(
  workflow: NativeAutomationWorkflow,
  step: NativeAutomationStep,
  input: Record<string, unknown>,
  context: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (typeof step.params.url === "string" && step.params.url.length > 0) {
    return executeHttpRequest({ ...step, type: "http.request" }, context);
  }

  const requestedAdapter = asString(step.params.adapter, "");
  const requestedModel = asString(step.params.model, "");
  const route = requestedAdapter
    ? providerRoute(requestedAdapter, requestedModel || "qwen3-coder:480b")
    : resolveAutomationAiRoute(workflow.companyId);
  if (!route) {
    return {
      status: "not_configured",
      adapter: requestedAdapter || "company-default",
      operation: asString(step.params.operation, "chat.completions"),
      note: "No configured credential was found for this adapter.",
    };
  }

  const operation = asString(step.params.operation, "chat.completions");
  const payload = isRecord(step.params.payload) ? step.params.payload : {};
  const rawMessages = Array.isArray(payload.messages) ? payload.messages : null;
  const messages = rawMessages
    ? rawMessages
        .filter(isRecord)
        .map((message) => ({
          role: asString(message.role, "user") as "system" | "user" | "assistant",
          content: asString(message.content, ""),
        }))
        .filter((message) => message.content.length > 0)
    : [
        {
          role: "user" as const,
          content:
            asString(payload.prompt, null) ??
            asString(step.params.prompt, null) ??
            JSON.stringify({ input, context }),
        },
      ];

  if (!operation.includes("chat") && !operation.includes("completion")) {
    return {
      status: "unsupported_operation",
      adapter: route.provider,
      model: route.model,
      operation,
      supportedOperations: ["chat.completions"],
    };
  }

  try {
    const client = new OpenAI({ apiKey: route.apiKey, baseURL: route.baseUrl });
    const request: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: requestedModel || route.model,
      temperature: typeof payload.temperature === "number" ? payload.temperature : 0.2,
      messages,
    };
    if (payload.responseFormat === "json_object") request.response_format = { type: "json_object" };
    const response = await client.chat.completions.create(request);
    return {
      status: "succeeded",
      adapter: route.provider,
      model: requestedModel || route.model,
      operation,
      output: response.choices[0]?.message?.content ?? "",
      usage: response.usage ?? null,
    };
  } catch (error) {
    return {
      status: "failed",
      adapter: route.provider,
      model: requestedModel || route.model,
      operation,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function executeUtilityStep(
  step: NativeAutomationStep,
  input: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const value = step.params.value ?? step.params.values ?? null;
  switch (step.type) {
    case "json.parse": {
      const raw = asString(step.params.text, "");
      return { parsed: raw ? parseJson(raw, {}) : {}, source: raw ? "params.text" : "empty" };
    }
    case "data.set":
      return { value: isRecord(value) ? value : step.params, source: "params" };
    case "data.extract":
      return { keys: Object.keys(input), extracted: input, contextKeys: Object.keys(context) };
    case "data.filter":
      return { filtered: true, criteria: step.params.criteria ?? null, input };
    case "data.dedupe":
      return { deduped: true, key: step.params.key ?? null, input };
    case "data.transform":
      return { transformed: step.params.mapping ?? step.params, inputKeys: Object.keys(input) };
    case "condition.if":
      return { condition: step.params.condition ?? null, matched: true };
    case "branch.switch":
      return { branch: asString(step.params.defaultBranch, "default"), cases: step.params.cases ?? [] };
    case "loop.each":
      return { itemCount: Array.isArray(step.params.items) ? step.params.items.length : 0 };
    case "merge.join":
      return { mergedContextKeys: Object.keys(context) };
    case "delay.wait":
      return { skippedDelay: true, seconds: step.params.seconds ?? null };
    case "error.catch":
      return { catchReady: true };
    case "email.send":
    case "message.send":
      return { queued: false, preview: step.params, note: "Configure an adapter/webhook to send externally." };
    case "rss.read":
    case "file.read":
    case "file.write":
      return { planned: true, params: step.params };
    case "operator.brief":
      return { brief: asString(step.params.template, "Operator brief generated from workflow context."), contextKeys: Object.keys(context) };
    case "friction.detect":
      return { friction: [], inspectedContextKeys: Object.keys(context) };
    case "evidence.pack":
      return { evidenceKeys: Object.keys(context), workflowEvidence: true };
    case "agent.panel":
      return { requestedRoles: step.params.roles ?? [], status: "panel_requested" };
    case "workflow.self_heal":
      return {
        repairSuggested: true,
        monitor: step.params.monitor ?? {
          window: "24h",
          signals: ["failed_runs", "operator_friction", "stale_dispatch"],
        },
        diagnosis: step.params.diagnosis ?? {
          useConfiguredModel: true,
          includeRunHistory: true,
          includeStepOutputs: true,
        },
        repair: step.params.repair ?? {
          createRepairIssue: true,
          draftFixWorkflow: true,
          maxChangedSteps: 2,
          allowedActions: ["add_guard", "change_params", "insert_approval", "add_evidence", "reroute_agent"],
        },
        approval: step.params.approval ?? {
          required: true,
          approverRole: "CEO",
        },
        evidence: step.params.evidence ?? {
          include: ["hypothesis", "failurePattern", "proposedPatch", "testPlan", "rollbackPlan"],
        },
        successMetric: step.params.successMetric ?? {
          name: "failure_rate",
          target: "decrease",
          compareWindow: "next_10_runs",
        },
        rollback: step.params.rollback ?? {
          keepOriginalDefinition: true,
          revertIfMetricWorsens: true,
        },
        workflowContextKeys: Object.keys(context),
      };
    default:
      return { accepted: true, type: step.type, params: step.params };
  }
}

function asString(value: unknown, fallback: string | null): string {
  return typeof value === "string" && value.length > 0 ? value : (fallback ?? "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function checkN8nBridge(config: Config): Promise<{
  state: "online" | "offline";
  baseUrl: string;
  latencyMs: number | null;
  error: string | null;
  warnings: string[];
}> {
  const baseUrl = (process.env.AUTOMATION_ENGINE_URL || process.env.N8N_BASE_URL || "http://127.0.0.1:5678").replace(/\/$/, "");
  const started = Date.now();
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 1_500);
  const warnings: string[] = [];
  const runtimeDataDir = join(config.dataDir, "n8n");
  if (!existsSync(runtimeDataDir)) {
    try {
      mkdirSync(runtimeDataDir, { recursive: true });
    } catch {
      warnings.push("n8n-local-data-dir-missing");
    }
  }
  try {
    const response = await fetch(`${baseUrl}/healthz`, { signal: ctrl.signal });
    clearTimeout(timeout);
    if (!response.ok) {
      return { state: "offline", baseUrl, latencyMs: Date.now() - started, error: `health returned ${response.status}`, warnings };
    }
    if (warnings.length > 0) {
      warnings.push("n8n-health-is-bridge-only-native-engine-authoritative");
    }
    return { state: "online", baseUrl, latencyMs: Date.now() - started, error: null, warnings };
  } catch (err) {
    clearTimeout(timeout);
    return {
      state: "offline",
      baseUrl,
      latencyMs: null,
      error: err instanceof Error ? err.message : "fetch failed",
      warnings,
    };
  }
}

export function nativeAutomationRuntime(config: Config): {
  mode: "native";
  localOnly: true;
  dataDir: string;
  stateEntries: number;
  customExtensions: string;
} {
  let stateEntries = 0;
  try {
    stateEntries = existsSync(config.dataDir) ? readdirSync(config.dataDir).length : 0;
  } catch {
    stateEntries = 0;
  }
  return {
    mode: "native",
    localOnly: true,
    dataDir: config.dataDir,
    stateEntries,
    customExtensions: "optional-n8n-bridge",
  };
}
