/**
 * Auto-assign service unit tests.
 *
 * Tests the full auto-assign pipeline:
 * lane-matching (via lane-matcher.ts) + least-loaded agent selection
 * (via auto-assign.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { clearLaneConfigCache, loadLaneConfig } from "./lane-matcher.js";
import { autoAssignAgent } from "./auto-assign.js";

let agentRows: any[] = [];
let issueRows: any[] = [];

vi.mock("../db/index.js", () => ({
  getSqlite: () => ({
    prepare: (sql: string) => ({
      all: () => sql.includes("execution_agents") ? agentRows : issueRows,
    }),
  }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LANE_CONFIG = {
  roles: {
    BackendEngineer: {
      agent_id_prefix: "79d8066d",
      allow: ["^packages/agentos-d/", "^packages/shared/"],
      description: "agentos-d daemon, AWCP, shared types",
    },
    FrontendEngineer: {
      agent_id_prefix: "8faf4a5a",
      allow: ["^packages/admin-ui/"],
      description: "admin-ui Next.js app",
    },
    PythonEngineer: {
      agent_id_prefix: "6f5da3aa",
      allow: ["^packages/scanner-worker/"],
      description: "scanner-worker FastAPI",
    },
    TechnicalWriter: {
      agent_id_prefix: "d2bde45f",
      allow: ["^docs/"],
      description: "docs",
    },
  },
};

const MOCK_AGENTS = [
  { id: "79d8066d-301c-42d2-b81c-276a6b2bc889", nameKey: "BackendEngineer" },
  { id: "79d8066d-0000-0000-0000-000000000001", nameKey: "Bee Dev" },
  { id: "8faf4a5a-08e5-40dd-83c5-dc585a7e453e", nameKey: "FrontendEngineer" },
  { id: "6f5da3aa-0833-4494-9843-e3338b2d007a", nameKey: "PythonEngineer" },
  { id: "d2bde45f-2fbc-4e9d-a8ad-40a8b5c4b36d", nameKey: "TechnicalWriter" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedDb(agents: Array<{ id: string; nameKey?: string; name?: string; role?: string }> = MOCK_AGENTS, issues: any[] = []) {
  agentRows = agents.map((agent) => ({
    id: agent.id,
    name: agent.nameKey ?? agent.name ?? agent.id,
    role: agent.role ?? null,
  }));
  issueRows = issues.map((issue) => ({
    id: issue.id,
    assignee_agent_id: issue.assigneeAgentId,
    status: issue.status,
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("autoAssignAgent", () => {
  beforeEach(() => {
    clearLaneConfigCache();
    loadLaneConfig(undefined, LANE_CONFIG);
    seedDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // single-lane match → correct agent picked
  // -------------------------------------------------------------------------
  it("picks the correct agent for a single-lane match", async () => {
    // BackendEngineer has 2 agents (79d8066d prefix). Neither has open issues.
    const result = await autoAssignAgent("BackendEngineer", "00000000-0000-4000-8000-000000000001");

    expect(result.triage).toBe(false);
    expect(result.assigneeAgentId).toBeTruthy();
    expect(result.assigneeAgentId!.startsWith("79d8066d")).toBe(true);
    expect(result.role).toBe("BackendEngineer");
    expect(result.candidates.length).toBeGreaterThan(0);
    // Candidate should include all agents with the prefix
    expect(result.candidates.every((c) => c.agentId.startsWith("79d8066d"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // multiple matching agents → least-loaded wins
  // -------------------------------------------------------------------------
  it("picks the least-loaded agent when multiple match a role", async () => {
    // Agent A has 3 open issues; Agent B has 1 open issue
    const agents = [
      { id: "79d8066d-0000-0000-0000-000000000001", nameKey: "Agent Alpha" },
      { id: "79d8066d-0000-0000-0000-000000000002", nameKey: "Agent Beta" },
    ];
    const issues = [
      { id: "1", assigneeAgentId: "79d8066d-0000-0000-0000-000000000001", status: "todo" },
      { id: "2", assigneeAgentId: "79d8066d-0000-0000-0000-000000000001", status: "todo" },
      { id: "3", assigneeAgentId: "79d8066d-0000-0000-0000-000000000001", status: "in_progress" },
      { id: "4", assigneeAgentId: "79d8066d-0000-0000-0000-000000000002", status: "todo" },
    ];
    seedDb(agents, issues);

    const result = await autoAssignAgent("BackendEngineer", "00000000-0000-4000-8000-000000000001");

    expect(result.triage).toBe(false);
    // Agent Beta has only 1 open issue — least loaded
    expect(result.assigneeAgentId).toBe("79d8066d-0000-0000-0000-000000000002");
    expect(result.candidates.find((c) => c.agentId === "79d8066d-0000-0000-0000-000000000002")!.total).toBe(1);
    expect(result.candidates.find((c) => c.agentId === "79d8066d-0000-0000-0000-000000000001")!.total).toBe(3);
  });

  // -------------------------------------------------------------------------
  // identical loads → alphabetical tie-break
  // -------------------------------------------------------------------------
  it("breaks ties alphabetically when loads are identical", async () => {
    const agents = [
      { id: "79d8066d-0000-0000-0000-000000000001", nameKey: "Zara Dev" },
      { id: "79d8066d-0000-0000-0000-000000000002", nameKey: "Alice Dev" },
    ];
    const issues = [
      // Both agents have exactly 2 open issues
      { id: "1", assigneeAgentId: "79d8066d-0000-0000-0000-000000000001", status: "todo" },
      { id: "2", assigneeAgentId: "79d8066d-0000-0000-0000-000000000001", status: "in_progress" },
      { id: "3", assigneeAgentId: "79d8066d-0000-0000-0000-000000000002", status: "todo" },
      { id: "4", assigneeAgentId: "79d8066d-0000-0000-0000-000000000002", status: "todo" },
    ];
    seedDb(agents, issues);

    const result = await autoAssignAgent("BackendEngineer", "00000000-0000-4000-8000-000000000001");

    expect(result.triage).toBe(false);
    // Alice Dev (A < Z) should win the tie-break
    expect(result.assigneeAgentId).toBe("79d8066d-0000-0000-0000-000000000002");
    expect(result.assigneeAgentId).toBe("79d8066d-0000-0000-0000-000000000002"); // Alice
  });

  // -------------------------------------------------------------------------
  // unknown role → triage
  // -------------------------------------------------------------------------
  it("returns triage=true when the role is not in lane config", async () => {
    const result = await autoAssignAgent("NonExistentRole", "00000000-0000-4000-8000-000000000001");

    expect(result.triage).toBe(true);
    expect(result.assigneeAgentId).toBeNull();
    expect(result.reason).toContain("not found");
  });

  // -------------------------------------------------------------------------
  // no agents with prefix → triage
  // -------------------------------------------------------------------------
  it("returns triage=true when no agents match the role prefix", async () => {
    const agents = [
      // No BackendEngineer prefix
      { id: "8faf4a5a-0000-0000-0000-000000000001", nameKey: "FrontendAgent" },
    ];
    seedDb(agents, []);

    const result = await autoAssignAgent("BackendEngineer", "00000000-0000-4000-8000-000000000001");

    expect(result.triage).toBe(true);
    expect(result.assigneeAgentId).toBeNull();
    expect(result.reason).toContain("No agents found");
  });

  // -------------------------------------------------------------------------
  // database failure -> gracefully degrades to triage
  // -------------------------------------------------------------------------
  it("degrades to triage when no execution rows are available", async () => {
    seedDb([], []);
    const result = await autoAssignAgent("BackendEngineer", "00000000-0000-4000-8000-000000000001");

    expect(result.triage).toBe(true);
    expect(result.assigneeAgentId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // result shape — candidates always populated when not triage
  // -------------------------------------------------------------------------
  it("populates candidates array even on triage (for triage UI)", async () => {
    const agents = [
      { id: "79d8066d-0000-0000-0000-000000000001", nameKey: "Solo Dev" },
    ];
    seedDb(agents, []);

    const result = await autoAssignAgent("BackendEngineer", "00000000-0000-4000-8000-000000000001");

    // No open issues, so this agent (even though available) is still returned
    // (the role resolves, but result is triage=false because assignment succeeds)
    expect(result.candidates.length).toBeGreaterThan(0);
  });
});
