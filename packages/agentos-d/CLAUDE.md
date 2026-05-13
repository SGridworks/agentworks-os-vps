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
| `AGENTOS_LEGACY_ADAPTER_URL` | unset | Optional legacy adapter URL for compatibility proxying. |
| `AGENTOS_LEGACY_ADAPTER_API_KEY` | unset | API key sent to the legacy adapter when enabled. |
| `AGENTOS_LEGACY_ADAPTER_ENABLED` | unset | Enables legacy adapter compatibility behavior when truthy. |
| `AGENTOS_EXECUTION_DATABASE_URL` | unset | Optional execution database URL override. |
| `AGENTOS_COMPANY_ID` | config default | Default execution company id for daemon-owned background tasks. |
| `AGENTOS_STANDING_ISSUE_ID` | config default | Default standing issue id for watcher digests and alerts. |
| `AGENTOS_API_URL` | `http://127.0.0.1:7710` | Base URL used by daemon-internal process watcher callbacks. |
| `AGENTOS_API_KEY` | `local-trusted` | API key used by daemon-internal process watcher callbacks. |

## Vault / Memory

| Variable | Default | Description |
|---|---|---|
| `VAULT_ROOT` | `~/vault` | Root directory for the file-backed tenant vault. Each tenant lives at `<VAULT_ROOT>/<tenantId>/`. The shared wiki content stays at `<VAULT_ROOT>/wiki/`; the prod tenant symlinks `wiki -> ../wiki` so wikilinks like `[[wiki/me/profile]]` resolve. |
| `MEMORY_KEY_MAX_BYTES` | `32768` | Hard per-key write limit (bytes). Writes exceeding this are rejected with `MemoryKeyTooLargeError`. Set to `0` to disable the cap (not recommended). |
| `CLAUDE_CODE_MEMORY_ROOT` | unset | Optional host path for operator-memory reads exposed through the MCP route. |

## Policy Engine

| Variable | Default | Description |
|---|---|---|
| `RULE_PACKS_DIR` | `<cwd>/rule-packs` | Directory containing YAML rule pack subdirectories. Each subdirectory's `*.yaml` files are loaded as candidate packs. |
| `AGENTWORKS_DEFAULT_PACK_ID` | `smb-starter` | Default pack assigned to newly created tenants. Set to an empty string to disable automatic assignment. |

## Agents / Execution

| Variable | Default | Description |
|---|---|---|
| `AWOS_AGENTS_ROOT` | `<repo>/agents` | Root directory for agent instruction files and migration backfills. |
| `AWOS_ADAPTER` | `stub` | Dispatch adapter selection. Use `router`, `spec`, or `kimi` only when Kimi credentials are configured. |
| `AWOS_REPO_ROOT` | current working directory | Repository root used by Kimi adapters when building task context. |
| `AGENTOS_DISPATCH_CONSUMER_ENABLED` | `true` | Set to `false` to stop the dispatch queue consumer. |
| `AGENTOS_DISPATCH_CONSUMER_INTERVAL_MS` | internal default | Dispatch consumer polling interval. |
| `AGENTOS_DISPATCH_CONSUMER_BATCH` | internal default | Maximum dispatch rows consumed per polling cycle. |
| `KIMI_API_KEY` / `MOONSHOT_API_KEY` | unset | Required only when a Kimi-backed adapter is selected and receives work. |
| `KIMI_BASE_URL` | `https://api.moonshot.ai/v1` | Kimi-compatible OpenAI API base URL. |
| `KIMI_MODEL` | `kimi-k2-turbo-preview` | Default model for Kimi-backed adapters. |
| `KIMI_TOOL_MODEL` | `KIMI_MODEL` | Model for the tool adapter. |
| `KIMI_REVIEW_MODEL` | `KIMI_MODEL` | Model for the review adapter. |
| `AWOS_TOOL_MAX_TURNS` | `50` | Maximum turns for tool-adapter tasks. |
| `AWOS_REVIEW_MAX_TURNS` | `25` | Maximum turns for review-adapter tasks. |
| `PDF_ENGINE` | fake engine | Set to `puppeteer` to use the Puppeteer PDF engine. |
| `PDF_ENGINE_EXECUTABLE_PATH` | unset | Browser executable path when `PDF_ENGINE=puppeteer`. |

## Scanner Sidecar

| Variable | Default | Description |
|---|---|---|
| `SCANNER_SIDECAR_URL` | `http://127.0.0.1:3101` | HTTP endpoint of the Python `scanner-worker`. |
| `SCANNER_POLL_INTERVAL_MS` | `30000` | Interval between background scanner polls. |
