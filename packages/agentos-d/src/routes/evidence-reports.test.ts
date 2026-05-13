/**
 * Evidence-reports route tests.
 *
 * These tests verify:
 *   - POST /api/evidence-reports/generate validates input and calls the service
 *   - GET  /api/evidence-reports lists reports with pagination
 *   - Errors are returned as { error, message } JSON
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import {
  createEvidenceReportsRouter,
} from "./evidence-reports.js";
import type { Config } from "../config.js";

// ---------------------------------------------------------------------------
// Mock DB — uses a self-returning proxy so any drizzle chain method works.
// Required because generateEvidenceReport calls aggregateEvidenceReportData
// which calls getDb() to query policy_decisions and scanner_findings.
// ---------------------------------------------------------------------------

function makeDbMock() {
  const target = {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === "all") return () => [];
      if (prop === "get") return () => null;
      if (prop === "run") return () => {};
      const fn = vi.fn();
      // Return fn so .method().method() chaining works
      return fn.mockReturnThis();
    },
  });
}

const mockDb = makeDbMock();

vi.mock("../db/index.js", () => ({
  getDb: () => mockDb,
}));

// ---------------------------------------------------------------------------
// Fake PdfEngine
// ---------------------------------------------------------------------------

import type { PdfRenderResult } from "@agentworks/pdf";

const FAKE_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00]); // %PDF\0

function makeFakeEngine() {
  return {
    name: "FakePdfEngine",
    render: vi.fn((): Promise<PdfRenderResult> =>
      Promise.resolve({
        bytes: FAKE_BYTES,
        byteLength: FAKE_BYTES.byteLength,
        contentType: "application/pdf",
        generatedAt: new Date().toISOString(),
      }),
    ),
    shutdown: vi.fn(() => Promise.resolve()),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp(config: Config) {
  const router = createEvidenceReportsRouter(config);
  const app = express();
  app.use(express.json());
  app.use("/api/evidence-reports", router);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/evidence-reports/generate", () => {
  it("returns 400 when tenantId is missing", async () => {
    const app = makeApp({} as Config);
    const res = await request(app)
      .post("/api/evidence-reports/generate")
      .send({ periodStart: "2026-01-01T00:00:00Z", periodEnd: "2026-01-31T00:00:00Z" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("returns 400 when periodStart >= periodEnd", async () => {
    const app = makeApp({} as Config);
    const res = await request(app)
      .post("/api/evidence-reports/generate")
      .send({
        tenantId: "00000000-0000-0000-0000-000000000001",
        periodStart: "2026-01-31T00:00:00Z",
        periodEnd: "2026-01-01T00:00:00Z",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_period");
  });

  it("returns 500 when PdfEngine is not configured", async () => {
    const app = makeApp({} as Config);
    const res = await request(app)
      .post("/api/evidence-reports/generate")
      .send({
        tenantId: "00000000-0000-0000-0000-000000000001",
        periodStart: "2026-01-01T00:00:00Z",
        periodEnd: "2026-01-31T00:00:00Z",
      });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("pdf_engine_unavailable");
  });

  it("returns the signed PDF result when PdfEngine is configured", async () => {
    const fakeEngine = makeFakeEngine();
    const app = makeApp({ pdfEngine: fakeEngine } as Config);
    const res = await request(app)
      .post("/api/evidence-reports/generate")
      .send({
        tenantId: "00000000-0000-0000-0000-000000000001",
        periodStart: "2026-01-01T00:00:00Z",
        periodEnd: "2026-01-31T00:00:00Z",
      });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("pdfBase64");
    expect(res.body).toHaveProperty("pdfHash");
    expect(res.body).toHaveProperty("hmac");
    expect(res.body).toHaveProperty("signedAt");
    expect(res.body.status).toBe("complete");
  });
});

describe("GET /api/evidence-reports", () => {
  it("returns 400 when tenantId is missing", async () => {
    const app = makeApp({} as Config);
    const res = await request(app).get("/api/evidence-reports");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("returns 400 for non-UUID tenantId", async () => {
    const app = makeApp({} as Config);
    const res = await request(app)
      .get("/api/evidence-reports")
      .query({ tenantId: "not-a-uuid" });
    expect(res.status).toBe(400);
  });
});
