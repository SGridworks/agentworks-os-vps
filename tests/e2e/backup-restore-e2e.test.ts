/**
 * Backup/restore end-to-end recovery test.
 *
 * Sequence:
 *   1. Boot daemon on ephemeral port + empty data dir
 *   2. Create a tenant + memory write (sets up state)
 *   3. Run `agentos backup` to produce an encrypted tarball
 *   4. Stop the daemon and wipe the data dir + vault dir
 *   5. Boot a fresh daemon on the same port (empty data dir)
 *   6. Run `agentos restore` from the tarball
 *   7. Boot daemon against restored data dir
 *   8. GET /api/tenants/{id} → assert tenant row is live
 *   9. memory.read via MCP → assert vault content is live
 *  10. GET /api/policy/decisions → assert policy decisions table is populated
 *
 * This proves the full backup/restore cycle preserves all tiers and the
 * daemon starts cleanly against restored state.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../..");
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
let backupFile: string;
let tenantId: string;
const DAEMON_PORT = 17720 + Math.floor(Math.random() * 500);

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

async function callMcpTool(
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

async function waitForHealthy(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Daemon at ${url} did not become healthy in ${timeoutMs}ms`);
}

function startDaemon(
  dataDir: string,
  vaultRoot: string,
  port: number,
): ChildProcess {
  return spawn("node", [DAEMON_ENTRY], {
    env: {
      ...process.env,
      AGENTOS_PORT: String(port),
      AGENTOS_HOST: "127.0.0.1",
      AGENTOS_LOG_LEVEL: "warn",
      RULE_PACKS_DIR: RULE_PACKS,
      VAULT_ROOT: vaultRoot,
      AGENTWORKS_DATA_DIR: dataDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function stopDaemon(child: ChildProcess): void {
  child?.kill("SIGTERM");
  // Wait up to 5s for process to exit
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && child.exitCode === null) {
    // spin
  }
}

function runBackup(
  dataDir: string,
  vaultRoot: string,
  port: number,
  outFile: string,
  passphrase: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "node",
      [DAEMON_ENTRY, "backup", "--out", outFile, "--key", passphrase],
      {
        env: {
          ...process.env,
          AGENTOS_PORT: String(port),
          AGENTOS_HOST: "127.0.0.1",
          AGENTOS_LOG_LEVEL: "warn",
          RULE_PACKS_DIR: RULE_PACKS,
          VAULT_ROOT: vaultRoot,
          AGENTWORKS_DATA_DIR: dataDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`backup exited ${code}`));
    });
  });
}

function runRestore(
  dataDir: string,
  vaultRoot: string,
  port: number,
  backupPath: string,
  passphrase: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "node",
      [DAEMON_ENTRY, "restore", backupPath, "--key", passphrase],
      {
        env: {
          ...process.env,
          AGENTOS_PORT: String(port),
          AGENTOS_HOST: "127.0.0.1",
          AGENTOS_LOG_LEVEL: "warn",
          RULE_PACKS_DIR: RULE_PACKS,
          VAULT_ROOT: vaultRoot,
          AGENTWORKS_DATA_DIR: dataDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`restore exited ${code}`));
    });
  });
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "awo-recovery-"));
  baseUrl = `http://127.0.0.1:${DAEMON_PORT}`;

  // Phase 1: boot empty daemon
  const dataDir1 = join(tmpRoot, "data-1");
  const vaultDir1 = join(tmpRoot, "vault-1");
  daemon = startDaemon(dataDir1, vaultDir1, DAEMON_PORT);
  await waitForHealthy(baseUrl);

  // Create tenant
  const res = await postJson("/api/tenants", {
    name: "Recovery Test Tenant",
    description: "backup/restore validation",
    industry: "healthcare",
  });
  expect(res.status).toBe(201);
  const tenant = (await res.json()) as { id: string };
  tenantId = tenant.id;

  // Assign rule pack so policy_decisions table gets populated
  const packRes = await postJson(`/api/tenants/${tenantId}/rule-packs`, {
    packId: "smb-starter",
    mode: "enforce",
  });
  expect(packRes.status).toBe(201);

  // Write to vault via memory.write MCP tool
  const vaultWriteResult = await callMcpTool("memory.write", {
    tenantId,
    key: `${tenantId}/recovery-check.md`,
    body: "# Recovery Check\n\nThis file must survive the wipe.",
    mode: "replace",
  });
  expect(vaultWriteResult.sha256).toMatch(/^[0-9a-f]{64}$/);

  // Policy check to populate policy_decisions via MCP tools/call
  const policyResult = await callMcpTool("policy.check", {
    tenantId,
    actor: { id: "recovery-agent", type: "agent", label: "RecoveryCheck" },
    proposedAction: { kind: "outbound.sms", summary: "recovery smoke test" },
    evidenceSnapshot: {
      contact_id: "recovery-c-1",
      dnc_status: false,
      phone_type: "mobile",
      target_jurisdiction: "US-OH",
      reassigned_number: false,
      "consent.source": "written",
      "consent.date": "2026-01-01",
      "consent.verified": true,
      action_kind: "outbound.sms",
      message_body: "smoke test",
      sender_id: "RCVR",
      housing_related: false,
      protected_class_indicator_present: false,
    },
    shadowMode: false,
  });
  expect(policyResult.decision).toBeTruthy();

  // Phase 2: run backup
  // backup appends .enc when encryption key is provided
  const unencryptedBackupPath = join(tmpRoot, "recovery-backup.tar.gz");
  backupFile = `${unencryptedBackupPath}.enc`;
  await runBackup(
    dataDir1,
    vaultDir1,
    DAEMON_PORT,
    unencryptedBackupPath,
    "recovery-test-key-42",
  );
  expect(existsSync(backupFile)).toBe(true);

  // Phase 3: stop daemon and wipe data dir + vault dir
  stopDaemon(daemon);
  rmSync(dataDir1, { recursive: true, force: true });
  rmSync(vaultDir1, { recursive: true, force: true });

  // Phase 4: fresh daemon with empty data dir
  const dataDir2 = join(tmpRoot, "data-2");
  daemon = startDaemon(dataDir2, vaultDir1, DAEMON_PORT);
  await waitForHealthy(baseUrl);

  // Phase 5: run restore (daemon should be stopped per restore docs,
  // but restore command itself doesn't require daemon to be down in this test
  // since it operates on files directly)
  await runRestore(
    dataDir2,
    vaultDir1,
    DAEMON_PORT,
    backupFile,
    "recovery-test-key-42",
  );

  // Phase 6: stop daemon
  stopDaemon(daemon);

  // Phase 7: start daemon against restored data dir
  const dataDir3 = join(tmpRoot, "data-restored");
  daemon = startDaemon(dataDir3, vaultDir1, DAEMON_PORT);
  await waitForHealthy(baseUrl);
}, 60_000);

afterAll(() => {
  daemon?.kill("SIGTERM");
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("backup/restore full-cycle recovery", () => {
  it("restored tenant row is queryable", async () => {
    const res = await getJson(`/api/tenants/${tenantId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      name: string;
      industry: string;
    };
    expect(body.id).toBe(tenantId);
    expect(body.name).toBe("Recovery Test Tenant");
    expect(body.industry).toBe("healthcare");
  });

  it("restored vault content is readable via memory.read", async () => {
    const result = await callMcpTool("memory.read", {
      tenantId,
      key: `${tenantId}/recovery-check.md`,
    });
    expect(String(result.body)).toContain("Recovery Check");
  });

  it("restored policy_decisions are queryable", async () => {
    const res = await getJson(`/api/policy/decisions?tenantId=${tenantId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; items: unknown[] };
    expect(body.total).toBeGreaterThanOrEqual(1);
  });

  it("daemon health endpoint responds after restore", async () => {
    const res = await getJson("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });
});
