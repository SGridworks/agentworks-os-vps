import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.js";
import type { Config } from "../config.js";
import { initDb, resetDb } from "../db/client.js";
import { migrate } from "../db/migrations/index.js";

const TENANT = "11111111-1111-1111-1111-111111111111";

let dataDir: string;
let app: ReturnType<typeof createApp>;

function config(): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    logLevel: "warn",
    awcpVersion: "awcp/v0.1",
    dataDir,
    scannerSidecarUrl: "http://127.0.0.1:0",
    scannerPollIntervalMs: 30_000,
    auditLogRetentionDays: 30,
  };
}

describe("execution routes", () => {
  beforeEach(() => {
    resetDb();
    dataDir = mkdtempSync(join(tmpdir(), "awo-exec-"));
    initDb({ config: config(), migrations: migrate });
    app = createApp(config());
  });

  afterEach(() => {
    resetDb();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("creates the tenant company project issue hierarchy", async () => {
    const company = await request(app)
      .post("/api/companies")
      .send({ tenantId: TENANT, name: "Acme Systems" });
    expect(company.status).toBe(201);

    const project = await request(app)
      .post(`/api/companies/${company.body.id}/projects`)
      .send({ tenantId: TENANT, name: "Execution cutover" });
    expect(project.status).toBe(201);
    expect(project.body.companyId).toBe(company.body.id);

    const issue = await request(app)
      .post(`/api/companies/${company.body.id}/issues`)
      .send({
        tenantId: TENANT,
        projectId: project.body.id,
        title: "Port coordinator daemon",
        priority: "high",
      });
    expect(issue.status).toBe(201);
    expect(issue.body.projectId).toBe(project.body.id);

    const list = await request(app).get(`/api/companies/${company.body.id}/issues`);
    expect(list.status).toBe(200);
    expect(list.body.items[0].title).toBe("Port coordinator daemon");
  });

  it("returns latest run + comment activity per issue (ProcessWatcher contract)", async () => {
    const company = await request(app)
      .post("/api/companies")
      .send({ tenantId: TENANT, name: "Watcher Co" });
    const project = await request(app)
      .post(`/api/companies/${company.body.id}/projects`)
      .send({ tenantId: TENANT, name: "Default" });
    const issue = await request(app)
      .post(`/api/companies/${company.body.id}/issues`)
      .send({
        tenantId: TENANT,
        projectId: project.body.id,
        title: "Watch this",
        priority: "high",
      });

    const before = await request(app).get(`/api/companies/${company.body.id}/issues`);
    expect(before.status).toBe(200);
    expect(before.body.items[0].executionRunId).toBeNull();
    expect(before.body.items[0].latestCommentAt).toBeNull();

    const run = await request(app).post("/api/runs").send({
      tenantId: TENANT,
      companyId: company.body.id,
      issueId: issue.body.id,
      status: "running",
    });
    expect(run.status).toBe(201);

    const comment = await request(app)
      .post(`/api/issues/${issue.body.id}/comments`)
      .send({ body: "checking in" });
    expect(comment.status).toBe(201);

    const after = await request(app).get(`/api/companies/${company.body.id}/issues`);
    expect(after.body.items[0].executionRunId).toBe(run.body.id);
    expect(after.body.items[0].latestCommentAt).toBe(comment.body.createdAt);
  });

  it("supports automation endpoints for costs and webhook intake", async () => {
    const company = await request(app)
      .post("/api/companies")
      .send({ tenantId: TENANT, name: "Automation Co" });
    expect(company.status).toBe(201);

    const cost = await request(app)
      .post(`/api/companies/${company.body.id}/cost-events`)
      .send({
        tenantId: TENANT,
        provider: "openai",
        model: "gpt",
        amountUsd: 1.25,
      });
    expect(cost.status).toBe(201);
    expect(cost.body.amountUsd).toBe(1.25);

    const intake = await request(app)
      .post("/api/webhooks/intake")
      .send({ tenantId: TENANT, eventType: "n8n.workflow", payload: { ok: true } });
    expect(intake.status).toBe(202);
    expect(intake.body.accepted).toBe(true);
  });
});
