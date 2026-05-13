/**
 * Tests for GET /api/admin/autopilot endpoint.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const DAEMON_ENTRY = join(REPO_ROOT, "packages", "agentos-d", "dist", "cli.js");
const RULE_PACKS = join(REPO_ROOT, "rule-packs");

let daemon: ChildProcess;
let tmpRoot: string;
let baseUrl: string;
let tenantId: string;

async function getJson(path: string): Promise<Response> {
  return await fetch(`${baseUrl}${path}`);
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await postJson("/api/mcp", {
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 1e9),
    method: "tools/call",
    params: { name, arguments: args },
  });
  expect(res.status).toBe(200);
  const env = (await res.json()) as {
    result?: { content: Array<{ type: string; text: string }> };
    error?: unknown;
  };
  if (env.error) throw new Error(`MCP error: ${JSON.stringify(env.error)}`);
  return JSON.parse(env.result!.content[0].text) as Record<string, unknown>;
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "awo-autopilot-get-test-"));
  const port = 17760 + Math.floor(Math.random() * 1000);
  baseUrl = `http://127.0.0.1:${port}`;
  daemon = spawn("node", [DAEMON_ENTRY], {
    env: {
      ...process.env,
      AGENTOS_PORT: String(port),
      AGENTOS_HOST: "127.0.0.1",
      AGENTOS_LOG_LEVEL: "warn",
      RULE_PACKS_DIR: RULE_PACKS,
      VAULT_ROOT: join(tmpRoot, "vault"),
      AGENTWORKS_DATA_DIR: join(tmpRoot, "data"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Wait until /api/health responds OK
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Daemon at ${baseUrl} did not become healthy in 10s`);
}, 30_000);

afterAll(() => {
  daemon?.kill("SIGTERM");
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("GET /api/admin/autopilot", () => {
  it("creates a tenant for testing", async () => {
    const res = await postJson("/api/tenants", {
      name: "Autopilot GET Test Tenant",
      description: "Testing autopilot GET endpoint",
      industry: "real_estate",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    tenantId = body.id;

    // Assign rule packs
    for (const packId of ["tcpa-real-estate", "fair-housing"]) {
      const r = await postJson(`/api/tenants/${tenantId}/rule-packs`, {
        packId,
        mode: "enforce",
      });
      expect(r.status).toBe(201);
    }
  });

  it("returns autopilot summary for tenant", async () => {
    const res = await getJson(`/api/admin/autopilot?tenantId=${tenantId}`);
    expect(res.status).toBe(200);
    
    const result = (await res.json()) as {
      safe: number;
      needsApproval: number;
      risky: number;
      summary: {
        triageIssues: number;
        approvalQueue: number;
        dispatchQueue: number;
        recentDecisions: number;
      };
      generatedAt: string;
    };

    expect(result).toHaveProperty("safe");
    expect(result).toHaveProperty("needsApproval");
    expect(result).toHaveProperty("risky");
    expect(result).toHaveProperty("summary");
    expect(result).toHaveProperty("generatedAt");

    expect(typeof result.safe).toBe("number");
    expect(typeof result.needsApproval).toBe("number");
    expect(typeof result.risky).toBe("number");
    expect(result.safe + result.needsApproval + result.risky).toBeGreaterThanOrEqual(0);
  });

  it("requires tenantId parameter", async () => {
    const res = await getJson("/api/admin/autopilot");
    expect(res.status).toBe(400);
    
    const result = await res.json();
    expect(result.error).toBe("tenantId required");
  });

  it("includes triage issues in needsApproval bucket", async () => {
    // Create a test issue by calling policy.check to generate some activity
    await callTool("policy.check", {
      tenantId,
      actor: { id: "agent-1", type: "agent", label: "TestAgent" },
      proposedAction: { kind: "memory.write", summary: "Write test data" },
      evidenceSnapshot: {
        action_kind: "memory.write",
        data_classification: "public",
        contains_pii: false,
      },
      shadowMode: false,
    });

    const res = await getJson(`/api/admin/autopilot?tenantId=${tenantId}`);
    expect(res.status).toBe(200);
    
    const result = await res.json();
    expect(result.summary.recentDecisions).toBeGreaterThan(0);
  });

  it("handles empty tenant gracefully", async () => {
    const fakeTenantId = "00000000-0000-0000-0000-000000000000";
    const res = await getJson(`/api/admin/autopilot?tenantId=${fakeTenantId}`);
    expect(res.status).toBe(200);
    
    const result = await res.json();
    expect(result.safe).toBe(0);
    expect(result.needsApproval).toBe(0);
    expect(result.risky).toBe(0);
    expect(result.summary.triageIssues).toBe(0);
    expect(result.summary.approvalQueue).toBe(0);
    expect(result.summary.dispatchQueue).toBe(0);
    expect(result.summary.recentDecisions).toBe(0);
  });
});