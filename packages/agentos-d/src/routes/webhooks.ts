/**
 * Tenant webhook CRUD routes.
 *
 *   POST   /api/tenants/:tenantId/webhooks    register a webhook
 *   GET    /api/tenants/:tenantId/webhooks    list webhooks for a tenant
 *   DELETE /api/webhooks/:id                  delete a webhook
 *
 * Substrate fires JSON POSTs to registered URLs on subscribed events
 * (e.g. approval_queue.enqueued). See packages/agentos-d/src/webhooks.ts.
 */

import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { tenantWebhooks, type NewTenantWebhookRow } from "../db/schema.js";
import type { Config } from "../config.js";

const KNOWN_EVENTS = ["approval_queue.enqueued", "policy.block", "*"] as const;

const RegisterSchema = z.object({
  url: z.string().url(),
  events: z
    .array(z.enum(KNOWN_EVENTS))
    .min(1)
    .default(["approval_queue.enqueued"]),
  secret: z.string().min(8).max(256).optional(),
});

export function createWebhooksRouter(_config: Config): Router {
  const router = Router({ mergeParams: true });

  router.post("/:tenantId/webhooks", (req, res) => {
    const tenantId = req.params.tenantId;
    if (!tenantId || !/^[0-9a-f-]{36}$/i.test(tenantId)) {
      res.status(400).json({ error: "invalid_tenant_id" });
      return;
    }
    const parsed = RegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }

    const now = new Date().toISOString();
    const row: NewTenantWebhookRow = {
      id: randomUUID(),
      tenantId,
      url: parsed.data.url,
      events: JSON.stringify(parsed.data.events),
      secret: parsed.data.secret ?? null,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    const db = getDb();
    db.insert(tenantWebhooks).values(row).run();

    res.status(201).json({
      id: row.id,
      tenantId: row.tenantId,
      url: row.url,
      events: parsed.data.events,
      hasSecret: !!parsed.data.secret,
      enabled: true,
      createdAt: row.createdAt,
    });
  });

  router.get("/:tenantId/webhooks", (req, res) => {
    const tenantId = req.params.tenantId;
    if (!tenantId) {
      res.status(400).json({ error: "invalid_tenant_id" });
      return;
    }
    const db = getDb();
    const rows = db
      .select()
      .from(tenantWebhooks)
      .where(eq(tenantWebhooks.tenantId, tenantId))
      .all();

    res.json({
      items: rows.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        url: r.url,
        events: safeParseEvents(r.events),
        hasSecret: !!r.secret,
        enabled: r.enabled,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    });
  });

  return router;
}

export function createWebhooksAdminRouter(_config: Config): Router {
  const router = Router();

  router.delete("/:id", (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const db = getDb();
    const result = db.delete(tenantWebhooks).where(eq(tenantWebhooks.id, id)).run();
    if ((result.changes ?? 0) === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(204).send();
  });

  return router;
}

function safeParseEvents(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
