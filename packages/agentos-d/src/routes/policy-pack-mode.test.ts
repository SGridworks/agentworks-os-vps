/**
 * AWO-187 — PATCH /api/policy/packs/:packId/mode tests.
 *
 * Exercises the per-pack shadow/enforce override:
 *   - validation (mode enum, reviewerId required)
 *   - upsert behavior (insert + update)
 *   - GET reads back the row, default response when no row
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
    getDb: () => {
      // The drizzle wrapper returned here is given the live sqlite handle so
      // that the route's raw $client access ((db as any).$client) finds it.
      return drizzle(sqlite);
    },
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

describe("PATCH /api/policy/packs/:packId/mode", () => {
  it("rejects when mode is missing", async () => {
    const res = await request(app)
      .patch("/api/policy/packs/smb-starter/mode")
      .send({ reviewerId: "admin" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("rejects when mode is not shadow or enforce", async () => {
    const res = await request(app)
      .patch("/api/policy/packs/smb-starter/mode")
      .send({ mode: "freeze", reviewerId: "admin" });
    expect(res.status).toBe(400);
  });

  it("rejects when reviewerId is missing", async () => {
    const res = await request(app)
      .patch("/api/policy/packs/smb-starter/mode")
      .send({ mode: "enforce" });
    expect(res.status).toBe(400);
  });

  it("inserts a row on first flip and returns the new mode", async () => {
    const res = await request(app)
      .patch("/api/policy/packs/smb-starter/mode")
      .send({ mode: "enforce", reviewerId: "admin", reason: "ready" });
    expect(res.status).toBe(200);
    expect(res.body.packId).toBe("smb-starter");
    expect(res.body.mode).toBe("enforce");
    expect(res.body.flippedBy).toBe("admin");
    expect(res.body.reason).toBe("ready");
    expect(typeof res.body.flippedAt).toBe("string");

    const row = sqlite
      .prepare("SELECT mode, flipped_by, reason FROM policy_pack_mode WHERE pack_id = ?")
      .get("smb-starter") as { mode: string; flipped_by: string; reason: string };
    expect(row.mode).toBe("enforce");
    expect(row.flipped_by).toBe("admin");
  });

  it("upserts on second flip — same pack switches to shadow", async () => {
    await request(app)
      .patch("/api/policy/packs/smb-starter/mode")
      .send({ mode: "enforce", reviewerId: "admin" });
    const res = await request(app)
      .patch("/api/policy/packs/smb-starter/mode")
      .send({ mode: "shadow", reviewerId: "admin2", reason: "rollback" });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("shadow");
    expect(res.body.flippedBy).toBe("admin2");

    const count = sqlite
      .prepare("SELECT COUNT(*) as c FROM policy_pack_mode WHERE pack_id = ?")
      .get("smb-starter") as { c: number };
    expect(count.c).toBe(1);
  });
});

describe("GET /api/policy/packs/:packId/mode", () => {
  it("returns the default shadow mode when no row exists", async () => {
    const res = await request(app).get("/api/policy/packs/unknown-pack/mode");
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("shadow");
    expect(res.body.flippedAt).toBeNull();
  });

  it("returns the persisted row after a PATCH", async () => {
    await request(app)
      .patch("/api/policy/packs/tcpa/mode")
      .send({ mode: "enforce", reviewerId: "ops" });
    const res = await request(app).get("/api/policy/packs/tcpa/mode");
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("enforce");
    expect(res.body.flippedBy).toBe("ops");
  });
});
