# AI Agent Install Guide — AgentWorks OS

**Audience:** an AI coding agent (Claude Code, Codex, Cursor, etc.) tasked with installing AgentWorks OS end-to-end.

**Operator hand-off:** point the agent at the repo root and say *"follow `docs/AI-AGENT-INSTALL-GUIDE.md` to install AgentWorks OS on this machine."*

**Target version:** v0.1.9.
**Estimated wall-clock:** 10-20 minutes on a clean machine, mostly the first Docker build of agentos-d (TypeScript compile + `pnpm deploy`) and scanner-worker (sentence-transformers download).

---

## How to read this guide

The install is **two scripts**. Run them in order. If both exit 0, you are done.

```bash
./apps/installer/src/install.sh --unattended \
  && ./apps/installer/scripts/smoke-test.sh
```

`install.sh` runs every pre-flight check, builds the images, brings up the stack, and finishes by invoking `smoke-test.sh` itself. The standalone invocation above is a safety net — if `install.sh` exits 0 but for some reason did not run the smoke test, you have an explicit second gate. Both scripts print PASS/FAIL lines an LLM agent can grep.

You should:

1. **Run the commands in §1 in order.** Every numbered step has a `Verify:` block with the exact command and the exact pass condition.
2. **Stop on the first failure** and surface the failing line to the operator. Each failure message in the scripts tells you exactly what to do next (see §3 Failure modes).
3. **Decision points are marked with `DECISION:`.** There are three (install dir, MCP client, vault layout). All have safe defaults — pick the default unless the operator says otherwise.
4. **Do not invent fixes.** If a `Fix:` block does not list the failure mode you are seeing, hand the failing line to the operator and stop.
5. **Report back** with the final summary (§4) verbatim.

Conventions:
- `$HOME` is the operator's home directory (`echo $HOME`).
- Commands in fenced blocks run as-is. Placeholders are in `<ANGLE_BRACKETS>`.
- "The daemon" = the `agentos-d` process. "The substrate" = the running stack as a whole.

---

## §1 — Install

### 1.1 Get the source

```bash
# If you are not already inside a checkout of agentworks-os, clone it.
# The sentinel grep matches the agentos-d build directive that's only present
# in the AgentWorks compose file (regardless of registry/tag changes).
if test -f docker-compose.yml && grep -qE "packages/agentos-d/Dockerfile|agentos-d:" docker-compose.yml; then
  echo "Already in an agentworks-os checkout."
else
  git clone --depth=1 --branch v0.1.9 \
    https://github.com/SGridworks/agentworks-os-vps.git
  cd agentworks-os-vps
fi
```

**Verify:**

```bash
test -f docker-compose.yml && test -f apps/installer/src/install.sh && echo OK
```

Expects `OK` on stdout.

### 1.2 DECISION: install location

**Default:** `$HOME/.agentworks/`

The installer reads `AGENTWORKS_DIR` from the environment. The default is correct for >95% of installs. Only ask the operator if they have a non-default preference (e.g. installing on a non-home volume).

```bash
echo "Install dir will be: ${AGENTWORKS_DIR:-$HOME/.agentworks}"
```

### 1.3 Run the installer

```bash
./apps/installer/src/install.sh --unattended
```

The `--unattended` flag suppresses the "press enter to continue" prompt. Everything else runs the same.

**What the installer does:**

1. Pre-flight: docker daemon up, ports 7710/3101/5678 free, ≥10 GB disk, ≥4 GB RAM, internet to github.com.
2. Creates `$AGENTWORKS_DIR/{data,config,logs}` and pre-chmods `data/n8n` + `data/scanner` to 777 (n8n runs as uid 1000, scanner as root — host uid mismatch otherwise blocks writes).
3. Re-uses the local checkout if you ran from one; otherwise `git clone`s into `$AGENTWORKS_DIR/source`.
4. Generates secrets (admin password, session secret, hex DB password) into `$AGENTWORKS_DIR/config/{.env,secrets.json}` mode 600. Idempotent — re-running preserves the operator's saved password.
5. `docker compose pull` (best effort — v0.1 publishes nothing, falls through).
6. `docker compose up -d --build`. First build is 5-15 minutes — the agentos-d TypeScript compile and the scanner-worker Python+sentence-transformers download dominate.
7. Waits up to 120s for `/api/health` to return 200.
8. Installs the `agentworks` CLI wrapper (symlink at `/usr/local/bin/agentworks` when writable, otherwise `~/.local/bin/agentworks`).
9. Extracts the MCP stdio bridge from the running `agentos-d` container into `$AGENTWORKS_DIR/config/mcp-stdio-bridge.js` so `agentworks mcp configure` has a real file to point clients at.
10. Runs `apps/installer/scripts/smoke-test.sh` end-to-end.
11. Prints the next-steps banner.

