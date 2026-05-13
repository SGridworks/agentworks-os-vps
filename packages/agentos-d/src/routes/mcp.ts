/**
 * MCP (Model Context Protocol) route — JSON-RPC 2.0 over HTTP.
 *
 * Single endpoint:
 *   POST /api/mcp   — JSON-RPC 2.0 envelope, methods listed below
 *
 * Supported methods:
 *   - initialize       — handshake, returns serverInfo + capabilities
 *   - tools/list       — enumerate the four substrate tools
 *   - tools/call      — invoke a tool by name with arguments
 *
 * Tools exposed:
 *   - memory.read      — read a vault page by key (FileVaultStore)
 *   - memory.write     — append/update a vault page (FileVaultStore)
 *   - memory.hot      — read the hot-cache page
 *   - policy.check    — evaluate a proposed action via policy-engine
 *   - activity.log    — write an append-only action log entry
 *
 * Auth: bearer token (same as REST routes). MCP clients send the token
 * via the standard Authorization header on the JSON-RPC POST.
 */

import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { join } from "node:path";
import { homedir } from "node:os";
import { readdirSync, statSync } from "node:fs";
import { FileVaultStore, type VaultStore, MemoryKeyTooLargeError, OperatorMemoryStore, OperatorMemoryError, renderSessionBrief } from "@agentworks/memory";
import { EmbedClient } from "../services/embed-client.js";
import { hybridSearch } from "../services/retrieval.js";
import { recordInsight } from "../services/insights.js";
import { loadPackFromFile, evaluatePacks } from "@agentworks/policy-engine";
import type { ActionEnvelope, RulePack } from "@agentworks/shared";
import { notifyTenantEvent } from "../webhooks.js";
import { resolveTenantShadowMode } from "../shadow-mode.js";
import { getEffectivePacksForTenant } from "../rule-pack-assignments.js";
import { getDb } from "../db/index.js";
import { actionLog, type NewActionLogRow } from "../db/schema.js";
import { logDecision } from "../services/policy/decisionLog.js";
import type { Config } from "../config.js";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "agentos-d";
const SERVER_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// JSON-RPC envelope schemas
// ---------------------------------------------------------------------------

const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

const ok = (id: string | number | null, result: unknown): JsonRpcSuccess => ({
  jsonrpc: "2.0",
  id,
  result,
});

