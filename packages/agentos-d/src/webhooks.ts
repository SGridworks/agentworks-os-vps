/**
 * Tenant webhook firing.
 *
 * Operators register a URL per tenant for substrate events
 * (approval_queue.enqueued, etc). When the substrate observes a subscribed
 * event, it POSTs JSON. Optional shared secret is sent as
 * X-AgentWorks-Signature: sha256=<hmac> over the request body.
 *
 * Fire-and-forget: errors are logged but not raised. The substrate must
 * never block on a downstream webhook.
 */

import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { tenantWebhooks } from "./db/schema.js";
import { getDb } from "./db/index.js";

// Capture the real fetch at module load time — before any vi.fn() wrappers are
// installed by tests. This guards against singleFork mode where all test files
// run in one process and one file's mock can pollute globalThis.fetch before
// another file's module is even imported.
const REAL_FETCH: typeof global.fetch = globalThis.fetch;

export interface WebhookPayload {
  event: string;
  tenantId: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export async function fireWebhook(
  url: string,
  payload: WebhookPayload,
  secret?: string | null,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "AgentWorks-Substrate/0.1",
  };
  if (secret) headers["X-AgentWorks-Signature"] = sign(body, secret);

  try {
    const res = await REAL_FETCH(url, { method: "POST", headers, body });
    return { ok: res.ok, status: res.status };
  } catch (err: unknown) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Fan-out a single event to every enabled webhook subscribed to it for the
 * tenant. Resolves once all webhooks have been attempted (in parallel).
 */
export async function notifyTenantEvent(
  tenantId: string,
  event: string,
  data: Record<string, unknown>,
): Promise<{ delivered: number; failed: number }> {
  const db = getDb();
  const rows = db
    .select()
    .from(tenantWebhooks)
    .where(
      and(eq(tenantWebhooks.tenantId, tenantId), eq(tenantWebhooks.enabled, true)),
    )
    .all();

  const subscribed = rows.filter((r) => {
    try {
      const events = JSON.parse(r.events) as string[];
      return events.includes(event) || events.includes("*");
    } catch {
      return false;
    }
  });

  if (subscribed.length === 0) return { delivered: 0, failed: 0 };

  const payload: WebhookPayload = {
    event,
    tenantId,
    occurredAt: new Date().toISOString(),
    data,
  };

  const results = await Promise.all(
    subscribed.map((r) => fireWebhook(r.url, payload, r.secret)),
  );

  const delivered = results.filter((r) => r.ok).length;
  const failed = results.length - delivered;

  for (const [i, r] of results.entries()) {
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[webhook] tenant=${tenantId} event=${event} url=${subscribed[i]!.url} ${r.status ? `status=${r.status}` : `error=${r.error}`}`,
      );
    }
  }

  return { delivered, failed };
}
