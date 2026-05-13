/**
 * onboarding route tests — detect-editors and write-config behaviors.
 *
 * The Docker daemon cannot safely write host editor configs. These tests keep
 * detection behavior covered and assert that write-config directs the operator
 * to the host-side wrapper.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
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

  it("directs valid write requests to the host-side wrapper", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/onboarding/write-config")
      .send({ reviewerId: "local-admin", editorIds: ["claude-code"] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("host_editor_config_unsupported");
    expect(res.body.command).toBe("agentworks mcp configure");
    expect(res.body.results[0].written).toBe(false);
    expect(res.body.results[0].message).toBe("use_host_agentworks_mcp_configure");
  });
});