const err = (
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

// ---------------------------------------------------------------------------
// Tool argument schemas
// ---------------------------------------------------------------------------

const MemoryReadArgsSchema = z.object({
  tenantId: z.string().uuid(),
  key: z.string().min(1),
  namespace: z.enum(["tenant", "operator"]).default("tenant"),
});

const MemoryWriteArgsSchema = z.object({
  tenantId: z.string().uuid(),
  key: z.string().min(1),
  body: z.string(),
  mode: z.enum(["replace", "append"]).default("replace"),
});

const MemoryHotArgsSchema = z.object({
  tenantId: z.string().uuid(),
});

const MemoryListArgsSchema = z.object({
  tenantId: z.string().uuid(),
  namespace: z.enum(["tenant", "operator"]).default("tenant"),
});

const MemorySearchArgsSchema = z.object({
  tenantId: z.string().uuid(),
  query: z.string().min(1).max(2000),
  topK: z.number().int().positive().max(200).optional(),
  kinds: z.array(z.enum(["episode", "insight"])).optional(),
});

const MemoryRecordInsightArgsSchema = z.object({
  tenantId: z.string().uuid(),
  frameType: z.enum(["preference", "fact", "plan", "constraint", "feedback", "error_pattern"]),
  content: z.string().min(1).max(4000),
  source: z.enum(["agent_reflection", "user_correction", "task_outcome", "manual"]),
  subject: z.string().max(240).optional(),
  episodeId: z.string().uuid().optional(),
  importance: z.number().int().min(1).max(5).optional(),
  validated: z.boolean().optional(),
});

export const PolicyCheckArgsSchema = z.object({
  tenantId: z.string().uuid(),
  actor: z.object({
    id: z.string(),
    type: z.enum(["human", "agent", "system"]),
    label: z.string(),
  }),
  proposedAction: z.object({
    kind: z.string(),
    summary: z.string(),
  }),
  evidenceSnapshot: z.record(z.unknown()).default({}),
  // Optional. When omitted, falls back to the tenant's effective mode
  // (resolveTenantShadowMode), which honors the auto-flip clock.
  shadowMode: z.boolean().optional(),
});

const ActivityLogArgsSchema = z.object({
  tenantId: z.string().uuid(),
  actor: z.object({
    id: z.string(),
    type: z.enum(["human", "agent", "system"]),
    label: z.string(),
  }),
  actionKind: z.string(),
  payloadSnapshot: z.record(z.unknown()).default({}),
  vaultRefs: z.array(z.string()).default([]),
  conversationRefs: z.array(z.string()).default([]),
  projectRefs: z.array(z.string()).default([]),
});

/** session.close — close a work session, render its brief, and persist it to the vault. */
const SessionCloseArgsSchema = z.object({
  tenantId: z.string().uuid(),
  session: z.object({
    id: z.string(),
    openedAt: z.string(), // ISO-8601
    closedAt: z.string().optional(), // ISO-8601; if omitted, defaults to now
  }),
  events: z
    .array(
      z.object({
        at: z.string(), // ISO-8601
        type: z.string(),
        description: z.string(),
      }),
    )
    .default([]),
});

// ---------------------------------------------------------------------------
// Tool catalog (returned by tools/list)
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "memory.read",
    description:
      "Read a page by key. namespace='tenant' (default) reads from the tenant vault; namespace='operator' reads from the operator's Claude Code auto-memory (read-only, cross-tenant operator preferences/feedback/project notes).",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string", format: "uuid" },
        key: { type: "string", description: "Vault page key, e.g. 'projects/sgridworks' or 'feedback-no-outbound-email-during-build'" },
        namespace: { type: "string", enum: ["tenant", "operator"], default: "tenant" },
      },
      required: ["tenantId", "key"],
    },
  },
  {
    name: "memory.list",
    description:
      "List available pages. namespace='tenant' returns the tenant vault keys; namespace='operator' returns operator Claude Code auto-memory entries with parsed name/description/type metadata for cheap browsing.",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string", format: "uuid" },
        namespace: { type: "string", enum: ["tenant", "operator"], default: "tenant" },
      },
      required: ["tenantId"],
    },
  },
  {
    name: "memory.search",
    description:
      "Hybrid retrieval over episodes + insights. Combines dense (cosine over embeddings) and sparse (FTS5 BM25) ranks via Reciprocal Rank Fusion (k=60). Returns top-k unified hits with score, denseRank, sparseRank, and kind-specific meta. Falls back to sparse-only if the embed sidecar is unavailable.",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string", format: "uuid" },
        query: { type: "string" },
        topK: { type: "number", default: 20, minimum: 1, maximum: 200 },
        kinds: {
          type: "array",
          items: { type: "string", enum: ["episode", "insight"] },
        },
      },
      required: ["tenantId", "query"],
    },
  },
  {
    name: "memory.record_insight",
    description:
      "Persist an atomic, frame-typed insight (preference|fact|plan|constraint|feedback|error_pattern). Embeds content for hybrid retrieval. Use for explicit corrections, recorded preferences, or post-session reflections.",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string", format: "uuid" },
        frameType: {
          type: "string",
          enum: ["preference", "fact", "plan", "constraint", "feedback", "error_pattern"],
        },
        content: { type: "string", description: "1-3 sentences. The insight itself." },
        source: {
          type: "string",
          enum: ["agent_reflection", "user_correction", "task_outcome", "manual"],
        },
        subject: { type: "string", description: "Entity this insight is about (optional)." },
        episodeId: { type: "string", format: "uuid", description: "Link back to an episode (optional)." },
        importance: { type: "number", minimum: 1, maximum: 5, default: 1 },
        validated: { type: "boolean", default: false },
      },
      required: ["tenantId", "frameType", "content", "source"],
    },
  },
  {
    name: "memory.write",
    description:
      "Append or replace a vault page. mode='append' adds to the end with a timestamp; mode='replace' overwrites.",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string", format: "uuid" },
        key: { type: "string" },
        body: { type: "string" },
        mode: { type: "string", enum: ["replace", "append"], default: "replace" },
      },
      required: ["tenantId", "key", "body"],
    },
  },
  {
    name: "memory.hot",
    description:
      "Return the curated hot.md summary for a tenant. Call this before any other vault read to get recent context cheaply. Returns body, updatedAt, sha256, and existed flag.",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string", format: "uuid" },
      },
      required: ["tenantId"],
    },
  },
  {
    name: "policy.check",
    description:
      "Evaluate a proposed action against active rule packs. Returns allow|block|route_to_review with reasons. Use shadowMode=true for advisory-only.",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string", format: "uuid" },
        actor: { type: "object" },
        proposedAction: { type: "object" },
        evidenceSnapshot: { type: "object" },
        shadowMode: { type: "boolean", default: true },
      },
      required: ["tenantId", "actor", "proposedAction"],
    },
  },
  {
    name: "activity.log",
    description:
      "Append an entry to the substrate-wide action log. Returns the log id and loggedAt.",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string", format: "uuid" },
        actor: { type: "object" },
        actionKind: { type: "string" },
        payloadSnapshot: { type: "object" },
        vaultRefs: { type: "array", items: { type: "string" } },
        conversationRefs: { type: "array", items: { type: "string" } },
        projectRefs: { type: "array", items: { type: "string" } },
      },
      required: ["tenantId", "actor", "actionKind"],
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Tool result type
// ---------------------------------------------------------------------------

