import { describe, it, expect, beforeEach, vi, afterAll } from "vitest";
import request from "supertest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";

const TMP_VAULT = mkdtempSync(join(tmpdir(), "mcp-vault-"));
process.env.VAULT_ROOT = TMP_VAULT;
afterAll(() => {
  rmSync(TMP_VAULT, { recursive: true, force: true });
});

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
    run: vi.fn().mockReturnThis(),
    all: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(null),
  };
  return { getDb: () => mockDb };
});

const TENANT = "11111111-1111-1111-1111-111111111111";

describe("MCP route — JSON-RPC envelope", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp(loadConfig({}));
    vi.clearAllMocks();
  });

  it("returns Invalid Request error for non-jsonrpc body", async () => {
    const res = await request(app).post("/api/mcp").send({ foo: "bar" });
    expect(res.status).toBe(200);
    expect(res.body.error.code).toBe(-32600);
  });

  it("initialize returns serverInfo and capabilities", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(1);
    expect(res.body.result.serverInfo.name).toBe("agentos-d");
    expect(res.body.result.protocolVersion).toBeTypeOf("string");
    expect(res.body.result.capabilities.tools).toBeDefined();
  });

  it("returns Method not found for unknown method", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .send({ jsonrpc: "2.0", id: 3, method: "unknown/method" });
    expect(res.status).toBe(200);
    expect(res.body.error.code).toBe(-32601);
  });
});

describe("MCP tools — description audit (AWO-157)", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp(loadConfig({}));
    vi.clearAllMocks();
  });

  it("every tool description is <= 320 chars", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(200);
    const tools: Array<{ name: string; description: string }> = res.body.result.tools;
    const failures: string[] = [];
    for (const tool of tools) {
      if (tool.description.length > 320) {
        failures.push(`${tool.name}: ${tool.description.length} chars (max 320)`);
      }
    }
    expect(failures, `Tools exceeding 320-char description limit:\n${failures.join("\n")}`).toHaveLength(0);
  });

  it("token counts per tool (approximate)", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(res.status).toBe(200);
    const tools: Array<{ name: string; description: string }> = res.body.result.tools;
    const lines = tools.map(
      (t) =>
        `${t.name.padEnd(20)} ${t.description.length.toString().padStart(3)} chars  ~${Math.ceil(t.description.length / 4)} tokens`
    );
    console.log("MCP tool description audit:");
    console.log(lines.join("\n"));
    expect(true).toBe(true);
  });

  it("returns all expected tool names", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect(res.status).toBe(200);
    const names = res.body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      "activity.log",
      "memory.hot",
      "memory.list",
      "memory.read",
      "memory.record_insight",
      "memory.search",
      "memory.write",
      "policy.check",
    ]);
  });
});

