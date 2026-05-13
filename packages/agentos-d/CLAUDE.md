# AgentWorks OS — Environment Variables

This file catalogues the environment variables that `agentos-d` and its
sub-systems read at startup. All are optional unless marked **Required**.

## Daemon

| Variable | Default | Description |
|---|---|---|
| `AGENTOS_HOST` | `127.0.0.1` | Bind address for the HTTP server. |
| `AGENTOS_PORT` | `7710` | Port for REST + MCP + WebSocket. |
| `AGENTOS_LOG_LEVEL` | `info` | Pino log level (`trace`, `debug`, `info`, `warn`, `error`, `fatal`). |
| `AGENTOS_DATA_DIR` | `./data` | SQLite DB path and local scratch space. **Production runs must set this to `~/Library/Application Support/agentworks-os/data` so a stray `node dist/cli.js` or `npx vitest` cannot fall back to the in-repo path.** Use `./run.sh` to launch with the canonical paths pre-set. Tests are guarded by `vitest.setup.ts`, which forces `AGENTOS_DATA_DIR` to a tmpdir if not already set. |
| `AGENTOS_AWCP_VERSION` | `awcp/v0.1` | Wire-format version string. |
| `AGENTOS_AUDIT_LOG_RETENTION_DAYS` | `30` | Age (days) at which `action_log` rows are purged. `0` = keep forever. |

## Vault / Memory

| Variable | Default | Description |
|---|---|---|
| `VAULT_ROOT` | `~/vault` | Root directory for the file-backed tenant vault. Each tenant lives at `<VAULT_ROOT>/<tenantId>/`. The shared wiki content stays at `<VAULT_ROOT>/wiki/`; the prod tenant symlinks `wiki -> ../wiki` so wikilinks like `[[wiki/me/profile]]` resolve. |
| `MEMORY_KEY_MAX_BYTES` | `32768` | Hard per-key write limit (bytes). Writes exceeding this are rejected with `MemoryKeyTooLargeError`. Set to `0` to disable the cap (not recommended). |

## Policy Engine

| Variable | Default | Description |
|---|---|---|
| `RULE_PACKS_DIR` | `<cwd>/rule-packs` | Directory containing YAML rule pack subdirectories. Each subdirectory's `*.yaml` files are loaded as candidate packs. |

## Scanner Sidecar

| Variable | Default | Description |
|---|---|---|
| `SCANNER_SIDECAR_URL` | `http://127.0.0.1:3101` | HTTP endpoint of the Python `scanner-worker`. |
| `SCANNER_POLL_INTERVAL_MS` | `30000` | Interval between background scanner polls. |
