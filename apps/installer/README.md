# AgentWorks OS — Installer

One-command bootstrap for AgentWorks OS. Works on any machine with Docker installed.

## Requirements

- **Docker** 20.10+ (with docker compose plugin or standalone `docker-compose`)
- **curl** (to fetch the installer)
- **Internet access** (to pull Docker images on first run)
- macOS, Linux, or Windows with WSL2

## Quick Install

Run this in your terminal:

```bash
curl -fsSL https://get.agentworks.os/install.sh | bash
```

For non-interactive (CI/CD) use:

```bash
curl -fsSL https://get.agentworks.os/install.sh | bash -s -- --unattended
```

## What the Installer Does

1. **Checks Docker** — verifies Docker is installed and the daemon is running
2. **Creates `~/.agentworks/`** — data, config, and log directories
3. **Generates secrets** — `AGENTWORKS_SESSION_SECRET`, admin password, DB password
4. **Writes `~/.agentworks/.env`** — consumed by `docker compose`
5. **Seeds rule-packs** — copies the default compliance packs into the volume
6. **Starts services** — `agentos-d`, `scanner-worker`, `n8n`
7. **Waits for health** — polls `http://localhost:7710/api/health` (up to 60s)
8. **Creates default tenant** — via `POST /api/tenants`
9. **Prints next steps** — URLs, credentials, and CLI commands

## Services

| Service | Port | Description |
|---------|------|-------------|
| `agentos-d` | 7710 | Main substrate daemon (REST + MCP) |
| `scanner-worker` | 3101 | Compliance scanner sidecar |
| `n8n` | 5678 | Workflow automation |

## Post-Install

1. Verify the daemon:

   ```bash
   curl http://localhost:7710/api/health
   ```

2. Connect Claude Desktop:

   ```bash
   agentworks mcp configure
   ```

The default Docker Compose stack starts `admin-ui` at `http://localhost:3000`.
On a VPS, keep it loopback-only and use an SSH tunnel or authenticated TLS
reverse proxy.

## Managing Services

Use the `agentworks` CLI (installed alongside the installer) — it wraps
`docker compose` so the right source root and env file are picked up
automatically.

```bash
agentworks status            # ps
agentworks logs              # logs -f
agentworks logs agentos-d    # logs -f for a single service
agentworks update            # update to the latest published release
agentworks update --check    # report current vs latest, no changes
agentworks uninstall         # stop, remove volumes, delete data dirs
```

## Uninstall

```bash
agentworks uninstall
```

## Local Checkout Development

If you are running the installer from a repo checkout, the script detects the local `docker-compose.yml` and rule-packs directory and uses them instead of cloning from GitHub:

```bash
cd ~/Projects/agentworks-os
./apps/installer/src/install.sh
```

## Troubleshooting

### "Docker daemon is not running"

Start Docker Desktop (or `sudo systemctl start docker` on Linux).

### "agentos-d did not respond within 60s"

Check if the container started correctly:

```bash
cd ~/.agentworks
docker compose logs agentos-d
```

### Services start but n8n is slow

n8n initialises its internal SQLite DB on first boot and may take up to 2 minutes. The installer does not block on n8n.

### Rule-packs not loading

Rule packs stay in the installed source checkout and are mounted into the
`agentos-d` container. Verify:

```bash
ls ~/.agentworks/source/rule-packs/
docker compose --env-file ~/.agentworks/config/.env -f ~/.agentworks/source/docker-compose.yml exec agentos-d ls /app/rule-packs/
```

## Architecture

```
~/.agentworks/
├── source/              # Cloned AgentWorks OS source (build context)
├── config/
│   ├── .env             # Auto-generated env (mode 600, used by docker compose)
│   └── secrets.json     # Generated admin password (mode 600)
├── data/
│   ├── agentworks.db    # SQLite database
│   ├── vault/           # Tenant vault
│   ├── n8n/             # n8n workflows + sqlite (chmod 777, uid mismatch)
│   └── scanner/         # Scanner state cache (chmod 777, uid mismatch)
└── logs/                # docker compose logs output
```
