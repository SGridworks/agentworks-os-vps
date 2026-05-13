/**
 * Agent routes: inbox-lite with critical-path sorting.
 *
 * GET /api/agents/me/inbox-lite
 *   Query:  agentId, companyId
 *   Returns: { items: IssueWithUnblockCount[] }
 *
 * Sort order:
 *   1. critical priority first
 *   2. unblockCount descending
 *   3. original priority order (critical < high < medium < low)
 *   4. recency descending (newer first)
 */

import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import type { Config } from "../config.js";
import { getSqlite } from "../db/index.js";
import { buildCriticalPath, sortInboxLite, type IssueNode } from "../services/critical-path.js";

const MAX_INSTRUCTIONS_BYTES = 256 * 1024;

function resolveInstructionsAbs(agentsRoot: string, rel: string): string | null {
  const absRoot = path.resolve(agentsRoot);
  const abs = path.resolve(absRoot, rel);
  const within = abs === absRoot || abs.startsWith(absRoot + path.sep);
  if (!within) return null;
  if (!abs.toLowerCase().endsWith(".md")) return null;
  return abs;
}

interface ExecutionIssue {
  id: string;
  identifier: string | null;
  companyId: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  parentIssueId: string | null;
  blockedOn: string[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

function fetchAllOpenIssues(companyId: string): ExecutionIssue[] {
  const rows = getSqlite()
    .prepare(`
      SELECT * FROM execution_issues
      WHERE company_id = ? AND status IN ('todo', 'in_progress', 'blocked', 'review')
      ORDER BY created_at DESC
    `)
    .all(companyId);
  return rows.map(mapIssue);
}

export function createAgentRouter(config: Config): Router {
  const router = Router();
  const agentsRoot = config.agentsRoot;

  router.get("/:agentId/instructions", async (req, res) => {
    const agentId = req.params.agentId;
    if (!z.string().uuid().safeParse(agentId).success) {
      res.status(400).json({ error: "invalid_agent_id" });
      return;
    }
    const row = getSqlite()
      .prepare("SELECT instructions_path FROM execution_agents WHERE id = ?")
      .get(agentId) as { instructions_path: string | null } | undefined;
    if (!row) {
      res.status(404).json({ error: "agent_not_found" });
      return;
    }
    if (!row.instructions_path) {
      res.json({ instructionsPath: null, content: null, exists: false });
      return;
    }
    const abs = resolveInstructionsAbs(agentsRoot, row.instructions_path);
    if (!abs) {
      res.status(400).json({ error: "instructions_path_outside_root", root: agentsRoot });
      return;
    }
    if (!fs.existsSync(abs)) {
      res.json({ instructionsPath: row.instructions_path, content: null, exists: false });
      return;
    }
    const content = await fs.promises.readFile(abs, "utf8");
    res.json({ instructionsPath: row.instructions_path, content, exists: true });
  });

  const PutInstructionsSchema = z.object({
    content: z.string().max(MAX_INSTRUCTIONS_BYTES, "instructions_too_large"),
  });

  router.put("/:agentId/instructions", async (req, res) => {
    const agentId = req.params.agentId;
    if (!z.string().uuid().safeParse(agentId).success) {
      res.status(400).json({ error: "invalid_agent_id" });
      return;
    }
    const parsed = PutInstructionsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
      return;
    }
    const row = getSqlite()
      .prepare("SELECT instructions_path FROM execution_agents WHERE id = ?")
      .get(agentId) as { instructions_path: string | null } | undefined;
    if (!row) {
      res.status(404).json({ error: "agent_not_found" });
      return;
    }
    if (!row.instructions_path) {
      res.status(400).json({ error: "no_instructions_path_set" });
      return;
    }
    const abs = resolveInstructionsAbs(agentsRoot, row.instructions_path);
    if (!abs) {
      res.status(400).json({ error: "instructions_path_outside_root", root: agentsRoot });
      return;
    }
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, parsed.data.content, "utf8");
    res.json({ instructionsPath: row.instructions_path, bytes: Buffer.byteLength(parsed.data.content, "utf8") });
  });

  const InboxLiteQuerySchema = z.object({
    agentId: z.string().uuid(),
    companyId: z.string().uuid(),
  });

  router.get("/me/inbox-lite", async (req, res) => {
    const parsed = InboxLiteQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }

    const { agentId, companyId } = parsed.data;

    try {
      const allOpen = await fetchAllOpenIssues(companyId);
      const agentIssues = allOpen.filter((i) => i.assigneeAgentId === agentId);

      // Build DAG nodes from all open issues (needed for transitive unblock counts)
      const nodes: IssueNode[] = allOpen.map((i) => ({
        id: i.id,
        status: i.status as IssueNode["status"],
        parentId: i.parentIssueId,
        blockedOn: i.blockedOn,
        priority: i.priority,
        createdAt: i.createdAt,
      }));

      const unblockCounts = buildCriticalPath(nodes);
      const sorted = sortInboxLite(
        agentIssues.map((i) => ({
          id: i.id,
          status: i.status as IssueNode["status"],
          parentId: i.parentIssueId,
          blockedOn: i.blockedOn,
          priority: i.priority,
          createdAt: i.createdAt,
        })),
        unblockCounts
      );

      const items = sorted.map((issue) => {
        const full = agentIssues.find((i) => i.id === issue.id)!;
        return {
          ...full,
          unblockCount: unblockCounts.get(issue.id) ?? 0,
        };
      });

      res.json({ items });
    } catch (err) {
      console.error("[agent/inbox-lite] error:", err);
      res.status(500).json({ error: "internal_error", message: (err as Error).message });
    }
  });

  return router;
}

function mapIssue(row: any): ExecutionIssue {
  return {
    id: row.id,
    identifier: row.identifier,
    companyId: row.company_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assigneeAgentId: row.assignee_agent_id,
    parentIssueId: row.parent_issue_id,
    blockedOn: parseBlockedOn(row.blocked_on_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function parseBlockedOn(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
