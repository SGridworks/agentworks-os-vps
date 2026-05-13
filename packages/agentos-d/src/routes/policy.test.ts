/**
 * Policy route tests — schema-validation + 404 path coverage.
 *
 * The substrate-e2e suite exercises the full policy.check pipeline against
 * a real daemon and database. These unit-style tests cover the route-level
 * contract: request shape acceptance/rejection, status codes, override 404.
 *
 * The DB is mocked because we don't care about persistence here — only that
 * the route hands valid requests through and rejects invalid ones with the
 * conventional `{ error: "invalid_request", details: ... }` body.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";

const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  offset: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnThis(),
  values: vi.fn().mockReturnThis(),
  run: vi.fn().mockReturnThis(),
  all: vi.fn().mockReturnValue([]),
  get: vi.fn().mockReturnValue(null),
  update: vi.fn().mockReturnThis(),
  set: vi.fn().mockReturnThis(),
};

vi.mock("../db/index.js", () => ({
  getDb: () => mockDb,
}));

// pause-service.ts imports db/client.js directly, so mock it separately
vi.mock("../db/client.js", () => ({
  getDb: () => mockDb,
  initDb: vi.fn(),
  resetDb: vi.fn(),
}));

const TENANT = "11111111-1111-1111-1111-111111111111";
const ACTION = "00000000-0000-0000-0000-000000000099";

function validEvaluateBody() {
  return {
    requestId: "22222222-2222-2222-2222-222222222222",
    proposedAt: new Date().toISOString(),
    tenantId: TENANT,
    actor: { id: "agent-1", type: "agent", label: "Test Agent" },
    actionKind: "outbound.sms",
    payload: { summary: "send hello" },
    context: { vaultRefs: [], conversationRefs: [], projectRefs: [], meta: {} },
    proposedAction: { kind: "outbound.sms", summary: "send hello" },
    evidenceSnapshot: { dnc_status: false },
  };
}

describe("policy routes", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp(loadConfig({}));
  });

  describe("POST /api/policy/evaluate", () => {
    it("returns 400 for missing body", async () => {
      const res = await request(app).post("/api/policy/evaluate").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_action_envelope");
    });

    it("returns 400 for malformed body — non-uuid tenantId", async () => {
      const res = await request(app)
        .post("/api/policy/evaluate")
        .send({ ...validEvaluateBody(), tenantId: "not-a-uuid" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_action_envelope");
    });

    it("returns 201 with default_allow when consent path is unset", async () => {
      const res = await request(app).post("/api/policy/evaluate").send(validEvaluateBody());
      expect(res.status).toBe(201);
      expect(res.body.decision).toBe("allow");
      expect(res.body.decisionReason).toBe("default_allow");
      expect(typeof res.body.decisionId).toBe("string");
      expect(typeof res.body.actionId).toBe("string");
    });

    it("routes to review when consent.verified=false", async () => {
      const res = await request(app)
        .post("/api/policy/evaluate")
        .send({
          ...validEvaluateBody(),
          consent: { source: "verbal", verified: false },
        });
      expect(res.status).toBe(201);
      expect(res.body.decision).toBe("route_to_review");
      expect(res.body.decisionReason).toBe("unverified_consent_requires_review");
    });

    it("honors explicit shadowMode flag in response", async () => {
      const res = await request(app)
        .post("/api/policy/evaluate")
        .send({ ...validEvaluateBody(), shadowMode: true });
      expect(res.status).toBe(201);
      expect(res.body.shadowMode).toBe(true);
    });
  });

  describe("PATCH /api/policy/decisions/:id/override", () => {
    it("returns 400 when override body is missing originalDecision", async () => {
      const res = await request(app)
        .patch(`/api/policy/decisions/${ACTION}/override`)
        .send({
          overriddenBy: "user-1",
          overriddenByLabel: "Admin",
          overrideReason: "test",
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("returns 404 when decision not found", async () => {
      const mockDb = vi.mocked(await import("../db/index.js")).getDb();
      vi.mocked(mockDb.get).mockReturnValue(null);

      const res = await request(app)
        .patch(`/api/policy/decisions/${ACTION}/override`)
        .send({
          overriddenBy: "user-1",
          overriddenByLabel: "Admin",
          originalDecision: "block",
          overrideReason: "test",
        });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });
  });

  describe("GET /api/policy/decisions", () => {
    it("returns empty list when no decisions exist", async () => {
      const mockDb = vi.mocked(await import("../db/index.js")).getDb();
      vi.mocked(mockDb.all).mockReturnValue([]);
      vi.mocked(mockDb.get).mockReturnValue({ count: 0 });

      const res = await request(app).get("/api/policy/decisions");
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(0);
      expect(res.body.total).toBe(0);
    });
  });
});
