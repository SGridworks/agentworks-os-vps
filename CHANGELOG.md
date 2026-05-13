# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.9] — 2026-05-13

First public release of AgentWorks OS from the dedicated
[`SGridworks/agentworks-os-vps`](https://github.com/SGridworks/agentworks-os-vps)
repository. Ships a default-on admin UI, loopback-bound host ports, a VPS
install runbook, and a scripted full-stack E2E verification path. Includes
the fixes called out by successive rounds of the pre-release adversarial audit.

> Predecessor: the archived
> [`SGridworks/agentworks-os`](https://github.com/SGridworks/agentworks-os)
> repository carries the prior 0.1.0–0.1.9 history (private). This is the
> open-source successor and the first public-facing tag.

### Fixed (audit round 1)

- `apps/installer/src/install.sh` preflight now resolves both `docker compose`
  (v2) and legacy `docker-compose`, and the installer's `compose()` helper uses
  whichever was detected. Previously hosts with only the legacy v1 CLI passed
  preflight but failed during pull/up.
- `agentworks mcp configure` emits an actionable error when host `node` is
  missing, including OS-specific install hints. Install runbook now lists
  Node.js 18+ as a prerequisite for that step.
- `docs/install-runbook.md` Cursor and Codex CLI sections now wire the bundled
  MCP stdio bridge (`packages/agentos-d/dist/bin/mcp-stdio.js`) instead of
  pointing clients at the daemon's HTTP endpoint directly.
- `docs/AI-AGENT-INSTALL-GUIDE.md` MCP-client decision prompt matches the
  wrapper's actual targets (`claude-desktop`, `claude-code`, `both`), with a
  pointer to install-runbook for Cursor/Codex.
- `agentworks restore` accepts both `restore <file>` and
  `restore --input <file>` (also `--input=<file>` and `-i <file>`); the
  documented flag form now matches the parser.
- `docker-compose.yml` no longer hardcodes `container_name`/`name` on every
  service, network, or volume.

### Fixed (audit round 2)

- `packages/n8n-nodes/Dockerfile` installs the AgentWorks n8n nodes to
  `/opt/agentworks-extensions` (outside the bind-mounted `.n8n` user folder)
  and the compose file sets `N8N_CUSTOM_EXTENSIONS=/opt/agentworks-extensions`.
  Previously the `${AGENTWORKS_DATA_DIR}/n8n:/home/node/.n8n` bind mount
  shadowed the entire `node_modules/@agentworks/n8n-nodes` install, so the
  substrate-aware Policy/Memory/Dispatch nodes were missing on every fresh
  install.
- `agentworks update --check` now extracts SemVer tags that include
  prerelease / build-metadata identifiers (e.g. `0.1.9-rc1`, `0.1.10+build.42`).
  The previous regex truncated on the first non-digit and could compare a
  suffixed release against the bare semver string.
- `agentworks update` persists the resolved version to
  `$AGENTWORKS_DIR/config/.env` after a successful pull/up, so a subsequent
  `agentworks restart` cannot recreate containers from the old image tag.
- `docs/rule-pack-authoring.md` no longer references the unshipped
  `agentworks pack validate` / `agentworks pack dry-run` subcommands. The
  rule-pack validation path is now documented as
  `pnpm --filter @agentworks/policy-engine test -- <pack.yaml>` (offline) or
  `POST /api/policy/check` (live).
- `agentworks <unknown-command>` now exits non-zero and prints an explicit
  "Unknown command: …" message before help. Previously unknown commands
  silently fell through to help with exit 0, which made mistyped commands
  look successful in agent-driven scripts.
- `agentworks backup` creates `dirname "$output"` before writing the tarball,
  so the documented path `~/.agentworks/data/backups/<file>.tar.gz` works
  out of the box.
- `docs/AI-AGENT-INSTALL-GUIDE.md` vault-relocation guidance now reflects how
  the daemon actually reads the vault path — relocating means editing the
  compose bind mount, not setting `VAULT_ROOT` in `.env`.
- `agentworks support-bundle` redacts secret-shaped env values from the
  embedded compose config (`AGENTWORKS_SESSION_SECRET`, `POSTGRES_PASSWORD`,
  `*_API_KEY`, `*_TOKEN`, `*PASSWORD*`, `*SECRET*`), drops the postgres dump
  by default, and adds a `--include-db` opt-in for support requests that
  need it. A `BUNDLE-README.txt` describes what's in/out so support knows.
- `COMPOSE_PROJECT_NAME` is derived from `basename($AGENTWORKS_DIR) + short
  sha256 of full path`, so two installs with the same basename but different
  paths (e.g. `/tmp/a/.agentworks` and `/tmp/b/.agentworks`) no longer
  collide on compose project names.
- `apps/installer/scripts/smoke-test.sh` creates a per-run disposable tenant
  named `smoke-test-<timestamp>-<pid>` instead of a permanent `smoke-test`
  tenant. Repeated runs no longer pile up identical rows.

### Fixed (audit round 3)

- Customer docs no longer print raw
  `docker compose --env-file ~/.agentworks/config/.env -f ~/.agentworks/source/docker-compose.yml ...`
  invocations. Those resolve to a different compose project than what the
  installer uses (the installer now sets `COMPOSE_PROJECT_NAME`). All such
  commands in `install-runbook.md`, `users-guide.md`, `support-bundle.md`,
  `quickstart.md`, `AI-AGENT-INSTALL-GUIDE.md`, `error-messages.md`, and
  `vps-blank-slate-install.md` are now `agentworks status/logs/restart`
  or the explicit `cd ~/.agentworks/source && COMPOSE_PROJECT_NAME=...`
  form.
- `docs/install-runbook.md` Cursor + Codex MCP setup now points at
  `~/.agentworks/config/mcp-stdio-bridge.js` (which the installer extracts
  from the running container) with `AGENTOS_URL` to match
  `agentworks mcp configure`. The earlier `dist/bin/mcp-stdio.js` path was
  gitignored and not present in a clean clone.
- `agentworks support-bundle` sanitization now redacts URL userinfo
  (`scheme://user:pass@host`) in addition to whole-line secret keys, so
  `AGENTOS_EXECUTION_DATABASE_URL` and any future `*_DATABASE_URL` value
  no longer leaks the embedded password.
- `docs/users-guide.md`, `docs/best-practices.md`, `docs/install-runbook.md`,
  `docs/error-messages.md`, and `docs/brand-naming-convention.md` replace
  the unshipped `agentworks pack validate` / `agentworks pack dry-run`
  references with the supported
  `pnpm --filter @agentworks/policy-engine test -- <pack.yaml>` and
  `POST /api/policy/check` paths.
- `docs/users-guide.md` version-check section uses
  `agentworks --help | head -1` (which prints the wrapper's
  `AgentWorks OS CLI — <version>` banner) instead of the unimplemented
  `agentworks version` subcommand.

### Added

- `scripts/awos-vps-e2e.mjs` — full-stack E2E (`pnpm test:vps-e2e`) exercising
  preflight, tenant/company/project/agent creation, issue lifecycle, dispatch
  + wakeup, policy `route_to_review` queueing, scanner submit/poll, and
  cross-record visibility.
- `docs/e2e-verification.md` — operator-facing guide for running the E2E
  against a live install (loopback or SSH-tunneled).
- `apps/installer/src/agentworks.sh` ships `compose()` with a
  `COMPOSE_PROJECT_NAME` mixin so the wrapper and installer agree on
  resource naming.

### Fixed (audit round 8)

- `apps/installer/scripts/smoke-test.sh` no longer creates a persistent
  smoke-test tenant row that pollutes the normal Admin UI tenant list.
- Dockerized Admin UI onboarding no longer attempts to write host editor MCP
  configs from inside the `agentos-d` container. First-run pairing now points
  operators to the host wrapper command, `agentworks mcp configure`, and the
  daemon route returns an explicit unsupported response for host editor writes.
- Agent-facing docs now discover tenants via `GET /api/tenants` instead of
  the unshipped `~/.agentworks/data/tenant-bootstrap.json` file.
- MCP docs now point Docker installs at
  `~/.agentworks/config/mcp-stdio-bridge.js` / `agentworks mcp configure`
  instead of fixed container names.
- Rule-pack docs now use the installed source checkout path
  `~/.agentworks/source/rule-packs` instead of stale
  `~/Projects/agentworks-os` or `~/.agentworks/rule-packs` paths.
- `packages/agentos-d/CLAUDE.md` now catalogs the daemon startup environment
  variables used by execution, legacy-adapter, dispatch, and Kimi-backed
  adapter paths.

### Fixed (audit round 9)

- `apps/installer/scripts/smoke-test.sh` no longer depends on host Python.
  The script creates a real disposable tenant via `POST /api/tenants`, runs
  the policy round-trip against that tenant, parses the response with shell
  tools, and deletes the disposable tenant before exit.
- `agentos-d` now supports `DELETE /api/tenants/:id` for operator cleanup of
  tenant registry rows, associated rule-pack/webhook/provider config rows, and
  the tenant vault directory.
- README and scanner positioning docs no longer claim default nightly scanner
  runs or Issue creation. They now describe submitted scans and configured
  watch scans accurately.
- The Automation n8n node now defaults to `http://agentos-d:7710` inside the
  compose network, and the installer smoke test verifies all five AgentWorks
  n8n nodes plus that Docker-default daemon URL.
- Release workflow tag validation now uses an anchored `^vN.N.N$` regex, so
  prerelease or suffixed tags cannot pass the release gate.
- Backup/restore docs now match the wrapper's supported
  `agentworks restore --input <file>` form, and agent-facing doc headers now
  target v0.1.9.

### Fixed (audit round 10)

- Admin UI Docker builds now copy every workspace package manifest before
  `pnpm install`, so clean Docker builds do not fail on workspace package
  discovery.
- Default dispatch uses the no-op stub adapter unless operators explicitly set
  `AWOS_ADAPTER` and matching provider credentials.
- `agentworks mcp configure` no longer depends on host Python to write JSON MCP
  client config.
- n8n workflow seeding now uses the n8n v1 API with `N8N_API_KEY` and is
  idempotent by workflow name.
- Installer smoke-test compose diagnostics now resolve the installer-created
  compose project instead of assuming the caller's current directory.

### Fixed (audit round 11)

- Customer docs now use the stdio bridge MCP shape emitted by
  `agentworks mcp configure` instead of raw HTTP `url` configs or
  `agentworks.local`.
- Update docs use the supported `agentworks --help | head -1` version check
  and describe the wrapper's update path accurately.
- Scanner-watch docs now state that watch directories are disabled by default
  and must be configured with `SCANNER_WATCH_DIRS`.
- Error-message docs route diagnostics through `agentworks status`,
  `agentworks logs`, and loopback URLs that match the default compose stack.

### Fixed (audit round 12)

- Piped installer runs no longer block on `read -r` from the script pipe. The
  prompt reads from `/dev/tty` when available and otherwise continues as
  unattended.
- Release installs now pull published GHCR images for `agentos-d`,
  `scanner-worker`, and `admin-ui` by default, and locally build only the n8n
  image that bundles AgentWorks custom nodes. Source-build installs are still
  available with `AGENTWORKS_BUILD_IMAGES=1`.
- Admin UI vault graph BFF now proxies the daemon's tenant-scoped
  `/api/memory/graph` endpoint. The smoke test writes a real smoke memory page
  and verifies the dashboard BFF can see it.
- `DELETE /api/tenants/:id` now also removes tenant-scoped action log,
  approval queue, and policy decision rows created by disposable smoke runs.
- `agentworks update` can refresh archive-based installs that do not contain a
  `.git` directory by replacing `~/.agentworks/source` with a shallow clone of
  the target release tag.
- The default compose stack now drains daemon wakeup dispatches every 250 ms
  with the built-in stub consumer, so validation does not depend on any
  host-side worker claiming the queue first.
- Install docs now list `git`, `curl`, `openssl`, GitHub, GHCR, npm, and the
  optional Node/Corepack/pnpm requirements on the paths that actually need
  them.

### Fixed (audit round 13)

- Scanner migration docs now set `SCANNER_WATCH_DIRS` to container-visible
  `/config/...` paths that match the compose mount, rather than host
  `~/.agentworks/config/...` paths the scanner container cannot see.
- Evidence Report dashboard generation now converts date-picker values to ISO
  datetimes before calling `/api/evidence-reports/generate`.
- Evidence Report download helper now calls the PDF route with
  `tenant_id`/`from`/`to` query parameters and requests `application/pdf`.

### Fixed (audit round 14)

- Default compose now bind-mounts the installed host `rule-packs/` tree into
  `agentos-d`, so newly added packs can be loaded by
  `POST /api/policy/packs/reload`.
- Installer preflight now checks Docker Hub reachability because the v0.1.9
  release path still locally builds the n8n image from Docker Hub base images.
- Policy-engine now ships an explicit `validate:pack` command for validating
  arbitrary rule-pack YAML files, and docs no longer pretend `vitest run` can
  validate a user-provided pack path.
- Troubleshooting docs now route service restart/log actions through the
  installed `agentworks` wrapper instead of raw compose commands or fixed
  container names.

### Known limitations

- Real-VPS install verification for this release was performed against a
  local OrbStack docker-compose stack on canonical ports, not on an actual
  remote VPS. The bundled E2E passed end-to-end against that stack.
- Default dispatch uses the stub adapter unless `AWOS_ADAPTER` and matching
  provider credentials are configured. This verifies queue/wakeup plumbing but
  does not execute autonomous LLM work.
- `VAULT_ROOT` relocation requires editing the compose bind mount; a
  first-class `--vault-root` configuration is on the next-release backlog.

## [0.1.9-archived] — 2026-05-05

Patch release focused on release hardening, stale-update safety, and clean
operator handoff.

### Fixed

- Release workflow checks out the resolved semver tag, derives the release
  SHA from `git rev-parse HEAD`, lowercases GHCR image paths, and allows
  release asset overwrite on reruns.
- Re-running the installer over an existing install now refreshes
  `~/.agentworks/source` to the installer ref before handing off to
  `agentworks update`, avoiding stale wrapper bytes.
- `agentworks update` keeps `AGENTWORKS_VERSION` mutable so compose can pull
  or rebuild the target tag.
- `agentworks restart` recreates services with the current compose file and
  removes orphaned containers instead of doing a narrow process restart.
- MCP configuration supports Claude Desktop, Claude Code, or both, including
  WSL path handling for Windows-hosted clients.

### Operator notes

- Default install starts `agentos-d`, `scanner-worker`, `n8n`, `admin-ui`,
  and Postgres on loopback-bound host ports.
- The install smoke test checks daemon health, tenant creation,
  `policy.check`, scanner health, n8n health, and Admin UI route health.
  Scanner, n8n, and Admin UI are fatal gates unless explicitly downgraded for
  daemon-only debugging.
- v0.1.x still uses fixed host ports: `7710`, `3101`, `5678`, and `3000`;
  custom host ports are not supported by the installer or smoke-test path.
- Known CLI doc mismatch carried in v0.1.9: `agentworks restore` accepts the
  backup path as the first positional argument even though the help text says
  `--input <file>`.

## [0.1.8] — 2026-05-05

Patch release. Codex's adversarial pre-release audit (the prompt at
`docs/CODEX-PRE-RELEASE-AUDIT.md` introduced in v0.1.7) ran against
the v0.1.7 commit and surfaced 7 findings: 2 BLOCKERs, 3 HIGH,
2 MEDIUM. v0.1.8 closes 6 of them; one MEDIUM (compose container_name
collisions across multi-install) is deferred as not-blocking for the
single-install norm.

### Fixed

- **agentos-d never loaded `SCANNER_SIDECAR_URL` (BLOCKER).** The
  config schema declared `scannerSidecarUrl` with default
  `http://127.0.0.1:3101`, but `loadConfig()` did not pass
  `env.SCANNER_SIDECAR_URL` to the Zod parse — so the daemon always
  used the default `127.0.0.1:3101`, which from inside the
  `agentos-d` container is the container itself, not the
  `scanner-worker` container. Every `/api/scanner/*` proxy call
  failed silently. Fix: `loadConfig()` now reads
  `env.SCANNER_SIDECAR_URL` (and `env.SCANNER_POLL_INTERVAL_MS`),
  and `docker-compose.yml` sets
  `SCANNER_SIDECAR_URL: http://scanner-worker:3101` on the agentos-d
  service. Removed the dead `SCANNER_SIDECAR_URL` from the
  scanner-worker service env (the Python code never read it; it was
  set on the wrong side of the relationship for two releases).
- **`docs/quickstart.md` promised an Admin UI at :7710 that does not
  exist (BLOCKER).** `agentos-d` does not serve a UI; the
  `admin-ui` package is published to GHCR but `docker-compose.yml`
  does not start it. Customer-facing docs now describe the daemon
  REST surface and explicitly note that admin-ui inclusion is a
  pending decision; no link to a non-existent UI.
- **Post-fix audit found remaining Admin UI install references
  (BLOCKER).** `docs/users-guide.md`, `docs/install-runbook.md`,
  `docs/mcp-integration.md`, migration docs, rule-pack docs, and the
  smoke-test footer still described the Admin UI/onboarding wizard as
  part of the default install. These now route default v0.1.x users to
  REST/MCP flows and mark the Admin UI as a separately-run package.
- **Smoke test gave a false PASS when scanner-worker or n8n was unreachable
  (HIGH).** The script printed `[WARN]` and continued, so a release
  gate could pass with the scanner sidecar broken. Stub mode (the
  default since v0.1.7) means `/health` should respond in <1s; if it
  doesn't, the sidecar is genuinely broken. Smoke test now treats
  scanner /health as fatal with a 30s deadline and n8n /healthz as
  fatal with a 120s deadline. Override with `SMOKE_SCANNER_OPTIONAL=1`
  or `SMOKE_N8N_OPTIONAL=1` only for daemon-only debugging.
- **Misleading "override AGENTOS_PORT" guidance in the
  port-conflict error message (HIGH).** The error told users to
  override the port, but every health check, doc URL, smoke-test
  invocation, and CLI command hardcodes 7710/3101/5678. Updated the
  message to explicitly say custom ports are not supported in v0.1.x.
- **Dead doc link `agentworks restart agentos-d` (HIGH).** The AI
  install guide §2.2(C) referenced a `restart` subcommand the
  wrapper did not implement; running it just printed help. Added
  `cmd_restart` to `agentworks.sh` (with no args bounces all
  services; with args bounces only the named services).
- **Stale `apps/installer/Dockerfile` (MEDIUM).** Referenced
  `bin/install.sh` which doesn't exist (deleted in v0.1.3). The
  Dockerfile bundled an installer-as-Docker-image idea that never
  shipped. Deleted; `apps/installer/src/install.sh` is the canonical
  install entry point.

### Known limitations carried forward

- Compose uses fixed `container_name`, network, and volume names.
  Two AgentWorks installs on the same host (different `AGENTWORKS_DIR`
  overrides) collide on `agentos-d` / `agentworks-postgres` /
  `scanner-worker` / `agentworks-n8n` container names. Single-install
  is the v0.1.x norm; multi-install would require deriving names
  from a project tag.
- `admin-ui` image is published but not started by compose. Customer
  install docs route users through REST/MCP for v0.1.x. Decision
  pending: add the service and route through reverse proxy, or keep it
  as a separately-run package.
- `postgres` runs by default and `agentos-d depends_on` it, despite
  install.sh banner calling postgres "legacy / not used in v1."
  Either docs or compose is wrong; non-blocking, deferred.

## [0.1.7] — 2026-05-04

Patch release. The v0.1.6 install succeeded ("Smoke test PASSED") but
the customer's post-install report surfaced one user-visible issue
(scanner /health unreachable) and a deep audit of the install path
turned up a cluster of latent bugs. v0.1.7 closes them.

### Fixed

- **scanner-worker /health unreachable for 5–15 min on first boot
  (BLOCKER, customer-reported).** The FastAPI app's `lifespan()`
  startup hook synchronously called `embed.preload()` and
  `rerank.preload()` BEFORE `yield`, which downloaded
  `BAAI/bge-base-en-v1.5` (~440 MB) and `BAAI/bge-reranker-base`
  (~1 GB) from HuggingFace. Uvicorn refuses connections until lifespan
  startup returns, so the scanner port was simply unbound for the
  download window. The smoke test gave up after ~3s and warned. Fix:
  `docker-compose.yml` now defaults `EMBEDDING_MODE=stub` and
  `RERANKER_MODE=stub` for the scanner-worker service. `/health`
  responds in <1s. Customers who want the real embedding models can
  flip to `EMBEDDING_MODE=real` / `RERANKER_MODE=real` in
  `~/.agentworks/config/.env` and restart.
- **scanner-worker watch poller never started (BLOCKER, silent).**
  `docker-compose.yml` set `SCANNER_WATCH_DIRS`, but
  `packages/scanner-worker/src/scanner_worker/app.py:112` reads
  `WATCH_DIRS`. The mismatch meant agent-config drift was silently
  never scanned. Compose env renamed; separator changed from `,` to `:`
  to match the parser.
- **scanner-worker Dockerfile EXPOSE/HEALTHCHECK on wrong port
  (BLOCKER, latent — masked by compose).** Dockerfile declared
  `EXPOSE 8001` and ran `HEALTHCHECK ... :8001/health`. Compose
  overrode the healthcheck to use 3101, hiding the bug; anyone running
  the image standalone (`docker run scanner-worker`) got a
  permanently-unhealthy container. Both lines now use 3101 (with the
  HEALTHCHECK reading `SCANNER_WORKER_PORT` for parity with the
  service env).
- **`agentworks update --check` broken on macOS (HIGH).** The wrapper
  used `grep -oP` (Perl-style regex), which is GNU-only. BSD grep on
  macOS does not support `-P`, so every Mac install reported "Could
  not fetch latest version" silently. Replaced with a portable `sed`
  pattern. Same fix applied to two other `grep -oP` uses inside
  `install.sh` (docker version + docker-compose version fallbacks).
- **`agentworks update --check` lied on every fresh install (HIGH).**
  The wrapper's default `AGENTWORKS_VERSION` was hard-pinned at
  `0.1.2`, four releases stale. So a freshly-installed v0.1.6 reported
  "Current 0.1.2 → Latest 0.1.6" and pulled an "update" the user
  already had. Bumped to 0.1.7 and added a release-checklist comment
  flagging it as a bump-on-every-tag value.
- **Dead doc link `install-runbook.md §Vault` (HIGH,
  customer-reported).** `docs/AI-AGENT-INSTALL-GUIDE.md §2.2 (B)`
  pointed at a section that never existed in the runbook. Replaced
  with an inline three-command symlink walkthrough, since that's all
  Layout B actually needs.

### Added

- **`install.sh` automatically adds `~/.local/bin` to the user's
  shell rc on Linux/WSL** when the `agentworks` CLI lands in
  `~/.local/bin` (instead of the system `/usr/local/bin`).
  Idempotent — won't re-append the line on re-runs. Detects bash
  vs zsh from `$SHELL` and writes to `~/.bashrc`, `~/.bash_profile`,
  or `~/.zshrc` accordingly. Friend's v0.1.6 report flagged this as
  "minor / cosmetic"; bundled here so the next install is one shell
  reload from a working CLI.

### Known limitations carried forward

- `admin-ui` image is published to GHCR but not started by
  `docker-compose.yml`. README and `install-runbook.md` still
  reference an admin UI on port 7710 that the daemon does not actually
  serve. Decision pending on whether to add the service or drop the
  reference; not a blocker for v0.1.7.
- `postgres` runs by default and `agentos-d` `depends_on` it, despite
  `install.sh`'s banner calling postgres "legacy / not used in v1."
  Either docs or compose is wrong; non-blocking, deferred.

## [0.1.6] — 2026-05-04

Patch release. Fixes the v0.1.5 install pipeline blocker that surfaced
the moment a friend ran the install on a clean Win11/WSL2 host: the
n8n image build aborted at COPY because `packages/n8n-nodes/dist`
doesn't exist in a fresh clone (it's gitignored). v0.1.6 is the first
release where every Dockerfile in the stack builds without a host-side
build step.

