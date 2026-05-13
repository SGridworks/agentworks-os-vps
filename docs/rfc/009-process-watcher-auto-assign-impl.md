# RFC 009 — ProcessWatcher + Auto-Assign: Implementation Details

**Status**: Final  
**Author**: TechLead  
**Created**: 2026-04-29  
**Parent**: RFC 008  
**Supersedes**: RFC 008 gaps: system user, worker registry, DB schema, lane-cache reload  

---

## Motivation

RFC 008 establishes the architecture. This RFC fills the implementation gaps that BackendEng needs to build AWO-174 (worker registry), AWO-175 (seven checks), and AWO-166 (auto-assign).

---

## 1. ProcessWatcher System User

### Option A: Paperclip Agent (rejected)

A paperclip-shaped agent with `adapterType = "hermes_local"` would:
- Consume an agent slot and API budget.
- Compete for the same resources it monitors.
- Add a circular dependency: the ProcessWatcher agent depends on itself staying healthy.
- Require an API key and JWT lifecycle management.

Rejected.

### Option B: DB-only system user (chosen)

Create a hardcoded system actor in `agentos-d` that:
- Is NOT a paperclip agent (no heartbeat, no API key, no JWT).
- Posts comments via the **internal issue service** (direct DB insert into `issue_comments`), not the public REST API.
- Has `authorUserId = "process_watcher"` and `authorAgentId = null`.
- Is initialized in `agentos-d/src/index.ts` as part of the worker registry startup, before the first tick fires.

**Schema**: No new table. The `issue_comments` table already has `authorUserId` and `authorAgentId`. `process_watcher` is a reserved sentinel value.

**Admin UI display**: Comments from `process_watcher` render with a robot icon and `ProcessWatcher` label (no user profile link).

---

## 2. Worker Registry (AWO-174)

### Startup Sequence

```typescript
// packages/agentos-d/src/workers/index.ts
import { registerProcessWatcher } from './process-watcher.js';
import { registerAutoAssign } from './auto-assign-hook.js';

export function registerWorkers(app: App) {
  // Run once at startup before scheduling
  registerProcessWatcher(app);
  registerAutoAssign(app);
  
  // Schedule recurring
  app.cron.schedule('*/5 * * * *', () => app.workers.processWatcher.tick());
}
```

### Worker Interface

```typescript
// packages/agentos-d/src/workers/worker.ts
export interface Worker {
  readonly name: string;
  tick(): Promise<void>;
}
```

### Graceful Shutdown

- `processWatcher.tick()` must be idempotent (a half-run check on crash should not corrupt state).
- Use a `processWatcher_runs` row with status `running` → `done`|`failed` as a distributed lock. If the server crashes mid-tick, the next tick detects a stale `running` row (updatedAt > 10 min ago) and resumes or aborts it.

---

## 3. `process_watcher_runs` Migration

```sql
-- packages/agentos-d/src/migrations/0013_process_watcher_runs.sql

CREATE TABLE process_watcher_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  check_type  INTEGER NOT NULL CHECK (check_type BETWEEN 1 AND 7),
  issue_id    UUID REFERENCES issues(id) ON DELETE SET NULL,
  verdict     TEXT NOT NULL CHECK (verdict IN ('pass', 'flag', 'auto_fix', 'error')),
  comment_id  UUID REFERENCES issue_comments(id) ON DELETE SET NULL,
  detail      TEXT,  -- JSON or human-readable note
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pwr_issue ON process_watcher_runs(issue_id);
CREATE INDEX idx_pwr_run_at ON process_watcher_runs(run_at);
CREATE INDEX idx_pwr_verdict ON process_watcher_runs(verdict) WHERE verdict != 'pass';
```

---

## 4. `issues.triage` Column Migration

```sql
-- packages/agentos-d/src/migrations/0014_issues_triage_flag.sql

ALTER TABLE issues ADD COLUMN triage BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX idx_issues_triage ON issues(triage) WHERE triage = true;
```

---

## 5. `agent-lanes.json` Caching + Reload

At startup, `auto-assign-hook.ts` reads `agent-lanes.json` into an in-memory `Map<roleName, LaneConfig>`:

```typescript
// packages/agentos-d/src/routes/issues/auto-assign-hook.ts
const laneCache = new Map<string, LaneConfig>();
let laneCacheLoadedAt = 0;

export function loadLaneCache() {
  const raw = readFileSync('/Users/example/.paperclip/scripts/agent-lanes.json', 'utf-8');
  const spec = JSON.parse(raw);
  laneCache.clear();
  for (const [role, cfg] of Object.entries(spec.roles)) {
    laneCache.set(role, cfg as LaneConfig);
  }
  laneCacheLoadedAt = Date.now();
}
```

