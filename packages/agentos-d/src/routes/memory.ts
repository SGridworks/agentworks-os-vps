/**
 * Memory routes — n8n-friendly REST wrappers around the tenant vault.
 *
 * The MCP server (routes/mcp.ts) exposes `memory.read` and `memory.write`
 * for MCP-aware clients (Claude Desktop, Cursor, Codex). These two routes
 * provide the same operations over plain HTTP for n8n custom nodes and
 * any other workflow tool that doesn't speak MCP.
 *
 * Both endpoints are tenant-scoped via the FileVaultStore — a tenant only
 * ever sees its own pages, even if it crafts a key that looks like another
 * tenant's path. Path traversal (`..`, leading `/`) is rejected by the
 * store with a thrown error which we surface as 400.
 *
 * POST /api/memory/read   { tenantId, key }                → page body + meta
 * POST /api/memory/write  { tenantId, key, body, mode? }   → write receipt
 */

import { Router } from "express";
import { z } from "zod";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  FileVaultStore,
  type VaultStore,
  extractWikilinks,
  OperatorMemoryStore,
  OperatorMemoryError,
  lintVault,
  wordCount,
  UsageTracker,
} from "@agentworks/memory";
import { EmbedClient } from "../services/embed-client.js";
import { hybridSearch } from "../services/retrieval.js";
import { recordInsight, listInsights, updateInsight, archiveInsight } from "../services/insights.js";
import { rebuildHotMd } from "../services/hot-md-builder.js";
import { loadPackFromFile } from "@agentworks/policy-engine";
import type { RulePack } from "@agentworks/shared";
import { getDb } from "../db/index.js";
import { getProvenance } from "../services/provenance.js";
import type { Config } from "../config.js";

function vaultRootDir(): string {
  return process.env.VAULT_ROOT ?? join(homedir(), "vault");
}

let _vaultStore: VaultStore | null = null;
export function getVaultStore(): VaultStore {
  if (_vaultStore) return _vaultStore;
  _vaultStore = new FileVaultStore({ root: vaultRootDir() });
  return _vaultStore;
}

let _usageTracker: UsageTracker | null = null;
function getUsageTracker(): UsageTracker {
  if (_usageTracker) return _usageTracker;
  _usageTracker = new UsageTracker(getVaultStore() as FileVaultStore, {
    batchSize: 50,
    flushIntervalMs: 3000, // 3 seconds
  });
  return _usageTracker;
}

// Test-only escape hatch — vitest needs to reset the singleton between
// suites that point at different VAULT_ROOTs. Prod code never calls this.
export function _resetVaultStoreForTesting(): void {
  _vaultStore = null;
  _usageTracker = null;
}

let _operatorStore: OperatorMemoryStore | null = null;
function getOperatorStore(): OperatorMemoryStore {
  if (_operatorStore) return _operatorStore;
  _operatorStore = new OperatorMemoryStore();
  return _operatorStore;
}

export function _resetOperatorStoreForTesting(): void {
  _operatorStore = null;
}

function inferKind(fmType: string | undefined, dir: string): string {
  if (fmType === "policy" || fmType === "runbook" || fmType === "template" || fmType === "evidence" || fmType === "schema" || fmType === "log" || fmType === "note") {
    return fmType;
  }
  if (dir.includes("policies")) return "policy";
  if (dir.includes("runbooks")) return "runbook";
  if (dir.includes("templates")) return "template";
  if (dir.includes("evidence")) return "evidence";
  if (dir.includes("schemas")) return "schema";
  if (dir.includes("logs") || dir.includes("audit")) return "log";
  return "note";
}

