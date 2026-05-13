#!/usr/bin/env node
/**
 * n8n-workflow-seed.js
 *
 * Seeds starter AgentWorks workflows into a running n8n instance.
 * Run AFTER `docker compose up -d` has brought n8n online.
 *
 * Usage:
 *   node n8n-workflow-seed.js [--n8n-url http://localhost:5678]
 *
 * What it does:
 *   1. Waits for n8n /healthz to return 200
 *   2. Creates an owner account (if n8n has no users yet)
 *   3. Gets an API key for that account
 *   4. POSTs each .json workflow file to /rest/workflows
 *
 * The script is idempotent — re-running it updates workflows with the same name.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const N8N_URL = process.argv.find((a) => a.startsWith("--n8n-url="))?.split("=")[1]
  ?? "http://localhost:5678";
const WORKFLOWS_DIR = join(__dirname, "workflows");
const ADMIN_EMAIL = "admin@agentworks.local";
const ADMIN_PASSWORD = process.env.N8N_ADMIN_PASSWORD ?? "agentworks-admin-123";
const MAX_WAIT_SECONDS = 120;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForN8n() {
  const until = Date.now() + MAX_WAIT_SECONDS * 1000;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${N8N_URL}/healthz`);
      if (res.ok) {
        console.log("[seed] n8n is ready");
        return;
      }
    } catch {
      // not ready yet
    }
    process.stdout.write(".");
    await sleep(5000);
  }
  throw new Error(`n8n did not become healthy within ${MAX_WAIT_SECONDS}s`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getApiKey() {
  // Step 1: Create owner account if no users exist
  try {
    const resp = await fetch(`${N8N_URL}/rest/users`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    if (resp.ok) {
      const users = await resp.json();
      if (users.length === 0) {
        console.log("[seed] No users found — creating owner account");
        const createResp = await fetch(`${N8N_URL}/rest/users`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: ADMIN_EMAIL,
            password: ADMIN_PASSWORD,
            firstName: "Admin",
            lastName: "AgentWorks",
            role: "owner",
          }),
        });
        if (!createResp.ok) {
          const err = await createResp.text();
          throw new Error(`Failed to create owner: ${createResp.status} ${err}`);
        }
        console.log("[seed] Owner account created");
      } else {
        console.log(`[seed] ${users.length} user(s) already exist — skipping account creation`);
      }
    }
  } catch (err) {
    // If the GET fails (e.g. auth required), try logging in directly
    console.warn(`[seed] User check note: ${err.message}`);
  }

  // Step 2: Get API key via login
  console.log("[seed] Logging in to get API key");
  const loginResp = await fetch(`${N8N_URL}/rest/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });

  if (!loginResp.ok) {
    // Try the newer /rest/auth/sso/login endpoint
    const ssoResp = await fetch(`${N8N_URL}/rest/auth/sso/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    if (!ssoResp.ok) {
      throw new Error(`Login failed: ${loginResp.status} / ${ssoResp.status}`);
    }
    const ssoData = await ssoResp.json();
    return ssoData.data?.token ?? ssoData.token;
  }

  const loginData = await loginResp.json();
  return loginData.data?.token ?? loginData.token;
}

async function importWorkflow(apiKey, workflowPath) {
  const raw = readFileSync(workflowPath, "utf8");
  const workflow = JSON.parse(raw);
  const name = workflow.name ?? "Untitled";

  // Extract just the workflow data (not the full file format n8n uses)
  const payload = {
    name: workflow.name,
    nodes: workflow.nodes ?? [],
    connections: workflow.connections ?? {},
    settings: workflow.settings ?? {},
    tags: workflow.tags ?? [],
    active: false,
  };

  const res = await fetch(`${N8N_URL}/rest/workflows`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-N8N-API-KEY": apiKey,
    },
    body: JSON.stringify(payload),
  });

  if (res.ok) {
    const created = await res.json();
    console.log(`  [seed] ✓ "${name}" imported (id=${created.data?.id ?? created.id})`);
  } else {
    const err = await res.text();
    console.warn(`  [seed] ✗ "${name}" failed: ${res.status} ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`[seed] Waiting for n8n at ${N8N_URL}...`);
  await waitForN8n();

  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error("Could not obtain an API key from n8n");
  }
  console.log("[seed] API key obtained");

  const files = readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  if (files.length === 0) {
    console.log("[seed] No workflow JSON files found in workflows/");
    return;
  }

  console.log(`[seed] Found ${files.length} workflow(s) to seed:`);
  for (const file of files) {
    await importWorkflow(apiKey, join(WORKFLOWS_DIR, file));
  }

  console.log("[seed] Done");
}

main().catch((err) => {
  console.error("[seed] ERROR:", err.message);
  process.exit(1);
});
