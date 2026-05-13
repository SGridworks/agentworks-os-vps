# RFC 008 — Workflow Discipline: ProcessWatcher + Auto-Assign Router

**Status**: Ready for CEO Review  
**Author**: TechLead  
**Created**: 2026-04-28  
**Blocks**: AWO-163, AWO-164, AWO-165, AWO-166, AWO-167, AWO-168  
**Supplemented by**: [RFC 009](./009-process-watcher-auto-assign-impl.md) — implementation details (system user, worker registry, migrations, lane-match algorithm, crash-safe tick, 7-check SQL reference)  
**Review**: CEO must sign off  

---

## Problem

The substrate has two structural gaps in agent workflow:

1. **No upfront prevention of misrouting.** Tickets get assigned at creation by whoever opens them (Coordinator / operator). Quality depends on the human having lane context. On 2026-04-28 BackendEngineer's queue was at 14 todos while FrontendEngineer had 1 — load imbalance with no automatic correction.
2. **No after-the-fact detection of agent hygiene failures.** Coordinator-side bash daemons catch some failures (commit-scope, peer-review, stale-progress); manual review catches the rest (LEARNINGS §8, §19). This does not scale to a customer install where operator is not standing over the board.

This RFC pairs prevention (Auto-Assign router) with detection (ProcessWatcher). Together they replace manual workflow management with substrate-native discipline.

**Customer value**: *"AgentWorks routes work to the right agent automatically and oversees every action — your team submits a task and the substrate handles assignment, dependency ordering, hygiene enforcement, and digest reporting."* That is pillar 2 (orchestration) + pillar 7 (audit) made visible.

---

## Design Decisions (Resolved)

### 1. ProcessWatcher locus: agentos-d-internal scheduled service

**Not a paperclip-shaped agent.**

A paperclip-shaped agent would share the same heartbeat protocol it is meant to supervise. It could stall, burn budget, and create a "who watches the watcher" recursion. An internal service inside `agentos-d` has these properties:

- Runs on a server tick (cron / `setInterval`), independent of any agent lifecycle.
- Has direct DB access to issues, comments, commits, and run logs.
- Can read filesystem guard logs (`commit-scope`, `stale-progress`, `closure-gate`) without being a subject of them.
- Does not consume an agent slot or API budget.

**Implementation**: a lightweight background worker in `packages/agentos-d/src/workers/process-watcher.ts`, triggered every 5 minutes. It executes the seven checks sequentially and posts comments via the internal issue-service, bypassing the public API.

### 2. Auto-Assign locus: server-side hook on `POST /api/issues`

**Not an agent-driven LaborBroker.**

Deterministic logic at creation time is faster, cheaper, and testable:

- Zero agent-budget consumption.
- Zero latency for the user — assignee is set before the ticket is persisted.
- Easy to override: if `assigneeAgentId` is present in the create payload, the hook skips.
- Unit-testable without spinning up an agent heartbeat.

**Implementation**: middleware in `packages/agentos-d/src/routes/issues.ts` that runs after validation and before persistence. It reads `agent-lanes.json` into memory at server start and caches it.

### 3. Critical-path computation: live on every `inbox-lite` request

**Not precomputed / cached for v1.**

Queue depth per agent in v1 is small (< 100 tickets). Computing downstream unblock count per ticket via a SQL CTE or in-memory graph traversal is sub-millisecond at this scale. Live computation avoids cache invalidation bugs and stale sorts when dependencies change.

**v2 optimization**: if profiling shows `inbox-lite` > 50 ms, precompute `criticalPathScore` on issue create / update and cache it in the `issues` table.

---

## Half A — Detection: ProcessWatcher

### Seven checks

| # | Check | Condition | Action |
|---|-------|-----------|--------|
| 1 | Stale `in_progress` | `updatedAt` > 45 min ago AND no comment from assignee AND no commit referencing identifier since `updatedAt` | Auto-park to `todo` with comment naming stall window. |
| 2 | Premature `done` | Status flipped to `done` AND (close-comment missing OR close-comment lacks file-path citations) | Re-open to `todo`, comment cites CLOSE-COMMENT-HYGIENE.md. |
| 3 | Off-lane commits | `commit-scope` log flags a file outside the agent's `allow` patterns | Comment on issue with diff snippet and lane violation. |
| 4 | Auto-commit + close mismatch | Auto-commit captured WIP and agent flipped `done` within 60 s | Re-open to `todo`, comment explains the trap (LEARNINGS §19). |
| 5 | Queue depth | Agent's `todo` count > watermark (default 8) | Comment on agent's most recent issue + digest flag. |
| 6 | Failed runs not retried | Run status = `failed` and `updatedAt` > 4 hours ago with no retry | Comment on associated issue, flag for Coordinator. |
| 7 | Blocked tickets stuck | Status = `blocked` and `updatedAt` > 4 hours ago with no unblock comment from another agent | Comment on issue, suggest escalation. |

