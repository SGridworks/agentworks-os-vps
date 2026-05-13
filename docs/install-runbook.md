# Install Runbook

**Time to complete:** under 20 minutes on a clean machine.
**Audience:** IT generalist or developer setting up AgentWorks OS for the first time.

If you are migrating from an existing setup with vault data or agent memory, follow the [Migration Guide](./migration-guide.md) instead. This runbook is for greenfield installs.

---

## Prerequisites

### Hardware

| | Requirement |
|---|---|
| Machine | Mac mini (M1/M2/M3) or Linux (Ubuntu 20.04+, Debian 11+) on the same LAN as agents |
| RAM | 4 GB minimum, 8 GB recommended |
| Disk | 10 GB minimum, 20 GB recommended |
| Network | Ethernet recommended over WiFi |

### Software

- **Docker Desktop** (macOS) or **Docker Engine** (Linux)
- At least one agent to connect: Claude Desktop, Cursor, Codex, or a custom REST integration

Check Docker is installed and running:

```bash
docker --version    # should print a version number
docker ps           # should list running containers (header row is fine)
```

If `docker ps` returns a connection error, open Docker Desktop and wait for it to finish starting before proceeding.

---

## Step 1 — Run the Installer

On the machine that will host AgentWorks OS:

```bash
git clone --depth=1 --branch v0.1.9 https://github.com/SGridworks/agentworks-os.git
cd agentworks-os
./apps/installer/src/install.sh --unattended \
  && ./apps/installer/scripts/smoke-test.sh
```

The script will:

1. Run pre-flight (Docker daemon up, ports 7710/3101/5678 free, ≥10 GB disk, ≥4 GB RAM, internet to github.com).
2. Create `~/.agentworks/` with `data/`, `config/`, and `logs/` subdirs (and pre-chmod `data/n8n` + `data/scanner` to 777 for the n8n+scanner uid mismatch).
3. Re-use the local checkout if you ran from one; otherwise `git clone` into `~/.agentworks/source`.
4. Generate secrets (admin password, session secret, hex DB password) into `~/.agentworks/config/{.env,secrets.json}` mode 600. **The admin password is in `~/.agentworks/config/secrets.json`.**
5. `docker compose pull` (best effort — falls through to local build).
6. `docker compose up -d --build`. First build is 5-15 minutes.
7. Wait up to 120s for `/api/health` to return 200, then run the end-to-end smoke test (POST /api/tenants + POST /api/policy/check + scanner/n8n/admin health assertions).