describe("MCP route — tools/call dispatch", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp(loadConfig({}));
    vi.clearAllMocks();
  });

  it("rejects missing tool name with -32602", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: {} });
    expect(res.status).toBe(200);
    expect(res.body.error.code).toBe(-32602);
  });

  it("returns unknown_tool for an unrecognized tool name", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .send({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "nope.nope", arguments: {} },
      });
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(true);
    const text = JSON.parse(res.body.result.content[0].text);
    expect(text.error).toBe("unknown_tool");
  });

  it("memory.read validates tenantId/key", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .send({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "memory.read", arguments: { tenantId: "not-uuid", key: "" } },
      });
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(true);
    const text = JSON.parse(res.body.result.content[0].text);
    expect(text.error).toBe("invalid_args");
  });

  it("memory.read returns empty body + zero-hash sha256 for missing key", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .send({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "memory.read",
          arguments: { tenantId: TENANT, key: "does-not-exist" },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBeFalsy();
    const text = JSON.parse(res.body.result.content[0].text);
    expect(text.key).toBe("does-not-exist");
    expect(text.body).toBe("");
    expect(text.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("memory.write replace then read round-trips body content", async () => {
    const writeRes = await request(app)
      .post("/api/mcp")
      .send({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "memory.write",
          arguments: {
            tenantId: TENANT,
            key: "smoke-roundtrip",
            body: "hello mcp",
            mode: "replace",
          },
        },
      });
    expect(writeRes.status).toBe(200);
    expect(writeRes.body.result.isError).toBeFalsy();
    const writeText = JSON.parse(writeRes.body.result.content[0].text);
    expect(writeText.bytesWritten).toBe(9);

    const readRes = await request(app)
      .post("/api/mcp")
      .send({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "memory.read",
          arguments: { tenantId: TENANT, key: "smoke-roundtrip" },
        },
      });
    const readText = JSON.parse(readRes.body.result.content[0].text);
    expect(readText.body).toBe("hello mcp");
  });

  it("memory.write returns structured key_too_large error for oversized body", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .send({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: {
          name: "memory.write",
          arguments: {
            tenantId: TENANT,
            key: "too-big",
            body: "x".repeat(32_769),
            mode: "replace",
          },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(true);
    const text = JSON.parse(res.body.result.content[0].text);
    expect(text.error).toBe("key_too_large");
    expect(text.limit_bytes).toBe(32_768);
    expect(text.actual_bytes).toBe(32_769);
    expect(text.suggestion).toContain("split");
  });

  it("memory.hot returns empty body for missing hot.md", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .send({
        jsonrpc: "2.0",
        id: 100,
        method: "tools/call",
        params: {
          name: "memory.hot",
          arguments: { tenantId: TENANT },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBeFalsy();
    const text = JSON.parse(res.body.result.content[0].text);
    expect(text.tenantId).toBe(TENANT);
    expect(text.key).toBe("hot");
    expect(text.existed).toBe(false);
    expect(text.body).toBe("");
  });

  it("policy.check persists a decision row and returns the decision JSON", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .send({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "policy.check",
          arguments: {
            tenantId: TENANT,
            actor: { id: "agent-x", type: "agent", label: "Test" },
            proposedAction: { kind: "send_sms", summary: "Cold outreach" },
            evidenceSnapshot: { source: "demo" },
            shadowMode: true,
          },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBeFalsy();

    const mockDb = (await import("../db/index.js")).getDb();
    expect(mockDb.insert).toHaveBeenCalled();
    expect(mockDb.values).toHaveBeenCalled();

    const text = JSON.parse(res.body.result.content[0].text);
    expect(text.decisionId).toMatch(/^[0-9a-f-]{36}$/);
    // Real evaluatePacks() is now wired; decision reflects rule pack evaluation.
    // The test tenant has no specific pack assignment, so it evaluates against
    // the default baseline packs. shadowMode=true must be reflected in the response.
    expect(["allow", "block", "route_to_review"]).toContain(text.decision);
    expect(typeof text.decisionReason).toBe("string");
    expect(text.decisionReason.length).toBeGreaterThan(0);
    expect(text.shadowMode).toBe(true);
  });

  it("memory.read namespace=operator reads from operator memory dir and skips vault", async () => {
    const opRoot = mkdtempSync(join(tmpdir(), "mcp-opmem-"));
    await fs.writeFile(
      join(opRoot, "feedback-test.md"),
      "---\nname: T\ndescription: short\ntype: feedback\n---\nbody-x",
    );
    process.env.CLAUDE_CODE_MEMORY_ROOT = opRoot;
    const { _resetOperatorMemoryStoreForTesting } = await import("./mcp.js");
    _resetOperatorMemoryStoreForTesting();

    const res = await request(app)
      .post("/api/mcp")
      .send({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "memory.read",
          arguments: { tenantId: TENANT, key: "feedback-test", namespace: "operator" },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBeFalsy();
    const text = JSON.parse(res.body.result.content[0].text);
    expect(text.namespace).toBe("operator");
    expect(text.body).toBe("body-x");
    expect(text.name).toBe("T");
    expect(text.type).toBe("feedback");
    expect(text.existed).toBe(true);

    rmSync(opRoot, { recursive: true, force: true });
    delete process.env.CLAUDE_CODE_MEMORY_ROOT;
    _resetOperatorMemoryStoreForTesting();
  });

  it("memory.read namespace=operator rejects path-traversal keys", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .send({
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: {
          name: "memory.read",
          arguments: { tenantId: TENANT, key: "../etc/passwd", namespace: "operator" },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(true);
    const text = JSON.parse(res.body.result.content[0].text);
    expect(text.error).toBe("INVALID_KEY");
  });

  it("memory.list namespace=operator returns parsed entries", async () => {
    const opRoot = mkdtempSync(join(tmpdir(), "mcp-opmem-"));
    await fs.writeFile(
      join(opRoot, "user-alpha.md"),
      "---\nname: A\ndescription: alpha\ntype: user\n---\nbody-a",
    );
    process.env.CLAUDE_CODE_MEMORY_ROOT = opRoot;
    const { _resetOperatorMemoryStoreForTesting } = await import("./mcp.js");
    _resetOperatorMemoryStoreForTesting();

    const res = await request(app)
      .post("/api/mcp")
      .send({
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: {
          name: "memory.list",
          arguments: { tenantId: TENANT, namespace: "operator" },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBeFalsy();
    const text = JSON.parse(res.body.result.content[0].text);
    expect(text.namespace).toBe("operator");
    expect(text.count).toBe(1);
    expect(text.entries[0]).toMatchObject({ key: "user-alpha", name: "A", type: "user" });

    rmSync(opRoot, { recursive: true, force: true });
    delete process.env.CLAUDE_CODE_MEMORY_ROOT;
    _resetOperatorMemoryStoreForTesting();
  });

  it("memory.record_insight rejects invalid frameType at the schema layer", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .send({
        jsonrpc: "2.0",
        id: 14,
        method: "tools/call",
        params: {
          name: "memory.record_insight",
          arguments: {
            tenantId: TENANT,
            frameType: "not-a-frame",
            content: "x",
            source: "manual",
          },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(true);
    const text = JSON.parse(res.body.result.content[0].text);
    expect(text.error).toBe("invalid_args");
  });

  it("activity.log inserts a row and returns id+tenantId+loggedAt", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .send({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "activity.log",
          arguments: {
            tenantId: TENANT,
            actor: { id: "agent-x", type: "agent", label: "Test" },
            actionKind: "demo.kind",
            payloadSnapshot: { foo: 1 },
            vaultRefs: ["wiki/projects/test"],
          },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBeFalsy();

    const mockDb = (await import("../db/index.js")).getDb();
    expect(mockDb.insert).toHaveBeenCalled();
    expect(mockDb.values).toHaveBeenCalled();
    expect(mockDb.run).toHaveBeenCalled();

    const text = JSON.parse(res.body.result.content[0].text);
    expect(text.tenantId).toBe(TENANT);
    expect(text.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof text.loggedAt).toBe("string");
  });
});
