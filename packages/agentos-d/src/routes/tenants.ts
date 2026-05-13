/**
 * Tenants routes — registry of customer tenants on this substrate instance.
 *
 *   GET  /api/tenants           — list all tenants
 *   POST /api/tenants           — create a tenant + seed vault directory
 *   GET  /api/tenants/:id       — get one tenant
 *
 * On create, the substrate:
 *   1. Generates a UUID for tenantId
 *   2. Resolves vaultRoot to <VAULT_ROOT>/<tenantId>
 *   3. Creates the directory if missing
 *   4. Writes a row to the tenants table
 *
 * The onboarding wizard calls POST /api/tenants as step 1.
 */

import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { eq, desc } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { tenants, type NewTenantRow } from "../db/schema.js";
import {
  assignPackToTenant,
  listAssignments,
  unassignPackFromTenant,
  DEFAULT_PACK_ID,
} from "../rule-pack-assignments.js";
import type { Config } from "../config.js";

const CreateTenantSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  industry: z
    .enum(["real_estate", "healthcare", "finance", "other"])
    .optional(),
});

function defaultVaultRoot(): string {
  return process.env.VAULT_ROOT ?? join(homedir(), "vault");
}

export function createTenantsRouter(_config: Config): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    const db = getDb();
    const rows = db
      .select()
      .from(tenants)
      .orderBy(desc(tenants.createdAt))
      .all();
    res.json(rows);
  });

  router.post("/", (req, res) => {
    const parsed = CreateTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const vaultRoot = join(defaultVaultRoot(), id);

    try {
      mkdirSync(vaultRoot, { recursive: true });
    } catch (err) {
      res
        .status(500)
        .json({ error: "vault_init_failed", message: String(err) });
      return;
    }

    const row: NewTenantRow = {
      id,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      industry: parsed.data.industry ?? null,
      vaultRoot,
      createdAt: now,
      updatedAt: now,
    };

    const db = getDb();
    db.insert(tenants).values(row).run();

    // Assign the configured default pack so a fresh tenant boots with at
    // least one rule pack subscribed. DEFAULT_PACK_ID is null when the
    // operator set AGENTWORKS_DEFAULT_PACK_ID="" — they want to assign
    // industry-specific packs themselves and not have smb-starter
    // auto-attached.
    if (DEFAULT_PACK_ID) {
      assignPackToTenant(id, DEFAULT_PACK_ID, "enforce");
    }

    res.status(201).json(row);
  });

  router.get("/:id", (req, res) => {
    const db = getDb();
    const row = db
      .select()
      .from(tenants)
      .where(eq(tenants.id, req.params.id))
      .get();
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(row);
  });

  // -------------------------------------------------------------------------
  // PATCH /api/tenants/:id/shadow-mode
  //
  // Operator override of the per-tenant shadow_mode + shadow_until clock.
  //   { shadowMode: true|false, shadowUntil?: ISO8601|null }
  // shadowUntil=null clears the auto-flip clock. Any other ISO datetime sets
  // it. Sending only shadowMode flips the mode immediately.
  // -------------------------------------------------------------------------
  const ShadowModeOverrideSchema = z
    .object({
      shadowMode: z.boolean().optional(),
      shadowUntil: z.string().datetime().nullable().optional(),
    })
    .refine(
      (v) => v.shadowMode !== undefined || v.shadowUntil !== undefined,
      { message: "must include shadowMode or shadowUntil" },
    );

  router.patch("/:id/shadow-mode", (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const parsed = ShadowModeOverrideSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }

    const db = getDb();
    const existing = db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, id))
      .get();
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const now = new Date().toISOString();
    const update: { shadowMode?: boolean; shadowUntil?: string | null; updatedAt: string } = {
      updatedAt: now,
    };
    if (parsed.data.shadowMode !== undefined) update.shadowMode = parsed.data.shadowMode;
    if (parsed.data.shadowUntil !== undefined) update.shadowUntil = parsed.data.shadowUntil;
    db.update(tenants).set(update).where(eq(tenants.id, id)).run();

    const row = db.select().from(tenants).where(eq(tenants.id, id)).get();
    res.json(row);
  });

  // -------------------------------------------------------------------------
  // GET    /api/tenants/:id/rule-packs        — list assigned packs
  // POST   /api/tenants/:id/rule-packs        — assign or update a pack
  // DELETE /api/tenants/:id/rule-packs/:pack  — unassign a pack
  // -------------------------------------------------------------------------
  const AssignSchema = z.object({
    packId: z.string().min(1).max(120),
    mode: z.enum(["enforce", "shadow"]).optional().default("enforce"),
  });

  router.get("/:id/rule-packs", (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const items = listAssignments(id);
    res.json({ items });
  });

  router.post("/:id/rule-packs", (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const db = getDb();
    const tenant = db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, id)).get();
    if (!tenant) {
      res.status(404).json({ error: "tenant_not_found" });
      return;
    }
    const parsed = AssignSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    const row = assignPackToTenant(id, parsed.data.packId, parsed.data.mode);
    res.status(201).json(row);
  });

  router.delete("/:id/rule-packs/:packId", (req, res) => {
    const id = req.params.id;
    const packId = req.params.packId;
    if (!id || !packId) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const removed = unassignPackFromTenant(id, packId);
    if (!removed) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(204).send();
  });

  return router;
}