### Output surface

- **Per-ticket comments**: immediate, actionable, posted by a system user (`ProcessWatcher`).
- **Admin UI digest**: a single page (`/admin/process-health`) showing counts per check, per agent, last 24 h. Served by AWO-165.

### Data model additions

- `process_watcher_runs` table: `id`, `runAt`, `checkType` (1-7), `issueId`, `verdict` (`pass` | `flag` | `auto-fix`), `commentId`, `createdAt`.
- `issues` table: add `verificationCommand` text nullable (closure gate from LEARNINGS §8). ProcessWatcher check #2 consumes this.

---

## Half B — Prevention: Auto-Assign Router

### Lane-match algorithm

```
function autoAssign(issue):
  if issue.assigneeAgentId is set: return

  paths = extractFilePaths(issue.description)   // regex for `packages/...`, `docs/...`, etc.
  candidates = empty map<roleName, matchCount>

  for each path in paths:
    for each role in agentLanes.roles:
      if any(role.allow pattern matches path):
        candidates[role] += 1

  if candidates is empty:
    issue.triage = true
    return

  if multiple candidates with equal top matchCount:
    // ambiguous — e.g., a path matches both Backend and TechLead (shared/)
    // Use longest-match tie-break: the role whose pattern is most specific
    // Fallback: triage = true
    issue.triage = true
    return

  winner = candidate with lowest todo count
  if tie: winner = alphabetical role name

  issue.assigneeAgentId = winner.agentId
```

### Triage queue

Tickets with `triage = true` and `assigneeAgentId = null` surface in the admin UI as the **Unassigned / Triage** queue. A Coordinator (human or CEO agent) manually assigns them. AWO-168 owns the UI surface.

### Critical-path sort for `inbox-lite`

After filtering to the agent's `in_progress` + `todo` issues, sort by:

1. **Critical-path score desc** — number of downstream tickets this ticket blocks (parent/dependency DAG depth).
2. **Priority desc** — `critical` > `high` > `medium` > `low`.
3. **CreatedAt asc** — older first.

Stale `in_progress` tickets (no comment or commit in 45 min) are treated as `todo` for sorting purposes. The agent still sees them, but they do not starve higher-priority fresh work (LEARNINGS §18).

**Implementation**: SQL CTE computing transitive dependency count, or in-memory graph traversal if dependency data is not yet in the DB. AWO-167 owns the implementation.

---

## API Contract Changes

### `POST /api/issues`

- New behavior: if `assigneeAgentId` is absent, the hook runs lane-match and sets it (or sets `triage = true`).
- Response shape unchanged.

### `GET /api/agents/me/inbox-lite`

- Response order changes: now sorted by critical-path score, priority, createdAt.
- Response shape unchanged.

### New internal routes (admin UI)

- `GET /api/admin/process-health` — digest of ProcessWatcher flags, last 24 h.
- `GET /api/admin/triage-queue` — unassigned tickets awaiting manual assignment.

---

## Dependency Graph

```
AWO-162 (this RFC)
├── AWO-163 — Define ProcessWatcher worker registry + lane spec
├── AWO-164 — Implement seven-check heartbeat in agentos-d
├── AWO-165 — Admin UI: Process Health digest page
├── AWO-166 — Auto-assign router middleware
├── AWO-167 — Critical-path DAG sort for inbox-lite
└── AWO-168 — Triage queue + admin UI surface
```

AWO-163 and AWO-166 can ship in parallel. AWO-164 depends on AWO-163. AWO-165 and AWO-168 depend on AWO-164 and AWO-166 respectively. AWO-167 is independent of ProcessWatcher and can ship in parallel with AWO-166.

---

## Out of Scope (Deferred)

- **LaborBroker LLM-driven planner.** Open as follow-up only if Shape A's failure rate signals it's needed.
- **Auto-decomposition of parent tickets.** Deferred to v2; manual decomposition stays human until we see how parents behave.
- **Replacing existing bash daemons.** v1 = ProcessWatcher consumes their logs; v2 collapses them into the service.
- **@-mention routing beyond in-app comments.** v1 = in-app only.

---

## Verification

- [ ] RFC committed to `docs/rfc/008-workflow-discipline-processwatcher-auto-assign.md`
- [ ] AWO-163 — ProcessWatcher worker registered in `agentos-d` startup sequence
- [ ] AWO-164 — All seven checks execute on a 5-minute tick and post comments
- [ ] AWO-165 — `/admin/process-health` renders counts per check per agent
- [ ] AWO-166 — Creating an issue without assignee triggers lane-match and sets `assigneeAgentId` or `triage=true`
- [ ] AWO-167 — `inbox-lite` returns tickets sorted by critical-path score
- [ ] AWO-168 — `/admin/triage-queue` lists unassigned tickets with manual-assign action
- [ ] Integration: create a ticket with ambiguous paths → lands in triage → manual assign → appears in correct agent's inbox in critical-path order