type ToolResult =
  | { content: Array<{ type: "text"; text: string }>; isError?: false }
  | { content: Array<{ type: "text"; text: string }>; isError: true };

// Lazy-init shared store; defaults to ~/vault/wiki, overridable by VAULT_ROOT.
let _vaultStore: VaultStore | null = null;
function getVaultStore(): VaultStore {
  if (_vaultStore) return _vaultStore;
  const root = process.env.VAULT_ROOT ?? join(homedir(), "vault", "wiki");
  _vaultStore = new FileVaultStore({ root });
  return _vaultStore;
}

let _operatorMemoryStore: OperatorMemoryStore | null = null;
function getOperatorMemoryStore(): OperatorMemoryStore {
  if (_operatorMemoryStore) return _operatorMemoryStore;
  _operatorMemoryStore = new OperatorMemoryStore();
  return _operatorMemoryStore;
}

export function _resetOperatorMemoryStoreForTesting(): void {
  _operatorMemoryStore = null;
}

async function callMemoryRead(
  args: z.infer<typeof MemoryReadArgsSchema>,
  _config: Config,
): Promise<ToolResult> {
  if (args.namespace === "operator") {
    try {
      const r = await getOperatorMemoryStore().read(args.key);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              namespace: "operator",
              tenantId: args.tenantId,
              key: r.key,
              body: r.body,
              name: r.name,
              description: r.description,
              type: r.type,
              updatedAt: r.updatedAt,
              sha256: r.sha256,
              bytes: r.bytes,
              existed: r.existed,
            }),
          },
        ],
      };
    } catch (e) {
      if (e instanceof OperatorMemoryError) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: e.code, message: e.message }) }],
        };
      }
      throw e;
    }
  }

  const store = getVaultStore();
  const r = await store.read(args.tenantId, args.key);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          namespace: "tenant",
          tenantId: r.tenantId,
          key: r.key,
          body: r.body,
          updatedAt: r.updatedAt,
          sha256: r.sha256,
          existed: r.existed,
        }),
      },
    ],
  };
}

