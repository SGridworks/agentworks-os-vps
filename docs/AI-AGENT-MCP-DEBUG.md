# AI Agent MCP Debug Guide

**Audience:** an AI coding agent the operator has tasked with diagnosing why an MCP client (Claude Desktop, Cursor, Codex, etc.) is not connecting to AgentWorks OS, or is connected but tools fail.

**Operator hand-off:** *"Claude Desktop says agentworks isn't connecting"*, or *"the memory.write tool errors out"*, or *"my agent can't see the vault."*

**Companion doc:** [docs/mcp-integration.md](./mcp-integration.md) — canonical MCP wiring instructions. This guide is diagnostic — what to check when wiring is supposedly done but doesn't work.

**Target version:** v0.1.1.

---

## How to read this guide

MCP failures cluster into five layers. Diagnose top-to-bottom — if a lower layer is broken, higher-layer tests will mislead you.

| Layer | What it is | Section |
|---|---|---|
| 1. Daemon reachable | The substrate is up and listening | §1 |
| 2. Bridge file present | `mcp-stdio-bridge.js` exists where the client expects it | §2 |
| 3. Client config valid | JSON parses; absolute paths; envs set | §3 |
| 4. Client launched bridge | Bridge process is actually running | §4 |
| 5. Tool calls round-trip | `memory.read` etc. work end-to-end | §5 |

Always start at §1. A "Claude can't see vault" report often turns out to be the daemon being down, not an MCP problem.

Rules:

1. **Don't edit the operator's MCP config without showing them the diff first.** Their config may have other servers.
2. **Don't print bearer tokens or admin passwords into chat** during diagnosis. Refer to file paths.
3. **Don't restart the daemon** to "see if that fixes it" — see [AI-AGENT-OPERATOR-RUNBOOK.md §0.2](./AI-AGENT-OPERATOR-RUNBOOK.md) for why. Backup first if you genuinely need to restart.

---

## §1 — Layer 1: daemon reachable

```bash
curl -sS --max-time 5 http://127.0.0.1:7710/api/health | head -c 300
```

**Expected:** JSON with `"status":"ok"`.

| Symptom | Cause | Fix |
|---|---|---|
| Connection refused | Daemon not running | See [operator runbook §2.2](./AI-AGENT-OPERATOR-RUNBOOK.md) |
| Timeout | Firewall or wrong port | Confirm port in `~/.agentworks/.env` (`AGENTOS_PORT`) |
| `{"status":"degraded"}` | Daemon is up but a dependency (DB, scanner) is down | Operator runbook §2.4 / §1.1 |
| HTML/login page | Wrong port — talking to something else | `lsof -i :7710` to confirm what's listening |

If §1 fails, **stop**. Higher layers cannot work. Hand off to operator runbook.

---

## §2 — Layer 2: bridge file present

The MCP stdio bridge is the program the host MCP client spawns. By install convention it's at `~/.agentworks/config/mcp-stdio-bridge.js`.

```bash
ls -l $HOME/.agentworks/config/mcp-stdio-bridge.js
file $HOME/.agentworks/config/mcp-stdio-bridge.js
```

**Expected:** file exists, > 1 KB, identified as a Node script (or "ASCII text").

**Fix:** if missing, copy from the running container:

```bash
docker cp agentos-d:/app/dist/bin/mcp-stdio-bridge.js \
  $HOME/.agentworks/config/mcp-stdio-bridge.js
chmod +x $HOME/.agentworks/config/mcp-stdio-bridge.js
```

Also confirm Node is on the host's PATH (the MCP client uses the host's `node` binary, not a containerized one):

```bash
which node
node --version
```

**Expected:** Node 18+ (LTS).

---

## §3 — Layer 3: client config valid

Each client has its own config file. Read them — don't write them blindly.

### §3.1 Find the right config file

