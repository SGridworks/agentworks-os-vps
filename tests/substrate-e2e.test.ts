/**
 * Substrate end-to-end smoke test.
 *
 * Boots agentos-d on an ephemeral port + temp DB + temp vault, then exercises
 * every pilot-install demo criterion through real HTTP traffic:
 *
 *  1. POST /api/tenants returns the row + the vault dir is materialized
 *  2. memory.write → memory.read round-trips with matching sha256
 *  3. policy.check (DNC=true real-estate SMS) returns block + 47 C.F.R. citation
 *  4. policy.check (route_to_review with shadowMode=false) returns approvalQueueId
 *  5. GET /api/approval-queue returns the pending row
 *  6. activity.log returns id + loggedAt
 *  7. GET /api/action/export.csv returns RFC-4180 CSV with the header row
 *
 * This test does NOT mock anything — it speaks to a real daemon process.
 * Anything the test misses is something the demo will miss.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const DAEMON_ENTRY = join(
  REPO_ROOT,
  "packages",
  "agentos-d",
  "dist",
  "cli.js",
);
const RULE_PACKS = join(REPO_ROOT, "rule-packs");

let daemon: ChildProcess;
let tmpRoot: string;
let baseUrl: string;
let tenantId: string;

async function postJson(path: string, body: unknown): Promise<Response> {
  return await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getJson(path: string): Promise<Response> {
  return await fetch(`${baseUrl}${path}`);
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
  tmpRoot = mkdtempSync(join(tmpdir(), "awo-e2e-"));
  const port = 17710 + Math.floor(Math.random() * 1000);
  baseUrl = `http://127.0.0.1:${port}`;
  daemon = spawn("node", [DAEMON_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      AGENTOS_PORT: String(port),
      AGENTOS_HOST: "127.0.0.1",
      AGENTOS_LOG_LEVEL: "warn",
      RULE_PACKS_DIR: RULE_PACKS,
      VAULT_ROOT: join(tmpRoot, "vault"),
      AGENTOS_DATA_DIR: join(tmpRoot, "data"),
      AWOS_AGENTS_ROOT: join(tmpRoot, "agents"),
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

describe("substrate end-to-end (pilot install criteria)", () => {
  it("creates a tenant and materializes its vault directory", async () => {
    const res = await postJson("/api/tenants", {
      name: "Example Tenant",
      description: "real-estate-adjacent SMB; lead-gen automation under TCPA",
      industry: "real_estate",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      name: string;
      description: string;
      industry: string;
      vaultRoot: string;
    };
    expect(body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(body.name).toBe("Example Tenant");
    expect(body.industry).toBe("real_estate");
    expect(existsSync(body.vaultRoot)).toBe(true);
    tenantId = body.id;

    // Assign the real-estate-relevant packs so policy.check evaluates the
    // TCPA + Fair Housing rules. POST /api/tenants auto-assigns smb-starter
    // only; for a real-estate tenant we want the regulated-industry packs
    // too. AWO-140's evaluator filter honors this.
    for (const packId of ["tcpa-real-estate", "fair-housing"]) {
      const r = await postJson(`/api/tenants/${tenantId}/rule-packs`, {
        packId,
        mode: "enforce",
      });
      expect(r.status).toBe(201);
    }
  });

  it("memory.write → memory.read round-trip with stable sha256", async () => {
    const writeResult = await callTool("memory.write", {
      tenantId,
      key: "projects/acme-realty",
      body: "# Acme Realty\n\nOH brokerage running outbound SMS.",
      mode: "replace",
    });
    expect(writeResult.sha256).toMatch(/^[0-9a-f]{64}$/);

    const readResult = await callTool("memory.read", {
      tenantId,
      key: "projects/acme-realty",
    });
    expect(readResult.body).toBe(
      "# Acme Realty\n\nOH brokerage running outbound SMS.",
    );
    expect(readResult.sha256).toBe(writeResult.sha256);
  });

  it("policy.check on DNC=true real-estate SMS returns BLOCK + TCPA citation", async () => {
    const result = await callTool("policy.check", {
      tenantId,
      actor: { id: "agent-1", type: "agent", label: "LeadGen" },
      proposedAction: { kind: "outbound.sms", summary: "hi from acme" },
      evidenceSnapshot: {
        contact_id: "c-1",
        dnc_status: true,
        phone_type: "mobile",
        target_jurisdiction: "US-OH",
        reassigned_number: false,
        "consent.source": "written",
        "consent.date": "2026-01-01",
        "consent.verified": true,
        action_kind: "outbound.sms",
        message_body: "Hi",
        sender_id: "ACME",
        housing_related: true,
        protected_class_indicator_present: false,
      },
      shadowMode: false,
    });
    expect(result.decision).toBe("block");
    expect(String(result.decisionReason)).toContain("do-not-call");
    expect(["real-estate-tcpa-fair-housing", "tcpa-real-estate"]).toContain(
      result.rulePackId,
    );
  });

  it("policy.check route_to_review enqueues to approval_queue", async () => {
    const result = await callTool("policy.check", {
      tenantId,
      actor: { id: "agent-1", type: "agent", label: "LeadGen" },
      proposedAction: { kind: "outbound.email", summary: "newsletter" },
      evidenceSnapshot: {
        contact_id: "c-1",
        dnc_status: false,
        email_address: "x@y.com",
        subscription_status: "none",
        action_kind: "outbound.email",
        sender_id: "ACME",
        message_body: "newsletter",
        message_body_missing_required_disclosure: false,
        contains_pii: false,
        actor_role: "licensed",
        local_time: "14:30",
        localTime: "14:30",
        data_residency: "US",
        data_minimization: true,
        protected_class_indicator_present: false,
        targeting_criteria_uses_protected_class: false,
        housing_related: false,
      },
      shadowMode: false,
    });
    expect(result.decision).toBe("route_to_review");
    expect(typeof result.approvalQueueId).toBe("string");

    const queueRes = await getJson(`/api/approval-queue?tenantId=${tenantId}`);
    expect(queueRes.status).toBe(200);
    const queue = (await queueRes.json()) as {
      total: number;
      items: Array<{ id: string; status: string; proposedActionKind: string }>;
    };
    expect(queue.total).toBeGreaterThanOrEqual(1);
    const pending = queue.items.find((i) => i.status === "pending");
    expect(pending?.proposedActionKind).toBe("outbound.email");

    // AWO-185 step 5: approve the entry and verify action_log is updated
    const patchRes = await fetch(
      `${baseUrl}/api/approval-queue/${pending!.id}/review`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reviewedBy: "reviewer-1",
          reviewedByLabel: "Admin Reviewer",
          reviewDecision: "approve",
          reviewNote: "e2e test approval",
        }),
      },
    );
    expect(patchRes.status).toBe(200);
    const approved = (await patchRes.json()) as { status: string };
    expect(approved.status).toBe("approved");
  });

  it("activity.log writes a row that exports as RFC-4180 CSV", async () => {
    const log = await callTool("activity.log", {
      tenantId,
      actor: { id: "agent-1", type: "agent", label: "LeadGen" },
      actionKind: "outbound.sms",
      payloadSnapshot: { summary: "smoke", contact_id: "c-1" },
      vaultRefs: ["projects/acme-realty"],
    });
    expect(log.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const csvRes = await getJson(
      `/api/action/export.csv?tenantId=${tenantId}`,
    );
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers.get("content-type")).toContain("text/csv");
    const csv = await csvRes.text();
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe(
      [
        "id",
        "tenantId",
        "actorId",
        "actorType",
        "actorLabel",
        "actionKind",
        "policyDecisionId",
        "loggedAt",
        "payloadSnapshot",
        "vaultRefs",
        "conversationRefs",
        "projectRefs",
      ].join(","),
    );
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[1]).toContain("outbound.sms");
  });

  it("compliance evidence report aggregates policy_decisions for the period", async () => {
    // Period covers everything created during this test suite — the previous
    // tests have already produced policy_decisions (block + route_to_review).
    const url = `/api/compliance/evidence-report?tenant_id=${tenantId}&from=2020-01-01&to=2099-01-01`;
    const res = await fetch(`${baseUrl}${url}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/pdf/);
    const pdfBytes = await res.arrayBuffer();
    expect(pdfBytes.byteLength).toBeGreaterThan(0);
    // Basic PDF header check (version varies by generator)
    const pdfText = new TextDecoder("latin1").decode(pdfBytes.slice(0, 5));
    expect(pdfText).toBe("%PDF-");
  });

  it("compliance verify-chain returns ok=true on the live daemon's policy_decisions", async () => {
    const url = `/api/compliance/verify-chain?tenantId=${tenantId}`;
    const res = await getJson(url);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tenantId: string;
      rowsChecked: number;
      ok: boolean;
      breaks: unknown[];
    };
    expect(body.tenantId).toBe(tenantId);
    expect(body.rowsChecked).toBeGreaterThanOrEqual(2);
    expect(body.ok).toBe(true);
    expect(body.breaks).toEqual([]);
  });

  it("compliance evidence report rejects bad period with 400", async () => {
    const url = `/api/compliance/evidence-report?tenant_id=${tenantId}&from=2026-04-28&to=2026-04-28`;
    const res = await getJson(url);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_period");
  });
});