> **CLI on PATH:** if `command -v agentworks` returns nothing after install, the installer placed it at `~/.local/bin/agentworks`. Add `export PATH="$HOME/.local/bin:$PATH"` to your shell rc, or invoke with the absolute path. Every `agentworks ...` command in §2 below works the same with the absolute path.

**Verify:** the installer exits 0 AND prints `Smoke test PASSED`. If you see either an `[ERROR]` line OR a non-zero exit code, jump to §3 Failure modes.

### 1.4 Confirm with an explicit smoke run

Belt and suspenders — run the smoke test once more standalone to be sure:

```bash
./apps/installer/scripts/smoke-test.sh
```

**Verify:** prints `AgentWorks OS smoke test PASSED` and exits 0. The script:
- polls `/api/health` until 200 (up to 90s)
- POSTs `/api/tenants` and parses the returned tenant id
- POSTs `/api/policy/check` for that tenant and asserts the response has a `decision` field of `allow`, `block`, or `route_to_review`
- checks scanner-worker `/health`, n8n `/healthz`, and admin-ui `/mission-control` as fatal install gates by default
- deletes the disposable smoke tenant before exit

A fresh install with no rule packs loaded returns `route_to_review` — that is correct. The point of the smoke test is shape, not policy outcome.

---

## §2 — Post-install

The substrate is up. Two more things make it useful.

### 2.1 DECISION: first MCP client (optional)

**Default:** Claude Desktop.

The MCP bridge lets a coding agent read/write the vault and submit actions through the policy engine. Wire one client first; the operator can wire others later.

Ask the operator:

> *"Which MCP client should I wire up first? Options: Claude Desktop, Claude
> Code, both, or skip. Default Claude Desktop. (Cursor and Codex CLI also
> support MCP — see docs/install-runbook.md for stdio bridge config.)"*

The wrapper handles platform-specific config for the supported targets
(`claude-desktop`, `claude-code`, `both`):

```bash
agentworks mcp configure --target claude-desktop
# or
agentworks mcp configure --target claude-code
# or
agentworks mcp configure --target both
```

For Cursor or Codex CLI, point them at the same stdio bridge manually — see
[install-runbook.md](./install-runbook.md#cursor) for the exact config.

Reads the active platform's Claude config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `~/.config/Claude/claude_desktop_config.json` on Linux), merges in the AgentWorks server entry (does NOT clobber other MCP servers), and points it at the bridge installed under the source clone.

**Verify:** ask the operator to fully quit Claude Desktop (Cmd+Q on macOS — closing the window is not enough) and relaunch. In a Claude conversation, run `/mcp list`. The output should include `agentworks` as an active server.

### 2.2 DECISION: vault layout (optional)

**Default:** `~/.agentworks/data/vault/<tenant_id>/`.

Each tenant's content lives at `<VAULT_ROOT>/<tenant_id>/`. The shipped
compose file bind-mounts `${AGENTWORKS_DATA_DIR}/vault` (default
`~/.agentworks/data/vault`) into the daemon container at `/data/vault`, and
the daemon's `VAULT_ROOT` is `/data/vault`. From the operator's machine
that's `~/.agentworks/data/vault`. Three layouts make sense:

> *"Three vault layouts. Which fits your situation?
> A) Fresh vault, no shared content. I create a clean tenant dir and that's it. Default.
> B) Existing vault, want to share it across tenants. I symlink shared subdirs into the tenant dir; the substrate's `FileVaultStore.list()` walks symlinks safely (cycle-detected via realpath dedup).
> C) External vault path (`~/Documents/notes/`, etc.). I edit the compose bind mount so the daemon sees the external path at `/data/vault`."*