let _embedClient: EmbedClient | null = null;
function getEmbedClient(): EmbedClient {
  if (_embedClient) return _embedClient;
  _embedClient = new EmbedClient();
  return _embedClient;
}

export function _resetEmbedClientForTesting(): void {
  _embedClient = null;
}

async function callMemorySearch(
  args: z.infer<typeof MemorySearchArgsSchema>,
  _config: Config,
): Promise<ToolResult> {
  const sqlite = (getDb() as unknown as { $client: import("better-sqlite3").Database }).$client;
  const hits = await hybridSearch(sqlite, getEmbedClient(), {
    tenantId: args.tenantId,
    query: args.query,
    topK: args.topK,
    kinds: args.kinds,
  });
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          tenantId: args.tenantId,
          query: args.query,
          count: hits.length,
          hits,
        }),
      },
    ],
  };
}

async function callMemoryRecordInsight(
  args: z.infer<typeof MemoryRecordInsightArgsSchema>,
  _config: Config,
): Promise<ToolResult> {
  const sqlite = (getDb() as unknown as { $client: import("better-sqlite3").Database }).$client;
  try {
    const r = await recordInsight(
      sqlite,
      {
        tenantId: args.tenantId,
        frameType: args.frameType,
        content: args.content,
        source: args.source,
        subject: args.subject,
        episodeId: args.episodeId,
        importance: args.importance,
        validated: args.validated,
      },
      { embedClient: getEmbedClient() },
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            id: r.id,
            tenantId: args.tenantId,
            frameType: args.frameType,
            embeddingWritten: r.embeddingWritten,
            embeddingModel: r.embeddingModel,
          }),
        },
      ],
    };
  } catch (e) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "record_insight_failed",
            message: e instanceof Error ? e.message : String(e),
          }),
        },
      ],
    };
  }
}

async function callMemoryList(
  args: z.infer<typeof MemoryListArgsSchema>,
  _config: Config,
): Promise<ToolResult> {
  if (args.namespace === "operator") {
    const entries = await getOperatorMemoryStore().list();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            namespace: "operator",
            tenantId: args.tenantId,
            count: entries.length,
            entries,
          }),
        },
      ],
    };
  }

  const store = getVaultStore();
  if (!store.list) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: "list_unsupported" }) }],
    };
  }
  const keys = await store.list(args.tenantId);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          namespace: "tenant",
          tenantId: args.tenantId,
          count: keys.length,
          keys,
        }),
      },
    ],
  };
}

async function callMemoryWrite(
  args: z.infer<typeof MemoryWriteArgsSchema>,
  _config: Config,
): Promise<ToolResult> {
  try {
    const store = getVaultStore();
    const w = await store.write(args.tenantId, args.key, args.body, {
      mode: args.mode,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            tenantId: w.tenantId,
            key: w.key,
            bytesWritten: w.bytesWritten,
            updatedAt: w.updatedAt,
            sha256: w.sha256,
          }),
        },
      ],
    };
  } catch (e) {
    if (e instanceof MemoryKeyTooLargeError) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "key_too_large",
              limit_bytes: e.limitBytes,
              actual_bytes: e.actualBytes,
              suggestion: "split into parts",
            }),
          },
        ],
      };
    }
    throw e;
  }
}

async function callMemoryHot(
  args: z.infer<typeof MemoryHotArgsSchema>,
  _config: Config,
): Promise<ToolResult> {
  const store = getVaultStore();
  const r = await store.read(args.tenantId, "hot");
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          tenantId: r.tenantId,
          key: r.key,
          body: r.body,
          updatedAt: r.updatedAt,
          sha256: r.sha256,
          existed: r.existed,
        }),
      },
    ],
  };
}