### Fixed

- **packages/n8n-nodes/Dockerfile**: was a single-stage Dockerfile that
  COPY'd `./packages/n8n-nodes/dist` from the build context, expecting a
  pre-built artifact. `dist/` is gitignored, so on a fresh clone the
  COPY failed with `failed to compute cache key: "/packages/n8n-nodes/dist":
  not found`, which aborted the entire `docker compose up` and left
  install.sh in the failure path with no services running. Rewritten as a
  multi-stage build (node:22-alpine builder → n8nio/n8n runtime) that
  installs pnpm, builds n8n-nodes from source inside the image, then
  copies the resulting dist/ into n8n's discoverable node_modules. Same
  pattern as packages/agentos-d/Dockerfile and packages/admin-ui/Dockerfile.

### Other

- Bundled non-blocking polish from the v0.1.5 → v0.1.6 window:
  - **fix(memory)**: vault-lint dead-link false positives. Wikilinks in
    fenced code blocks (template/example placeholders like `[[page-name]]`)
    no longer count as real outbound links, and the resolver now matches
    in both directions so tenant-prefixed `[[<tenantId>/me/profile]]`
    resolves to `me/profile.md`. On a 365-page vault the dead-link warning
    count dropped from 243 → ~80 (real broken links only).
  - **fix(admin-ui)**: TopBar tenant switcher was a styled no-op (rendered
    a chevron but had no click handler). Wired with localStorage
    persistence + custom-event broadcast via a new `useActiveTenant` hook;
    memory-vault page migrated to read the active tenant from the hook
    instead of hardcoding `tenants[0]`.
  - **chore(agents)**: 21 agent-instruction files in `agents/_imported/`
    and `agents/*/AGENTS.md` had stale paperclip/Hermes vocabulary that
    surfaced verbatim in the admin UI's agent-instruction renderer.
    Replaced customer-visible labels (Paperclip API → AgentWorks API,
    `{{paperclipApiUrl}}` → `{{agentworksApiUrl}}`, etc.) per
    `agents/_shared/STANDALONE-PRODUCT-DOCS.md`. Architectural lineage
    notes in role docs are kept (engineering-internal, not customer-visible).