For (A), no action needed — the daemon creates the tenant dir on first write.

For (B), in `$AGENTWORKS_DIR/data/vault/<tenant_id>/`, symlink the directories
you want shared. Example:

```bash
TENANT_ID=$(curl -s http://127.0.0.1:7710/api/tenants \
  | python3 -c 'import json,sys; data=json.load(sys.stdin); items=data.get("items", data) if isinstance(data, dict) else data; print(items[0]["id"])')
cd "${AGENTWORKS_DIR:-$HOME/.agentworks}/data/vault/$TENANT_ID"
ln -s ../wiki wiki
ln -s ../shared-runbooks runbooks
```

The substrate's `FileVaultStore.list()` walks symlinks safely (cycle-detected
via realpath dedup), so a tenant directory containing only symlinks resolves
to the canonical files. Do NOT symlink the operator's `~/.claude/projects/.../memory/`
directory unless they ask — that folder is operator-private memory and may
include secrets.

For (C): the daemon reads the vault from `/data/vault` **inside the container**,
which is bind-mounted from `${AGENTWORKS_DATA_DIR}/vault` on the host. To
relocate the vault, point the data dir at the external location and bind it
in by editing `docker-compose.yml`:

```yaml
# in services.agentos-d.volumes (and scanner-worker if needed):
- /absolute/path/to/external/vault:/data/vault
```

Then `agentworks restart agentos-d`. Setting `VAULT_ROOT` in
`$AGENTWORKS_DIR/config/.env` alone has no effect — compose hardcodes the
in-container `VAULT_ROOT=/data/vault` and the env override is shadowed.
A future release will surface this as a first-class `--vault-root` option.


---

## §3 — Failure modes

Every failure message printed by `install.sh` and `smoke-test.sh` is enumerated here. Match the message to the row, take the action, re-run.

| Failed step prints… | What's wrong | Fix |
|---|---|---|
| `Required ports already in use: 7710` (or 3101, 5678) | Something else is bound to a substrate port. | Run `lsof -i :<port>` to find the holder. Stop it (it is almost always another agentos-d, an n8n, or a docker-compose stack from a prior install). Re-run. |
| `Need >= 10 GB free under $HOME` | Disk pressure. | Free space on the volume holding `$HOME`. Do not auto-clean — surface to the operator. |
| `System has only N GB RAM; substrate needs >= 4 GB` | Below minimum. | Stop. Surface to the operator. |
| `Cannot reach https://github.com` | No internet (or proxy). | If the host is behind a corporate proxy, `export HTTPS_PROXY=...` and re-run. Otherwise tell the operator to fix network. |
| `Docker daemon is not running` | Docker Desktop / OrbStack / `dockerd` is not up. | macOS: `open -a "Docker"` or `open -a OrbStack`. Linux: `sudo systemctl start docker`. Wait 30s. Re-run. |
| `Docker daemon reachable but current user lacks permission` | Linux: user not in `docker` group. | Run `sudo usermod -aG docker $USER`, then log out and back in (or `newgrp docker`). Re-run. **Do NOT prefix `install.sh` with `sudo`** — it would create root-owned files in `$HOME/.agentworks`. |
| `openssl is required to generate session secrets` | openssl missing from PATH. | macOS: ships with the system; check `which openssl`. Linux: `apt install openssl` or `dnf install openssl`. Re-run. |
| `git is required to fetch the AgentWorks source` | git missing. | Install git (Xcode Command Line Tools on macOS, `apt install git` on Debian/Ubuntu). Re-run. |
| `agentos-d did not respond at .../api/health within 90s` | Daemon failed to come up. | Run `agentworks logs agentos-d (last 100 lines)`. Common: SQLite migration failure (look for `migration` in logs), pnpm symlink issue (build was incomplete — re-run `docker compose build agentos-d`), or OOM. |
| `POST /api/tenants failed` | Daemon is up but rejecting writes. | Same `docker compose logs agentos-d --tail 100`. Check for `EACCES` (permission on data dir) or `SQLITE_READONLY` (data/agentworks.db readonly). |
| `policy.check returned an unexpected decision` | Decision was something other than `allow`/`block`/`route_to_review`. | Schema drift between the installer's smoke test and the running daemon version. The smoke test should be updated to match. Surface to the operator. |
| `scanner-worker /health unreachable` | Scanner sidecar down, or real embedding mode still downloading model weights. | Fatal by default. Diagnose with `agentworks logs scanner-worker (last 100 lines)`. Only use `SMOKE_SCANNER_OPTIONAL=1` for daemon-only debugging. |
| `n8n /healthz unreachable` | n8n down or still booting. | Fatal by default. Wait once if first boot is slow, then diagnose with `agentworks logs n8n (last 100 lines)`. Only use `SMOKE_N8N_OPTIONAL=1` for daemon-only debugging. |
| `admin-ui /mission-control unreachable` | Admin UI down or still building/booting. | Fatal by default. Diagnose with `agentworks logs admin-ui (last 100 lines)`. Only use `SMOKE_ADMIN_OPTIONAL=1` for daemon-only debugging. |

