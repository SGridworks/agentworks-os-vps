/**
 * AWO-195 — rule pack draft + promote endpoint tests.
 *
 * Exercises the per-pack draft staging:
 *   - validation
 *   - save (insert + upsert)
 *   - read 404 vs 200
 *   - promote returns the draft and clears the row
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("./mcp.js", () => ({
  callPolicyCheck: vi.fn(),
  getRulePacks: vi.fn().mockResolvedValue([]),
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
let app: express.Express;

vi.mock("../db/index.js", () => {
  return {
    getDb: () => drizzle(sqlite),
  };
});

beforeEach(async () => {
  sqlite = new Database(":memory:");
  migrate(sqlite);
  const { createPolicyRouter } = await import("./policy.js");
  app = express();
  app.use(express.json());
  app.use("/api/policy", createPolicyRouter({} as never));
});

afterEach(() => {
  sqlite.close();
});

describe("POST /api/policy/packs/:packId/draft", () => {
  it("rejects when yaml is missing", async () => {
    const res = await request(app)
      .post("/api/policy/packs/smb-starter/draft")
      .send({ savedBy: "admin" });
    expect(res.status).toBe(400);
  });

  it("inserts a draft row and returns savedAt", async () => {
    const res = await request(app)
      .post("/api/policy/packs/smb-starter/draft")
      .send({ yaml: "pack_id: smb-starter\npack_version: '0.2.0'", savedBy: "admin" });
    expect(res.status).toBe(200);
    expect(res.body.packId).toBe("smb-starter");
    expect(res.body.savedBy).toBe("admin");
    expect(typeof res.body.savedAt).toBe("string");
  });

  it("upserts on second save — overwrites yaml", async () => {
    await request(app)
      .post("/api/policy/packs/smb-starter/draft")
      .send({ yaml: "first" });
    await request(app)
      .post("/api/policy/packs/smb-starter/draft")
      .send({ yaml: "second", savedBy: "admin2" });
    const get = await request(app).get("/api/policy/packs/smb-starter/draft");
    expect(get.body.yaml).toBe("second");
    expect(get.body.savedBy).toBe("admin2");
  });
});

describe("GET /api/policy/packs/:packId/draft", () => {
  it("returns 404 when no draft exists", async () => {
    const res = await request(app).get("/api/policy/packs/missing/draft");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_draft");
  });

  it("returns the saved draft", async () => {
    await request(app)
      .post("/api/policy/packs/p/draft")
      .send({ yaml: "x: 1", savedBy: "admin" });
    const res = await request(app).get("/api/policy/packs/p/draft");
    expect(res.status).toBe(200);
    expect(res.body.yaml).toBe("x: 1");
  });
});

describe("POST /api/policy/packs/:packId/draft/promote", () => {
  it("returns 404 when no draft", async () => {
    const res = await request(app).post("/api/policy/packs/missing/draft/promote");
    expect(res.status).toBe(404);
  });

  it("returns the draft and clears the row", async () => {
    await request(app)
      .post("/api/policy/packs/p/draft")
      .send({ yaml: "promoted-content", savedBy: "admin" });
    const res = await request(app).post("/api/policy/packs/p/draft/promote");
    expect(res.status).toBe(200);
    expect(res.body.promoted).toBe(true);
    expect(res.body.draft.yaml).toBe("promoted-content");

    const get = await request(app).get("/api/policy/packs/p/draft");
    expect(get.status).toBe(404);
  });
});