**Reload**: On `SIGHUP`, `auto-assign-hook.ts` calls `loadLaneCache()` synchronously. This allows hot-reloading without a daemon restart.

**Initial load**: called once at module import time.

---

## 6. Lane-Match Algorithm (refined from RFC 008)

The auto-assign pipeline is **split into two phases** to keep concerns separated:

| Phase | Module | Responsibility |
|-------|--------|----------------|
| Lane match | `lane-matcher.ts` | Description → role (pure, no DB calls) |
| Agent pick | `auto-assign.ts` | Role + company → least-loaded agent (DB query) |

### 6a. `matchLane()` — path-to-role mapping

```typescript
// packages/agentos-d/src/services/lane-matcher.ts

export interface LaneMatchResult {
  matched: boolean;
  ambiguous: boolean;
  role?: string;
  agentIdPrefix?: string;
  reason: string;
}

export function matchLane(description: string): LaneMatchResult {
  const paths = extractFilePaths(description);
  if (paths.length === 0) {
    return { matched: false, ambiguous: false, reason: "No file paths extracted" };
  }

  const config = loadLaneConfig();
  const scored: Array<{ role: string; score: number; agentIdPrefix: string }> = [];

  for (const [roleName, role] of Object.entries(config.roles)) {
    const score = scoreRole(role, paths); // count of matched paths
    if (score > 0) {
      scored.push({ role: roleName, score, agentIdPrefix: role.agent_id_prefix });
    }
  }

  if (scored.length === 0) {
    return { matched: false, ambiguous: false, reason: `No lane matched any of: ${paths.join(", ")}` };
  }

  // Sort by score DESC so the highest-match role is first
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0]!;
  const bestScore = best.score;

  // Ambiguity: any other role with the SAME top score?
  const ties = scored.filter((s) => s.score === bestScore);
  if (ties.length > 1) {
    return {
      matched: false,
      ambiguous: true,
      reason: `Ambiguous: roles ${ties.map((t) => t.role).join(", ")} all scored ${bestScore} for: ${paths.join(", ")}`,
    };
  }

  return {
    matched: true,
    ambiguous: false,
    role: best.role,
    agentIdPrefix: best.agentIdPrefix,
    reason: `Matched ${best.role} (score=${best.score}) for: ${paths.join(", ")}`,
  };
}
```

**Key rules:**
- **Score drives selection.** The role that matches the most paths wins. `todoCount` is deliberately NOT used here — it belongs in the agent-pick phase.
- **Ambiguity is score-based only.** If two roles both match the same top number of paths, the ticket is unassignable (triage). This prevents misrouting a ticket that genuinely spans lanes.
- **Alphabetical order is NOT a tie-breaker for role selection.** It is only used inside `autoAssignAgent()` when two agents in the same role have identical load.

### 6b. `autoAssignAgent()` — role-to-agent mapping

```typescript
// packages/agentos-d/src/services/auto-assign.ts

export interface AutoAssignResult {
  assigneeAgentId: string | null;
  reason: string;
  role: string | null;
  triage: boolean;
  candidates: AgentIssueCounts[];
}

export async function autoAssignAgent(
  role: string,
  companyId: string,
): Promise<AutoAssignResult> {
  const laneConfig = loadLaneConfig();
  const roleEntry = laneConfig.roles[role];
  if (!roleEntry) {
    return { assigneeAgentId: null, reason: `Role "${role}" not found`, role, triage: true, candidates: [] };
  }

  const { agent_id_prefix: prefix } = roleEntry;

  // Parallel fetch
  const [agents, issues] = await Promise.all([
    listCompanyAgents(companyId),
    listCompanyIssues(companyId),
  ]);

  const matchingAgents = agents.filter((a) => a.id.startsWith(prefix));
  if (matchingAgents.length === 0) {
    return { assigneeAgentId: null, reason: `No agents with prefix ${prefix}`, role, triage: true, candidates: [] };
  }

  const openCounts = countOpenIssuesPerAgent(issues);

  const candidates: AgentIssueCounts[] = matchingAgents.map((a) => ({
    agentId: a.id,
    agentName: a.nameKey ?? a.name ?? a.id,
    todo: 0,
    inProgress: 0,
    total: openCounts[a.id] ?? 0,
  }));

  // Sort by total open issues ASC, then agent name ASC
  candidates.sort((a, b) => {
    if (a.total !== b.total) return a.total - b.total;
    return a.agentName.localeCompare(b.agentName);
  });

  const winner = candidates[0]!;
  return {
    assigneeAgentId: winner.agentId,
    reason: `Assigned to ${winner.agentName} (${winner.total} open; role=${role})`,
    role,
    triage: false,
    candidates,
  };
}
```

