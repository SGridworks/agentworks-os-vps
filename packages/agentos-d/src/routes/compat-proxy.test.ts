import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.js";
import type { Config } from "../config.js";
import { initDb, resetDb } from "../db/client.js";
import { getDb } from "../db/index.js";
import { migrate } from "../db/migrations/index.js";
import { compatProxyEvents } from "../db/schema.js";

let dataDir: string;

function testConfig(port: number, enabled = true): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    logLevel: "warn",
    awcpVersion: "awcp/v0.1",
    dataDir,
    scannerSidecarUrl: "http://127.0.0.1:0",
    scannerPollIntervalMs: 30_000,
    auditLogRetentionDays: 30,
    companyId: "00000000-0000-4000-8000-000000000001",
    standingIssueId: "standing",
    legacyAdapterUrl: `http://127.0.0.1:${port}`,
    legacyAdapterApiKey: "local-trusted",
    legacyAdapterEnabled: enabled,
    logger: {
      fatal: () => undefined,
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
      trace: () => undefined,
    } as unknown as Config["logger"],
  };
}

async function startUpstream(
  handler: http.RequestListener,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no test port");
  return {
    port: address.port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe("compat proxy", () => {
  const closers: Array<() => Promise<void>> = [];

  beforeEach(() => {
    resetDb();
    dataDir = mkdtempSync(join(tmpdir(), "awo-compat-"));
    initDb({ config: testConfig(0), migrations: migrate });
  });

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    resetDb();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("forwards allowlisted legacy GET routes and preserves auth headers", async () => {
    let seenAuth = "";
    let seenUrl = "";
    const upstream = await startUpstream((req, res) => {
      seenAuth = req.headers.authorization ?? "";
      seenUrl = req.url ?? "";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ items: [{ identifier: "AWO-1" }] }));
    });
    closers.push(upstream.close);

    const app = createApp(testConfig(upstream.port));
    const res = await request(app)
      .get("/api/companies/company-1/issues?status=todo")
      .set("Authorization", "Bearer daemon-token");

    expect(res.status).toBe(200);
    expect(res.body.items[0].identifier).toBe("AWO-1");
    expect(seenAuth).toBe("Bearer daemon-token");
    expect(seenUrl).toBe("/api/companies/company-1/issues?status=todo");
    expect(res.headers["x-agentworks-compat-proxy"]).toBe("agentos-d");

    const rows = getDb().select().from(compatProxyEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].method).toBe("GET");
    expect(rows[0].path).toBe("/api/companies/company-1/issues?status=todo");
    expect(rows[0].statusCode).toBe(200);
    expect(rows[0].requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(rows[0].responseHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("forwards JSON bodies for daemon mutations", async () => {
    let body = "";
    const upstream = await startUpstream((req, res) => {
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      });
    });
    closers.push(upstream.close);

    const app = createApp(testConfig(upstream.port));
    const res = await request(app)
      .post("/api/agents/agent-1/wakeup")
      .set("X-Paperclip-Run-Id", "run-123")
      .send({ payload: { issueId: "issue-1" } });

    expect(res.status).toBe(200);
    expect(JSON.parse(body)).toEqual({ payload: { issueId: "issue-1" } });
    const rows = getDb().select().from(compatProxyEvents).all();
    expect(rows[0].runId).toBe("run-123");
    expect(rows[0].requestBytes).toBeGreaterThan(0);
  });

  it("does not forward unrelated paths", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.statusCode = 500;
      res.end("should not be called");
    });
    closers.push(upstream.close);

    const app = createApp(testConfig(upstream.port));
    const res = await request(app).get("/api/not-a-legacy-route");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
    expect(getDb().select().from(compatProxyEvents).all()).toHaveLength(0);
  });
});