## [0.1.5] — 2026-05-04

Patch release. Closes the v0.1.4 friend-readiness gap. v0.1.4 published a
working stack but the install-then-use loop still bounced anyone who wasn't
already familiar with the repo: the daemon silently wrote to an ephemeral
path inside the container, the `agentworks` CLI was never on PATH, and
the install guide's repo-detection grep matched no compose lines. v0.1.5
is the first release where a friend can `git clone && ./install.sh` and
have a CLI they can use afterwards.

### Fixed

- **`docker-compose.yml`**: agentos-d's data env var was named
  `AGENTWORKS_DATA_DIR`, but the daemon reads `AGENTOS_DATA_DIR`
  (`packages/agentos-d/src/config.ts:50`). The mismatch meant SQLite
  wrote to `/app/data` (an ephemeral container layer) instead of `/data`
  (the bind mount), and every tenant, vault page, and audit row vanished
  on the next `docker compose down`. Renamed to `AGENTOS_DATA_DIR`.
- **`apps/installer/src/install.sh`**:
  - Sentinel grep in repo-detection (`grep -q "agentworks/agentos-d"`)
    matched zero lines after the v0.1.3 image rename. Replaced with
    `grep -qE "packages/agentos-d/Dockerfile|agentos-d:"`, which matches
    on either the build directive or the published image tag.
  - Pre-flight now distinguishes "Docker daemon down" from "Docker
    daemon up but current user lacks permission" on Linux. The latter
    prints the `usermod -aG docker` fix and explicitly warns NOT to
    re-run `install.sh` under sudo (which would create root-owned files
    in `~/.agentworks`).
  - Added `check_openssl()` to pre-flight — the secret generator silently
    crashed mid-install on hosts without openssl on PATH.
  - `print_next_steps` no longer echoes the admin password, no longer
    points at admin-ui :3000 (not in the v0.1 compose), and no longer
    auto-opens a browser.
