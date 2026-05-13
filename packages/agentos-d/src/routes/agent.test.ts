/**
 * Integration tests for GET /api/agents/me/inbox-lite
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { createAgentRouter } from "./agent.js";

const dbRows: any[] = [];

vi.mock("../db/index.js", () => ({
  getSqlite: () => ({
    prepare: () => ({
      all: () => dbRows,
    }),
  }),
}));

describe("GET /api/agents/me/inbox-lite", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/agents", createAgentRouter({} as any));

  beforeEach(() => {
    dbRows.splice(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 when agentId or companyId missing", async () => {
    const res = await request(app).get("/api/agents/me/inbox-lite");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("returns 400 for invalid uuid", async () => {
    const res = await request(app)
      .get("/api/agents/me/inbox-lite")
      .query({ agentId: "not-a-uuid", companyId: "not-a-uuid" });
    expect(res.status).toBe(400);
  });

  it("sorts by critical priority first, then unblockCount desc, then recency", async () => {
    const agentId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const companyId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    const issues = [
      {
        id: "i-high-old",
        identifier: "HIGH-1",
        title: "High old",
        description: null,
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
        parent_issue_id: null,
        blocked_on_json: "[]",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        completed_at: null,
        company_id: companyId,
        assignee_agent_id: agentId,
      },
      {
        id: "i-critical-new",
        identifier: "CRIT-1",
        title: "Critical new",
        description: null,
        status: "todo",
        priority: "critical",
        assigneeAgentId: agentId,
        parent_issue_id: null,
        blocked_on_json: "[]",
        created_at: "2026-04-01T00:00:00Z",
        updated_at: "2026-04-01T00:00:00Z",
        completed_at: null,
        company_id: companyId,
        assignee_agent_id: agentId,
      },
      {
        id: "i-medium-unblocker",
        identifier: "MED-1",
        title: "Medium unblocker",
        description: null,
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        parent_issue_id: null,
        blocked_on_json: "[]",
        created_at: "2026-02-01T00:00:00Z",
        updated_at: "2026-02-01T00:00:00Z",
        completed_at: null,
        company_id: companyId,
        assignee_agent_id: agentId,
      },
      {
        id: "i-blocked-child",
        identifier: "BLK-1",
        title: "Blocked child",
        description: null,
        status: "blocked",
        priority: "high",
        assigneeAgentId: "other-agent",
        parent_issue_id: "i-medium-unblocker",
        blocked_on_json: JSON.stringify(["i-medium-unblocker"]),
        created_at: "2026-03-01T00:00:00Z",
        updated_at: "2026-03-01T00:00:00Z",
        completed_at: null,
        company_id: companyId,
        assignee_agent_id: "other-agent",
      },
    ];

    dbRows.push(...issues);

    const res = await request(app)
      .get("/api/agents/me/inbox-lite")
      .query({ agentId, companyId });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(3);

    const ids = res.body.items.map((i: any) => i.id);
    // 1. critical first
    expect(ids[0]).toBe("i-critical-new");
    // 2. medium-unblocker has unblockCount=1 (blocked child in company)
    // 3. high-old has unblockCount=0
    expect(ids[1]).toBe("i-medium-unblocker");
    expect(ids[2]).toBe("i-high-old");

    // unblockCount should be present on each item
    expect(res.body.items[0].unblockCount).toBe(0);
    expect(res.body.items[1].unblockCount).toBe(1);
    expect(res.body.items[2].unblockCount).toBe(0);
  });

  it("filters out issues assigned to other agents", async () => {
    const agentId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const companyId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    const issues = [
      {
        id: "i-mine",
        identifier: "MINE-1",
        title: "Mine",
        description: null,
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        parent_issue_id: null,
        blocked_on_json: "[]",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        completed_at: null,
        company_id: companyId,
        assignee_agent_id: agentId,
      },
      {
        id: "i-other",
        identifier: "OTH-1",
        title: "Other",
        description: null,
        status: "todo",
        priority: "critical",
        assigneeAgentId: "other-agent",
        parent_issue_id: null,
        blocked_on_json: "[]",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        completed_at: null,
        company_id: companyId,
        assignee_agent_id: "other-agent",
      },
    ];

    dbRows.push(...issues);

    const res = await request(app)
      .get("/api/agents/me/inbox-lite")
      .query({ agentId, companyId });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe("i-mine");
  });

  it("handles empty open issue list gracefully", async () => {
    const agentId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const companyId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    const res = await request(app)
      .get("/api/agents/me/inbox-lite")
      .query({ agentId, companyId });

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

});