| Client | macOS path |
|---|---|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` |
| Codex CLI | `~/.codex/mcp.json` |

```bash
# pick the one the operator named:
CLIENT_CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
test -f "$CLIENT_CFG" && echo "exists" || echo "missing"
cat "$CLIENT_CFG" | head -40
```

### §3.2 Validate the config

The `agentworks` server entry should look like this. The four common errors:

```json
{
  "mcpServers": {
    "agentworks": {
      "command": "node",
      "args": ["/Users/<NAME>/.agentworks/config/mcp-stdio-bridge.js"],
      "env": {
        "AGENTOS_URL": "http://127.0.0.1:7710",
        "AGENTOS_TENANT_ID": "<UUID>"
      }
    }
  }
}
```

Diagnostic checks:

```bash
# JSON parses?
python3 -c "import json,sys; json.load(open('$CLIENT_CFG'))" && echo "json ok"

# Path is absolute (no ~ or $HOME)?
python3 -c "
import json
c = json.load(open('$CLIENT_CFG'))
args = c['mcpServers']['agentworks']['args']
for a in args:
    if a.startswith('~') or a.startswith('\$') or not a.startswith('/'):
        print(f'BAD PATH: {a}')
        break
else:
    print('paths ok')
"

# Bridge path actually exists?
python3 -c "
import json, os
c = json.load(open('$CLIENT_CFG'))
p = c['mcpServers']['agentworks']['args'][0]
print('bridge file exists' if os.path.isfile(p) else f'MISSING: {p}')
"

# AGENTOS_TENANT_ID set?
python3 -c "
import json
c = json.load(open('$CLIENT_CFG'))
env = c['mcpServers']['agentworks'].get('env', {})
print('tenant ok' if env.get('AGENTOS_TENANT_ID') else 'TENANT MISSING')
"
```

| Check fails | Fix |
|---|---|
| `json ok` fails | The config is malformed JSON. Common cause: trailing commas. Show the operator the parse error and which line. |
| `BAD PATH` | Claude Desktop in particular does NOT expand `~` or `$HOME`. Replace with the absolute path from `echo $HOME`. |
| `MISSING:` | The bridge file moved or was never copied. See §2. |
| `TENANT MISSING` | The bridge can't address a tenant. Get the UUID from `~/.agentworks/data/tenant-bootstrap.json` and add it. |

### §3.3 Other servers in the same file

Operators commonly have multiple MCP servers configured (memory, filesystem, etc.). Don't blow them away.

```bash
python3 -c "
import json
c = json.load(open('$CLIENT_CFG'))
print('servers configured:', list(c.get('mcpServers', {}).keys()))
"
```

If you need to write a new entry, **read the file, modify in memory, write back** — never overwrite with a single-server config.

---

## §4 — Layer 4: client launched the bridge

After config changes, the MCP client must be **fully quit and relaunched**. Closing the window does not relaunch the MCP child processes.

```bash
# Tell the operator: Cmd+Q the MCP client app, then reopen it.
```

After they relaunch, check whether the bridge process is actually running:

```bash
ps aux | grep -E "mcp-stdio-bridge|agentworks" | grep -v grep
```

**Expected:** at least one `node /Users/.../mcp-stdio-bridge.js` process whose parent is the MCP client (Claude, Cursor, etc.). The PPID matters — if the parent is `1` or your shell, it's an old run.

**Fix:**

| Symptom | Cause | Fix |
|---|---|---|
| No bridge process | Client did not launch it | Confirm config file path is the right one for that client; full quit and relaunch. |
| Bridge process exists but client says "disconnected" | Bridge crashed at startup | See §4.1 |
| Multiple bridge processes | Old runs not cleaned up | `pkill -f mcp-stdio-bridge.js` then relaunch the client. |

### §4.1 Bridge crashed at startup

The bridge logs to stderr, which the MCP client may not surface. Run the bridge directly to see what it prints:

```bash
AGENTOS_URL=http://127.0.0.1:7710 \
AGENTOS_TENANT_ID=<UUID> \
node $HOME/.agentworks/config/mcp-stdio-bridge.js < /dev/null
```

The bridge expects MCP-protocol input on stdin; with `/dev/null` it will hand-shake then exit. What you're looking for is *whether it crashes during startup* and what the error says. Common errors:

| Error | Cause |
|---|---|
| `ECONNREFUSED 127.0.0.1:7710` | Daemon down — go back to §1 |
| `Invalid tenantId` | UUID format wrong; copy from `tenant-bootstrap.json` literally |
| `Cannot find module` | Node version too old, or bridge file was truncated during `docker cp` — re-copy |
| `EACCES` on a path | Bridge has no permission for a tmp/log path |

---

## §5 — Layer 5: tools round-trip

If §1–§4 are clean and the client still says tools fail, the daemon is reachable but per-tool semantics are off. Test each one directly via REST first:

### §5.1 memory.read

```bash
curl -sS "http://127.0.0.1:7710/api/memory/read?tenantId=$TENANT_ID&key=hot" | head -c 500
```

| Symptom | Cause |
|---|---|
| `404` for an existing key | Tenant ID mismatch — the agent is calling with a different tenant than the one that has the key. |
| `200` with empty body | Key doesn't exist. Not an error. |
| `403` | Auth not forwarding (current v0.1.x: MCP route is open on localhost only; if you're getting 403, something else is in front of the daemon). |

### §5.2 memory.write

```bash
curl -sS -X POST http://127.0.0.1:7710/api/memory/write \
  -H "content-type: application/json" \
  -d '{
    "tenantId": "'"$TENANT_ID"'",
    "key": "scratch/mcp-debug-test",
    "body": "# test\n\nwritten by MCP debug at '"$(date)"'"
  }' | head -c 500