- **`docs/AI-AGENT-INSTALL-GUIDE.md`** and **`docs/install-runbook.md`**:
  bumped install command to v0.1.5, removed admin-ui :3000 references,
  fixed the repo-detection grep, fixed the wrong `~/.agentworks/docker-compose.yml`
  path (compose lives at `~/.agentworks/source/docker-compose.yml`), added
  a CLI-on-PATH callout, and added Docker-permission and openssl rows to
  the failure-modes table.

### Added

- **`agentworks` CLI on PATH**: install.sh now installs a symlink to the
  wrapper at `/usr/local/bin/agentworks` (or `~/.local/bin/agentworks`
  if `/usr/local/bin` is not writable). Every `agentworks <verb>` command
  in the docs now actually resolves after install. The installer's
  next-steps banner prints the absolute CLI path it chose so an LLM agent
  can hand it back verbatim if PATH is not configured.
- **MCP stdio bridge extraction**: install.sh now `compose cp`s
  `mcp-stdio-bridge.js` out of the running agentos-d container into
  `~/.agentworks/config/mcp-stdio-bridge.js` so `agentworks mcp configure`
  has a real file to point Claude Desktop / Cursor / Codex at.

## [0.1.4] — 2026-05-04

Patch release. Fixes the v0.1.3 release pipeline gap: admin-ui's image
failed to build, which cascaded and skipped the install.sh upload + GHCR
package public-flip steps. v0.1.4 is the first release where every
docker image publishes and the post-build steps run unconditionally.

