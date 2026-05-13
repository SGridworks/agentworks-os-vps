/**
 * onboarding route tests — detect-editors and write-config behaviors.
 *
 * Each test case stubs HOME to a temp dir so the editor-config writes are
 * fully sandboxed. The merge logic is exercised per editor target plus
 * one shared-state idempotency case.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { createOnboardingRouter } from "./onboarding.js";
import type { Config } from "../config.js";

let tempHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(path.join(tmpdir(), "awo-onboarding-"));
  originalHome = process.env.HOME;
  process.env.HOME = tempHome;
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  rmSync(tempHome, { recursive: true, force: true });
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/onboarding", createOnboardingRouter({} as Config));
  return app;
}

describe("POST /api/onboarding/detect-editors", () => {
  it("reports all three targets, present=false when no configs exist", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/onboarding/detect-editors").send({});
    expect(res.status).toBe(200);
    expect(res.body.editors).toHaveLength(3);
    const ids = res.body.editors.map((e: { id: string }) => e.id).sort();
    expect(ids).toEqual(["claude-code", "claude-desktop", "cursor"]);
    for (const e of res.body.editors) expect(e.present).toBe(false);
  });

  it("flags an editor as present when its config file exists", async () => {
    mkdirSync(path.join(tempHome, ".claude"), { recursive: true });
    writeFileSync(path.join(tempHome, ".claude", "mcp.json"), "{}", "utf8");
    const app = buildApp();
    const res = await request(app).post("/api/onboarding/detect-editors").send({});
    const cc = res.body.editors.find((e: { id: string }) => e.id === "claude-code");
    expect(cc.present).toBe(true);
  });
});

describe("POST /api/onboarding/write-config", () => {
  it("rejects when reviewerId is missing", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/onboarding/write-config")
      .send({ editorIds: ["claude-code"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("rejects when editorIds resolves to nothing known", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/onboarding/write-config")
      .send({ reviewerId: "local-admin", editorIds: ["unknown-editor"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown_editor_ids");
  });

  it("creates the agentworks server entry when config is absent", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/onboarding/write-config")
      .send({ reviewerId: "local-admin", editorIds: ["claude-code"] });
    expect(res.status).toBe(200);
    expect(res.body.results[0].written).toBe(true);
    expect(res.body.results[0].message).toBe("added");
    const written = JSON.parse(
      readFileSync(path.join(tempHome, ".claude", "mcp.json"), "utf8"),
    );
    expect(written.mcpServers.agentworks).toEqual({
      command: "agentos-mcp-stdio",
      args: [],
    });
  });

  it("preserves unrelated server entries on merge", async () => {
    mkdirSync(path.join(tempHome, ".cursor"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { existing: { command: "other", args: ["--foo"] } } }),
      "utf8",
    );
    const app = buildApp();
    const res = await request(app)
      .post("/api/onboarding/write-config")
      .send({ reviewerId: "local-admin", editorIds: ["cursor"] });
    expect(res.body.results[0].written).toBe(true);
    const written = JSON.parse(
      readFileSync(path.join(tempHome, ".cursor", "mcp.json"), "utf8"),
    );
    expect(written.mcpServers.existing).toEqual({ command: "other", args: ["--foo"] });
    expect(written.mcpServers.agentworks).toBeDefined();
  });

  it("is idempotent — second write with identical config reports already_present", async () => {
    const app = buildApp();
    await request(app)
      .post("/api/onboarding/write-config")
      .send({ reviewerId: "local-admin", editorIds: ["claude-desktop"] });
    const res = await request(app)
      .post("/api/onboarding/write-config")
      .send({ reviewerId: "local-admin", editorIds: ["claude-desktop"] });
    expect(res.body.results[0].written).toBe(false);
    expect(res.body.results[0].message).toBe("already_present");
  });

  it("returns parse_failed when the existing config file is malformed JSON", async () => {
    mkdirSync(path.join(tempHome, ".cursor"), { recursive: true });
    writeFileSync(path.join(tempHome, ".cursor", "mcp.json"), "{not-json", "utf8");
    const app = buildApp();
    const res = await request(app)
      .post("/api/onboarding/write-config")
      .send({ reviewerId: "local-admin", editorIds: ["cursor"] });
    expect(res.body.results[0].written).toBe(false);
    expect(res.body.results[0].message).toMatch(/parse_failed/);
  });
});