```

Then confirm it lands:

```bash
curl -sS "http://127.0.0.1:7710/api/memory/read?tenantId=$TENANT_ID&key=scratch/mcp-debug-test" | head -c 300
ls -lt $HOME/vault/wiki/$TENANT_ID/scratch/mcp-debug-test.md 2>/dev/null
```

**Verify:** body matches what you just wrote, and the file exists on disk.

| Symptom | Cause |
|---|---|
| `key escapes tenant subtree` | Key has `..` or starts with `/` — sanitize. |
| Disk write fails | `VAULT_ROOT` mounted read-only or wrong path. Check `docker compose exec agentos-d env \| grep VAULT_ROOT` and `ls -ld <path>`. |

Clean up after the test:

```bash
curl -sS -X DELETE "http://127.0.0.1:7710/api/memory/delete?tenantId=$TENANT_ID&key=scratch/mcp-debug-test"
```

### §5.3 policy.check

```bash
curl -sS -X POST http://127.0.0.1:7710/api/policy/check \
  -H "content-type: application/json" \
  -d '{"tenantId":"'"$TENANT_ID"'","action":{"kind":"email.send","payload":{"to":"x@example.com","subject":"t","body":"t"}}}' \
  | head -c 500
```

Expect a `decision` field. If you get `route_to_review` and the operator expected `allow`, the rule packs are doing their job — that's not a bug.

### §5.4 activity.log

```bash
curl -sS -X POST http://127.0.0.1:7710/api/audit \
  -H "content-type: application/json" \
  -d '{"tenantId":"'"$TENANT_ID"'","actor":"mcp-debug","action":"diagnostic.ping","detail":{"note":"debug"}}'
```

Then read it back:

```bash
curl -sS "http://127.0.0.1:7710/api/audit?tenantId=$TENANT_ID&limit=1" | head -c 500
```

The entry you just wrote should be at the top.

---

## §6 — Specific failure modes

### §6.1 "Server connecting / disconnected" loop in Claude Desktop

The MCP client tries to connect, the bridge starts, then the bridge exits, then the client retries. Causes:

1. Daemon is up but `/api/health` returns >5xx — bridge gives up on first health check.
2. `AGENTOS_TENANT_ID` is unset — bridge refuses to start.
3. Node version on the host is too old (<18). Claude Desktop uses the user's `PATH` `node`, which on some machines is an ancient global install.

Fix in order: §1 → §3 → `node --version`.

### §6.2 Tools listed but every call returns "internal error"

The daemon is up and the bridge is up, but every tool errors. Likely a daemon-side problem:

```bash
docker compose -f $HOME/.agentworks/docker-compose.yml logs --tail 100 agentos-d | \
  grep -iE "error|exception|trace"
