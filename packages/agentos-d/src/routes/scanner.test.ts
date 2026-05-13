import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

// Capture the real globalThis.fetch once at module load — before any vi.fn() wrappers
// are installed. This is the anchor we restore to in afterEach.
const originalFetch: typeof global.fetch = globalThis.fetch;

describe("scanner routes", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    // Pin to localhost:1 so the "unreachable" test stays deterministic even
    // if the developer has the scanner-worker running on its real port.
    // loadConfig() doesn't expose scannerSidecarUrl through env vars, so we
    // build the Config object inline rather than threading another env hook.
    const base = loadConfig({});
    app = createApp({ ...base, scannerSidecarUrl: "http://127.0.0.1:1" });
    vi.clearAllMocks();
    // Always restore to the real globalThis.fetch before each test.
    // This prevents scanner.test.ts's mock from leaking into other test files
    // when pool=forks+singleFork runs everything in one process.
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("POST /api/scanner/submit", () => {
    it("returns 400 when neither targetUrl nor pasteContent is provided", async () => {
      const res = await request(app)
        .post("/api/scanner/submit")
        .send({ tenantId: "550e8400-e29b-41d4-a716-446655440000" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("returns 400 for invalid UUID", async () => {
      const res = await request(app)
        .post("/api/scanner/submit")
        .send({ tenantId: "not-a-uuid", pasteContent: "test" });
      expect(res.status).toBe(400);
    });

    it("returns 502 when scanner-worker is unreachable", async () => {
      // Mock fetch to throw so the route's try/catch fires and returns 502
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      global.fetch = vi.fn<any>().mockRejectedValue(new Error("ENOTFOUND"));

      const res = await request(app)
        .post("/api/scanner/submit")
        .send({
          tenantId: "550e8400-e29b-41d4-a716-446655440000",
          pasteContent: "test content",
        });
      expect(res.status).toBe(502);
      expect(res.body.error).toBe("scanner_worker_unreachable");
    });
  });

  describe("GET /api/scanner/jobs/:id", () => {
    it("returns 404 when job not found", async () => {
      // Mock fetch to return 404 so the route proxies it correctly
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      global.fetch = vi.fn<any>().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve("not found"),
      });

      const res = await request(app).get("/api/scanner/jobs/nonexistent-id");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/scanner/findings", () => {
    it("persists an automation-submitted finding", async () => {
      const mockDb = vi.mocked(await import("../db/index.js")).getDb();
      const res = await request(app)
        .post("/api/scanner/findings")
        .send({
          tenantId: "550e8400-e29b-41d4-a716-446655440000",
          severity: "high",
          title: "Workflow credential exposure",
          description: "Credential appears in workflow JSON",
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("open");
      expect(mockDb.insert).toHaveBeenCalledOnce();
    });
  });

  describe("GET /api/scanner/findings", () => {
    it("returns paginated findings", async () => {
      const mockDb = vi.mocked(await import("../db/index.js")).getDb();
      vi.mocked(mockDb.select).mockReturnThis();
      vi.mocked(mockDb.from).mockReturnThis();
      vi.mocked(mockDb.where).mockReturnThis();
      vi.mocked(mockDb.orderBy).mockReturnThis();
      vi.mocked(mockDb.limit).mockReturnThis();
      vi.mocked(mockDb.offset).mockReturnThis();
      vi.mocked(mockDb.all).mockReturnValue([
        {
          id: "finding-1",
          tenantId: "tenant-1",
          originId: "origin-1",
          originKind: "scanner_finding",
          severity: "high",
          ruleId: "rule-1",
          title: "Test finding",
          description: "A test",
          remediation: "Fix it",
          affectedEndpoint: null,
          status: "open",
          resolvedBy: null,
          resolvedAt: null,
          resolutionNote: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);
      vi.mocked(mockDb.get).mockReturnValue({ count: 1 });

      const res = await request(app).get("/api/scanner/findings");
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.total).toBe(1);
    });

    it("filters findings by severity", async () => {
      const mockDb = vi.mocked(await import("../db/index.js")).getDb();
      vi.mocked(mockDb.select).mockReturnThis();
      vi.mocked(mockDb.from).mockReturnThis();
      vi.mocked(mockDb.where).mockReturnThis();
      vi.mocked(mockDb.orderBy).mockReturnThis();
      vi.mocked(mockDb.limit).mockReturnThis();
      vi.mocked(mockDb.offset).mockReturnThis();
      vi.mocked(mockDb.all).mockReturnValue([]);
      vi.mocked(mockDb.get).mockReturnValue({ count: 0 });

      const res = await request(app).get("/api/scanner/findings?severity=critical");
      expect(res.status).toBe(200);
      // Invalid severity is silently ignored (logs warning)
      expect(res.body.items).toHaveLength(0);
    });
  });

  describe("GET /api/scanner/health", () => {
    it("returns healthy when scanner-worker responds 200", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            scannerVersion: "0.1.0",
            definitionsLoaded: true,
            definitionsCount: 47,
          }),
      });
      // @ts-ignore — override fetch for this test scope
      global.fetch = mockFetch;

      const res = await request(app).get("/api/scanner/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("healthy");
      expect(res.body.scannerVersion).toBe("0.1.0");
      expect(res.body.definitionsCount).toBe(47);
    });

    it("returns 503 when scanner-worker is unreachable", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app).get("/api/scanner/health");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("unhealthy");
      expect(res.body.reason).toBe("scanner_worker_unreachable");
    });

    it("returns 503 when scanner-worker returns non-200", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: () => Promise.resolve({ reason: "definitions_failed_to_load" }),
      });
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app).get("/api/scanner/health");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("unhealthy");
    });
  });

  describe("POST /api/scanner/batch", () => {
    const validBatch = {
      tenantId: "550e8400-e29b-41d4-a716-446655440000",
      targets: [
        { type: "claude_md", path: "/test/.claude.md", content: "# Test" },
        { type: "cursorrules", path: "/test/.cursorrules", content: "[]" },
      ],
      policyMode: "shadow",
      priority: "standard",
    };

    it("returns 400 when targets array is empty", async () => {
      const res = await request(app)
        .post("/api/scanner/batch")
        .send({ tenantId: "550e8400-e29b-41d4-a716-446655440000", targets: [] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("returns 400 for invalid target type", async () => {
      const res = await request(app)
        .post("/api/scanner/batch")
        .send({
          tenantId: "550e8400-e29b-41d4-a716-446655440000",
          targets: [{ type: "invalid_type", path: "/test", content: "x" }],
        });
      expect(res.status).toBe(400);
    });

    it("returns 502 when scanner-worker is unreachable", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app).post("/api/scanner/batch").send(validBatch);
      expect(res.status).toBe(502);
      expect(res.body.error).toBe("scanner_worker_unreachable");
    });

    it("returns 501 when scanner-worker returns 404 (not implemented)", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve("Not Found"),
      });
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app).post("/api/scanner/batch").send(validBatch);
      expect(res.status).toBe(501);
      expect(res.body.error).toBe("batch_not_implemented");
    });

    it("returns 202 with normalized snake_case keys when scanner-worker returns 202", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 202,
        json: () =>
          Promise.resolve({
            batch_id: "batch-123",
            status: "queued",
            targetCount: 2,
            estimatedSeconds: 30,
          }),
      });
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app).post("/api/scanner/batch").send(validBatch);
      expect(res.status).toBe(202);
      expect(res.body.batchId).toBe("batch-123");
      expect(res.body.status).toBe("queued");
      expect(res.body.targetCount).toBe(2);
      expect(res.body.estimatedSeconds).toBe(30);
    });

    it("uses client-provided batchId if supplied", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 202,
        json: () =>
          Promise.resolve({
            batch_id: "client-batch-456",
            status: "queued",
            targetCount: 2,
          }),
      });
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app)
        .post("/api/scanner/batch")
        .send({ ...validBatch, batchId: "client-batch-456" });
      expect(res.status).toBe(202);
      expect(res.body.batchId).toBe("client-batch-456");
    });
  });

  describe("PATCH /api/scanner/findings/:id", () => {
    it("returns 404 when finding does not exist", async () => {
      const mockDb = vi.mocked(await import("../db/index.js")).getDb();
      vi.mocked(mockDb.select).mockReturnThis();
      vi.mocked(mockDb.from).mockReturnThis();
      vi.mocked(mockDb.where).mockReturnThis();
      vi.mocked(mockDb.get).mockReturnValue(null);

      const res = await request(app)
        .patch("/api/scanner/findings/nonexistent")
        .send({ status: "resolved" });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/scanner/jobs/:id/sarif", () => {
    const sarifBody = JSON.stringify({
      version: "2.1.0",
      runs: [
        {
          results: [
            {
              ruleId: "AWCP-001",
              level: "error",
              message: { text: "Hardcoded credential detected" },
              locations: [{ physicalLocation: { artifactLocation: { uri: "src/auth.ts" } } }],
            },
          ],
        },
      ],
    });

    it("returns SARIF 2.1.0 with correct content-type when job exists", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(sarifBody),
        headers: new Headers({ "content-type": "application/json" }),
      });
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app).get("/api/scanner/jobs/scan-123/sarif");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      const parsed = JSON.parse(res.text);
      expect(parsed.version).toBe("2.1.0");
      expect(parsed.runs[0].results[0].ruleId).toBe("AWCP-001");
    });

    it("returns 404 when job not found", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve("not found"),
      });
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app).get("/api/scanner/jobs/nonexistent/sarif");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });

    it("returns 503 when scanner-worker is unavailable", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve(""),
      });
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app).get("/api/scanner/jobs/scan-123/sarif");
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("scanner_unavailable");
    });

    it("returns 502 when scanner-worker is unreachable", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app).get("/api/scanner/jobs/scan-123/sarif");
      expect(res.status).toBe(502);
      expect(res.body.error).toBe("scanner_worker_unreachable");
    });
  });

  describe("GET /api/scanner/jobs/:id/json", () => {
    const jsonFindings = JSON.stringify({
      scanId: "scan-123",
      status: "complete",
      findings: [
        {
          id: "finding-1",
          ruleId: "AWCP-001",
          severity: "high",
          title: "Hardcoded credential",
          description: "A hardcoded credential was detected",
          location: { file: "src/auth.ts", line: 42 },
          remediation: "Remove the credential and use environment variables",
        },
      ],
    });

    it("returns findings JSON with correct content-type when job exists", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(jsonFindings),
        headers: new Headers({ "content-type": "application/json" }),
      });
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app).get("/api/scanner/jobs/scan-123/json");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      const parsed = JSON.parse(res.text);
      expect(parsed.scanId).toBe("scan-123");
      expect(parsed.findings[0].ruleId).toBe("AWCP-001");
    });

    it("returns 404 when job not found", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve("not found"),
      });
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app).get("/api/scanner/jobs/nonexistent/json");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });

    it("returns 503 when scanner-worker is unavailable", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve(""),
      });
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app).get("/api/scanner/jobs/scan-123/json");
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("scanner_unavailable");
    });

    it("returns 502 when scanner-worker is unreachable", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app).get("/api/scanner/jobs/scan-123/json");
      expect(res.status).toBe(502);
      expect(res.body.error).toBe("scanner_worker_unreachable");
    });
  });
});