### Fixed

- **admin-ui Dockerfile**: `pnpm --filter @agentworks/admin-ui build`
  matched zero packages because admin-ui's `package.json` declares its
  name as `admin-ui`, not `@agentworks/admin-ui` like every other package.
  Filter changed to `pnpm --filter admin-ui`. Also added a builder-stage
  `mkdir -p packages/admin-ui/public` so the runtime stage's COPY does
  not fail when no static assets exist yet.
- **Release workflow**: `Publish GitHub Release with install.sh` and
  `Make GHCR packages public` now run with `if: always()`. A partial
  image build (e.g. one Dockerfile broken) no longer skips the release
  asset upload, and whatever packages did publish still get flipped
  public.

## [0.1.3] — 2026-05-04

Patch release. Repairs the install pipeline end-to-end. v0.1.2 (and every
release before it) shipped a `curl | bash` install URL that exited 0 but
produced a half-broken stack on a clean Linux/WSL host. v0.1.3 is the
first version where `git clone && ./apps/installer/src/install.sh` actually
brings the substrate up and passes a real smoke test.

### Fixed

- **scanner-worker Dockerfile**: was unbuildable. `python:3.11-slim-amd64`
  does not exist on Docker Hub (`python:3.11-slim` is multi-arch already);
  `libffi7` no longer ships in Debian Trixie (renamed to `libffi8`); the
  COPY layout flattened `src/` into `/app/` and broke hatchling's dynamic
  version; `pip install -e .` left a `.pth` file pointing into the builder
  stage that did not exist at runtime.