// Lazy-load rule packs from RULE_PACKS_DIR (defaults to <repo>/rule-packs).
// Each subdirectory's *.yaml is a candidate pack. Successfully parsed packs
// land in _rulePacks; per-file load errors land in _ruleLoadErrors so
// operators can introspect via GET /api/policy/packs without having to dig
// through container logs. POST /api/policy/packs/reload clears both and
// rescans without bouncing the daemon.
export interface RulePackLoadError {
  /** Absolute path of the YAML file that failed to load. */
  path: string;
  /** Pack subdirectory name (best-effort identifier when pack_id can't be parsed). */
  pack_dir: string;
  /** Error message from the loader. */
  error: string;
}

let _rulePacks: RulePack[] | null = null;
let _ruleLoadErrors: RulePackLoadError[] = [];

/**
 * Clear the in-memory rule pack cache. Next getRulePacks() rescans the
 * RULE_PACKS_DIR. Wired to POST /api/policy/packs/reload so an operator
 * who edits a pack on disk can pick it up without recreating the daemon
 * container.
 */
export function clearRulePackCache(): void {
  _rulePacks = null;
  _ruleLoadErrors = [];
}

/**
 * Most-recent load errors. Surfaced in GET /api/policy/packs as `loadErrors[]`.
 * Empty when every YAML under RULE_PACKS_DIR loaded cleanly.
 */
export function getRulePackLoadErrors(): readonly RulePackLoadError[] {
  return _ruleLoadErrors;
}

