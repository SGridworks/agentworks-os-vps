/**
 * Dispatch route tests — POST /api/dispatch + lifecycle.
 *
 * Drives a real sqlite via the shared db singleton, isolated per-test
 * via a fresh tmp file. The dispatch_queue migration runs at boot, so
 * inserts go through the real Drizzle path rather than a mock.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.js";
import { initDb, resetDb } from "../db/client.js";
import { migrate } from "../db/migrations/index.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
let dataDir: string;

describe("dispatch routes", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    resetDb();
    dataDir = mkdtempSync(join(tmpdir(), "awo-dispatch-"));
    initDb({
      config: {
        host: "127.0.0.1",
        port: 0,
        logLevel: "warn",
        awcpVersion: "awcp/v0.1",
        dataDir,
        scannerSidecarUrl: "http://127.0.0.1:0",
        scannerPollIntervalMs: 30_000,
        auditLogRetentionDays: 30,
      },
      migrations: migrate,
    });
    app = createApp({
      host: "127.0.0.1",
      port: 0,
      logLevel: "warn",
      awcpVersion: "awcp/v0.1",
      dataDir,
      scannerSidecarUrl: "http://127.0.0.1:0",
      scannerPollIntervalMs: 30_000,
      auditLogRetentionDays: 30,
    });
  });

  afterEach(() => {
    resetDb();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe("POST /api/dispatch", () => {
    it("returns 400 when body is missing required fields", async () => {
      const res = await request(app).post("/api/dispatch").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("rejects taskKind that doesn't match canonical regex", async () => {
      const res = await request(app)
        .post("/api/dispatch")
        .send({
          tenantId: TENANT,
          taskKind: "OutboundSMS",
          targetAgentId: "agent-1",
          input: {},
        });
      expect(res.status).toBe(400);
    });

    it("rejects empty targetAgentId", async () => {
      const res = await request(app)
        .post("/api/dispatch")
        .send({
          tenantId: TENANT,
          taskKind: "outbound.sms",
          targetAgentId: "",
          input: {},
        });
      expect(res.status).toBe(400);
    });

    it("returns 201 with taskId + queued status on a clean dispatch", async () => {
      const res = await request(app)
        .post("/api/dispatch")
        .send({
          tenantId: TENANT,
          taskKind: "outbound.sms",
          targetAgentId: "agent-1",
          input: { to: "+15551234567", body: "hi" },
        });
      expect(res.status).toBe(201);
      expect(res.body.taskId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(res.body.status).toBe("queued");
      expect(res.body.taskKind).toBe("outbound.sms");
    });
  });

  describe("GET /api/dispatch", () => {
    it("returns the freshly-dispatched row", async () => {
      const create = await request(app).post("/api/dispatch").send({
        tenantId: TENANT,
        taskKind: "outbound.sms",
        targetAgentId: "agent-1",
        input: { to: "+15551234567" },
      });
      const taskId = create.body.taskId;

      const list = await request(app).get(`/api/dispatch?tenantId=${TENANT}`);
      expect(list.status).toBe(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0].id).toBe(taskId);
      expect(list.body.items[0].input).toEqual({ to: "+15551234567" });
      expect(list.body.total).toBe(1);
    });

    it("filters by status", async () => {
      await request(app).post("/api/dispatch").send({
        tenantId: TENANT,
        taskKind: "outbound.sms",
        targetAgentId: "agent-1",
        input: {},
      });

      const queued = await request(app).get(`/api/dispatch?status=queued`);
      const completed = await request(app).get(`/api/dispatch?status=completed`);
      expect(queued.body.items.length).toBeGreaterThanOrEqual(1);
      expect(completed.body.items.length).toBe(0);
    });
  });

  describe("GET /api/dispatch/:id", () => {
    it("returns 404 for unknown id", async () => {
      const res = await request(app).get("/api/dispatch/no-such-id");
      expect(res.status).toBe(404);
    });

    it("returns the row with input parsed back to an object", async () => {
      const create = await request(app).post("/api/dispatch").send({
        tenantId: TENANT,
        taskKind: "crm.write",
        targetAgentId: "agent-1",
        input: { record: "lead-123" },
      });
      const res = await request(app).get(`/api/dispatch/${create.body.taskId}`);
      expect(res.status).toBe(200);
      expect(res.body.input).toEqual({ record: "lead-123" });
    });
  });

  describe("PATCH /api/dispatch/:id", () => {
    it("returns 400 when status is missing", async () => {
      const res = await request(app)
        .patch("/api/dispatch/no-such-id")
        .send({});
      expect(res.status).toBe(400);
    });

    it("returns 404 when entry doesn't exist", async () => {
      const res = await request(app)
        .patch("/api/dispatch/no-such-id")
        .send({ status: "completed" });
      expect(res.status).toBe(404);
    });

    it("transitions queued → dispatched and stamps dispatchedAt", async () => {
      const create = await request(app).post("/api/dispatch").send({
        tenantId: TENANT,
        taskKind: "outbound.sms",
        targetAgentId: "agent-1",
        input: {},
      });
      const taskId = create.body.taskId;

      const update = await request(app)
        .patch(`/api/dispatch/${taskId}`)
        .send({ status: "dispatched" });
      expect(update.status).toBe(200);
      expect(update.body.status).toBe("dispatched");
      expect(update.body.dispatchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(update.body.completedAt).toBeNull();
    });

    it("transitions queued→dispatched→completed with timestamps on both steps", async () => {
      const create = await request(app).post("/api/dispatch").send({
        tenantId: TENANT,
        taskKind: "outbound.sms",
        targetAgentId: "agent-1",
        input: {},
      });
      const taskId = create.body.taskId;

      // Step 1: adapter claims the task
      const dispatched = await request(app)
        .patch(`/api/dispatch/${taskId}`)
        .send({ status: "dispatched" });
      expect(dispatched.status).toBe(200);
      expect(dispatched.body.status).toBe("dispatched");
      expect(dispatched.body.dispatchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(dispatched.body.completedAt).toBeNull();

      // Step 2: adapter completes the task
      const completed = await request(app)
        .patch(`/api/dispatch/${taskId}`)
        .send({ status: "completed" });
      expect(completed.status).toBe(200);
      expect(completed.body.status).toBe("completed");
      expect(completed.body.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("rejects queued→completed directly (must go through dispatched)", async () => {
      const create = await request(app).post("/api/dispatch").send({
        tenantId: TENANT,
        taskKind: "outbound.sms",
        targetAgentId: "agent-1",
        input: {},
      });
      const blocked = await request(app)
        .patch(`/api/dispatch/${create.body.taskId}`)
        .send({ status: "completed" });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toBe("invalid_transition");
      expect(blocked.body.current_status).toBe("queued");
      expect(blocked.body.allowed_transitions).toEqual(["dispatched", "failed"]);
    });

    it("captures error on failed transition", async () => {
      const create = await request(app).post("/api/dispatch").send({
        tenantId: TENANT,
        taskKind: "outbound.sms",
        targetAgentId: "agent-1",
        input: {},
      });
      const update = await request(app)
        .patch(`/api/dispatch/${create.body.taskId}`)
        .send({ status: "failed", error: "agent did not acknowledge" });
      expect(update.status).toBe(200);
      expect(update.body.status).toBe("failed");
      expect(update.body.error).toBe("agent did not acknowledge");
    });

    it("rejects completed→dispatched with 409", async () => {
      const create = await request(app).post("/api/dispatch").send({
        tenantId: TENANT,
        taskKind: "outbound.sms",
        targetAgentId: "agent-1",
        input: {},
      });
      const taskId = create.body.taskId;
      // Setup: queued→dispatched→completed
      await request(app).patch(`/api/dispatch/${taskId}`).send({ status: "dispatched" });
      await request(app).patch(`/api/dispatch/${taskId}`).send({ status: "completed" });
      // Attempt to go backwards
      const forbidden = await request(app)
        .patch(`/api/dispatch/${taskId}`)
        .send({ status: "dispatched" });
      expect(forbidden.status).toBe(409);
      expect(forbidden.body.error).toBe("invalid_transition");
      expect(forbidden.body.current_status).toBe("completed");
      expect(forbidden.body.requested_status).toBe("dispatched");
      expect(forbidden.body.allowed_transitions).toEqual([]);
    });

    it("rejects failed→completed with 409", async () => {
      const create = await request(app).post("/api/dispatch").send({
        tenantId: TENANT,
        taskKind: "outbound.sms",
        targetAgentId: "agent-1",
        input: {},
      });
      const taskId = create.body.taskId;
      // Setup: queued→dispatched→failed
      await request(app).patch(`/api/dispatch/${taskId}`).send({ status: "dispatched" });
      await request(app).patch(`/api/dispatch/${taskId}`).send({ status: "failed" });
      // Cannot go from failed to completed
      const forbidden = await request(app)
        .patch(`/api/dispatch/${taskId}`)
        .send({ status: "completed" });
      expect(forbidden.status).toBe(409);
      expect(forbidden.body.error).toBe("invalid_transition");
      expect(forbidden.body.current_status).toBe("failed");
      expect(forbidden.body.allowed_transitions).toEqual([]);
    });

    it("rejects completed→failed with 409", async () => {
      const create = await request(app).post("/api/dispatch").send({
        tenantId: TENANT,
        taskKind: "outbound.sms",
        targetAgentId: "agent-1",
        input: {},
      });
      const taskId = create.body.taskId;
      // Setup: queued→dispatched→completed
      await request(app).patch(`/api/dispatch/${taskId}`).send({ status: "dispatched" });
      await request(app).patch(`/api/dispatch/${taskId}`).send({ status: "completed" });
      // completed→failed is not valid
      const forbidden = await request(app)
        .patch(`/api/dispatch/${taskId}`)
        .send({ status: "failed" });
      expect(forbidden.status).toBe(409);
      expect(forbidden.body.current_status).toBe("completed");
      expect(forbidden.body.allowed_transitions).toEqual([]);
    });

    it("allows dispatched→failed and dispatched→completed", async () => {
      const create = await request(app).post("/api/dispatch").send({
        tenantId: TENANT,
        taskKind: "outbound.sms",
        targetAgentId: "agent-1",
        input: {},
      });
      await request(app)
        .patch(`/api/dispatch/${create.body.taskId}`)
        .send({ status: "dispatched" });
      const toFailed = await request(app)
        .patch(`/api/dispatch/${create.body.taskId}`)
        .send({ status: "failed" });
      expect(toFailed.status).toBe(200);
      expect(toFailed.body.status).toBe("failed");
    });

    it("allows queued→failed", async () => {
      const create = await request(app).post("/api/dispatch").send({
        tenantId: TENANT,
        taskKind: "outbound.sms",
        targetAgentId: "agent-1",
        input: {},
      });
      const toFailed = await request(app)
        .patch(`/api/dispatch/${create.body.taskId}`)
        .send({ status: "failed" });
      expect(toFailed.status).toBe(200);
      expect(toFailed.body.status).toBe("failed");
    });
  });
});