### 6c. Integration in `POST /api/issues` hook

```typescript
// packages/agentos-d/src/routes/issues.ts (simplified)

const laneResult = matchLane(description);
if (!laneResult.matched) {
  issue.triage = true;
  issue.triageReason = laneResult.reason;
  return;
}

const assignResult = await autoAssignAgent(laneResult.role, companyId);
if (assignResult.triage) {
  issue.triage = true;
  issue.triageReason = assignResult.reason;
  return;
}

issue.assigneeAgentId = assignResult.assigneeAgentId;
```

### 6d. Why the old algorithm was wrong

Earlier drafts (and the first implementation of `lane-matcher.ts`) sorted candidates by `todoCount` before `score`. This causes misrouting when a lower-scoring role has fewer open tickets than a higher-scoring role. Example:

- `BackendEngineer` matches 5 paths (score 5), todo count 10
- `FrontendEngineer` matches 1 path (score 1), todo count 2

Sorting by todo count picks `FrontendEngineer` — wrong. Sorting by score picks `BackendEngineer` — correct. Load-balancing happens **after** the correct role is identified, inside `autoAssignAgent()`.


---

## 7. Stale Lock Recovery

The ProcessWatcher tick uses a row-level lock to prevent double-execution:

```typescript
// packages/agentos-d/src/workers/process-watcher.ts

async function tick() {
  const lockRow = await db.insert(processWatcherRuns)
    .values({ id: crypto.randomUUID(), checkType: 0, verdict: 'running', runAt: new Date() })
    .returning({ id: processWatcherRuns.id });

  try {
    for (let check = 1; check <= 7; check++) {
      await runCheck(check);
    }
    await db.update(processWatcherRuns)
      .set({ verdict: 'done' })
      .where(eq(processWatcherRuns.id, lockRow[0].id));
  } catch (err) {
    await db.update(processWatcherRuns)
      .set({ verdict: 'error', detail: String(err) })
      .where(eq(processWatcherRuns.id, lockRow[0].id));
  }
}
```

On next startup, if a `verdict = 'running'` row exists with `runAt` > 10 minutes ago, it is safe to assume the previous run crashed. Mark it `error` and proceed.

---

## 8. Seven Checks (implementation reference)

| # | Check | SQL reference | Action |
|---|-------|-------------|--------|
| 1 | Stale `in_progress` | `SELECT * FROM issues WHERE status = 'in_progress' AND updatedAt < now() - interval '45 min' AND id NOT IN (SELECT issue_id FROM issue_comments WHERE createdAt > issues.updatedAt) AND id NOT IN (SELECT issue_id FROM commits WHERE createdAt > issues.updatedAt)` | `UPDATE issues SET status = 'todo'` + comment |
| 2 | Premature `done` | `SELECT * FROM issues WHERE status = 'done' AND completedAt > now() - interval '5 min' AND (description NOT LIKE '%[file path]%' OR description NOT LIKE '%verification%')` | Reopen + comment |
| 3 | Off-lane commits | Read `~/.paperclip/logs/commit-scope.log` since last run | Comment per violation |
| 4 | Auto-commit + close mismatch | `SELECT * FROM issues WHERE status = 'done' AND completedAt - startedAt < 60s AND EXISTS (SELECT 1 FROM auto_commit_logs WHERE issue_id = issues.id AND timestamp > issues.startedAt)` | Reopen + comment |
| 5 | Queue depth | `SELECT assigneeAgentId, COUNT(*) FROM issues WHERE status = 'todo' GROUP BY assigneeAgentId HAVING COUNT(*) > 8` | Comment + digest flag |
| 6 | Failed runs not retried | `SELECT * FROM heartbeat_runs WHERE status = 'failed' AND updatedAt < now() - interval '4 hours' AND NOT EXISTS (SELECT 1 FROM heartbeat_runs r2 WHERE r2.status != 'failed' AND r2.issueId = heartbeat_runs.issueId AND r2.updatedAt > heartbeat_runs.updatedAt)` | Comment + flag |
| 7 | Blocked stuck | `SELECT * FROM issues WHERE status = 'blocked' AND updatedAt < now() - interval '4 hours' AND NOT EXISTS (SELECT 1 FROM issue_comments WHERE issueId = issues.id AND createdAt > issues.updatedAt AND authorAgentId != issues.assigneeAgentId)` | Comment + suggest escalation |

---

## 9. Files to Create

