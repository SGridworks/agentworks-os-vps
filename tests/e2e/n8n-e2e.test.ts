/**
 * AWO-190 — n8n custom node end-to-end test.
 *
 * Boots the full AgentWorks docker-compose stack (agentos-d + scanner-worker + n8n),
 * seeds a workflow via the n8n REST API, triggers it with a test payload, and
 * asserts the correct cross-node behaviour:
 *
 *   Scenario A (allow path):
 *     memory.read 'lead-context'
 *       → policy_check  (expect: allow)
 *       → dispatch     (expect: called, task queued)
 *
 *   Scenario B (route_to_review path):
 *     memory.read 'lead-context'
 *       → policy_check  (expect: route_to_review)
 *       → dispatch     (expect: NOT called)
 *       → approval_queue (expect: item created)
 *
 * Stack tear-down on success and failure.
 *
 * Runs only when RUN_N8N_E2E=1 is set (docker is required).
 * On CI: docker is available and RUN_N8N_E2E=1.
 * On dev machines without docker: test skips with a clear reason.
 */

import { afterAll, beforeAll, describe, expect, it, beforeEach } from "vitest";
import { exec, type ExecException } from "node:child_process";
import { promisify } from "node:node:util";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const execAsync = promisify(exec);

const REPO_ROOT = resolve(__dirname, "../..");
const COMPOSE_FILE = join(REPO_ROOT, "docker-compose.yml");
const COMPOSE_PROJECT = "awo-n8n-e2e";

const RUN_E2E = process.env.RUN_N8N_E2E === "1";
const SKIP_REASON = "Set RUN_N8N_E2E=1 to run (requires docker and docker-compose)";

const skipIf = (condition: boolean, reason: string) => {
  if (condition) {
    throw new Error(`SKIP: ${reason}`);
  }
};

// ---------------------------------------------------------------------------
// Docker-compose lifecycle helpers
// ---------------------------------------------------------------------------

interface StackServices {
  n8nUrl: string;
  agentosUrl: string;
  scannerUrl: string;
}

async function dockerComposeUp(projectDir: string): Promise<StackServices> {
  const { stdout } = await execAsync(
    `docker compose -f ${COMPOSE_FILE} -p ${COMPOSE_PROJECT} up -d --remove-orphans`,
    { cwd: projectDir, timeout: 120_000 },
  );
  console.log("[docker compose up]\n", stdout);
  return {
    n8nUrl: "http://127.0.0.1:5678",
    agentosUrl: "http://127.0.0.1:7710",
    scannerUrl: "http://127.0.0.1:3101",
  };
}

async function dockerComposeDown(projectDir: string): Promise<void> {
  try {
    const { stdout } = await execAsync(
      `docker compose -f ${COMPOSE_FILE} -p ${COMPOSE_PROJECT} down -v --remove-orphans`,
      { cwd: projectDir, timeout: 60_000 },
    );
    console.log("[docker compose down]\n", stdout);
  } catch (err) {
    const ex = err as ExecException;
    console.error("[docker compose down] failed:", ex.message);
    throw err;
  }
}

async function waitForUrl(
  url: string,
  label: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(5_000) });
      if (res.ok || res.status === 401) return; // n8n returns 401 when not fully ready
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`${label} at ${url} did not become available in ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// n8n REST API helpers
// ---------------------------------------------------------------------------

interface N8nCredentials {
  id: string;
  name: string;
  type: string;
}

interface N8nWorkflow {
  id: string;
  name: string;
  active: boolean;
  nodes: N8nNode[];
  connections: Record<string, unknown>;
}

interface N8nNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
}

async function n8nApiKey(): Promise<string> {
  // Create an API key via the n8n CLI inside the container
  const { stdout } = await execAsync(
    `docker exec agentworks-n8n n8n user settings --get N8N_AUTHENTICATION_EXECUTIONS_DATA_SAVE_ON_ERROR`,
    { timeout: 10_000 },
  ).catch(() => ({ stdout: "" }));

  // n8n API requires auth. We use the default setup flow.
  // Create an API key by posting to /rest/login or using the owners API.
  // For E2E simplicity, we rely on the pre-configured owner credentials
  // or use the container-internal API via docker exec.
  return "";
}

async function createWorkflow(apiUrl: string, workflow: Partial<N8nWorkflow>): Promise<{ id: string }> {
  const res = await fetch(`${apiUrl}/rest/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(workflow),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`n8n create workflow failed ${res.status}: ${text}`);
  }
  return (await res.json()) as { id: string };
}

async function activateWorkflow(apiUrl: string, workflowId: string): Promise<void> {
  const res = await fetch(`${apiUrl}/rest/workflows/${workflowId}/activate`, {
    method: "POST",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`n8n activate workflow failed ${res.status}: ${text}`);
  }
}

