# VPS Quickstart

Use this when a human operator, Codex, or Claude Code needs to clone and run AgentWorks OS on a fresh VPS.

## 1. Clone

```bash
git clone https://github.com/SGridworks/agentworks-os-vps.git
cd agentworks-os-vps
```

For a release candidate:

```bash
git checkout BRANCH_OR_TAG
```

## 2. Configure

```bash
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
```

Edit `.env`:

```text
AGENTWORKS_SESSION_SECRET=<first-generated-secret>
POSTGRES_PASSWORD=<second-generated-secret>
```

Keep these values unless you have a secured reverse proxy:

```text
AGENTOS_BIND_ADDR=127.0.0.1
SCANNER_BIND_ADDR=127.0.0.1
ADMIN_UI_BIND_ADDR=127.0.0.1
AGENTOS_HOST_PORT=7710
SCANNER_HOST_PORT=3101
ADMIN_UI_HOST_PORT=3000
```

## 3. Start

```bash
docker compose up -d --build
docker compose ps
```

Expected host endpoints:

```text
http://127.0.0.1:3000        Admin UI
http://127.0.0.1:7710        agentos-d REST API
http://127.0.0.1:7710/api/mcp MCP endpoint
http://127.0.0.1:3101/health Scanner health
```

## 4. Verify

```bash
curl -fsS http://127.0.0.1:7710/api/health
curl -fsS http://127.0.0.1:3101/health
curl -fsS http://127.0.0.1:3000
```

## 5. Remote Access

From your laptop:

```bash
ssh -L 3000:127.0.0.1:3000 -L 7710:127.0.0.1:7710 -L 3101:127.0.0.1:3101 user@YOUR_VPS_HOST
```

Then open:

```text
http://127.0.0.1:3000
```

## 6. Codex MCP

```bash
codex mcp add agentworks --url http://127.0.0.1:7710/api/mcp
codex mcp list
```

## 7. Claude Code MCP

```bash
claude mcp add --transport http agentworks http://127.0.0.1:7710/api/mcp
claude mcp list
```

## 8. Stop Or Update

```bash
docker compose down
git pull --ff-only
docker compose up -d --build
```

## Security

Do not expose port `7710` directly to the internet. MCP auth forwarding is not implemented yet. Use SSH tunnels, VPN, or an authenticated TLS reverse proxy.
