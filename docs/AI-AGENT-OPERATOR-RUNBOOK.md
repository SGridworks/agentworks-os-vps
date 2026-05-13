# AI Agent Operator Runbook

**Audience:** an AI coding agent the operator has tasked with day-to-day operation of an already-installed AgentWorks OS deployment.

**Operator hand-off:** *"check on AgentWorks OS"* or *"there's a problem with the substrate, look into it."*

**When to use which guide:**

| The operator says | Use |
|---|---|
| "Install AgentWorks OS." | [AI-AGENT-INSTALL-GUIDE.md](./AI-AGENT-INSTALL-GUIDE.md) |
| "Write a rule pack for X." | [AI-AGENT-RULE-PACK-GUIDE.md](./AI-AGENT-RULE-PACK-GUIDE.md) |
| "MCP isn't working." | [AI-AGENT-MCP-DEBUG.md](./AI-AGENT-MCP-DEBUG.md) |
| "Clean up the vault." | [AI-AGENT-VAULT-HYGIENE.md](./AI-AGENT-VAULT-HYGIENE.md) |
| "Check on the substrate." / "Daily ops." / "Something's broken." | This guide. |

**Target version:** v0.1.9.

---

## How to read this guide

You are operating someone else's running system. The cost of a wrong action here is much higher than during install — operators rely on the audit log being complete, the vault being intact, and the daemon not getting restarted at random.

1. **Read before acting.** Triage in §1 first; pick the right §-section based on what you find.
2. **Backup before destructive action.** §0.2 below — this is the rule.
3. **Don't restart the daemon casually.** A SQLite-empty-on-restart bug is documented for v0.1.x. Always backup first.
4. **Don't edit rule packs in production without shadow mode.** See [AI-AGENT-RULE-PACK-GUIDE.md §7](./AI-AGENT-RULE-PACK-GUIDE.md).
5. **Don't bypass the approval queue.** If a queued action is stuck, the right move is "tell the operator to review it," not "approve it on their behalf."
6. **Stop and ask** before any of: deleting data, force-pushing to a repo, editing the operator's `~/.claude/`, `~/.codex/`, or `~/.cursor/` config without a documented need, restarting services during business hours, modifying live rule packs.

---

## §0 — Pre-action invariants

Run these before any action that changes state.

### 0.1 Confirm you're on the right host

```bash
hostname
agentworks status
```

If `~/.agentworks/source/docker-compose.yml` doesn't exist, this host doesn't have AgentWorks installed. Stop and ask the operator which host they meant.

### 0.2 Take a backup

For *anything* that touches data — installing a rule pack, restarting the daemon, modifying the vault, debugging a stuck queue — backup first:

```bash
agentworks backup $HOME/.agentworks/data/backups/preop-$(date +%Y%m%d-%H%M%S).tar.gz
ls -lh $HOME/.agentworks/data/backups/ | tail -3
```

**Verify:** new tarball exists and is at least a few KB.

This rule exists because of a documented v0.1.x risk: the daemon's SQLite database has come back empty after SIGKILL+restart cycles, and the cause is not yet root-caused. A pre-op backup is your insurance policy.

### 0.3 Find the tenant ID

```bash
TENANT_ID=$(grep -o '"id":"[^"]*"' $HOME/.agentworks/data/tenant-bootstrap.json 2>/dev/null | \
  head -1 | cut -d\" -f4)
echo "TENANT_ID=$TENANT_ID"
```

If empty, the daemon hasn't bootstrapped yet — escalate to the operator.

---

## §1 — Triage

When the operator says "check on the substrate" or reports a vague problem, run this triage in order. The first failure tells you which section to jump to.

### 1.1 Containers up?

```bash
agentworks status
```

**Verify:** `agentos-d`, `scanner-worker`, `n8n`, and `postgres` all show `Up`.

**Fix:** any service down → §2 "Service health".

### 1.2 Daemon answering?

```bash
curl -sS --max-time 5 http://127.0.0.1:7710/api/health | head -c 300
```

**Verify:** JSON with `"status":"ok"`.

**Fix:** no response → §2.2 "Daemon won't start". Wrong response → §2.3 "Daemon stale".

### 1.3 Recent audit-log activity?

```bash
curl -sS "http://127.0.0.1:7710/api/audit?tenantId=$TENANT_ID&limit=10" | head -c 1000
```

**Verify:** at least one entry, with a recent timestamp if the operator was using agents recently.

**Fix:** empty when it shouldn't be → §3 "Audit log gap".

### 1.4 Approval queue depth

```bash
curl -sS "http://127.0.0.1:7710/api/approvals?tenantId=$TENANT_ID&status=pending" | \
  head -c 1000
```

**Verify:** the count is what the operator expects. A queue depth growing unboundedly suggests a rule-pack misconfig or a missing reviewer.

