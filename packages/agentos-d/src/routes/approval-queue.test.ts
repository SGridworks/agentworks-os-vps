/**
 * Approval-queue route tests — list + review path coverage.
 *
 * Substrate-e2e exercises the full enqueue → review flow end-to-end. These
 * unit tests pin the route surface: list shape, single-entry 404, review
 * schema validation, review status code transitions.
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
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    run: vi.fn().mockReturnThis(),
    all: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(null),
  };
  return { getDb: () => mockDb };
});

const TENANT = "11111111-1111-1111-1111-111111111111";

function validReviewBody() {
  return {
    reviewedBy: "user-1",
    reviewedByLabel: "Admin",
    reviewDecision: "approve",
    reviewNote: "looks good",
  };
}

describe("approval-queue routes", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp(loadConfig({}));
    vi.clearAllMocks();
  });

  describe("POST /api/approval-queue", () => {
    it("enqueues an automation approval", async () => {
      const mockDb = vi.mocked(await import("../db/index.js")).getDb();
      const res = await request(app)
        .post("/api/approval-queue")
        .send({
          tenantId: TENANT,
          proposedActionKind: "issue.close",
          proposedActionSummary: "Close AWO-1",
          decisionReason: "Needs operator review",
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("pending");
      expect(res.body.tenantId).toBe(TENANT);
      expect(mockDb.insert).toHaveBeenCalledTimes(2);
    });
  });

  describe("GET /api/approval-queue", () => {
    it("returns empty list when queue is empty", async () => {
      const mockDb = vi.mocked(await import("../db/index.js")).getDb();
      vi.mocked(mockDb.all).mockReturnValue([]);
      vi.mocked(mockDb.get).mockReturnValue({ count: 0 });

      const res = await request(app).get("/api/approval-queue");
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(0);
      expect(res.body.total).toBe(0);
    });

    it("returns pending approvals", async () => {
      const mockDb = vi.mocked(await import("../db/index.js")).getDb();
      const now = new Date().toISOString();
      vi.mocked(mockDb.all).mockReturnValue([
        {
          id: "aq-1",
          policyDecisionId: "pd-1",
          tenantId: TENANT,
          actorLabel: "Test Agent",
          proposedActionKind: "outbound.sms",
          proposedActionSummary: "send hello",
          decisionReason: "unverified_consent",
          status: "pending",
          reviewedBy: null,
          reviewedByLabel: null,
          reviewNote: null,
          reviewedAt: null,
          createdAt: now,
          updatedAt: now,
        },
      ]);
      vi.mocked(mockDb.get).mockReturnValue({ count: 1 });

      const res = await request(app).get("/api/approval-queue");
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].id).toBe("aq-1");
      expect(res.body.total).toBe(1);
    });
  });

  describe("GET /api/approval-queue/:id", () => {
    it("returns 404 when entry not found", async () => {
      const mockDb = vi.mocked(await import("../db/index.js")).getDb();
      vi.mocked(mockDb.get).mockReturnValue(null);

      const res = await request(app).get("/api/approval-queue/nonexistent");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });
  });

  describe("PATCH /api/approval-queue/:id/review", () => {
    it("returns 400 for missing review body", async () => {
      const res = await request(app)
        .patch("/api/approval-queue/aq-1/review")
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("returns 400 for invalid reviewDecision value", async () => {
      const res = await request(app)
        .patch("/api/approval-queue/aq-1/review")
        .send({ ...validReviewBody(), reviewDecision: "maybe" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("returns 404 when entry not found", async () => {
      const mockDb = vi.mocked(await import("../db/index.js")).getDb();
      vi.mocked(mockDb.get).mockReturnValue(null);

      const res = await request(app)
        .patch("/api/approval-queue/nonexistent/review")
        .send(validReviewBody());
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });

    it("returns 409 when entry is already reviewed", async () => {
      const mockDb = vi.mocked(await import("../db/index.js")).getDb();
      vi.mocked(mockDb.get).mockReturnValue({
        id: "aq-1",
        status: "approved",
        policyDecisionId: "pd-1",
      });

      const res = await request(app)
        .patch("/api/approval-queue/aq-1/review")
        .send(validReviewBody());
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("already_reviewed");
    });
  });
});
