/**
 * Memory route tests — POST /api/memory/{read,write}.
 *
 * Drives a real FileVaultStore against a tmp VAULT_ROOT so we exercise the
 * tenant-isolation guarantees the n8n nodes rely on. The DB mock is reused
 * from the rest of the suite so other handlers don't try to touch a real
 * sqlite — these routes don't talk to the DB at all.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { _resetVaultStoreForTesting } from "./memory.js";

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

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
let vaultRoot: string;
let originalVaultRoot: string | undefined;

describe("memory routes", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    originalVaultRoot = process.env.VAULT_ROOT;
  });

  afterAll(() => {
    if (originalVaultRoot === undefined) delete process.env.VAULT_ROOT;
    else process.env.VAULT_ROOT = originalVaultRoot;
  });

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), "awo-mem-route-"));
    process.env.VAULT_ROOT = vaultRoot;
    _resetVaultStoreForTesting();
    app = createApp(loadConfig({}));
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  describe("POST /api/memory/write", () => {
    it("returns 400 when body fails schema (missing key)", async () => {
      const res = await request(app)
        .post("/api/memory/write")
        .send({ tenantId: TENANT_A, body: "hello" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("returns 400 for non-uuid tenantId", async () => {
      const res = await request(app)
        .post("/api/memory/write")
        .send({ tenantId: "nope", key: "k", body: "b" });
      expect(res.status).toBe(400);
    });

    it("returns 201 with bytesWritten + sha256 on a clean write", async () => {
      const res = await request(app)
        .post("/api/memory/write")
        .send({ tenantId: TENANT_A, key: "projects/x", body: "hello world" });
      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.bytesWritten).toBe(11);
      expect(res.body.data.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(res.body.data.mode).toBe("replace");
    });

    it("rejects path traversal via .. in key", async () => {
      const res = await request(app)
        .post("/api/memory/write")
        .send({ tenantId: TENANT_A, key: "../escape", body: "x" });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it("append mode preserves existing content", async () => {
      await request(app)
        .post("/api/memory/write")
        .send({ tenantId: TENANT_A, key: "log", body: "first" });
      const r2 = await request(app)
        .post("/api/memory/write")
        .send({ tenantId: TENANT_A, key: "log", body: "second", mode: "append" });
      expect(r2.status).toBe(201);

      const read = await request(app)
        .post("/api/memory/read")
        .send({ tenantId: TENANT_A, key: "log" });
      expect(read.body.data.body).toContain("first");
      expect(read.body.data.body).toContain("second");
    });
  });

  describe("POST /api/memory/read", () => {
    it("returns existed=false on missing page (no error)", async () => {
      const res = await request(app)
        .post("/api/memory/read")
        .send({ tenantId: TENANT_A, key: "ghost" });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.existed).toBe(false);
      expect(res.body.data.body).toBe("");
    });

    it("round-trips body after a write", async () => {
      await request(app)
        .post("/api/memory/write")
        .send({ tenantId: TENANT_A, key: "hello", body: "world" });
      const res = await request(app)
        .post("/api/memory/read")
        .send({ tenantId: TENANT_A, key: "hello" });
      expect(res.status).toBe(200);
      expect(res.body.data.body).toBe("world");
      expect(res.body.data.existed).toBe(true);
    });

    it("returns 400 for invalid tenantId", async () => {
      const res = await request(app)
        .post("/api/memory/read")
        .send({ tenantId: "bad", key: "x" });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/memory/lint", () => {
    it("returns 400 for invalid tenantId", async () => {
      const res = await request(app).get("/api/memory/lint").query({ tenantId: "bad" });
      expect(res.status).toBe(400);
    });

    it("reports zero pages on an empty vault", async () => {
      const res = await request(app).get("/api/memory/lint").query({ tenantId: TENANT_A });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.pageCount).toBe(0);
      expect(res.body.data.findings).toEqual([]);
    });

    it("flags orphan pages, dead links, and frontmatter gaps", async () => {
      const tenantDir = join(vaultRoot, TENANT_A);
      mkdirSync(tenantDir, { recursive: true });
      writeFileSync(
        join(tenantDir, "alpha.md"),
        `---\ntitle: Alpha\ntype: note\n---\n\nLinks to [[beta]] and [[ghost]].\n`,
      );
      writeFileSync(
        join(tenantDir, "beta.md"),
        `---\ntitle: Beta\ntype: note\n---\n\nNo backlinks here.\n`,
      );
      writeFileSync(
        join(tenantDir, "no-frontmatter.md"),
        `Just a body, no frontmatter at all. Linked from [[alpha]]? No.\n`,
      );

      const res = await request(app).get("/api/memory/lint").query({ tenantId: TENANT_A });
      expect(res.status).toBe(200);
      expect(res.body.data.pageCount).toBe(3);

      const kinds = res.body.data.findings.map((f: { kind: string }) => f.kind);
      expect(kinds).toContain("orphan_page");
      expect(kinds).toContain("dead_link");
      expect(kinds).toContain("frontmatter_gap");

      const dead = res.body.data.findings.find(
        (f: { kind: string; message: string }) =>
          f.kind === "dead_link" && f.message.includes("ghost"),
      );
      expect(dead).toBeTruthy();
    });

    it("isolates findings by tenant", async () => {
      mkdirSync(join(vaultRoot, TENANT_A), { recursive: true });
      writeFileSync(
        join(vaultRoot, TENANT_A, "page.md"),
        `---\ntitle: Page\n---\n\nLinks to [[missing]].\n`,
      );

      const a = await request(app).get("/api/memory/lint").query({ tenantId: TENANT_A });
      expect(a.body.data.pageCount).toBe(1);

      const b = await request(app).get("/api/memory/lint").query({ tenantId: TENANT_B });
      expect(b.body.data.pageCount).toBe(0);
    });
  });

  describe("GET /api/memory/hot-cache", () => {
    it("returns 400 for invalid tenantId", async () => {
      const res = await request(app).get("/api/memory/hot-cache").query({ tenantId: "bad" });
      expect(res.status).toBe(400);
    });

    it("returns existed=false when hot.md does not exist", async () => {
      const res = await request(app).get("/api/memory/hot-cache").query({ tenantId: TENANT_A });
      expect(res.status).toBe(200);
      expect(res.body.data.existed).toBe(false);
      expect(res.body.data.words).toBe(0);
      expect(res.body.data.body).toBe("");
    });

    it("returns body + word count when hot.md exists", async () => {
      await request(app)
        .post("/api/memory/write")
        .send({ tenantId: TENANT_A, key: "hot", body: "one two three four five" });

      const res = await request(app).get("/api/memory/hot-cache").query({ tenantId: TENANT_A });
      expect(res.status).toBe(200);
      expect(res.body.data.existed).toBe(true);
      expect(res.body.data.words).toBe(5);
      expect(res.body.data.body).toBe("one two three four five");
    });
  });

  describe("POST /api/memory/hot-cache/rebuild", () => {
    it("returns 400 for invalid tenantId", async () => {
      const res = await request(app)
        .post("/api/memory/hot-cache/rebuild")
        .send({ tenantId: "bad" });
      expect(res.status).toBe(400);
    });

    it("rebuilds hot.md and reports word count", async () => {
      const res = await request(app)
        .post("/api/memory/hot-cache/rebuild")
        .send({ tenantId: TENANT_A });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.words).toBeGreaterThan(0);
      expect(res.body.data.tenantId).toBe(TENANT_A);
      expect(typeof res.body.data.rebuiltAt).toBe("string");

      const read = await request(app)
        .post("/api/memory/read")
        .send({ tenantId: TENANT_A, key: "hot" });
      expect(read.body.data.existed).toBe(true);
      expect(read.body.data.body).toContain("Tenant Snapshot");
    });
  });

  describe("tenant isolation", () => {
    it("tenant A cannot read tenant B's pages even with the same key", async () => {
      await request(app)
        .post("/api/memory/write")
        .send({ tenantId: TENANT_A, key: "secret", body: "alpha" });

      const res = await request(app)
        .post("/api/memory/read")
        .send({ tenantId: TENANT_B, key: "secret" });
      expect(res.status).toBe(200);
      expect(res.body.data.existed).toBe(false);
      expect(res.body.data.body).toBe("");
    });
  });
});