**Fix:** unexpected items in the queue → §4 "Approval queue triage".

### 1.5 Disk and memory headroom

```bash
df -h $HOME | tail -1
docker stats --no-stream --format "table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}" 2>&1 | head -10
```

**Verify:** disk has at least a few GB free; no container pinning CPU at 100% or memory at the cap.

**Fix:** disk < 5 GB → §5 "Disk pressure". Container memory-bound → §6 "Container OOM".

### 1.6 Triage report

After running 1.1 through 1.5, write a one-paragraph status before doing anything else:

> *"Triage at <time>: containers <state>, daemon <state>, audit log <last entry timestamp>, approval queue depth <N>, disk <N> GB free. <One-line summary of any anomaly.>"*

This goes in your final report. Don't lose it.

---

## §2 — Service health

### §2.1 Container restart loop

```bash
agentworks status
agentworks logs <service>
```

Read the last 100 lines. The exit cause is almost always in there:

- `EADDRINUSE` → port conflict; something else is on 7710/3101/5678. Find it (`lsof -i :7710`). Don't kill processes you didn't start; ask the operator.
- `Error: ENOENT: no such file or directory ... /app/data/...` → the data dir is mounted wrong or the volume is missing. Reconfirm `docker-compose.yml` paths.
- `Error: SQLITE_CORRUPT` → see §2.4 "SQLite corruption".
- `migration ... failed` → forward-only migrations aborted. Restore from §0.2 backup, surface to operator.

### §2.2 Daemon won't start

Backup first if you haven't (§0.2). Then:

```bash
agentworks logs agentos-d (last 200 lines)
```

If logs show a clean start but `/api/health` doesn't answer:

- Wait 30 seconds — first-start migrations can take a minute on a large DB.
- Check `docker compose ps` again — the container may be `Up (health: starting)`.

If logs end at "Listening on :7710" but health still won't answer, port-mapping is wrong. `docker port agentos-d` should show `7710/tcp -> 127.0.0.1:7710`.

### §2.3 Daemon stale (responding but with old code)

After an update, the daemon may serve stale code if the image wasn't actually pulled.

```bash
agentworks status (image tag column)
docker inspect agentos-d --format '{{.Created}} {{.Config.Image}}'
```

If the image creation date predates the announced release: `docker compose pull && docker compose up -d agentos-d`. Then re-verify §1.2.

### §2.4 SQLite corruption

Stop the daemon (do NOT kill -9):

```bash
agentworks restart agentos-d   # stop+start via recreate
```

Restore from the most recent good backup:

```bash
agentworks restore $HOME/.agentworks/data/backups/<latest-backup>.tar.gz
```

If restore fails integrity checks or the archive cannot be read, try the next-most-recent known-good backup and preserve the failed archive for diagnosis.

Restart:

```bash
agentworks restart agentos-d
```

Re-verify §1.2 and §1.3. Then tell the operator what was lost (anything created after the backup timestamp).

---

## §3 — Audit log gap

If the audit log has no entries when it should:

1. Check whether agents are actually calling the substrate. The MCP bridge might be misconfigured — see [AI-AGENT-MCP-DEBUG.md](./AI-AGENT-MCP-DEBUG.md).
2. Check the tenant ID — agents calling with the wrong tenant ID write to a different subtree.
3. The audit log is hash-chained; gaps are detectable. Run:

```bash
curl -sS "http://127.0.0.1:7710/api/audit/verify?tenantId=$TENANT_ID" | head -c 500
```

**Verify:** `valid: true`. If `false`, the chain is broken — surface immediately to the operator. This is a possible compliance incident.

---

## §4 — Approval queue triage

When the queue depth is unexpectedly high or growing:

```bash
curl -sS "http://127.0.0.1:7710/api/approvals?tenantId=$TENANT_ID&status=pending" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); 
items=d.get('items', d) if isinstance(d, dict) else d;
print(f'count: {len(items)}')
print('top rule_ids triggering review:')
from collections import Counter
c = Counter()
for it in items:
    c[it.get('matchedRuleId','?')] += 1
for r,n in c.most_common(10): print(f'  {n:4d}  {r}')"
```

This shows which rule is generating the most queued items. Two cases:

**Case A — one rule dominates the queue (90%+).** The rule is either too broad (firing on legitimate actions) or genuinely catching a real problem. Pull a few example items, read them, decide:

```bash
curl -sS "http://127.0.0.1:7710/api/approvals/<approvalId>" | head -c 2000
```

If the examples are all legitimate actions getting flagged, the rule is too broad. Surface to operator with concrete examples and propose a narrower `when:` clause. **Do not edit the live rule pack yourself unless explicitly authorized.**

