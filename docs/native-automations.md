# Native Automations

AgentWorks OS ships with a native automation runtime inside `agentos-d`.
Workflows live in the daemon's own SQLite database. n8n is supported as
an optional bridge, not as the authority for automation state.

This document covers the operator-facing surface: data model, supported
step types, admin API, and the end-to-end create/run flow.

## Why native instead of n8n-only

- **Self-contained**: a fresh install runs and exercises automations
  with no n8n container running. The n8n service is still bundled for
  operators who want it.
- **Single source of truth**: template, workflow, and run state live in
  the same SQLite database as tenants, vault pages, and the dispatch
  queue. Backup is one file.
- **Policy-aware**: every step that touches outbound action passes
  through the same policy engine and approval queue the rest of the
  daemon uses.
- **MCP-reachable**: the admin API surfaces every native automation
  operation, so an LLM agent connected over MCP can list, create, run,
  and inspect workflows the same way an operator can through the
  admin UI.

## Data model

Migration `0035_native_automations` adds three tables:

| Table | Purpose |
|---|---|
| `native_automation_templates` | Reusable workflow definitions. Includes operator-created custom templates plus bundled templates the daemon ships with. |
| `native_automation_workflows` | Installed or directly-created managed workflows. Scoped to a tenant and a company. |
| `native_automation_runs` | Run history. Tracks status, per-step outputs, run input, and the policy decisions each step produced. |

Migration `0036_native_automation_n8n_ai` adds external-engine sync
metadata so a native workflow can track its n8n counterpart without
making n8n the source of truth.

## Step types

The public REST API accepts these nine step types in a workflow's
`steps[].type`:

| Step type | What it does |
|---|---|
| `policy.check` | Run a `policy.check` against the active rule pack. Returns the decision, used for downstream conditional execution. |
| `approval.enqueue` | Route an action to the approval queue. Used after a `policy.check` returns `route_to_review`. |
| `vault.read` | Read a vault page by `key`. |
| `vault.write` | Write or append to a vault page. Supports `mode: replace` and `mode: append`. |
| `issue.create` | Create an issue scoped to the run's company. |
| `issue.update` | Update an existing issue's status, description, or assignee. |
| `dispatch` | Enqueue a dispatch to an agent (by role or by `assigneeAgentId`). |
| `scanner.finding` | Surface or update an AgentGuard scanner finding. |
| `webhook.intake` | Accept the trigger payload as the run input (only meaningful for `trigger: "webhook"`). |

The runtime layer in `services/native-automations.ts` recognizes
additional step types for internal use (flow control, AI steps, HTTP
calls). These are not yet exposed through the public REST API and are
subject to change before they become public surface.

## Admin API

All endpoints live under the existing admin router and require the same
auth as the rest of the admin API.

```
GET    /api/admin/automations?companyId=<uuid>
POST   /api/admin/automations/templates
POST   /api/admin/automations/templates/:templateId/install
POST   /api/admin/automations/workflows
PATCH  /api/admin/automations/workflows/:workflowId
POST   /api/admin/automations/workflows/:workflowId/run
GET    /api/admin/automations/runs/:runId
GET    /api/admin/automations/workflows/:workflowId/n8n-export
```

`GET /api/admin/automations` returns engine state, n8n bridge health,
warnings, bundled and custom templates, installed workflows, and the
most recent runs in one payload. The admin UI uses this for the
`/automations` page.

## Create a managed workflow

```bash
curl -sS -X POST http://127.0.0.1:7710/api/admin/automations/workflows \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Manual vault capture",
    "trigger": "manual",
    "status": "paused",
    "definition": {
      "trigger": "manual",
      "steps": [
        {
          "id": "write",
          "name": "Write vault note",
          "type": "vault.write",
          "params": {
            "key": "automations/manual-capture",
            "body": "# Manual vault capture\n\nCreated by native automation.",
            "mode": "append"
          }
        }
      ]
    }
  }'
```

Activate it before running:

```bash
WORKFLOW_ID=...  # from the create response
curl -sS -X PATCH http://127.0.0.1:7710/api/admin/automations/workflows/$WORKFLOW_ID \
  -H 'Content-Type: application/json' \
  -d '{"status":"active"}'
```

Run it:

```bash
curl -sS -X POST http://127.0.0.1:7710/api/admin/automations/workflows/$WORKFLOW_ID/run \
  -H 'Content-Type: application/json' \
  -d '{"input":{}}'
```

The response includes a `runId`. Inspect it:

```bash
curl -sS http://127.0.0.1:7710/api/admin/automations/runs/$RUN_ID
```

## Install a bundled template

The daemon ships bundled templates that solve common operator workflows.
List them:

```bash
curl -sS http://127.0.0.1:7710/api/admin/automations | jq '.templates[].id'
```

Install one as a managed workflow:

```bash
TEMPLATE_ID=...
curl -sS -X POST http://127.0.0.1:7710/api/admin/automations/templates/$TEMPLATE_ID/install \
  -H 'Content-Type: application/json' \
  -d '{}'
```

The new workflow is created in `status: paused`. PATCH it to `active`
before running.

## n8n bridge

`GET /api/admin/automations` includes a `bridge` object reporting the
local n8n service's health when present. The native engine does not
depend on n8n being up. When you do want to run a native workflow on
n8n, export it:

```bash
curl -sS http://127.0.0.1:7710/api/admin/automations/workflows/$WORKFLOW_ID/n8n-export
```

The response is JSON in n8n's import format. Drop it into the n8n UI's
"Import from File" flow.

## Required configuration

Native automations work with no extra configuration for the nine step
types listed above. No model API keys, no external services.

Two optional environment variables come into play if you later enable
the AI-assisted steps documented in the runtime layer:

- `AWOS_AUTOMATION_AI_PROVIDER` — overrides which provider AI steps
  route through (`kimi`, `openai`, `minimax`, `ollama_cloud`).
- `AWOS_AUTOMATION_AI_MODEL` — overrides the model name passed to the
  provider.

When AI steps fire, the daemon reads the corresponding `<PROVIDER>_API_KEY`
from `process.env` or from `~/.agentworks/secrets.env` (override path
with `AWOS_SECRETS_PATH`). See `packages/agentos-d/src/adapters/awos-secrets.ts`
for the resolution order.

## Experimental step types

The runtime layer defines additional step types beyond the nine listed
above (flow control, AI, HTTP, file I/O, email/message send, evidence
packing). They are not exposed through the public REST schema and are
filtered out of the templates list response by default.

Set `AWOS_AUTOMATION_EXPERIMENTAL_STEPS=1` in the daemon environment to
opt in. With the flag on:

- Bundled templates that use experimental step types become visible in
  the templates list response.
- `POST /api/admin/automations/templates/:templateId/install` accepts
  templates that use experimental step types.
- `POST /api/admin/automations/workflows` and `PATCH .../workflows/:id`
  still enforce the 9-type Zod schema for operator-authored definitions.
  Experimental step types are only reachable through bundled templates
  and direct service calls in this release.

Treat the flag as an opt-in to functionality whose API surface may
change without a major-version bump.

## Other limitations in this release

- A workflow can declare at most 20 steps.
- Run history retention is not pruned automatically yet.
- Templates cannot reference other templates; nesting is a future
  feature.

Track open work and report issues on the
[`agentworks-os-vps`](https://github.com/SGridworks/agentworks-os-vps/issues)
repository.