If the script fails, see [Common Errors](#common-errors) at the end of this document.

---

## Step 2 — Verify All Services Are Running

```bash
docker compose --env-file ~/.agentworks/config/.env -f ~/.agentworks/source/docker-compose.yml ps
```

All default services should show `Up` within 30 seconds of the installer completing.

| Service | What it is | Port |
|---|---|---|
| `agentos-d` | Main daemon — REST API + MCP server | 7710 |
| `scanner-worker` | AgentGuard sidecar — security scanner | 3101 |
| `n8n` | Workflow automation | 5678 |
| `admin-ui` | Browser operator dashboard | 3000 |
| `postgres` | Local execution database | internal only |

All host ports are loopback-bound by default. On a VPS, use SSH tunnels or an authenticated TLS reverse proxy rather than opening service ports directly.

---

## Step 3 — Verify the daemon

Verify the REST/MCP daemon:

```bash
curl http://localhost:7710/api/health
```

Expected result: HTTP 200 with `"status":"ok"`.

Verify the rest of the default stack:

```bash
curl -fsS http://127.0.0.1:3101/health
curl -fsS http://127.0.0.1:5678/healthz
curl -fsSI http://127.0.0.1:3000/mission-control
```

---

## Step 4 — Connect an Agent via MCP

### Claude Desktop

1. Run:

```bash
agentworks mcp configure --target claude-desktop
```

2. Restart Claude Desktop.

3. In a new conversation, verify the connection:

```
/memory read
```

If AgentWorks OS is connected, Claude will return vault content. An empty vault returns `{ "existed": false }` — this is normal on a fresh install.

### Cursor

Cursor Settings → Features → MCP → Add server URL: `http://localhost:7710`

### Codex CLI

```bash
codex mcp add agentworks http://localhost:7710
```

### Custom Agents (REST)

Submit policy checks directly to the REST API. See [AWCP](./awcp.md) for the action envelope schema.

```bash
curl -X POST http://localhost:7710/api/policy/check \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "YOUR_TENANT_ID",
    "actionKind": "outbound.sms",
    "payload": { "to": "5550001234", "body": "hello" },
    "actorId": "test-user",
    "actorLabel": "test user",
    "actorType": "system",
    "summary": "install-runbook policy check"
  }'
```

The response includes a `decision` field: `allow`, `block`, or `route_to_review`.

---

## Step 5 — Verify a Policy Decision

List loaded rule packs:

```bash
curl http://localhost:7710/api/policy/packs
```

Submit a test policy check:

```bash
curl -X POST http://localhost:7710/api/policy/check \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "YOUR_TENANT_ID",
    "actionKind": "outbound.sms",
    "payload": { "to": "5550001234", "body": "test message" },
    "actorId": "test-user",
    "actorLabel": "test user",
    "actorType": "system",
    "summary": "install-runbook policy check"
  }'
```

A `block` response means the action was caught by an active rule. A `route_to_review` response means it landed in the approval queue. `allow` means no rule fired.

---

## Step 6 — Verify the Scanner

Trigger a manual scan:

```bash
curl -X POST http://localhost:7710/api/scanner/submit \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "YOUR_TENANT_ID",
    "pasteContent": "# Test CLAUDE.md\n# No risky patterns here",
    "policyMode": "shadow"
  }'
```

Poll for results (replace `SCAN_ID` with the value from the response):

```bash
curl "http://localhost:7710/api/scanner/jobs/SCAN_ID?tenantId=YOUR_TENANT_ID"
```

A clean first scan shows zero findings.

---

## Step 7 — n8n Workflow Automation

n8n is pre-configured with AgentWorks custom nodes and two starter workflows.

**Access:** `http://localhost:5678`

On first launch, n8n prompts you to create an owner account. After that, the seed script populates the workflows:

```bash
node ~/.agentworks/source/scripts/n8n-workflow-seed.js
```

### AgentWorks Nodes in n8n

| Node | Purpose |
|---|---|
| **AgentWorks Policy Check** | Submit an action to the compliance engine. Three outputs: Allow / Block / Review |
| **AgentWorks Memory Write** | Write a vault page (key + body) for your tenant |
| **AgentWorks Memory Read** | Read a vault page by key for your tenant |
| **AgentWorks Dispatch** | Hand a task to a target agent via the substrate queue |

### Starter Workflows

1. **Lead Intake** — Policy-check a lead record on intake; write to vault on allow, route to review, log on block
2. **Outbound Dispatch** — Policy-check an outbound action; dispatch to agent on allow, route to review, or audit on block

### Configure Tenant Variables

After import, edit each workflow and set:

| Variable | Value |
|---|---|
| `TENANT_ID` | Your tenant UUID from `GET /api/tenants` |
| `ACTOR_ID` | Identifier for this workflow, e.g. `n8n-workflow` |
| `DEFAULT_AGENT_ID` | Target agent ID for dispatch nodes |

For production, create a dedicated API key in n8n under **Settings → API Key** rather than using the owner account credentials.

---

## Common Errors

### "Docker is not running"

`docker ps` returns a connection error.

**Fix:** Open Docker Desktop. Wait for the whale icon in the menu bar to stop animating. Run `docker ps` again.

---

### "Port 7710 is already in use"

The `agentos-d` daemon couldn't bind to port 7710.

**Fix:** Find the conflicting process:

```bash
lsof -i :7710
```

Stop it and re-run the installer. Custom host ports are not supported in v0.1.x because health checks, smoke tests, and docs assume fixed ports.

---

### "Where is the admin password?"

The installer writes generated secrets to `~/.agentworks/config/secrets.json` with mode 600.

**Fix:** read it locally on the host:

```bash
cat ~/.agentworks/config/secrets.json
```

---

### "MCP connection refused" in Claude Desktop

Claude Desktop can't reach the AgentWorks OS MCP server.

**Fix (in order):**

1. Confirm AgentWorks OS is running: `docker compose --env-file ~/.agentworks/config/.env -f ~/.agentworks/source/docker-compose.yml ps` — `agentos-d` should show `Up`
2. Confirm the machine can reach the host: `curl http://localhost:7710/api/health` from the machine running Claude Desktop
3. If on different machines, use the IP address instead of `localhost`: `http://192.168.x.x:7710`
4. Check your Claude Desktop config has the correct URL with no trailing slash

---

### "Rule pack invalid" on first policy check

YAML syntax error or the pack references a field not in the action schema.

**Fix:** Validate with:

```bash
agentworks pack validate /path/to/pack.yaml
```

See [Rule Pack Authoring](./rule-pack-authoring.md) for the schema reference.

---

### "No rule packs loaded"

The policy engine started but no packs are active.

**Fix:** Use the REST API to load and activate a rule pack, or use **Policy** → **Rule Packs** in the Admin UI.

---

### Vault is empty after onboarding

Agents can connect but `/memory read` returns nothing.

**Fix:** Seed the vault through the memory API, or use **Memory** → **Seed from Text** in the Admin UI.

---

## Uninstalling

To remove AgentWorks OS and all data:

```bash
docker compose --env-file ~/.agentworks/config/.env -f ~/.agentworks/source/docker-compose.yml down -v
rm -rf ~/.agentworks
rm -rf ~/Library/Application\ Support/agentworks   # macOS
rm -rf ~/.config/agentworks                        # Linux
```

This deletes the database, vault, and all logs. The uninstaller does not touch your Claude Desktop config — remove the `agentworks` MCP server entry manually.

---

## Next Steps

- [User's Guide](./users-guide.md) — day-to-day operation
- [Rule Pack Authoring](./rule-pack-authoring.md) — write your own packs
- [Best Practices](./best-practices.md) — operational patterns for a healthy deployment