**Case B — diverse rule_ids, all old.** The operator has stopped reviewing the queue. Surface: *"Queue depth is N, oldest item is X days old. The queue is for human review — these aren't going to clear themselves. Should I help you batch-process them?"*

**What you may NOT do:** approve, reject, or send-back items unless the operator explicitly tells you to act on a specific approvalId.

---

## §5 — Disk pressure

```bash
du -sh $HOME/.agentworks/data/* 2>/dev/null | sort -h | tail
docker system df
```

The biggest consumers are usually:

- `data/agentworks.db` — the daemon's main DB. Don't touch.
- `data/backups/` — backup tarballs. Older than 90 days are pruneable IF the operator agrees.
- Docker images — `docker image prune` after the operator confirms.
- `logs/` — rotate-able. The installer doesn't auto-rotate yet.

**What you may NOT do:** `rm` anything under `data/` without explicit operator confirmation. Daemon files and audit logs are not interchangeable with disk savings.

---

## §6 — Container OOM / runaway CPU

```bash
docker stats --no-stream
```

If `agentos-d` is at the memory cap:

- Recent rule-pack with an expensive `when:` block? Disable the pack with shadow mode.
- Embedding sidecar churning? Set `EMBEDDING_MODE=stub` in `.env` and restart.
- Vault graph endpoint getting hammered by an external dashboard? Rate-limit at the network level (operator decision).

If `scanner-worker` is hot:

- A scan run is in progress; check `/scanner/status`. Wait it out.
- Repeated OOMs → it's hitting a pathological agent config. Surface the affected agent path to the operator.

---

## §7 — Routine checks (the "daily" version)

When the operator says *"daily check"* or *"routine pass"*, run these and report:

1. §1.1 through §1.5 (triage)
2. Rule-pack shadow-mode review:

```bash
# Any pack still in shadow past its window?
curl -sS http://127.0.0.1:7710/api/policy/packs/stats | head -c 1000
```

3. Last successful backup age:

```bash
ls -lt $HOME/.agentworks/data/backups/*.tar.gz 2>/dev/null | head -1
```

If older than 7 days, take a fresh backup (§0.2).

4. Scanner findings count:

```bash
curl -sS "http://127.0.0.1:3101/findings?tenantId=$TENANT_ID&status=open" | head -c 500
```

5. n8n workflow status (if the operator uses n8n):

```bash
curl -sS http://127.0.0.1:5678/healthz | head -c 200
```

---

## §8 — Final report template

```
AgentWorks OS daily check — <YYYY-MM-DD HH:MM>

Triage:
  Containers:        <agentos-d/scanner-worker/n8n status>
  Daemon health:     <ok/degraded — details>
  Audit log:         <last entry, chain valid? yes/no>
  Approval queue:    <pending count>, oldest <age>
  Disk free:         <N GB>
  Memory pressure:   <none / <service> at <N>% cap>

Anomalies (if any):
  - <specific finding with timestamps and counts>

Actions taken:
  - <"none — read-only check" if you didn't change state>
  - <or: list each change, why, what backup was taken first>

Recommended for operator:
  1. <highest-priority thing — be specific>
  2. <next>

Backups:
  Last successful: <path, size, age>
  Pre-op (if you took one this session): <path, size>

Open questions for operator:
  1. <if any>
```

If everything was clean, that's fine — your report says so concisely. Don't pad.

---

## Quick-reference commands

```bash
# State of everything
agentworks status

# Tail daemon
agentworks logs agentos-d

# Backup
agentworks backup $HOME/.agentworks/data/backups/preop-$(date +%Y%m%d-%H%M%S).tar.gz

# Restart one service (do this only if you've backed up)
agentworks restart agentos-d

# Reload rule packs without restart
curl -sS -X POST http://127.0.0.1:7710/api/policy/packs/reload

# Audit log (last 50)
curl -sS "http://127.0.0.1:7710/api/audit?tenantId=$TENANT_ID&limit=50"

# Approval queue (pending)
curl -sS "http://127.0.0.1:7710/api/approvals?tenantId=$TENANT_ID&status=pending"

# Memory graph
curl -sS "http://127.0.0.1:7710/api/memory/graph?tenantId=$TENANT_ID"
```

---

## See also

- [docs/users-guide.md](./users-guide.md) §17 "Troubleshooting", §12 "Routine Maintenance"
- [docs/best-practices.md](./best-practices.md) — operating norms
- [docs/backup-restore.md](./backup-restore.md) — recovery procedures
- [docs/AI-AGENT-INSTALL-GUIDE.md](./AI-AGENT-INSTALL-GUIDE.md)
- [docs/AI-AGENT-MCP-DEBUG.md](./AI-AGENT-MCP-DEBUG.md)
- [docs/AI-AGENT-VAULT-HYGIENE.md](./AI-AGENT-VAULT-HYGIENE.md)
