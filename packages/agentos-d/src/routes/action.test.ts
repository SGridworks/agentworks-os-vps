/**
 * Action log route tests — schema-validation + status code contracts.
 *
 * substrate-e2e exercises the full action ingest/query path against a real
 * daemon and database. These unit-style tests cover the route-level shape:
 * what the route accepts, what it rejects, and the row-shape parsing on GET.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";

vi.mock("../db/index.js", () => {
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
    get: vi.fn().mockReturnValue({ count: 0 }),
  };
  return { getDb: () => mockDb };
});

const TENANT = "11111111-1111-1111-1111-111111111111";

function validIngestBody() {
  return {
    tenantId: TENANT,
    actor: { id: "agent-1", type: "agent", label: "Test Agent" },
    actionKind: "outbound.sms",
    payloadSnapshot: { to: "+15551234567", body: "hi" },
  };
}

describe("action log routes", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp(loadConfig({}));
    vi.clearAllMocks();
  });

  describe("POST /api/action", () => {
    it("returns 400 for missing body", async () => {
      const res = await request(app).post("/api/action").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("returns 400 when actor.type is invalid", async () => {
      const res = await request(app)
        .post("/api/action")
        .send({
          ...validIngestBody(),
          actor: { id: "x", type: 42, label: "x" },
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("returns 201 with id and loggedAt when action is logged", async () => {
      const res = await request(app).post("/api/action").send(validIngestBody());
      expect(res.status).toBe(201);
      expect(typeof res.body.id).toBe("string");
      expect(res.body.tenantId).toBe(TENANT);
      expect(typeof res.body.loggedAt).toBe("string");
    });

    it("accepts optional policyDecisionId and proposedAt", async () => {
      const res = await request(app)
        .post("/api/action")
        .send({
          ...validIngestBody(),
          policyDecisionId: "22222222-2222-2222-2222-222222222222",
          proposedAt: new Date().toISOString(),
        });
      expect(res.status).toBe(201);
    });
  });

  describe("GET /api/action", () => {
    it("returns empty list when no actions logged", async () => {
      const mockDb = vi.mocked(await import("../db/index.js")).getDb();
      vi.mocked(mockDb.all).mockReturnValue([]);

      const res = await request(app).get("/api/action");
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
      expect(res.body.total).toBe(0);
    });

    it("parses JSON-encoded fields on each row", async () => {
      const mockDb = vi.mocked(await import("../db/index.js")).getDb();
      const now = new Date().toISOString();
      vi.mocked(mockDb.all).mockReturnValue([
        {
          id: "log-1",
          tenantId: TENANT,
          actorId: "agent-1",
          actorType: "agent",
          actorLabel: "Test",
          actionKind: "outbound.sms",
          payloadSnapshot: JSON.stringify({ to: "+15551234567" }),
          vaultRefs: JSON.stringify([]),
          conversationRefs: JSON.stringify([]),
          projectRefs: JSON.stringify([]),
          policyDecisionId: null,
          proposedAt: now,
          loggedAt: now,
        },
      ]);
      vi.mocked(mockDb.get).mockReturnValue({ count: 1 });

      const res = await request(app).get("/api/action");
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].payloadSnapshot).toEqual({ to: "+15551234567" });
      expect(res.body.items[0].vaultRefs).toEqual([]);
      expect(res.body.total).toBe(1);
    });
  });
});