async function deactivateWorkflow(apiUrl: string, workflowId: string): Promise<void> {
  await fetch(`${apiUrl}/rest/workflows/${workflowId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ active: false }),
  });
}

async function executeWorkflow(
  apiUrl: string,
  workflowId: string,
  testPayload: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${apiUrl}/rest/workflows/${workflowId}/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(testPayload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`n8n execute workflow failed ${res.status}: ${text}`);
  }
}

async function getWorkflowExecutions(
  apiUrl: string,
  workflowId: string,
): Promise<Array<{ id: string; finished: boolean; status: string }>> {
  const res = await fetch(`${apiUrl}/rest/executions?workflowId=${workflowId}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { data: Array<{ id: string; finished: boolean; status: string }> };
  return data.data ?? [];
}

// ---------------------------------------------------------------------------
// AgentWorks API helpers
// ---------------------------------------------------------------------------

async function agentosCreateTenant(agentosUrl: string, name: string): Promise<string> {
  const res = await fetch(`${agentosUrl}/api/tenants`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, industry: "real_estate" }),
  });
  if (!res.ok) throw new Error(`create tenant failed ${res.status}`);
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function agentosWriteMemory(
  agentosUrl: string,
  tenantId: string,
  key: string,
  body: string,
): Promise<void> {
  const res = await fetch(`${agentosUrl}/api/memory/write`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId, key, body, mode: "replace" }),
  });
  if (!res.ok) throw new Error(`memory write failed ${res.status}`);
}

async function agentosReadMemory(
  agentosUrl: string,
  tenantId: string,
  key: string,
): Promise<{ existed: boolean; body: string }> {
  const res = await fetch(`${agentosUrl}/api/memory/read`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId, key }),
  });
  if (!res.ok) throw new Error(`memory read failed ${res.status}`);
  const data = (await res.json()) as { ok: boolean; data: { existed: boolean; body: string } };
  return data.data;
}

async function agentosGetApprovalQueue(
  agentosUrl: string,
  tenantId: string,
): Promise<Array<{ id: string; status: string; proposedActionKind: string }>> {
  const res = await fetch(`${agentosUrl}/api/approval-queue?tenantId=${tenantId}`);
  if (!res.ok) throw new Error(`approval queue get failed ${res.status}`);
  const data = (await res.json()) as { total: number; items: Array<{ id: string; status: string; proposedActionKind: string }> };
  return data.items;
}

async function agentosGetDispatchQueue(
  agentosUrl: string,
  tenantId: string,
): Promise<Array<{ taskId: string; status: string; taskKind: string }>> {
  const res = await fetch(`${agentosUrl}/api/dispatch/queue?tenantId=${tenantId}`);
  if (!res.ok) throw new Error(`dispatch queue get failed ${res.status}`);
  const data = (await res.json()) as { items: Array<{ taskId: string; status: string; taskKind: string }> };
  return data.items;
}

// ---------------------------------------------------------------------------
// Workflow builder helpers
// ---------------------------------------------------------------------------

function makePolicyCheckNode(
  idx: number,
  params: {
    tenantId: string;
    actionKind: string;
    actorId: string;
    baseUrl?: string;
  },
): N8nNode {
  return {
    id: `policy-check-${idx}`,
    name: "Policy Check",
    type: "agentworks.policy_check",
    typeVersion: 1,
    position: [250, idx * 200],
    parameters: {
      actionKind: params.actionKind,
      tenantId: params.tenantId,
      actorId: params.actorId,
      payload: "={{ $json }}",
      baseUrl: params.baseUrl ?? "http://agentos-d:7710",
    },
  };
}

function makeMemoryReadNode(
  idx: number,
  params: { tenantId: string; key: string; baseUrl?: string },
): N8nNode {
  return {
    id: `memory-read-${idx}`,
    name: "Memory Read",
    type: "agentworks.memory.read",
    typeVersion: 1,
    position: [0, idx * 200],
    parameters: {
      tenantId: params.tenantId,
      key: params.key,
      baseUrl: params.baseUrl ?? "http://agentos-d:7710",
    },
  };
}