```

Read for stack traces. Common: a recent rule pack with a malformed `when:` block crashing the engine on every check. Fix: disable that pack via shadow mode.

### §6.3 "Tool not found" for a tool that should exist

Bridge version mismatch. The bridge file you copied may be from an older `agentos-d` image. Re-run §2's `docker cp`.

### §6.4 Memory writes succeed but graph doesn't show them

Most likely cause: stale Admin UI cache or the vault graph has not been re-indexed. Force a refresh:

```bash
curl -sS -X POST http://127.0.0.1:7710/api/memory/graph/rebuild?tenantId=$TENANT_ID
```

If the writes are landing on disk but graph is empty even after rebuild, check that `VAULT_ROOT` and the tenant subtree match what the daemon thinks it should:

```bash
docker compose exec agentos-d env | grep -E "VAULT_ROOT|AGENTOS_DATA_DIR"
ls -la $HOME/vault/wiki/$TENANT_ID/ | head
```

The v0.1.1 fix to `FileVaultStore.list()` follows symlinks — if you're on v0.1.0, upgrade.

### §6.5 Different tenant IDs on different machines

The operator's laptop and desktop both have AgentWorks installed — and each has its own auto-generated tenant ID. Symptoms: agent on laptop writes a page, agent on desktop can't find it.

This is a feature (tenants are isolated by design), but it surprises operators. Two valid fixes:

1. Use one machine's daemon. Wire all MCP clients to that one URL.
2. Pick one tenant ID, configure all daemons to use the same `AGENTOS_TENANT_ID`, sync the vault directory between machines.

This is a configuration call — surface it, don't decide it for them.

---

## §7 — Final report

```
MCP debug — <time>

Layer-by-layer status:
  1. Daemon reachable:   <ok / fail — details>
  2. Bridge file:        <ok / missing / wrong location>
  3. Client config:      <ok / errors found>
  4. Bridge process:     <running / not running / multiple>
  5. Tool round-trips:   <memory.read OK, memory.write OK, policy.check OK, activity.log OK>

Root cause:
  <one-sentence statement of what was actually wrong>

Fix applied:
  <what you changed, or "none — diagnosis only">

Operator must do:
  1. Cmd+Q and relaunch <client> so the new config takes effect
  2. <anything else>

Open questions:
  <if any>
```

---

## Quick-reference checklist

```bash
# 1. Daemon
curl -sS http://127.0.0.1:7710/api/health

# 2. Bridge
ls $HOME/.agentworks/config/mcp-stdio-bridge.js
node --version

# 3. Config
python3 -c "import json; print(list(json.load(open('<config-path>'))['mcpServers']))"

# 4. Process
ps aux | grep mcp-stdio-bridge | grep -v grep

# 5. Tool calls
curl -sS "http://127.0.0.1:7710/api/memory/read?tenantId=$TENANT_ID&key=hot"
curl -sS -X POST http://127.0.0.1:7710/api/policy/check -H "content-type: application/json" -d '...'
```

---

## See also

- [docs/mcp-integration.md](./mcp-integration.md) — canonical MCP wiring
- [docs/AI-AGENT-INSTALL-GUIDE.md](./AI-AGENT-INSTALL-GUIDE.md) §6 — first MCP client setup
- [docs/AI-AGENT-OPERATOR-RUNBOOK.md](./AI-AGENT-OPERATOR-RUNBOOK.md) — daemon and service health
- [docs/users-guide.md](./users-guide.md) §10 "MCP and API Tools"
