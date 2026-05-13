/**
 * onboarding.ts — endpoints consumed by the admin-ui onboarding wizard
 * to detect installed AI editors and write back the agentos-mcp-stdio
 * entry so the substrate is auto-paired at first chat.
 *
 * POST /api/onboarding/detect-editors -> { editors: [{ id, label, configPath, present }] }
 * POST /api/onboarding/write-config   -> { results: [{ id, configPath, written, message }] }
 *
 * POST /api/onboarding/initialize    -> { tenantId, vaultRoot }  (step 2 orchestrator)
 *
 * Filesystem writes are idempotent: existing entries under other keys are
 * preserved, the "agentworks" server key is upserted in place.
 */

import express, { type Router } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Config } from "../config.js";
import { getDb } from "../db/index.js";
import { tenants, type NewTenantRow } from "../db/schema.js";
import {
  assignPackToTenant,
  listAssignments,
  unassignPackFromTenant,
} from "../rule-pack-assignments.js";

interface EditorTarget {
  id: string;
  label: string;
  configPath: string;
}

const SERVER_KEY = "agentworks";
const STDIO_BIN = "agentos-mcp-stdio";

function editorTargets(): EditorTarget[] {
  const home = os.homedir();
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      configPath: path.join(home, ".claude", "mcp.json"),
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      configPath: path.join(home, ".config", "Claude", "claude_desktop_config.json"),
    },
    {
      id: "cursor",
      label: "Cursor",
      configPath: path.join(home, ".cursor", "mcp.json"),
    },
  ];
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

interface McpConfigShape {
  mcpServers?: Record<string, { command?: string; args?: string[] }>;
}

async function mergeServerEntry(configPath: string): Promise<{ written: boolean; message: string }> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  let existing: McpConfigShape = {};
  if (await pathExists(configPath)) {
    try {
      const raw = await fs.readFile(configPath, "utf8");
      existing = raw.trim() ? (JSON.parse(raw) as McpConfigShape) : {};
    } catch (err) {
      return { written: false, message: `parse_failed: ${(err as Error).message}` };
    }
  }
  const servers = existing.mcpServers ?? {};
  const desired = { command: STDIO_BIN, args: [] as string[] };
  const current = servers[SERVER_KEY];
  const alreadyEqual =
    current && current.command === desired.command &&
    JSON.stringify(current.args ?? []) === JSON.stringify(desired.args);
  if (alreadyEqual) {
    return { written: false, message: "already_present" };
  }
  servers[SERVER_KEY] = desired;
  existing.mcpServers = servers;
  await fs.writeFile(configPath, JSON.stringify(existing, null, 2) + "\n", "utf8");
  return { written: true, message: current ? "updated" : "added" };
}

const WriteConfigBody = z.object({
  reviewerId: z.string().min(1),
  editorIds: z.array(z.string().min(1)).min(1),
});

export function createOnboardingRouter(_config: Config): Router {
  const router = express.Router();

  router.post("/detect-editors", async (_req, res) => {
    const targets = editorTargets();
    const editors = await Promise.all(
      targets.map(async (t) => ({
        id: t.id,
        label: t.label,
        configPath: t.configPath,
        present: await pathExists(t.configPath),
      })),
    );
    res.json({ editors });
  });

  router.post("/write-config", async (req, res) => {
    const parsed = WriteConfigBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
      return;
    }
    const { editorIds } = parsed.data;
    const targets = editorTargets();
    const requested = targets.filter((t) => editorIds.includes(t.id));
    if (requested.length === 0) {
      res.status(400).json({ error: "unknown_editor_ids" });
      return;
    }
    const results = await Promise.all(
      requested.map(async (t) => {
        try {
          const r = await mergeServerEntry(t.configPath);
          return { id: t.id, configPath: t.configPath, ...r };
        } catch (err) {
          return {
            id: t.id,
            configPath: t.configPath,
            written: false,
            message: `write_failed: ${(err as Error).message}`,
          };
        }
      }),
    );
    res.json({ results });
  });

  // ---------------------------------------------------------------------------
  // POST /api/onboarding/initialize
  //
  // Orchestrates the full onboarding tenant creation in a single call:
  //   1. Create tenant row + vault directory
  //   2. Assign the user-selected rule pack (in shadow mode per design doc)
  //   3. Seed the vault with an empty .agentworks marker so first-agent can
  //      detect it exists and offer to populate it from memory.
  //
  // This replaces the previous multi-step flow where createTenant() was called
  // alone and always assigned smb-starter regardless of UI selection.
  // ---------------------------------------------------------------------------
  const InitializeBody = z.object({
    tenantName: z.string().min(1).max(120),
    tenantDescription: z.string().max(2000).optional(),
    industry: z
      .enum(["real_estate", "healthcare", "finance", "other"])
      .optional(),
    selectedPack: z.enum(["minimal", "standard", "blank"]).default("minimal"),
  });

  function defaultVaultRoot(): string {
    return process.env.VAULT_ROOT ?? join(homedir(), "vault", "wiki");
  }

  router.post("/initialize", (req, res) => {
    const parsed = InitializeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }

    const { tenantName, tenantDescription, industry, selectedPack } = parsed.data;

    // Map UI pack IDs to real pack IDs on disk.
    // 'minimal' and 'standard' map to smb-starter (the only pre-seeded pack).
    // 'blank' intentionally assigns no pack — tenant starts with zero rules.
    const packId = selectedPack === "blank" ? null : "smb-starter";

    const id = randomUUID();
    const now = new Date().toISOString();
    const vaultRoot = join(defaultVaultRoot(), id);

    // 1. Create vault directory
    try {
      mkdirSync(vaultRoot, { recursive: true });
    } catch (err) {
      res.status(500).json({ error: "vault_init_failed", message: String(err) });
      return;
    }

    // 2. Insert tenant row
    const row: NewTenantRow = {
      id,
      name: tenantName,
      description: tenantDescription ?? null,
      industry: industry ?? null,
      vaultRoot,
      createdAt: now,
      updatedAt: now,
    };

    let db;
    try {
      db = getDb();
    } catch (err) {
      res.status(500).json({ error: "db_init_failed", message: String(err) });
      return;
    }

    try {
      db.insert(tenants).values(row).run();
    } catch (err) {
      res.status(500).json({ error: "tenant_insert_failed", message: String(err) });
      return;
    }

    // 3. Assign selected pack in shadow mode (shadow = observing, not blocking)
    if (packId) {
      try {
        assignPackToTenant(id, packId, "shadow");
      } catch (err) {
        // Non-fatal: tenant is created. Pack can be assigned manually later.
        console.error(`[onboarding] pack assignment failed for tenant ${id}:`, err);
      }
    }

    // 4. Seed vault — write a .agentworks marker file so the memory package
    //    can detect this vault belongs to AgentWorks OS and offer to populate it.
    try {
      const markerPath = join(vaultRoot, ".agentworks");
      const markerContent = JSON.stringify(
        {
          version: "1",
          tenantId: id,
          tenantName,
          createdAt: now,
        },
        null,
        2,
      );
      fs.writeFile(markerPath, markerContent, "utf8");
    } catch (err) {
      console.error(`[onboarding] vault marker write failed for ${vaultRoot}:`, err);
      // Non-fatal — vault directory was created successfully.
    }

    res.status(201).json({ tenantId: id, vaultRoot });
  });

  return router;
}