```
packages/agentos-d/src/
  workers/
    index.ts                    # registerWorkers + cron setup
    process-watcher.ts          # main worker + 7 checks
    process-watcher.test.ts
    auto-assign-hook.ts         # lane-match + route middleware
    auto-assign-hook.test.ts
    worker.ts                   # Worker interface
  migrations/
    0013_process_watcher_runs.sql
    0014_issues_triage_flag.sql
```

---

## 10. Dependency Order for Implementation

```
AWO-174 (worker registry + migrations)
    ↓
AWO-175 (ProcessWatcher seven checks)  ← depends on AWO-174
    ↓
AWO-166 (auto-assign hook)             ← independent, can parallel with AWO-175
    ↓
AWO-165 (Admin UI Process Health)      ← depends on AWO-175
AWO-168 (Admin UI triage queue)        ← depends on AWO-166
AWO-167 (critical-path sort)           ← independent
```

---

## 11. Inbox-Lite Integration (AWO-167 Boundary Resolution)

**Problem:** The `GET /api/agents/me/inbox-lite` handler lives in the paperclip runtime (`packages/paperclip/server/src/routes/agents.ts`), which is outside the AgentWorks repo and outside BackendEngineer's lane. RFC 008 requires critical-path sorting of inbox-lite responses, but BackendEngineer cannot modify paperclip.

**Resolution:** Agentos-d exposes a new proxy endpoint that consumes paperclip's inbox-lite and re-sorts the result.

### New route: `GET /api/agents/me/inbox`

```typescript
// packages/agentos-d/src/routes/agents.ts (new file)

export function createAgentsRouter(config: Config): Router {
  const router = Router();

  router.get("/me/inbox", async (req, res) => {
    const agentId = req.header("X-Paperclip-Agent-Id");
    const companyId = req.header("X-Paperclip-Company-Id");
    if (!agentId || !companyId) {
      return res.status(401).json({ error: "missing_agent_or_company" });
    }

    // 1. Fetch raw inbox from paperclip
    const raw = await paperclipFetch<
      { items: Array<{
          id: string;
          title: string;
          status: string;
          priority: string;
          createdAt: string;
          parentId: string | null;
        }> }
    >(`/api/agents/${agentId}/inbox-lite`, companyId);

    // 2. Build DAG from all open issues in the company (needed for unblockCount)
    const allIssues = await paperclipFetch<{ items: PcIssue[] }>(
      `/api/companies/${companyId}/issues?limit=500&status=todo,in_progress,blocked`,
      companyId,
    );

    // 3. Compute critical-path scores
    const scores = buildCriticalPath(allIssues.items);

    // 4. Re-sort: critical priority first, then unblockCount desc, then priority, then recency
    const sorted = sortInboxLite(raw.items, scores);

    // 5. Return enriched payload (same shape + unblockCount field)
    return res.json({ items: sorted });
  });

  return router;
}
```

### Why a new endpoint instead of modifying paperclip

1. **Lane discipline:** BackendEngineer does not edit paperclip.
2. **No table overload:** We do not add columns to paperclip's `issues` table.
3. **Backward compatibility:** Paperclip's `inbox-lite` continues to work unsorted for any caller that has not migrated.
4. **Agent migration path:** Hermes adapter config points `inbox-lite` URL to agentos-d (`http://127.0.0.1:7710`) instead of paperclip (`http://127.0.0.1:3100`). This is a one-line config change per agent.

### Files to create

```
packages/agentos-d/src/routes/agents.ts       # proxy + sort
packages/agentos-d/src/routes/agents.test.ts  # mock paperclip responses
```

### Registration

Add to `packages/agentos-d/src/app.ts`:

```typescript
import { createAgentsRouter } from "./routes/agents.js";
app.use("/api/agents", createAgentsRouter(config));
```

### Dependency update

AWO-167 is unblocked. BackendEngineer owns `routes/agents.ts` and `routes/agents.test.ts`. No paperclip changes required.

---

## Verification

- [ ] `0013_process_watcher_runs` migration runs forward on fresh DB
- [ ] `0014_issues_triage_flag` migration adds column without locking table
- [ ] `process-watcher.test.ts` covers all 7 checks with mocked DB
- [ ] `auto-assign-hook.test.ts` covers: no-paths → triage, single-match → assign, ambiguous → triage, manual-override → skip
- [ ] Stale lock recovery: crash mid-tick → next tick recovers without duplicate comments
- [ ] SIGHUP reload: modifying `agent-lanes.json` → next auto-assign uses new lanes
- [ ] `GET /api/agents/me/inbox` proxies paperclip inbox-lite and re-sorts by critical-path score
