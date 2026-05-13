/**
 * Issues Routes — Auto-assign endpoint tests.
 *
 * POST /api/issues/auto-assign
 * GET  /api/issues/lane-match-preview
 *
 * Uses vi.mock to replace the lane-matcher module so that router closures
 * capture the mock. vi.spyOn cannot intercept function references captured
 * in ESM closures — only vi.mock at the module level works.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";

// ---------------------------------------------------------------------------
// Mock lane-matcher module — installed BEFORE the router under test is imported
// ---------------------------------------------------------------------------

// Mutable store so individual tests can change the mock's return value
const mockLaneResult = {
  matched: true as boolean,
  ambiguous: false as boolean,
  role: "BackendEngineer" as string | undefined,
  agentIdPrefix: "79d8066d" as string | undefined,
  reason: "mocked lane match" as string,
};

let callCount = 0;
let lastCallArgs: unknown[] = [];

vi.mock("../services/lane-matcher.js", () => ({
  matchLane: vi.fn(({ issueDescription }: { issueDescription: string }) => {
    callCount++;
    lastCallArgs = [{ issueDescription }];
    return { ...mockLaneResult };
  }),
  loadLaneConfig: vi.fn(() => ({
    roles: {
      BackendEngineer: { agent_id_prefix: "79d8066d", allow: ["^packages/agentos-d/"], description: "" },
      FrontendEngineer: { agent_id_prefix: "8faf4a5a", allow: ["^packages/admin-ui/"], description: "" },
      PythonEngineer: { agent_id_prefix: "6f5da3aa", allow: ["^packages/scanner-worker/"], description: "" },
      TechnicalWriter: { agent_id_prefix: "d2bde45f", allow: ["^docs/"], description: "" },
    },
  })),
  clearLaneConfigCache: vi.fn(),
  extractFilePaths: vi.fn(),
}));

vi.mock("../services/auto-assign.js", () => ({
  autoAssignAgent: vi.fn(async () => ({
    assigneeAgentId: "79d8066d-301c-42d2-b81c-276a6b2bc889",
    reason: "least loaded (mocked)",
    role: "BackendEngineer",
    triage: false,
    candidates: [],
  })),
}));

// ---------------------------------------------------------------------------
// Mock lane-assignments to prevent DB access in tests
// ---------------------------------------------------------------------------
vi.mock("../services/lane-assignments.js", () => ({
  emitLaneAssignment: vi.fn(async () => {}),
  resolveLaneAssignment: vi.fn(async () => undefined),
}));

// ---------------------------------------------------------------------------
// Import router AFTER vi.mock is installed
// ---------------------------------------------------------------------------

import { createIssuesRouter } from "./issues.js";

// ---------------------------------------------------------------------------
// Test app setup
// ---------------------------------------------------------------------------

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/issues", createIssuesRouter({} as any));
  return app;
}

// ---------------------------------------------------------------------------
// Per-test reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Reset mock state
  mockLaneResult.matched = true;
  mockLaneResult.ambiguous = false;
  mockLaneResult.role = "BackendEngineer";
  mockLaneResult.agentIdPrefix = "79d8066d";
  mockLaneResult.reason = "mocked lane match";
  callCount = 0;
  lastCallArgs = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests — POST /api/issues/auto-assign
// ---------------------------------------------------------------------------

describe("POST /api/issues/auto-assign", () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
  });

  it("returns 400 when body is missing", async () => {
    const res = await request(app)
      .post("/api/issues/auto-assign")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("returns 400 when companyId is not a uuid", async () => {
    const res = await request(app)
      .post("/api/issues/auto-assign")
      .send({
        companyId: "not-a-uuid",
        issueId: "00000000-0000-0000-0000-000000000001",
        description: "Fix packages/agentos-d/src/app.ts",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("skips lane matching when currentAssigneeAgentId is set (manual wins)", async () => {
    const res = await request(app)
      .post("/api/issues/auto-assign")
      .send({
        companyId: "00000000-0000-0000-0000-000000000001",
        issueId: "00000000-0000-0000-0000-000000000002",
        description: "Fix packages/agentos-d/src/app.ts",
        currentAssigneeAgentId: "00000000-0000-0000-0000-000000000003",
      });

    expect(res.status).toBe(200);
    expect(res.body.triage).toBe(false);
    expect(res.body.assigneeAgentId).toBe("00000000-0000-0000-0000-000000000003");
    expect(res.body.role).toBeNull();
    expect(res.body.reason).toBe("Manual assignment — lane matching skipped");
  });

  it("skips lane matching when currentAssigneeAgentId is null (manual wins)", async () => {
    const res = await request(app)
      .post("/api/issues/auto-assign")
      .send({
        companyId: "00000000-0000-0000-0000-000000000001",
        issueId: "00000000-0000-0000-0000-000000000002",
        description: "Fix packages/agentos-d/src/app.ts",
        currentAssigneeAgentId: null,
      });

    expect(res.status).toBe(200);
    // null is falsy but !== undefined, so manual assignment wins
    expect(res.body.triage).toBe(false);
    expect(res.body.assigneeAgentId).toBeNull();
    expect(res.body.reason).toBe("Manual assignment — lane matching skipped");
  });

  it("calls lane matcher when no currentAssigneeAgentId", async () => {
    const res = await request(app)
      .post("/api/issues/auto-assign")
      .send({
        companyId: "00000000-0000-0000-0000-000000000001",
        issueId: "00000000-0000-0000-0000-000000000002",
        description: "Fix packages/agentos-d/src/app.ts",
      });

    expect(res.status).toBe(200);
    expect(res.body.triage).toBe(false);
    expect(res.body.matched).toBe(true);
    expect(res.body.role).toBe("BackendEngineer");
    expect(res.body.agentIdPrefix).toBe("79d8066d");
  });

  it("returns triage=true when lane matcher returns no match", async () => {
    mockLaneResult.matched = false;
    mockLaneResult.ambiguous = false;
    mockLaneResult.role = undefined;
    mockLaneResult.agentIdPrefix = undefined;
    mockLaneResult.reason = "No lane matched any of: some/random/path.ts";

    const res = await request(app)
      .post("/api/issues/auto-assign")
      .send({
        companyId: "00000000-0000-0000-0000-000000000001",
        issueId: "00000000-0000-0000-0000-000000000002",
        description: "Fix some/random/path.ts",
      });

    expect(res.status).toBe(200);
    expect(res.body.triage).toBe(true);
    expect(res.body.matched).toBe(false);
  });

  it("returns triage=true when lane matcher returns ambiguous", async () => {
    mockLaneResult.matched = false;
    mockLaneResult.ambiguous = true;
    mockLaneResult.reason =
      "Ambiguous: roles BackendEngineer, FrontendEngineer all scored 1 for: packages/agentos-d/src/app.ts";

    const res = await request(app)
      .post("/api/issues/auto-assign")
      .send({
        companyId: "00000000-0000-0000-0000-000000000001",
        issueId: "00000000-0000-0000-0000-000000000002",
        description: "Fix both admin-ui and agentos-d at the same time",
      });

    expect(res.status).toBe(200);
    expect(res.body.triage).toBe(true);
    expect(res.body.ambiguous).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — GET /api/issues/lane-match-preview
// ---------------------------------------------------------------------------

describe("GET /api/issues/lane-match-preview", () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
  });

  it("returns 400 when description query param is missing", async () => {
    const res = await request(app).get("/api/issues/lane-match-preview");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("description query param required");
  });

  it("returns lane match result for valid description", async () => {
    mockLaneResult.matched = true;
    mockLaneResult.ambiguous = false;
    mockLaneResult.role = "PythonEngineer";
    mockLaneResult.agentIdPrefix = "6f5da3aa";
    mockLaneResult.reason = "Matched PythonEngineer (score=1) for: packages/scanner-worker/main.py";

    const encoded = encodeURIComponent("Fix packages/scanner-worker/main.py");
    const res = await request(app).get(
      `/api/issues/lane-match-preview?description=${encoded}`
    );

    expect(res.status).toBe(200);
    expect(res.body.triage).toBe(false);
    expect(res.body.role).toBe("PythonEngineer");
    expect(res.body.matched).toBe(true);
    expect(res.body.ambiguous).toBe(false);
  });

  it("returns triage=true when no match", async () => {
    mockLaneResult.matched = false;
    mockLaneResult.ambiguous = false;
    mockLaneResult.role = undefined;
    mockLaneResult.reason = "No file paths extracted from description";

    const encoded = encodeURIComponent("A vague issue with no paths");
    const res = await request(app).get(
      `/api/issues/lane-match-preview?description=${encoded}`
    );

    expect(res.status).toBe(200);
    expect(res.body.triage).toBe(true);
    expect(res.body.matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests — GET /api/issues/lanes
// ---------------------------------------------------------------------------

describe("GET /api/issues/lanes", () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
  });

  it("returns the parsed lane config with roles and universalAllow", async () => {
    const res = await request(app).get("/api/issues/lanes");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.roles)).toBe(true);
    expect(res.body.roles.length).toBeGreaterThan(0);
    const backend = res.body.roles.find((r: { role: string }) => r.role === "BackendEngineer");
    expect(backend).toBeDefined();
    expect(backend.agentIdPrefix).toBe("79d8066d");
    expect(Array.isArray(backend.allow)).toBe(true);
    expect(backend.allow).toContain("^packages/agentos-d/");
    expect(Array.isArray(res.body.universalAllow)).toBe(true);
  });

  it("returns 500 when the lane config cannot be loaded", async () => {
    const matcher = (await import("../services/lane-matcher.js")) as unknown as {
      loadLaneConfig: { mockImplementationOnce: (impl: () => unknown) => void };
    };
    matcher.loadLaneConfig.mockImplementationOnce(() => {
      throw new Error("config missing");
    });
    const res = await request(app).get("/api/issues/lanes");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("lane_config_unreadable");
    expect(res.body.message).toBe("config missing");
  });
});
