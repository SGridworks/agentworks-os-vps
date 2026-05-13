# Quickstart Guide

**Goal:** install AgentWorks OS v0.1.9 on a clean Docker host, verify all default services, and run one policy decision end-to-end.

**Audience:** developer or IT generalist. No prior AgentWorks OS experience required.

---

## Prerequisites

- macOS or Linux machine you control
- Docker Desktop on macOS, or Docker Engine on Linux
- `git`, `curl`, `openssl`, and `python3`
- Optional for repo-developer E2E: Node.js 22+ with Corepack/pnpm enabled
- 4 GB RAM minimum, 8 GB recommended
- 10 GB free disk minimum, 20 GB recommended

Check Docker:

```bash
docker --version
docker ps
```

If `docker ps` returns a daemon or permission error, fix Docker before installing. Do not run the installer with `sudo`; it will create root-owned files under `~/.agentworks`.

---

## Step 1 - Install

Recommended release installer:

```bash
curl -fsSL https://github.com/SGridworks/agentworks-os-vps/releases/download/v0.1.9/install.sh | bash -s -- --unattended
```

Equivalent source-clone install:

```bash
git clone --depth=1 --branch v0.1.9 https://github.com/SGridworks/agentworks-os-vps.git
cd agentworks-os-vps
./apps/installer/src/install.sh --unattended
```

The installer:

- creates `~/.agentworks/data`, `~/.agentworks/config`, and `~/.agentworks/logs`
- writes fresh secrets to `~/.agentworks/config/.env` and `~/.agentworks/config/secrets.json`
- installs the `agentworks` wrapper on PATH when possible
- starts the Docker Compose stack from `~/.agentworks/source/docker-compose.yml`
- runs the installer smoke test

Expected completion signal:

```text
AgentWorks OS smoke test PASSED
```

---

## Step 2 - Verify Services

```bash
agentworks status
```

Expected default services:

| Service | Purpose | Host port |
|---|---|---|
| `agentos-d` | REST API + MCP server | `7710` |
| `scanner-worker` | security scanner sidecar | `3101` |
| `n8n` | workflow automation | `5678` |
| `admin-ui` | operator dashboard | `3000` |
| `postgres` | local execution database | internal only |

Default v0.1.9 uses fixed loopback-bound host ports `7710`, `3101`, `5678`, and `3000`. Custom host ports are not supported by the installer, smoke test, or docs in v0.1.x.

---

## Step 3 - Verify Health Endpoints

```bash
curl -fsS http://127.0.0.1:7710/api/health
curl -fsS http://127.0.0.1:3101/health
curl -fsS http://127.0.0.1:5678/healthz
curl -fsSI http://127.0.0.1:3000/mission-control
```

Expected:

- daemon health returns JSON with `"status":"ok"`
- scanner health returns HTTP 200
- n8n health returns HTTP 200
- admin-ui returns HTTP 200

---

## Step 4 - Run the E2E Smoke Test

From the installed source tree:

```bash
~/.agentworks/source/apps/installer/scripts/smoke-test.sh
```

The smoke test is the release-grade install check. It:

- polls `/api/health`
- creates a disposable tenant with `POST /api/tenants`
- evaluates a test action with `POST /api/policy/check`
- verifies scanner `/health`
- verifies n8n `/healthz`
- verifies admin-ui `/mission-control`
- deletes the disposable smoke tenant before exit

Scanner, n8n, and admin-ui are fatal by default in v0.1.9. Only set `SMOKE_SCANNER_OPTIONAL=1`, `SMOKE_N8N_OPTIONAL=1`, or `SMOKE_ADMIN_OPTIONAL=1` for narrow daemon-only debugging.

For the full VPS workflow gate after install:

```bash
cd ~/.agentworks/source
corepack enable
corepack prepare pnpm@9 --activate
pnpm install --frozen-lockfile
pnpm test:vps-e2e
```

That full workflow gate is for release/developer verification. It requires
host Node/Corepack/pnpm because it drives the installed Docker stack from the
source checkout.

---

## Step 5 - Manual Policy Check

Create or reuse a tenant:

```bash
TENANT_ID=$(curl -fsS -X POST http://127.0.0.1:7710/api/tenants \
  -H "Content-Type: application/json" \
  -d '{"name":"quickstart","description":"quickstart verification"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "$TENANT_ID"
```

Submit a policy check:

```bash
curl -fsS -X POST http://127.0.0.1:7710/api/policy/check \
  -H "Content-Type: application/json" \
  -d "{
    \"tenantId\": \"$TENANT_ID\",
    \"actionKind\": \"outbound.sms\",
    \"payload\": {\"to\":\"5550001234\", \"body\":\"test\"},
    \"actorId\": \"quickstart-test\",
    \"actorLabel\": \"quickstart test\",
    \"actorType\": \"system\",
    \"summary\": \"quickstart policy check\"
  }"
```

The response includes `decision`, `reason`, `requestId`, and `decisionId`. A valid decision is `allow`, `block`, or `route_to_review`.

---

## Step 6 - Connect an MCP Client

For Claude Desktop or Claude Code:

```bash
agentworks mcp configure --target claude-desktop
# or
agentworks mcp configure --target claude-code
# or
agentworks mcp configure --target both
```

Restart the client after configuration. The wrapper writes a local stdio bridge configuration and points it at `http://localhost:7710`.

---

## What's Next

| Task | Doc |
|---|---|
| Clean VPS deployment | [VPS Blank-Slate Install](./vps-blank-slate-install.md) |
| Full install procedure | [Install Runbook](./install-runbook.md) |
| E2E and manual verification | [E2E Verification](./e2e-verification.md) |
| Day-to-day operation | [User's Guide](./users-guide.md) |
| Bring existing vault or agent configs | [Migration Guide](./migration-guide.md) |
| Write policy rule packs | [Rule Pack Authoring](./rule-pack-authoring.md) |
| Back up or restore data | [Backup and Restore](./backup-restore.md) |

If a step fails, run:

```bash
agentworks logs
```

For support diagnostics, see [Support Bundle](./support-bundle.md).
