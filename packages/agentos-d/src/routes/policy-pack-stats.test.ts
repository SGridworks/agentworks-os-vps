/**
 * Tests for GET /api/policy/packs/stats — per-pack rules count + 24h fires.
 *
 * Real in-memory SQLite + real migrations so we exercise the actual prepared
 * statements. Rule packs come from a temporary RULE_PACKS_DIR seeded with a
 * minimal YAML pack.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./mcp.js", () => ({
  callPolicyCheck: vi.fn(),
  getRulePacks: vi.fn(),
}));

vi.mock("../websocket-server.js", () => ({
  broadcast: vi.fn(),
}));

vi.mock("../pause-service.js", () => ({
  isPaused: vi.fn().mockReturnValue(false),
}));

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "../db/migrations/index.js";

let sqlite: Database.Database;

vi.mock("../db/index.js", () => ({
  getDb: () => drizzle(sqlite),
}));

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const PACK_ID = "smb-starter";

let app: express.Express;
let packsDir: string;

async function setupApp() {
  const { getRulePacks } = (await import("./mcp.js")) as unknown as {
    getRulePacks: { mockResolvedValue: (v: unknown) => void };
  };
  // Provide a stable rule pack with two rules (matches what the SQL counts against).
  getRulePacks.mockResolvedValue([
    {
      pack_id: PACK_ID,
      pack_version: "1.0.0",
      pack_name: "SMB Starter",
      pack_description: "Test pack",
      target_action_kinds: ["email"],
      rules: [{ id: "r1" }, { id: "r2" }],
      industry: "smb",
    },
  ]);

  const { createPolicyRouter } = await import("./policy.js");
  app = express();
  app.use(express.json());
  app.use("/api/policy", createPolicyRouter({} as never));
}

beforeAll(() => {
  packsDir = mkdtempSync(join(tmpdir(), "awos-packs-"));
  mkdirSync(join(packsDir, PACK_ID), { recursive: true });
  writeFileSync(
    join(packsDir, PACK_ID, "manifest.yaml"),
    "pack_id: smb-starter\npack_version: 1.0.0\nrules: []\n",
  );
  process.env.RULE_PACKS_DIR = packsDir;
});

afterAll(() => {
  rmSync(packsDir, { recursive: true, force: true });
  delete process.env.RULE_PACKS_DIR;
});

beforeEach(async () => {
  sqlite = new Database(":memory:");
  migrate(sqlite);
  await setupApp();
});

afterEach(() => {
  sqlite.close();
});

function insertDecision(opts: { packId: string; tenantId: string; decidedAt: string; decision?: string }) {
  sqlite
    .prepare(
      `INSERT INTO policy_decisions (
        id, action_id, tenant_id,
        actor_id, actor_type, actor_label,
        proposed_action_kind, proposed_action_summary,
        evidence_snapshot,
        decision, decision_reason, shadow_mode,
        rule_pack_id,
        decided_at,
        proposed_at,
        created_at,
        decision_hash, prev_decision_hash
      ) VALUES (?, ?, ?, 'a', 'agent', 'Test', 'email', 'sum', '{}', ?, 'r', 0, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      crypto.randomUUID(),
      crypto.randomUUID(),
      opts.tenantId,
      opts.decision ?? "allow",
      opts.packId,
      opts.decidedAt,
      opts.decidedAt,
      opts.decidedAt,
      "h" + Math.random(),
    );
}

describe("GET /api/policy/packs/stats", () => {
  it("returns rulesCount + zero fires when no decisions exist", async () => {
    const res = await request(app).get("/api/policy/packs/stats");
    expect(res.status).toBe(200);
    expect(res.body.windowHours).toBe(24);
    expect(res.body.tenantId).toBeNull();
    expect(res.body.totals).toEqual({ rulesCount: 2, fires24h: 0 });
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      packId: PACK_ID,
      rulesCount: 2,
      fires24h: 0,
      lastFireAt: null,
    });
  });

  it("counts decisions inside the 24h window and ignores older ones", async () => {
    const now = Date.now();
    const inWindow = new Date(now - 30 * 60 * 1000).toISOString(); // 30min ago
    const outOfWindow = new Date(now - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    insertDecision({ packId: PACK_ID, tenantId: TENANT_A, decidedAt: inWindow });
    insertDecision({ packId: PACK_ID, tenantId: TENANT_A, decidedAt: inWindow });
    insertDecision({ packId: PACK_ID, tenantId: TENANT_A, decidedAt: outOfWindow });

    const res = await request(app).get("/api/policy/packs/stats");
    expect(res.status).toBe(200);
    expect(res.body.totals.fires24h).toBe(2);
    expect(res.body.items[0].fires24h).toBe(2);
    expect(res.body.items[0].lastFireAt).toBe(inWindow);
  });

  it("filters by tenantId when provided", async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    insertDecision({ packId: PACK_ID, tenantId: TENANT_A, decidedAt: recent });
    insertDecision({ packId: PACK_ID, tenantId: TENANT_B, decidedAt: recent });
    insertDecision({ packId: PACK_ID, tenantId: TENANT_B, decidedAt: recent });

    const allRes = await request(app).get("/api/policy/packs/stats");
    expect(allRes.body.totals.fires24h).toBe(3);

    const tenantRes = await request(app).get(`/api/policy/packs/stats?tenantId=${TENANT_B}`);
    expect(tenantRes.status).toBe(200);
    expect(tenantRes.body.tenantId).toBe(TENANT_B);
    expect(tenantRes.body.totals.fires24h).toBe(2);
    expect(tenantRes.body.items[0].fires24h).toBe(2);
  });

  it("rejects malformed tenantId with 400", async () => {
    const res = await request(app).get("/api/policy/packs/stats?tenantId=not-a-uuid");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("returns generatedAt as ISO timestamp", async () => {
    const res = await request(app).get("/api/policy/packs/stats");
    expect(res.body.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
