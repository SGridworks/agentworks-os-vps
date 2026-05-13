import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const BASE = process.env.AWOS_BASE ?? "http://127.0.0.1:7710/api";
const ADMIN = process.env.AWOS_ADMIN ?? "http://127.0.0.1:3000";
const SCANNER = process.env.AWOS_SCANNER ?? "http://127.0.0.1:3101";
const N8N = process.env.AWOS_N8N ?? "http://127.0.0.1:5678";
const OUT_DIR =
  process.env.AWOS_E2E_OUT ??
  `/tmp/awos-vps-e2e-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const runSlug = `e2e-${Date.now().toString(36)}`;
const evidence = {
  runSlug,
  startedAt: new Date().toISOString(),
  base: BASE,
  admin: ADMIN,
  scanner: SCANNER,
  n8n: N8N,
  outDir: OUT_DIR,
  ids: {},
  steps: [],
  artifacts: {},
};

await mkdir(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(name, method, url, body, ok = [200, 201, 202, 204, 307, 308]) {
  const fullUrl = url.startsWith("http") ? url : `${BASE}${url}`;
  const res = await fetch(fullUrl, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text.slice(0, 1000);
  }
  const record = { name, method, url: fullUrl, status: res.status, body: parsed };
  if (!ok.includes(res.status)) {
    const err = new Error(`${name} failed: HTTP ${res.status}`);
    err.record = record;
    throw err;
  }
  return record;
}

async function step(name, fn) {
  const startedAt = new Date().toISOString();
  try {
    const result = await fn();
    evidence.steps.push({ name, status: "PASS", startedAt, endedAt: new Date().toISOString(), result });
    console.log(`PASS ${name}`);
    return result;
  } catch (err) {
    evidence.steps.push({
      name,
      status: "FAIL",
      startedAt,
      endedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
      detail: err?.record,
    });
    throw err;
  }
}

async function save(name, data) {
  const path = join(OUT_DIR, name);
  await writeFile(path, JSON.stringify(data, null, 2));
  evidence.artifacts[name] = path;
}

async function poll(name, fn, done, attempts, delayMs) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    last = await fn();
    if (done(last)) return last;
    await sleep(delayMs);
  }
  throw new Error(`${name} did not reach expected state; last=${JSON.stringify(last)}`);
}

process.on("uncaughtException", async (err) => {
  evidence.finishedAt = new Date().toISOString();
  evidence.status = "FAIL";
  evidence.error = err instanceof Error ? err.message : String(err);
  await save("summary.json", evidence).catch(() => {});
  console.error(err);
  process.exit(1);
});

await step("preflight daemon health", async () => (await request("daemon health", "GET", "/health")).body);
await step("preflight scanner via daemon", async () => (await request("scanner health", "GET", "/scanner/health")).body);
await step("preflight scanner direct", async () => (await request("scanner direct", "GET", `${SCANNER}/health`)).body);
await step("preflight n8n", async () => (await request("n8n health", "GET", `${N8N}/healthz`)).body);
await step("preflight admin-ui", async () => {
  const pages = ["/", "/mission-control", "/agents", "/triage-queue", "/scanner"];
  const out = [];
  for (const page of pages) out.push({ page, status: (await request(`admin ${page}`, "GET", `${ADMIN}${page}`)).status });
  return out;
});

const tenant = await step("create tenant", async () => {
  const r = await request("create tenant", "POST", "/tenants", {
    name: `AWOS VPS E2E Tenant ${runSlug}`,
    description: "Disposable tenant created by AWOS E2E test.",
    industry: "other",
  });
  evidence.ids.tenantId = r.body.id;
  return r.body;
});

const companies = await step("create companies", async () => {
  const out = [];
  for (const label of ["Operations Company", "Client Delivery Company"]) {
    out.push(
      (
        await request("create company", "POST", "/companies", {
          tenantId: tenant.id,
          name: `AWOS ${label} ${runSlug}`,
          slug: `${label.toLowerCase().replaceAll(" ", "-")}-${runSlug}`,
          metadata: { e2eRun: runSlug },
        })
      ).body,
    );
  }
  evidence.ids.companyIds = out.map((x) => x.id);
  return out;
});

const projects = await step("create projects", async () => {
  const out = [];
  for (const company of companies) {
    out.push(
      (
        await request("create project", "POST", `/companies/${company.id}/projects`, {
          tenantId: tenant.id,
          name: `Workflow Completion Project ${runSlug}`,
          metadata: { e2eRun: runSlug, companyId: company.id },
        })
      ).body,
    );
  }
  evidence.ids.projectIds = out.map((x) => x.id);
  return out;
});

const agents = await step("create agents", async () => {
  const specs = [
    { name: "Coordinator Agent", role: "Coordinator", companyId: companies[0].id },
    { name: "Analyst Agent", role: "Analyst", companyId: companies[0].id },
    { name: "Builder Agent", role: "Builder", companyId: companies[1].id },
  ];
  const out = [];
  for (const spec of specs) {
    out.push(
      (
        await request("create agent", "POST", "/agents", {
          tenantId: tenant.id,
          companyId: spec.companyId,
          name: `${spec.name} ${runSlug}`,
          role: spec.role,
          status: "active",
          config: {
            adapterType: "stub",
            adapterConfig: { model: "stub-e2e" },
            runtimeConfig: { heartbeat: { intervalSec: 0, wakeOnDemand: true } },
            capabilities: "e2e workflow test",
          },
        })
      ).body,
    );
  }
  evidence.ids.agentIds = out.map((x) => x.id);
  return out;
});

const issue = await step("create assigned issue", async () => {
  const r = await request("create issue", "POST", `/companies/${companies[0].id}/issues`, {
    tenantId: tenant.id,
    projectId: projects[0].id,
    title: `E2E workflow issue ${runSlug}`,
    description: "Exercise todo -> in_progress -> done plus wakeup dispatch.",
    priority: "high",
    assigneeAgentId: agents[1].id,
    metadata: { e2eRun: runSlug, kind: "assigned-workflow" },
  });
  evidence.ids.issueId = r.body.id;
  return r.body;
});

const triageIssue = await step("triage path assign", async () => {
  const created = (
    await request("create triage issue", "POST", `/companies/${companies[0].id}/issues`, {
      tenantId: tenant.id,
      projectId: projects[0].id,
      title: `E2E triage issue ${runSlug}`,
      description: "Starts unassigned; should appear in triage queue until assigned.",
      priority: "medium",
      metadata: { e2eRun: runSlug, kind: "triage" },
    })
  ).body;
  evidence.ids.triageIssueId = created.id;
  const queue = (await request("triage queue", "GET", "/admin/triage-queue")).body;
  if (!queue.issues?.some((x) => x.id === created.id)) throw new Error("triage issue not found in queue");
  await request("assign triage issue", "POST", "/admin/triage-queue/assign", {
    issueId: created.id,
    assigneeAgentId: agents[0].id,
  });
  const after = (await request("triage queue after assign", "GET", "/admin/triage-queue")).body;
  if (after.issues?.some((x) => x.id === created.id)) throw new Error("assigned issue still in triage queue");
  return { issueId: created.id, before: queue.count, after: after.count };
});

await step("workflow issue transitions", async () => {
  await request("issue in progress", "PATCH", `/issues/${issue.id}`, {
    status: "in_progress",
    comment: "E2E test started work.",
  });
  await request("add comment", "POST", `/issues/${issue.id}/comments`, {
    authorId: agents[1].id,
    authorLabel: agents[1].name,
    body: "E2E agent comment using the corrected body field.",
  });
  const done = (
    await request("issue done", "PATCH", `/issues/${issue.id}`, {
      status: "done",
      comment: "E2E test completed work.",
    })
  ).body;
  if (done.status !== "done" || !done.completedAt) throw new Error("issue did not reach done");
  return done;
});

const wakeup = await step("wakeup dispatch completes", async () => {
  const w = (
    await request("agent wakeup", "POST", `/agents/${agents[1].id}/wakeup`, {
      source: "awos-e2e",
      triggerDetail: "vps-e2e",
      reason: "Complete assigned issue through dispatch path",
      issueId: issue.id,
      payload: { issueId: issue.id, companyId: companies[0].id, projectId: projects[0].id, runSlug },
      idempotencyKey: `${runSlug}:${issue.id}:wakeup`,
    })
  ).body;
  evidence.ids.dispatchId = w.dispatchId;
  evidence.ids.wakeupId = w.wakeupId;
  const dispatch = await poll(
    "dispatch",
    async () => (await request("get dispatch", "GET", `/dispatch/${w.dispatchId}`)).body,
    (x) => ["completed", "failed"].includes(x.status),
    10,
    3000,
  );
  if (dispatch.status !== "completed") throw new Error(`dispatch failed: ${dispatch.error ?? "unknown error"}`);
  const state = (await request("runtime state", "GET", `/agents/${agents[1].id}/runtime-state`)).body;
  if (state.lastRunStatus !== "succeeded") throw new Error(`runtime state not succeeded: ${JSON.stringify(state)}`);
  return { wakeup: w, dispatch, state };
});

await step("execution run event and task session", async () => {
  const run = (
    await request("create run", "POST", "/runs", {
      tenantId: tenant.id,
      companyId: companies[0].id,
      projectId: projects[0].id,
      issueId: issue.id,
      agentId: agents[1].id,
      status: "succeeded",
      summary: "E2E workflow completed through AWOS API.",
    })
  ).body;
  evidence.ids.runId = run.id;
  await request("run event", "POST", `/runs/${run.id}/events`, {
    tenantId: tenant.id,
    eventType: "e2e.workflow.completed",
    message: "Workflow reached done state.",
    data: { e2eRun: runSlug, confidence: 1 },
  });
  const session = (
    await request("task session", "POST", `/agents/${agents[1].id}/task-sessions`, {
      taskKey: `issue:${issue.identifier ?? issue.id}`,
      issueId: issue.id,
      adapterType: "stub",
      sessionParams: { e2eRun: runSlug },
      lastRunId: run.id,
      status: "succeeded",
    })
  ).body;
  return { run, session };
});

await step("policy route_to_review and approval queue", async () => {
  const evalRes = (
    await request("policy evaluate", "POST", "/policy/evaluate", {
      requestId: crypto.randomUUID(),
      proposedAt: new Date().toISOString(),
      tenantId: tenant.id,
      actor: { id: agents[0].id, type: "agent", label: agents[0].name },
      actionKind: "outbound.sms",
      payload: { summary: "send review-required message" },
      context: { vaultRefs: [], conversationRefs: [], projectRefs: [projects[0].id], meta: { e2eRun: runSlug } },
      proposedAction: { kind: "outbound.sms", summary: "send review-required message" },
      evidenceSnapshot: { dnc_status: false },
      consent: { source: "written", recordRef: `e2e-${runSlug}`, verified: false },
    })
  ).body;
  if (evalRes.decision !== "route_to_review" || !evalRes.approvalQueueId) {
    throw new Error(`expected route_to_review; got ${JSON.stringify(evalRes)}`);
  }
  const queue = (await request("approval queue", "GET", `/approval-queue?tenantId=${tenant.id}&status=pending`)).body;
  if (!queue.items?.some((x) => x.id === evalRes.approvalQueueId)) throw new Error("approval queue missing item");
  await request("review approval", "PATCH", `/approval-queue/${evalRes.approvalQueueId}/review`, {
    reviewedBy: "awos-e2e",
    reviewedByLabel: "AWOS E2E",
    reviewDecision: "approve",
    reviewNote: "Approved by E2E workflow.",
  });
  return { decision: evalRes.decision, approvalQueueId: evalRes.approvalQueueId };
});

const scannerResult = await step("scanner submit and poll", async () => {
  const submit = (
    await request("scanner submit", "POST", "/scanner/submit", {
      tenantId: tenant.id,
      target: {
        type: "claude_md",
        path: `e2e/${runSlug}/CLAUDE.md`,
        content: "# E2E Scanner Target\n\nThis file is a harmless scanner workflow probe.",
      },
      policyMode: "shadow",
      priority: "standard",
    })
  ).body;
  const job = await poll(
    "scanner job",
    async () => (await request("scanner job", "GET", `/scanner/jobs/${submit.scanId}?tenantId=${tenant.id}`)).body,
    (x) => ["complete", "error"].includes(x.status),
    10,
    2000,
  );
  if (job.status !== "complete") throw new Error(`scanner job failed: ${JSON.stringify(job)}`);
  await request("scanner findings", "GET", `/scanner/findings?tenantId=${tenant.id}`);
  return job;
});

await step("created records visible", async () => {
  const companyList = (await request("list companies", "GET", `/companies?tenantId=${tenant.id}`)).body;
  const agentList = (await request("list agents", "GET", `/agents?tenantId=${tenant.id}`)).body;
  const issueList = (await request("list issues", "GET", `/companies/${companies[0].id}/issues`)).body;
  return {
    companies: companyList.items?.length ?? 0,
    agents: agentList.items?.length ?? 0,
    issues: issueList.items?.length ?? 0,
    issueStatus: issueList.items?.find((x) => x.id === issue.id)?.status,
    triageIssueId: triageIssue.issueId,
    dispatchStatus: wakeup.dispatch.status,
    scannerStatus: scannerResult.status,
  };
});

evidence.finishedAt = new Date().toISOString();
evidence.status = "PASS";
await save("summary.json", evidence);
console.log(JSON.stringify({ status: evidence.status, runSlug, outDir: OUT_DIR, ids: evidence.ids }, null, 2));
