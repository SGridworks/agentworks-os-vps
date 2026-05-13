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
 *   2. Uses a caller-supplied n8n API key
 *   3. Creates or updates each .json workflow file through /api/v1/workflows
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
// Repo layout: scripts/ is sibling to workflows/, not parent.
const WORKFLOWS_DIR = join(__dirname, "..", "workflows");
const N8N_API_KEY = process.env.N8N_API_KEY;
if (!N8N_API_KEY) {
  console.error("[seed] N8N_API_KEY is required.");
  console.error(`[seed] Create an owner account at ${N8N_URL}, generate an API key, then run:`);
  console.error("[seed]   N8N_API_KEY='...' \\");
  console.error("[seed]   node scripts/n8n-workflow-seed.js");
  process.exit(2);
}
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

async function n8nApi(path, init = {}) {
  const res = await fetch(`${N8N_URL}/api/v1${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-N8N-API-KEY": N8N_API_KEY,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${init.method ?? "GET"} ${path} failed: ${res.status} ${body}`);
  }
  return res.status === 204 ? null : res.json();
}

async function listWorkflowsByName() {
  const payload = await n8nApi("/workflows");
  const workflows = Array.isArray(payload?.data) ? payload.data : [];
  return new Map(workflows.map((w) => [w.name, w]));
}

async function importWorkflow(existingByName, workflowPath) {
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

  const existing = existingByName.get(name);
  if (existing?.id) {
    const updated = await n8nApi(`/workflows/${existing.id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    console.log(`  [seed] ✓ "${name}" updated (id=${updated.data?.id ?? updated.id ?? existing.id})`);
  } else {
    const created = await n8nApi("/workflows", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    console.log(`  [seed] ✓ "${name}" imported (id=${created.data?.id ?? created.id})`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`[seed] Waiting for n8n at ${N8N_URL}...`);
  await waitForN8n();

  const existingByName = await listWorkflowsByName();
  console.log("[seed] API key accepted");

  const files = readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  if (files.length === 0) {
    console.log("[seed] No workflow JSON files found in workflows/");
    return;
  }

  console.log(`[seed] Found ${files.length} workflow(s) to seed:`);
  for (const file of files) {
    await importWorkflow(existingByName, join(WORKFLOWS_DIR, file));
  }

  console.log("[seed] Done");
}

main().catch((err) => {
  console.error("[seed] ERROR:", err.message);
  process.exit(1);
});