export async function getRulePacks(): Promise<RulePack[]> {
  if (_rulePacks) return _rulePacks;
  const root = process.env.RULE_PACKS_DIR ?? join(process.cwd(), "rule-packs");
  const packs: RulePack[] = [];
  const errors: RulePackLoadError[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    _rulePacks = [];
    _ruleLoadErrors = [];
    return _rulePacks;
  }
  for (const sub of entries) {
    const subPath = join(root, sub);
    let isDir = false;
    try {
      isDir = statSync(subPath).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    let files: string[] = [];
    try {
      files = readdirSync(subPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/\.ya?ml$/.test(f)) continue;
      const fullPath = join(subPath, f);
      try {
        // eslint-disable-next-line no-await-in-loop
        const pack = await loadPackFromFile(fullPath);
        packs.push(pack);
      } catch (e) {
        errors.push({
          path: fullPath,
          pack_dir: sub,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  // Industry-specific packs (target_action_kinds set) evaluate before baseline
  // packs (target_action_kinds null/undefined). Within each tier, preserve
  // filesystem order. Without this, an outbound.sms with DNC=true would be
  // blocked by smb-starter's generic SMB-001 rule before TCPA-RE-001 could
  // fire with the proper 47 C.F.R. § 64.1200(c)(2) citation.
  packs.sort((a, b) => {
    const aSpecific = Array.isArray(a.target_action_kinds) ? 0 : 1;
    const bSpecific = Array.isArray(b.target_action_kinds) ? 0 : 1;
    return aSpecific - bSpecific;
  });
  _rulePacks = packs;
  _ruleLoadErrors = errors;
  return _rulePacks;
}

export async function callPolicyCheck(
  args: z.infer<typeof PolicyCheckArgsSchema>,
  _config: Config,
): Promise<ToolResult> {
  const db = getDb();
  const now = new Date().toISOString();
  const decisionId = randomUUID();
  const actionId = randomUUID();

  const allPacks = await getRulePacks();
  // Filter to the tenant's subscribed packs. Tenants with zero assignments
  // get every loaded pack (safe default — see getEffectivePacksForTenant).
  const packs = getEffectivePacksForTenant(args.tenantId, allPacks);
  let decision: "allow" | "block" | "route_to_review" = "allow";
  let decisionReason = "default_allow";
  let matchedRulePackId: string | null = null;
  let matchedRulePackVersion: string | null = null;

  // Resolve effective shadowMode once (per-request arg wins, else tenant
  // default with auto-flip). Hoisted outside the packs-empty branch so the
  // policy_decisions row + auto-enqueue gate read the same value.
  const tenantShadow = resolveTenantShadowMode(args.tenantId);
  const effectiveShadowMode = args.shadowMode ?? tenantShadow.shadowMode;

  if (packs.length > 0) {
    // Canonical RFC 001 ActionEnvelope. Rules read snake_case fields like
    // action_kind, dnc_status, consent.source from payload; spread the
    // evidence into payload so they're visible to evaluateCondition.
    const envelope: ActionEnvelope = {
      requestId: actionId,
      proposedAt: now,
      tenantId: args.tenantId,
      actor: args.actor,
      actionKind: args.proposedAction.kind,
      payload: {
        action_kind: args.proposedAction.kind,
        summary: args.proposedAction.summary,
        ...args.evidenceSnapshot,
      },
      context: {
        vaultRefs: [],
        conversationRefs: [],
        projectRefs: [],
        meta: { ...args.evidenceSnapshot, action_kind: args.proposedAction.kind },
      },
      reviewed: false,
    };

    const result = evaluatePacks(packs, envelope, effectiveShadowMode);
    decision = result.decision;
    decisionReason = result.reason;
    if (result.matchedRule) {
      const matchedRuleId = result.matchedRule.rule_id;
      const matchedPack = packs.find((p) =>
        p.rules.some((r) => r.rule_id === matchedRuleId),
      );
      matchedRulePackId = matchedPack?.pack_id ?? null;
      matchedRulePackVersion = matchedPack?.pack_version ?? null;
    }
  }

  // logDecision handles the hash chain, row insert, and auto-enqueue.
  // It returns { decisionId, approvalQueueId }.
  const { decisionId: loggedDecisionId, approvalQueueId } = logDecision({
    tenantId: args.tenantId,
    actionId,
    actor: args.actor,
    proposedAction: args.proposedAction,
    evidenceSnapshot: args.evidenceSnapshot,
    decision,
    decisionReason,
    shadowMode: effectiveShadowMode,
    rulePackId: matchedRulePackId,
    rulePackVersion: matchedRulePackVersion,
  });

  // Fire-and-forget webhook fan-out. Failures are logged in webhooks.ts;
  // they must never block the policy.check response.
  if (approvalQueueId !== null) {
    void notifyTenantEvent(args.tenantId, "approval_queue.enqueued", {
      approvalQueueId,
      policyDecisionId: loggedDecisionId,
      proposedActionKind: args.proposedAction.kind,
      proposedActionSummary: args.proposedAction.summary,
      actorLabel: args.actor.label,
      decisionReason,
    });
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          decisionId: loggedDecisionId,
          actionId,
          decision,
          decisionReason,
          shadowMode: effectiveShadowMode,
          rulePackId: matchedRulePackId,
          rulePackVersion: matchedRulePackVersion,
          approvalQueueId,
          createdAt: now,
        }),
      },
    ],
  };
}

async function callActivityLog(
  args: z.infer<typeof ActivityLogArgsSchema>,
  _config: Config,
): Promise<ToolResult> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const row: NewActionLogRow = {
    id,
    tenantId: args.tenantId,
    actorId: args.actor.id,
    actorType: args.actor.type,
    actorLabel: args.actor.label,
    actionKind: args.actionKind,
    payloadSnapshot: JSON.stringify(args.payloadSnapshot),
    vaultRefs: JSON.stringify(args.vaultRefs),
    conversationRefs: JSON.stringify(args.conversationRefs),
    projectRefs: JSON.stringify(args.projectRefs),
    policyDecisionId: null,
    proposedAt: now,
    loggedAt: now,
  };
  getDb().insert(actionLog).values(row).run();
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ id, tenantId: args.tenantId, loggedAt: now }),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// tools/call dispatcher
// ---------------------------------------------------------------------------