If the failure does not match any row above, hand the failing line and the last 50 log lines to the operator and stop. Do not retry blindly.

---

## §4 — Final report

Post this back to the operator, filling the bracketed values:

```
AgentWorks OS v0.1.9 install complete.

Install location:  [PATH from §1.2, default $HOME/.agentworks]
Source clone:      [PATH, default $HOME/.agentworks/source]
Daemon URL:        http://127.0.0.1:7710
CLI:               [path printed by installer — /usr/local/bin/agentworks or ~/.local/bin/agentworks]
Admin password:    saved at $HOME/.agentworks/config/secrets.json (mode 600)
MCP client wired:  [Claude Desktop / Cursor / Codex / skipped]
Vault layout:      [A / B / C from §2.2]

Verifications passed:
  [✓] install.sh exited 0
  [✓] install.sh's embedded smoke test printed "Smoke test PASSED"
  [✓] standalone smoke-test.sh re-run printed "AgentWorks OS smoke test PASSED"
  [✓] tenant created end-to-end
  [✓] policy.check returned a valid decision
  [✓] scanner-worker /health passed
  [✓] n8n /healthz passed
  [✓] admin-ui /mission-control passed

Optional / non-blocking:
  [note any checks deliberately downgraded with SMOKE_*_OPTIONAL]

Next:
  1. The admin password is in $HOME/.agentworks/config/secrets.json — do NOT print it to chat.
  2. Wire an MCP client: agentworks mcp configure (or absolute path if not on PATH).
  3. Load a rule pack matching the operator's industry (rule-packs/ in source).
  4. Read docs/users-guide.md for the full feature tour.

Notes / caveats:
  [Anything unexpected. If the smoke test passed cleanly, write "None."]
```

**Do not print the admin password into chat.** Always refer the operator to the file.

---

## Reference: paths and ports

| Thing | Where |
|---|---|
| Install dir | `$HOME/.agentworks/` |
| Source clone | `$HOME/.agentworks/source/` |
| .env (mode 600) | `$HOME/.agentworks/config/.env` |
| Secrets (mode 600) | `$HOME/.agentworks/config/secrets.json` |
| SQLite DB | `$HOME/.agentworks/data/agentworks.db` |
| n8n state | `$HOME/.agentworks/data/n8n/` (777, uid mismatch) |
| Scanner state | `$HOME/.agentworks/data/scanner/` (777, uid mismatch) |
| Logs | `$HOME/.agentworks/logs/` |
| Daemon | `http://127.0.0.1:7710` |
| Scanner | `http://127.0.0.1:3101` |
| n8n | `http://127.0.0.1:5678` |

## See also

- [README.md](../README.md) — product overview
- [docs/install-runbook.md](./install-runbook.md) — human-oriented install guide
- [docs/users-guide.md](./users-guide.md) — full feature tour, post-install
- [docs/mcp-integration.md](./mcp-integration.md) — MCP setup detail
- [docs/rule-pack-authoring.md](./rule-pack-authoring.md) — write your own rule packs
- [docs/backup-restore.md](./backup-restore.md) — recovery procedures
- [CHANGELOG.md](../CHANGELOG.md) — release notes
