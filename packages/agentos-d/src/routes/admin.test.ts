/**
 * Admin routes — scope_violations telemetry.
 *
 * POST /api/admin/scope-violations  — write a violation record
 * GET  /api/admin/scope-violations  — list with optional filters
 * GET  /api/admin/scope-violations/summary — aggregated per-agent summary
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import type { Config } from "../config.js";

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
  groupBy: vi.fn().mockReturnThis(),
};

vi.mock("../db/index.js", () => ({
  getDb: () => mockDb,
}));

vi.mock("../db/client.js", () => ({
  getDb: () => mockDb,
  initDb: vi.fn(),
  resetDb: vi.fn(),
}));

function makeConfig(): Config {
  return {
    companyId: "00000000-0000-4000-8000-000000000001",
    logLevel: "silent",
    sessionSecret: "test-secret",
    listenPort: 0,
    vaultDir: "",
    dataDir: "",
    awosBaseUrl: "http://127.0.0.1:3100",
    awosApiKey: "test",
    jwtSecret: "test",
    googleClientId: "",
    googleClientSecret: "",
    redirectUrl: "",
    allowedOrigins: ["http://localhost:3000"],
    costMeterUrl: "",
    costMeterApiKey: "",
  };
}

describe("POST /api/admin/scope-violations", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp(makeConfig());
  });

  it("returns 201 and the created id", async () => {
    const res = await request(app)
      .post("/api/admin/scope-violations")
      .send({
        revertedFromCommit: "abc123",
        agentRunId: "run-1",
        agentId: "agent-1",
        agentRole: "BackendEngineer",
        files: ["docs/foo.md", "packages/admin-ui/bar.ts"],
        reason: "touched files outside lane",
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("id");
    expect(res.body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(mockDb.insert).toHaveBeenCalled();
    expect(mockDb.values).toHaveBeenCalled();
    expect(mockDb.run).toHaveBeenCalled();
  });

  it("returns 400 for missing required fields", async () => {
    const res = await request(app)
      .post("/api/admin/scope-violations")
      .send({ revertedFromCommit: "abc123" }); // missing files

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("returns 400 for empty files array", async () => {
    const res = await request(app)
      .post("/api/admin/scope-violations")
      .send({ revertedFromCommit: "abc123", files: [] });

    expect(res.status).toBe(400);
  });

  it("returns 400 for wrong type", async () => {
    const res = await request(app)
      .post("/api/admin/scope-violations")
      .send({ revertedFromCommit: 123, files: ["a"] });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/admin/scope-violations", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp(makeConfig());
  });

  it("returns empty items array when no violations", async () => {
    mockDb.all.mockReturnValueOnce([]);

    const res = await request(app).get("/api/admin/scope-violations");

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it("returns violations ordered by revertedAt desc", async () => {
    const rows = [
      {
        id: "id-1",
        revertedFromCommit: "a1",
        agentRunId: null,
        agentId: null,
        agentRole: null,
        files: JSON.stringify(["a.md"]),
        reason: null,
        revertedAt: "2026-01-01T00:00:00Z",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "id-2",
        revertedFromCommit: "a2",
        agentRunId: null,
        agentId: null,
        agentRole: null,
        files: JSON.stringify(["b.md"]),
        reason: null,
        revertedAt: "2026-01-02T00:00:00Z",
        createdAt: "2026-01-02T00:00:00Z",
      },
    ];
    mockDb.all.mockReturnValueOnce(rows);

    const res = await request(app).get("/api/admin/scope-violations");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].revertedFromCommit).toBe("a1"); // desc
    expect(res.body.items[0].files).toEqual(["a.md"]); // parsed from JSON
    expect(res.body.items[1].revertedFromCommit).toBe("a2");
  });

  it("filters by agentId", async () => {
    mockDb.all.mockReturnValueOnce([]);

    const res = await request(app)
      .get("/api/admin/scope-violations")
      .query({ agentId: "backend" });

    expect(res.status).toBe(200);
    expect(mockDb.where).toHaveBeenCalled();
  });

  it("caps limit at 1000", async () => {
    mockDb.all.mockReturnValueOnce([]);

    await request(app)
      .get("/api/admin/scope-violations")
      .query({ limit: "5000" });

    expect(mockDb.limit).toHaveBeenCalledWith(1000);
  });
});

describe("GET /api/admin/scope-violations/summary", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp(makeConfig());
  });

  it("returns empty summaries when no violations", async () => {
    mockDb.all.mockReturnValueOnce([]);

    const res = await request(app).get("/api/admin/scope-violations/summary");

    expect(res.status).toBe(200);
    expect(res.body.summaries).toEqual([]);
  });

  it("aggregates total reverts per agent", async () => {
    // First call: groupBy count query
    mockDb.all.mockReturnValueOnce([
      { agentId: "be", count: 2 },
      { agentId: "fe", count: 1 },
    ]);
    // Second call: recent rows for dir analysis
    mockDb.all.mockReturnValueOnce([
      {
        id: "1",
        agentId: "be",
        files: JSON.stringify(["p/a.ts", "p/b.ts"]),
        revertedFromCommit: "c1",
        agentRunId: null,
        agentRole: null,
        reason: null,
        revertedAt: "2026-01-01T00:00:00Z",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "2",
        agentId: "fe",
        files: JSON.stringify(["ui/x.ts"]),
        revertedFromCommit: "c2",
        agentRunId: null,
        agentRole: null,
        reason: null,
        revertedAt: "2026-01-02T00:00:00Z",
        createdAt: "2026-01-02T00:00:00Z",
      },
    ]);

    const res = await request(app).get("/api/admin/scope-violations/summary");

    expect(res.status).toBe(200);
    const summaries = res.body.summaries as Array<{ agentId: string; totalReverts: number }>;
    const be = summaries.find((s) => s.agentId === "be");
    const fe = summaries.find((s) => s.agentId === "fe");
    expect(be?.totalReverts).toBe(2);
    expect(fe?.totalReverts).toBe(1);
  });
});