- **agentos-d Dockerfile**: copying `packages/agentos-d/node_modules`
  invalidated every relative pnpm symlink into the virtual store. Now uses
  `pnpm deploy --filter @agentworks/agentos-d --prod /deploy` to materialize
  a flat tree.
- **`docker-compose.yml`**: scanner-worker build context corrected to
  `./packages/scanner-worker` (matches the release workflow); bind-mount
  paths parametrized via `AGENTWORKS_DATA_DIR`/`AGENTWORKS_CONFIG_DIR` so
  install.sh can run compose from the source root while volumes resolve
  under `~/.agentworks/`; `image:` repointed at `ghcr.io/sgridworks/...`
  so `docker compose pull` actually finds the published images.
- **`apps/installer/src/install.sh`**: clones the source instead of
  fetching only docker-compose.yml from raw GitHub (previous path could
  not work because compose has `build:` directives and v0.1 publishes
  nothing pullable); generates `POSTGRES_PASSWORD` as hex, not base64
  with `/`/`+` that corrupt the postgres URL; pre-creates `data/n8n` and
  `data/scanner` with chmod 777 so the container uid mismatch does not
  block writes; idempotent so re-running after a partial failure does
  not invalidate the saved admin password.
- **Release workflow**: `actions/cosign-installer@v4` does not exist —
  was the reason every release since v0.1.0 failed before pushing any
  GHCR image. Fixed to `sigstore/cosign-installer@v3`. Sign steps now
  early-exit cleanly if `COSIGN_PRIVATE_KEY` is not set instead of taking
  down the whole job.