async function dispatchToolCall(
  name: string,
  rawArgs: unknown,
  config: Config,
): Promise<ToolResult> {
  switch (name) {
    case "memory.read": {
      const parsed = MemoryReadArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          isError: true,
          content: [
            { type: "text", text: JSON.stringify({ error: "invalid_args", issues: parsed.error.flatten() }) },
          ],
        };
      }
      return callMemoryRead(parsed.data, config);
    }
    case "memory.write": {
      const parsed = MemoryWriteArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          isError: true,
          content: [
            { type: "text", text: JSON.stringify({ error: "invalid_args", issues: parsed.error.flatten() }) },
          ],
        };
      }
      return callMemoryWrite(parsed.data, config);
    }
    case "memory.hot": {
      const parsed = MemoryHotArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          isError: true,
          content: [
            { type: "text", text: JSON.stringify({ error: "invalid_args", issues: parsed.error.flatten() }) },
          ],
        };
      }
      return callMemoryHot(parsed.data, config);
    }
    case "memory.list": {
      const parsed = MemoryListArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          isError: true,
          content: [
            { type: "text", text: JSON.stringify({ error: "invalid_args", issues: parsed.error.flatten() }) },
          ],
        };
      }
      return callMemoryList(parsed.data, config);
    }
    case "memory.search": {
      const parsed = MemorySearchArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          isError: true,
          content: [
            { type: "text", text: JSON.stringify({ error: "invalid_args", issues: parsed.error.flatten() }) },
          ],
        };
      }
      return callMemorySearch(parsed.data, config);
    }
    case "memory.record_insight": {
      const parsed = MemoryRecordInsightArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          isError: true,
          content: [
            { type: "text", text: JSON.stringify({ error: "invalid_args", issues: parsed.error.flatten() }) },
          ],
        };
      }
      return callMemoryRecordInsight(parsed.data, config);
    }
    case "policy.check": {
      const parsed = PolicyCheckArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          isError: true,
          content: [
            { type: "text", text: JSON.stringify({ error: "invalid_args", issues: parsed.error.flatten() }) },
          ],
        };
      }
      return callPolicyCheck(parsed.data, config);
    }
    case "activity.log": {
      const parsed = ActivityLogArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          isError: true,
          content: [
            { type: "text", text: JSON.stringify({ error: "invalid_args", issues: parsed.error.flatten() }) },
          ],
        };
      }
      return callActivityLog(parsed.data, config);
    }
    default:
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: "unknown_tool", name }) }],
      };
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createMcpRouter(config: Config): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    const parsed = JsonRpcRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(200).json(err(null, -32600, "Invalid Request", parsed.error.flatten()));
      return;
    }
    const reqMsg: JsonRpcRequest = parsed.data;
    const id = reqMsg.id ?? null;

    try {
      switch (reqMsg.method) {
        case "initialize": {
          res.status(200).json(
            ok(id, {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            }),
          );
          return;
        }
        case "tools/list": {
          res.status(200).json(ok(id, { tools: TOOLS }));
          return;
        }
        case "tools/call": {
          const callParams = z
            .object({ name: z.string(), arguments: z.unknown().optional() })
            .safeParse(reqMsg.params);
          if (!callParams.success) {
            res
              .status(200)
              .json(err(id, -32602, "Invalid params", callParams.error.flatten()));
            return;
          }
          const result = await dispatchToolCall(
            callParams.data.name,
            callParams.data.arguments ?? {},
            config,
          );
          res.status(200).json(ok(id, result));
          return;
        }
        default:
          res.status(200).json(err(id, -32601, `Method not found: ${reqMsg.method}`));
          return;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(200).json(err(id, -32603, "Internal error", msg));
    }
  });

  return router;
}