export function createMemoryRouter(_config: Config): Router {
  const router = Router();

  // Clean up usage tracker on process exit
  process.on('exit', () => {
    if (_usageTracker) {
      _usageTracker.destroy();
    }
  });

  process.on('SIGINT', () => {
    if (_usageTracker) {
      _usageTracker.destroy();
    }
  });

  process.on('SIGTERM', () => {
    if (_usageTracker) {
      _usageTracker.destroy();
    }
  });

  const ReadRequestSchema = z.object({
    tenantId: z.string().uuid(),
    key: z.string().min(1),
    actorId: z.string().uuid().optional(), // Agent ID for usage tracking
  });

  const WriteRequestSchema = z.object({
    tenantId: z.string().uuid(),
    key: z.string().min(1),
    body: z.string(),
    mode: z.enum(["replace", "append"]).default("replace"),
  });

  router.post("/read", async (req, res) => {
    const parsed = ReadRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    const { tenantId, key, actorId } = parsed.data;
    try {
      const r = await getVaultStore().read(tenantId, key);
      
      // Track usage if actorId is provided and document exists
      if (actorId && r.existed) {
        getUsageTracker().recordUsage(tenantId, key, actorId);
      }
      
      res.status(200).json({
        ok: true,
        data: {
          tenantId: r.tenantId,
          key: r.key,
          body: r.body,
          sha256: r.sha256,
          updatedAt: r.updatedAt,
          existed: r.existed,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "vault read failed";
      res.status(400).json({ ok: false, error: message });
    }
  });

  const GraphRequestSchema = z.object({
    tenantId: z.string().uuid(),
  });

  router.get("/graph", async (req, res) => {
    const parsed = GraphRequestSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    const { tenantId } = parsed.data;
    try {
      const store = getVaultStore();
      if (!store.list) {
        res.status(500).json({ ok: false, error: "vault store does not support list" });
        return;
      }
      const keys = await store.list(tenantId);
      const reads = await Promise.all(keys.map((k) => store.read(tenantId, k)));
      const pages = reads.filter((r) => r.existed);

      const dirHueMap = new Map<string, number>();
      const dirCount = new Map<string, number>();
      const goldenAngle = 137.508;

      const notes = pages.map((p) => {
        const segments = p.key.split("/");
        const dir = segments.length > 1 ? segments.slice(0, -1).join("/") : "";
        const top = dir.split("/")[0] ?? "(root)";
        if (!dirHueMap.has(top)) {
          dirHueMap.set(top, (dirHueMap.size * goldenAngle) % 360);
        }
        dirCount.set(dir, (dirCount.get(dir) ?? 0) + 1);

        const fmTitle = /(?:^|\n)title:\s*(.+)/i.exec(p.body)?.[1]?.trim().replace(/^["']|["']$/g, "");
        const title = fmTitle || segments[segments.length - 1] || p.key;
        const fmType = /(?:^|\n)type:\s*(.+)/i.exec(p.body)?.[1]?.trim().toLowerCase();
        const fmTags = /(?:^|\n)tags:\s*\[([^\]]*)\]/i.exec(p.body)?.[1]
          ?.split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean) ?? [];
        const kind = inferKind(fmType, dir);

        return {
          id: p.key,
          title,
          dir,
          kind,
          tags: fmTags,
          chars: p.body.length,
          edited: p.updatedAt,
          outgoing: 0,
          backlinks: 0,
        };
      });

      const noteIds = new Set(notes.map((n) => n.id));
      const edges: [string, string][] = [];
      const outCount = new Map<string, number>();
      const inCount = new Map<string, number>();

      for (const p of pages) {
        const links = extractWikilinks(p.body);
        for (const wl of links) {
          // best-effort: try wl as-is, then with the page's directory prefix
          let target: string | undefined = noteIds.has(wl) ? wl : undefined;
          if (!target) {
            const dirPrefix = p.key.includes("/") ? p.key.slice(0, p.key.lastIndexOf("/") + 1) : "";
            const candidate = dirPrefix + wl.replace(/^\//, "");
            if (noteIds.has(candidate)) target = candidate;
          }
          if (!target || target === p.key) continue;
          edges.push([p.key, target]);
          outCount.set(p.key, (outCount.get(p.key) ?? 0) + 1);
          inCount.set(target, (inCount.get(target) ?? 0) + 1);
        }
      }

      for (const n of notes) {
        n.outgoing = outCount.get(n.id) ?? 0;
        n.backlinks = inCount.get(n.id) ?? 0;
      }

      const dirs = Array.from(dirCount.entries()).map(([dir, count]) => ({
        dir,
        count,
        hue: dirHueMap.get(dir.split("/")[0] ?? "") ?? 0,
      }));

      res.status(200).json({
        ok: true,
        data: { tenantId, notes, edges, dirs, generatedAt: new Date().toISOString() },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "vault graph failed";
      res.status(500).json({ ok: false, error: message });
    }
  });

  // Operator (claude-code) memory — read-only bridge to ~/vault/memory/.
  // No tenant isolation: this is the operator's own cross-project memory.
  router.get("/operator", async (_req, res) => {
    try {
      const entries = await getOperatorStore().list();
      res.status(200).json({ ok: true, data: { count: entries.length, entries } });
    } catch (err) {
      const message = err instanceof Error ? err.message : "operator list failed";
      res.status(500).json({ ok: false, error: message });
    }
  });

  const OperatorReadRequestSchema = z.object({
    key: z.string().min(1),
  });

  router.post("/operator/read", async (req, res) => {
    const parsed = OperatorReadRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      const r = await getOperatorStore().read(parsed.data.key);
      res.status(200).json({ ok: true, data: r });
    } catch (err) {
      if (err instanceof OperatorMemoryError) {
        res.status(400).json({ ok: false, error: err.code, message: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : "operator read failed";
      res.status(500).json({ ok: false, error: message });
    }
  });

  let embedClient: EmbedClient | null = null;
  const getEmbed = (): EmbedClient => {
    if (!embedClient) embedClient = new EmbedClient();
    return embedClient;
  };

  const SearchRequestSchema = z.object({
    tenantId: z.string().uuid(),
    query: z.string().min(1).max(2000),
    topK: z.number().int().positive().max(200).optional(),
    kinds: z.array(z.enum(["episode", "insight"])).optional(),
  });

  const InsightRequestSchema = z.object({
    tenantId: z.string().uuid(),
    frameType: z.enum(["preference", "fact", "plan", "constraint", "feedback", "error_pattern"]),
    content: z.string().min(1).max(4000),
    source: z.enum(["agent_reflection", "user_correction", "task_outcome", "manual"]),
    subject: z.string().max(240).optional(),
    episodeId: z.string().uuid().optional(),
    importance: z.number().int().min(1).max(5).optional(),
    validated: z.boolean().optional(),
  });

  router.post("/insight", async (req, res) => {
    const parsed = InsightRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      const sqlite = (getDb() as unknown as { $client: import("better-sqlite3").Database }).$client;
      const r = await recordInsight(sqlite, parsed.data, { embedClient: getEmbed() });
      res.status(201).json({ ok: true, data: r });
    } catch (err) {
      const message = err instanceof Error ? err.message : "record_insight failed";
      res.status(500).json({ ok: false, error: message });
    }
  });

  const ListInsightsQuerySchema = z.object({
    tenantId: z.string().uuid(),
    frameType: z
      .enum(["preference", "fact", "plan", "constraint", "feedback", "error_pattern"])
      .optional(),
    subject: z.string().max(240).optional(),
    lifecycle: z.enum(["active", "archived", "invalidated"]).optional(),
    limit: z.coerce.number().int().positive().max(1000).optional(),
  });

  router.get("/insight", (req, res) => {
    const parsed = ListInsightsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      const sqlite = (getDb() as unknown as { $client: import("better-sqlite3").Database }).$client;
      const rows = listInsights(sqlite, parsed.data);
      res.status(200).json({ ok: true, data: { count: rows.length, items: rows } });
    } catch (err) {
      const message = err instanceof Error ? err.message : "list_insights failed";
      res.status(500).json({ ok: false, error: message });
    }
  });

  const UpdateInsightSchema = z.object({
    tenantId: z.string().uuid(),
    content: z.string().min(1).max(4000).optional(),
    validated: z.boolean().optional(),
    importance: z.number().int().min(1).max(5).optional(),
    subject: z.string().max(240).nullable().optional(),
  });

  router.patch("/insight/:id", (req, res) => {
    const id = String(req.params.id);
    const parsed = UpdateInsightSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      const sqlite = (getDb() as unknown as { $client: import("better-sqlite3").Database }).$client;
      const { tenantId, ...rest } = parsed.data;
      const updated = updateInsight(sqlite, tenantId, id, rest);
      res.status(200).json({ ok: true, data: updated });
    } catch (err) {
      const message = err instanceof Error ? err.message : "update_insight failed";
      const status = message === "insight not found" ? 404 : 500;
      res.status(status).json({ ok: false, error: message });
    }
  });

  const ArchiveInsightSchema = z.object({ tenantId: z.string().uuid() });

  router.delete("/insight/:id", (req, res) => {
    const id = String(req.params.id);
    const parsed = ArchiveInsightSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      const sqlite = (getDb() as unknown as { $client: import("better-sqlite3").Database }).$client;
      archiveInsight(sqlite, parsed.data.tenantId, id);
      res.status(200).json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "archive_insight failed";
      const status = message.includes("not found") ? 404 : 500;
      res.status(status).json({ ok: false, error: message });
    }
  });

  router.post("/search", async (req, res) => {
    const parsed = SearchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      const sqlite = (getDb() as unknown as { $client: import("better-sqlite3").Database }).$client;
      const hits = await hybridSearch(sqlite, getEmbed(), parsed.data);
      res.status(200).json({
        ok: true,
        data: { tenantId: parsed.data.tenantId, query: parsed.data.query, count: hits.length, hits },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "search failed";
      res.status(500).json({ ok: false, error: message });
    }
  });

  const LintQuerySchema = z.object({
    tenantId: z.string().uuid(),
  });

  router.get("/lint", async (req, res) => {
    const parsed = LintQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      const report = await lintVault(vaultRootDir(), parsed.data.tenantId);
      res.status(200).json({ ok: true, data: report });
    } catch (err) {
      const message = err instanceof Error ? err.message : "vault lint failed";
      res.status(500).json({ ok: false, error: message });
    }
  });

  const HotCacheQuerySchema = z.object({
    tenantId: z.string().uuid(),
  });

  router.get("/hot-cache", async (req, res) => {
    const parsed = HotCacheQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      const r = await getVaultStore().read(parsed.data.tenantId, "hot");
      res.status(200).json({
        ok: true,
        data: {
          tenantId: parsed.data.tenantId,
          key: "hot",
          existed: r.existed,
          updatedAt: r.updatedAt,
          words: r.existed ? wordCount(r.body) : 0,
          body: r.body,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "hot-cache read failed";
      res.status(500).json({ ok: false, error: message });
    }
  });

  const HotCacheRebuildSchema = z.object({
    tenantId: z.string().uuid(),
  });

  router.post("/hot-cache/rebuild", async (req, res) => {
    const parsed = HotCacheRebuildSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      const db = getDb();
      const vault = getVaultStore();
      const packsDir = process.env.RULE_PACKS_DIR ?? join(process.cwd(), "rule-packs");
      let packs: RulePack[] = [];
      try {
        const pack = await loadPackFromFile(packsDir);
        packs = [pack];
      } catch {
        packs = [];
      }
      const result = await rebuildHotMd({
        db,
        vault,
        tenantId: parsed.data.tenantId,
        packs,
      });
      res.status(200).json({
        ok: true,
        data: {
          tenantId: parsed.data.tenantId,
          words: result.words,
          path: result.path,
          rebuiltAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "hot-cache rebuild failed";
      res.status(500).json({ ok: false, error: message });
    }
  });

  router.post("/write", async (req, res) => {
    const parsed = WriteRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    const { tenantId, key, body, mode } = parsed.data;
    try {
      const w = await getVaultStore().write(tenantId, key, body, { mode });
      res.status(201).json({
        ok: true,
        data: {
          tenantId: w.tenantId,
          key: w.key,
          bytesWritten: w.bytesWritten,
          sha256: w.sha256,
          updatedAt: w.updatedAt,
          mode,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "vault write failed";
      res.status(400).json({ ok: false, error: message });
    }
  });

  const ProvenanceQuerySchema = z.object({
    tenantId: z.string().uuid(),
    key: z.string().min(1).max(512),
  });

  router.get("/provenance", async (req, res) => {
    const parsed = ProvenanceQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    const { tenantId, key } = parsed.data;
    try {
      const provenance = await getProvenance(tenantId, key);
      // For now, we always return provenance data even if document doesn't exist
      // This will be updated when vault store integration is complete
      res.status(200).json({
        ok: true,
        data: provenance,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "provenance query failed";
      res.status(500).json({ ok: false, error: message });
    }
  });

  return router;
}