### Added

- **Pre-flight checks in install.sh**: ports 7710/3101/5678 free, ≥10 GB
  disk under `$HOME`, ≥4 GB RAM, internet to github.com, Docker daemon
  reachable. Each failure prints the exact next action.
- **`apps/installer/scripts/smoke-test.sh`**: real install gate that
  POSTs `/api/tenants` and `/api/policy/check` end-to-end and asserts
  the response shape. `install.sh main()` calls it at the end and exits
  non-zero on failure. An LLM agent driving the install can grep for
  `[PASS]` / `[FAIL]` / "Smoke test PASSED".
- **Release workflow**: `workflow_dispatch` trigger so a maintainer can
  re-run a release without cutting a new tag; uploads
  `apps/installer/src/install.sh` as a release asset on every `v*` push
  via `softprops/action-gh-release@v2`; flips the published GHCR
  packages public so unauthenticated `docker compose pull` works for
  end users.
- **`docs/AI-AGENT-INSTALL-GUIDE.md`** rewritten (~600 → ~250 lines) for
  the new flow: clone, run two scripts, enumerated failure modes with
  fixes, final report template.

### Removed

- Stale `apps/installer/install.sh` and `apps/installer/bin/install.sh`
  duplicates (both stuck at v0.1.0). `apps/installer/src/install.sh` is
  the single source of truth.

## [0.1.2] — 2026-05-04

Patch release. Closes the v0.1.1 known-issues list — the agentos-d test
suite is now fully green.

### Fixed

- **`packages/agentos-d` autopilot integration test** — the daemon now boots
  from the correct release checkout path and uses `AGENTOS_DATA_DIR` plus a
  tmp `AWOS_AGENTS_ROOT`, avoiding stale package-relative data and agents
  paths in the test environment.
- **Autopilot dispatch idempotency** — safe auto-dispatched policy decisions
  now get idempotency rows too, so replaying the same dispatch key returns the
  same safe and review-side counts.
- **Backup / restore CLI** — restore round-trip now returns exit 0
  consistently against the v0.1.1 backup-safety guards; backup manifests store
  the restored SQLite payload checksum instead of an impossible self-referential
  tarball checksum.
- **Provenance frontmatter** — reads without an `actorId` no longer emit
  `lastUsedBy: []`; the key is omitted entirely, consistent with
  `authoringAgent`, `lastUpdatedBy`, and related optional frontmatter.
- **Mission-map node colors** — blocked issues now render red-500
  (`#ef4444`) like failed runs; red-900 (`#991b1b`) is reserved for evidence
  nodes with `severity` of `block` or `critical`.
- **Memory usage route tests** — usage tracking now runs against an in-process
  app with tmp data and vault roots instead of whichever daemon happens to be
  listening on `localhost:7710`.

### Known issues

None at the substrate level. `tests/substrate-e2e.test.ts` 8/8 green;
`packages/agentos-d` 629/629.

## [0.1.1] — 2026-05-04

Patch release. Closes the v0.1.0 known-issues list for policy-engine and
admin-ui, and ships one real bug fix that was caught after release.

### Fixed

- **Memory graph showed only the tenant's own subtree.**
  `FileVaultStore.list()` used `fs.readdir({ recursive: true })`, which does
  NOT follow symbolic links. Tenants whose `wiki/` and `memory/` folders are
  symlinks (the recommended layout for shared knowledge) saw a fraction of
  their actual notes in `/api/memory/graph`. `list()` now walks manually and
  resolves each symlink via `fs.stat`. realpath dedup keeps the walk
  cycle-safe.
