/**
 * Webhook firing test.
 *
 * Spins up a local HTTP server, registers it as a tenant webhook, then
 * triggers notifyTenantEvent and asserts the POST landed with the expected
 * body and HMAC signature header.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { initDb, resetDb, getDb } from "./db/client.js";
import { migrate } from "./db/migrations/index.js";
import { tenantWebhooks } from "./db/schema.js";
import { notifyTenantEvent, fireWebhook } from "./webhooks.js";

// Capture the real globalThis.fetch at module load time — before any vi.fn
// wrappers are installed in the shared singleFork process.
const REAL_FETCH: typeof global.fetch = globalThis.fetch;

let tmpRoot: string;
let server: Server;
let serverUrl: { current: string } = { current: "pending" };
let received: { headers: IncomingMessage["headers"]; body: string }[] = [];

async function startMockServer(): Promise<void> {
  received = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
  });

  return new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        serverUrl.current = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
}

async function stopMockServer(): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

beforeEach(async () => {
  resetDb();
  tmpRoot = mkdtempSync(join(tmpdir(), "awo-webhook-"));
  initDb({
    config: {
      host: "127.0.0.1",
      port: 0,
      logLevel: "warn",
      awcpVersion: "awcp/v0.1",
      dataDir: tmpRoot,
      scannerSidecarUrl: "http://127.0.0.1:0",
      scannerPollIntervalMs: 30_000,
      auditLogRetentionDays: 30,
    },
    migrations: migrate,
  });
  await startMockServer();
});

afterEach(async () => {
  await stopMockServer();
  resetDb();
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

describe("webhook firing", () => {
  it("fireWebhook POSTs JSON and returns ok", async () => {
    const result = await fireWebhook(serverUrl.current, {
      event: "approval_queue.enqueued",
      tenantId: "t-1",
      occurredAt: new Date().toISOString(),
      data: { foo: "bar" },
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(received).toHaveLength(1);
    const r = received[0]!;
    expect(r.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(r.body) as { event: string; data: { foo: string } };
    expect(body.event).toBe("approval_queue.enqueued");
    expect(body.data.foo).toBe("bar");
  });

  it("attaches HMAC signature when secret is provided", async () => {
    const secret = "shhhh";
    await fireWebhook(serverUrl.current, {
      event: "approval_queue.enqueued",
      tenantId: "t-1",
      occurredAt: "2026-04-28T00:00:00Z",
      data: {},
    }, secret);
    const r = received[0]!;
    const sig = r.headers["x-agentworks-signature"];
    expect(typeof sig).toBe("string");
    const expected = `sha256=${createHmac("sha256", secret).update(r.body).digest("hex")}`;
    expect(sig).toBe(expected);
  });

  it("omits signature header when no secret", async () => {
    await fireWebhook(serverUrl.current, {
      event: "x",
      tenantId: "t-1",
      occurredAt: "2026-04-28T00:00:00Z",
      data: {},
    });
    expect(received[0]!.headers["x-agentworks-signature"]).toBeUndefined();
  });

  it("notifyTenantEvent fans out only to subscribed enabled webhooks", async () => {
    const tenantId = "11111111-1111-1111-1111-111111111111";
    const now = new Date().toISOString();
    const db = getDb();
    db.insert(tenantWebhooks).values([
      {
        id: "w1",
        tenantId,
        url: serverUrl.current,
        events: JSON.stringify(["approval_queue.enqueued"]),
        secret: null,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "w2",
        tenantId,
        url: serverUrl.current,
        events: JSON.stringify(["policy.block"]),
        secret: null,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "w3",
        tenantId,
        url: serverUrl.current,
        events: JSON.stringify(["approval_queue.enqueued"]),
        secret: null,
        enabled: false, // disabled — must not fire
        createdAt: now,
        updatedAt: now,
      },
    ]).run();

    const result = await notifyTenantEvent(tenantId, "approval_queue.enqueued", {
      hello: "world",
    });
    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(0);
    expect(received).toHaveLength(1);
  });

  it('"*" wildcard subscription receives every event', async () => {
    const tenantId = "11111111-1111-1111-1111-111111111111";
    const now = new Date().toISOString();
    const db = getDb();
    db.insert(tenantWebhooks).values({
      id: "w-wild",
      tenantId,
      url: serverUrl.current,
      events: JSON.stringify(["*"]),
      secret: null,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }).run();

    await notifyTenantEvent(tenantId, "approval_queue.enqueued", {});
    await notifyTenantEvent(tenantId, "policy.block", {});

    expect(received).toHaveLength(2);
  });

  it("network failures don't throw — fire-and-forget", async () => {
    const result = await fireWebhook("http://127.0.0.1:1", {
      event: "x",
      tenantId: "t-1",
      occurredAt: "2026-04-28T00:00:00Z",
      data: {},
    });
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
  });
});