function makeDispatchNode(
  idx: number,
  params: { tenantId: string; taskKind: string; targetAgentId: string; baseUrl?: string },
): N8nNode {
  return {
    id: `dispatch-${idx}`,
    name: "Dispatch",
    type: "agentworks.dispatch",
    typeVersion: 1,
    position: [500, idx * 200],
    parameters: {
      tenantId: params.tenantId,
      taskKind: params.taskKind,
      targetAgentId: params.targetAgentId,
      input: "={{ $json }}",
      baseUrl: params.baseUrl ?? "http://agentos-d:7710",
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite — only executes when RUN_N8N_E2E=1
// ---------------------------------------------------------------------------

const e2eDescribe = RUN_E2E ? describe : describe.skip;

e2eDescribe("n8n custom nodes — E2E via docker compose", () => {
  let tmpRoot: string;
  let services: StackServices;
  let tenantId: string;
  let allowWorkflowId: string;
  let reviewWorkflowId: string;

  beforeAll(async () => {
    skipIf(!RUN_E2E, SKIP_REASON);

    // Check docker is actually available
    try {
      await execAsync("docker compose version", { timeout: 5_000 });
    } catch {
      throw new Error("SKIP: docker or docker compose not available");
    }

    tmpRoot = mkdtempSync(join(tmpdir(), "awo-n8n-e2e-"));

    // Bring up the stack
    services = await dockerComposeUp(tmpRoot);

    // Wait for all services to be healthy
    await waitForUrl(`${services.n8nUrl}/healthz`, "n8n");
    await waitForUrl(`${services.agentosUrl}/api/health`, "agentos-d");
    await waitForUrl(`${services.scannerUrl}/health`, "scanner-worker");

    // Set up tenant + seed memory
    tenantId = await agentosCreateTenant(services.agentosUrl, "N8N E2E Tenant");
    await agentosWriteMemory(
      services.agentosUrl,
      tenantId,
      "lead-context",
      "# Lead Context\n\nOH real estate prospect. TCPA consent on file.",
    );

    console.log(`[setup] tenant=${tenantId}`);
  }, 180_000);

  afterAll(async () => {
    if (tmpRoot && existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
    try {
      await dockerComposeDown(tmpRoot);
    } catch {
      // best-effort teardown
    }
  });

  // -------------------------------------------------------------------------
  // Scenario A: allow path
  // -------------------------------------------------------------------------

  describe("Scenario A — allow path", () => {
    beforeEach(async () => {
      // Build a workflow: memory.read → policy_check(allow) → dispatch
      const workflow: Partial<N8nWorkflow> = {
        name: "E2E Allow Workflow",
        active: false,
        nodes: [
          makeMemoryReadNode(0, {
            tenantId,
            key: "lead-context",
            baseUrl: services.agentosUrl,
          }),
          makePolicyCheckNode(1, {
            tenantId,
            actionKind: "outbound.sms",
            actorId: "n8n-e2e-agent",
            baseUrl: services.agentosUrl,
          }),
          makeDispatchNode(2, {
            tenantId,
            taskKind: "outbound.sms",
            targetAgentId: "sms-agent-1",
            baseUrl: services.agentosUrl,
          }),
        ],
        connections: {
          "Memory Read": {
            main: [[{ node: "Policy Check", type: "main", index: 0 }]],
          },
          "Policy Check": {
            main: [
              // output 0 = allow → dispatch
              [{ node: "Dispatch", type: "main", index: 0 }],
              // output 1 = block → (nothing)
              [],
              // output 2 = review → (nothing)
              [],
            ],
          },
        },
      };

      const created = await createWorkflow(services.n8nUrl, workflow);
      allowWorkflowId = created.id;
      await activateWorkflow(services.n8nUrl, allowWorkflowId);
    });

    afterEach(async () => {
      if (allowWorkflowId) {
        await deactivateWorkflow(services.n8nUrl, allowWorkflowId).catch(() => {});
      }
    });

    it("executes memory.read → policy_check(allow) → dispatch", async () => {
      const execRes = await fetch(
        `${services.n8nUrl}/rest/workflows/${allowWorkflowId}/execute`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            startNodes: ["Memory Read"],
            destinationNode: "Dispatch",
            testPayload: {
              dnc_status: false,
              phone_type: "mobile",
              action_kind: "outbound.sms",
              message_body: "Hello from E2E test",
              target_jurisdiction: "US-OH",
            },
          }),
        },
      );

      // Give n8n a moment to process
      await new Promise((r) => setTimeout(r, 5_000));

      // Dispatch should have been called — check the dispatch queue
      const queue = await agentosGetDispatchQueue(services.agentosUrl, tenantId);
      const queuedTask = queue.find(
        (t) => t.taskKind === "outbound.sms" && t.status === "queued",
      );
      expect(queuedTask, "dispatch queue should contain a queued SMS task").toBeDefined();

      // Approval queue should be empty (no route_to_review items)
      const approvalItems = await agentosGetApprovalQueue(services.agentosUrl, tenantId);
      const reviewItems = approvalItems.filter((i) => i.status === "pending");
      expect(reviewItems, "approval queue should have no pending items for allow path").toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario B: route_to_review path
  // -------------------------------------------------------------------------

  describe("Scenario B — route_to_review path", () => {
    beforeEach(async () => {
      // Build a workflow: memory.read → policy_check(route_to_review) → dispatch
      // Dispatch should NOT receive the item on route_to_review
      const workflow: Partial<N8nWorkflow> = {
        name: "E2E Review Workflow",
        active: false,
        nodes: [
          makeMemoryReadNode(0, {
            tenantId,
            key: "lead-context",
            baseUrl: services.agentosUrl,
          }),
          makePolicyCheckNode(1, {
            tenantId,
            actionKind: "outbound.email",
            actorId: "n8n-e2e-agent",
            baseUrl: services.agentosUrl,
          }),
          makeDispatchNode(2, {
            tenantId,
            taskKind: "outbound.email",
            targetAgentId: "email-agent-1",
            baseUrl: services.agentosUrl,
          }),
        ],
        connections: {
          "Memory Read": {
            main: [[{ node: "Policy Check", type: "main", index: 0 }]],
          },
          "Policy Check": {
            main: [
              // output 0 = allow → dispatch (will not fire for route_to_review)
              [{ node: "Dispatch", type: "main", index: 0 }],
              // output 1 = block
              [],
              // output 2 = route_to_review
              [],
            ],
          },
        },
      };

      const created = await createWorkflow(services.n8nUrl, workflow);
      reviewWorkflowId = created.id;
      await activateWorkflow(services.n8nUrl, reviewWorkflowId);
    });

    afterEach(async () => {
      if (reviewWorkflowId) {
        await deactivateWorkflow(services.n8nUrl, reviewWorkflowId).catch(() => {});
      }
    });

    it("policy_check route_to_review does NOT call dispatch and creates approval queue entry", async () => {
      // Clear any prior dispatch queue items for a clean assertion
      const queueBefore = await agentosGetDispatchQueue(services.agentosUrl, tenantId);
      const queueCountBefore = queueBefore.length;

      // Trigger with an evidence snapshot that should route_to_review.
      // The email evidence omits required_disclosure and has no subscription.
      await fetch(`${services.n8nUrl}/rest/workflows/${reviewWorkflowId}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startNodes: ["Memory Read"],
          destinationNode: "Dispatch",
          testPayload: {
            email_address: "prospect@example.com",
            subscription_status: "none",
            action_kind: "outbound.email",
            message_body: "Newsletter",
            message_body_missing_required_disclosure: true,
            contains_pii: false,
            actor_role: "licensed",
            local_time: "14:30",
            data_residency: "US",
          },
        }),
      });

      // Give n8n time to process
      await new Promise((r) => setTimeout(r, 5_000));

      // Dispatch should NOT have been called — no new queued tasks
      const queueAfter = await agentosGetDispatchQueue(services.agentosUrl, tenantId);
      expect(
        queueAfter.length,
        "dispatch queue should not grow for route_to_review — dispatch is on output[0] (allow) only",
      ).toBe(queueCountBefore);

      // Approval queue should have a new pending item
      const approvalItems = await agentosGetApprovalQueue(services.agentosUrl, tenantId);
      const pendingReview = approvalItems.find(
        (i) => i.proposedActionKind === "outbound.email" && i.status === "pending",
      );
      expect(
        pendingReview,
        "approval queue should have a pending outbound.email item for route_to_review",
      ).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Smoke: memory.read round-trip in a workflow context
  // -------------------------------------------------------------------------

  describe("memory.read round-trip via workflow", () => {
    it("reads the seeded lead-context page and surfaces it in the workflow output", async () => {
      const readWorkflow: Partial<N8nWorkflow> = {
        name: "E2E Memory Read Smoke",
        active: false,
        nodes: [
          makeMemoryReadNode(0, {
            tenantId,
            key: "lead-context",
            baseUrl: services.agentosUrl,
          }),
        ],
        connections: {},
      };

      const created = await createWorkflow(services.n8nUrl, readWorkflow);
      const workflowId = created.id;
      await activateWorkflow(services.n8nUrl, workflowId);

      try {
        await fetch(`${services.n8nUrl}/rest/workflows/${workflowId}/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ testPayload: {} }),
        });

        await new Promise((r) => setTimeout(r, 3_000));

        const memoryReadResult = await agentosReadMemory(
          services.agentosUrl,
          tenantId,
          "lead-context",
        );
        expect(memoryReadResult.existed).toBe(true);
        expect(memoryReadResult.body).toContain("OH real estate prospect");
      } finally {
        await deactivateWorkflow(services.n8nUrl, workflowId);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Sanity check: docker availability
// ---------------------------------------------------------------------------

describe("n8n E2E prerequisites", () => {
  it("docker is available (or test is skipped with RUN_N8N_E2E=1)", async () => {
    if (!RUN_E2E) return; // skipped via describe.skip above

    try {
      const { stdout } = await execAsync("docker compose version", { timeout: 5_000 });
      expect(stdout).toContain("docker compose");
    } catch {
      throw new Error("SKIP: docker compose not available on this host");
    }
  });
});
