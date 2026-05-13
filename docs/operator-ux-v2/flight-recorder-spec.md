# Flight Recorder UX Specification

## Goal
Provide operators with a chronological timeline view of every agent action, decision, and substrate event so they can answer "What happened?" and "Why?" for any moment in the past 30 days. The recorder surfaces a merged, time-ordered stream that collapses multi-step agent runs into a single expandable card while preserving the underlying atomic events for drill-down.

## Surfaces

### 1. Timeline page (`/timeline`)
- **URL**: `/timeline` (Admin UI)
- **Default range**: last 24 h, adjustable 1 h … 30 d
- **Auto-refresh**: 10 s when viewing "now"
- **Primary sort**: `event_ts ASC` (newest at bottom, infinite-scroll upward)
- **Secondary sort**: `event_id ASC` (tie-breaker for same millisecond)

### 2. Agent run card (collapsible)
- **Header**: agent name, final disposition badge (`allow | block | route_to_review`), duration, expand chevron
- **Collapsed height**: 64 px fixed
- **Expanded body**: chronological list of inner events (max 25 shown, "Show all" paginates)

### 3. "Why?" popover
- **Trigger**: click on any disposition badge
- **Content**: rule pack(s) that contributed the winning verdict, severity, evidence snippets (≤ 140 chars each), link to full evidence in vault
- **Dismiss**: click-outside or ESC

### 4. CSV export
- **Endpoint**: `GET /api/timeline/export?from=…&to=…`
- **Shape**: same columns as table below, UTF-8, BOM-free, RFC 4180

## Backend

### Schema: `file_access_log` (new table)
```sql
create table file_access_log (
  event_id          uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id),
  agent_id          uuid not null,
  agent_run_id      uuid not null,          -- groups atomic steps of one run
  event_ts          timestamptz not null,
  event_type        text not null,          -- run_start | action | policy_hit | run_end
  severity          text,                   -- allow | block | route_to_review | info
  disposition       text,                   -- final verdict for run_end rows only
  rule_pack_id      text,                   -- populated for policy_hit
  evidence_json     jsonb,                  -- arbitrary evidence captured at moment
  file_path         text,                   -- file acted upon (nullable)
  file_hash_before  text,                   -- sha256 hex (nullable)
  file_hash_after   text,                   -- sha256 hex (nullable)
  created_at        timestamptz default now()
);
create index file_access_log_ts_idx on file_access_log (tenant_id, event_ts desc);
create index file_access_log_run_idx on file_access_log (tenant_id, agent_run_id, event_ts asc);
```

### Ingestion contract
- AgentOS daemon writes one row per event **inside** the transaction that produces the event
- `agent_run_id` is generated once at run start and reused for every event in that run
- `disposition` is NULL except on `event_type = 'run_end'` where it carries the final aggregated verdict

### Merge & ordering rules
1. All events share the same monotonic clock (`event_ts`)
2. Within a single millisecond, order by `event_id ASC` (UUID v7 is time-ordered)
3. Collapse strategy for UI:
   - Find `run_start` … `run_end` range per `agent_run_id`
   - Render one card whose header is `run_start` row and whose expandable body is the inner events
   - Adjacent cards are separated by ≥ 1 ms or different `agent_id`

### Retention
- 30 days online (hot partition)
- Nightly job moves older rows to cold partition (out of scope for v1)

## Frontend

### Timeline table (virtualized)
Columns shown:
1. **Time** (`event_ts` formatted as 13:04:05.123)
2. **Agent** (agent name link → agent detail)
3. **Action** (`event_type` humanized)
4. **File** (`file_path` basename, hover full path)
5. **Disposition** (colored badge, click → "Why?" popover)

### State management
- React Query key: `['timeline', tenantId, from, to]`
- Pagination cursor: `last_event_ts + last_event_id` (URL persisted for shareability)
- Expanded cards stored in localStorage per tenant (max 50 cached)

### Error handling
- 5xx on fetch: inline banner "Timeline unavailable, retrying in 10 s" with manual retry button
- Empty result: zero-state graphic + "No events in selected range"

## Out of scope
- Snapshot-based replay (rewind/fast-forward agent state)
- Real-time streaming (WebSocket) — polling is sufficient for v1
- Cold storage UI or restore workflows
- Editing or deleting events (append-only log)
- Cross-tenant search or aggregated analytics

## Open questions
1. Do we need a separate `file_access_log` partition per tenant or is single-table with tenant_id sufficient for 30-day volume?
2. Should the "Why?" popover also surface the human reviewer’s comment when disposition was `route_to_review` and later approved/denied?
3. CSV export limit: hard 50 k rows or stream gzip?