- **`packages/policy-engine`** — `evaluator.test.ts` expected `block` for
  missing `required_data`. Tests realigned to the runtime's
  `route_to_review` behavior, which is the correct fail-safe (see v0.1.0
  known-issues note).
- **`packages/admin-ui`** — `yaml-schema.test.ts` expectations realigned to
  the schema's `rules.minItems = 1` and `condition.then.required = [decision,
  reason]` constraints. Marker messages also now include the offending
  property name for `additionalProperties` and `required` errors so Monaco
  surfaces it inline.

### Known issues

Still triaged for v0.1.2:

- `packages/agentos-d`: 11 failures across `cli.test.ts` (backup/restore
  CLI), `bin/mcp-stdio.test.ts`, `routes/admin-mission-map`,
  `routes/memory-usage`, and `services/mission-map`. The substrate-e2e suite
  remains the canonical shippability check.

## [0.1.0] — 2026-05-04

First public release. Initial commit history is reset from the internal
substrate that drove pre-release development; commit-level provenance
prior to v0.1.0 is preserved internally.

### Added

- **Substrate daemon (`agentos-d`)** — single Node process exposing REST,
  MCP server, and WebSocket. Hosts the policy engine, vault store,
  approval queue, and hash-chained audit log.
- **Policy engine** — YAML rule pack loader and evaluator with
  severity-aware aggregation. Outcomes: `allow`, `block`,
  `route_to_review`. Shadow mode with 7-day default observe-only window
  before flipping to enforce.
- **Rule packs (v1)** — `smb-starter`, `tcpa-real-estate`,
  `fair-housing`, `hipaa-placeholder`. Authored to the `awcp/v0.1` schema.
- **Memory / vault** — tenant-scoped FileVaultStore with markdown on disk.
  Recursive-character chunker, OpenAI-compatible embed client, Chroma /
  Qdrant vector store, hybrid BM25 + vector retrieval, optional
  cross-encoder rerank.
- **Approval queue** — rule packs can return `route_to_review`; queued
  actions surface in admin UI for human approve / reject / send-back.
  Reviewer actions logged in audit trail.
- **Compliance Evidence Report PDF** — monthly signed and hash-chained
  PDF summarizing policy decisions and approval-queue activity. Disclaimer:
  evidence of system state, not legal compliance.
- **AgentGuard scanner** — embedded as a Python FastAPI sidecar,
  `scanner-worker`. Continuous scan of agent configs (CLAUDE.md,
  .cursorrules, MCP configs). Findings surface as Issues in the admin UI.
- **n8n integration** — bundled in docker-compose; substrate-aware custom
  nodes for memory read/write, dispatch, and policy_check.
- **Admin UI** — Next.js 14 app router. Onboarding wizard, rule pack
  YAML editor with CLI dry-run, approval queue, scanner findings,
  evidence-report preview, mission map, autopilot, triage queue.
- **Adapter SDK (`@agentworks/agent-adapters`)** — uniform interface for
  external agent runtimes including Claude Local, Codex, Cursor, Gemini,
  OpenCode, Pi, and a Hermes adapter.
- **One-command installer** — `apps/installer/src/install.sh`, fetched
  from the v0.1.0 GitHub release asset. Stands up the full stack on a
  Docker host in under 20 minutes.
- **AWCP v0.1 draft spec** — wire format, API surface, and data model in
  `docs/awcp.md`. Posture: breaking-changes-allowed until either an
  external implementer or 6 months of customer learning.
- **Backup / restore** — `agentworks backup` and `agentworks restore`
  CLIs with optional encryption. Documented in
  [`docs/backup-restore.md`](./docs/backup-restore.md).

### Not in v0.1.0

- Cost metering and per-agent LLM spend attribution (planned: v1.1)
- Per-employee SSO / federated auth (planned: v1.2)
- Browser extension for ChatGPT / Manus integration (planned: v2)
- Hosted / cloud deployment (local-only in v1 by design)
- AWCP v1.0 stable spec (v0.1 is a draft)
- MCP-first rule-pack preview (CLI dry-run is the v1 fallback)

### Known issues

The following test failures are documented and triaged for v0.1.1:

- `packages/policy-engine`: 2 failures in `evaluator.test.ts` —
  `required_data` undefined and null variants currently return
  `route_to_review` instead of `block`. The runtime path
  (`route_to_review`) is the correct fail-safe; the tests' expected
  decision is the bug.
- `packages/agentos-d`: 11 failures across `cli.test.ts`
  (backup/restore CLI), `bin/mcp-stdio.test.ts`, `routes/admin-mission-map`,
  `routes/memory-usage`, and `services/mission-map`. Pre-existing
  regressions slated for v0.1.1.
- `packages/admin-ui`: 3 failures in `lib/yaml-schema.test.ts` — test
  expectations contradict the JSON schema's `minItems` and
  `additionalProperties` constraints. Test bugs, not product bugs.

The canonical shippability check, `tests/substrate-e2e.test.ts`, passes
8/8 against a freshly booted daemon.

### Security

This is the first public release; no prior CVEs apply. See
[SECURITY.md](./SECURITY.md) for the disclosure process.
