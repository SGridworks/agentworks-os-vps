# Trust Layer – design spec

## Goal
Surface real-time trust signals for every external dependency the substrate touches (LLM provider, vector store, scanner side-car, policy-engine rule packs, vault store, audit log). A single GET `/api/admin/trust` endpoint returns a normalized “traffic-light” view that the admin-ui topbar polls every 30 s. The UX shows a green / amber / red shield icon plus a one-line summary; clicking opens a pop-over with the full table of providers, last-seen timestamps, and failure reasons when present.

## Surfaces
1. REST endpoint – GET `/api/admin/trust` (tenant-scoped, admin cookie required)
2. WebSocket status stream – same payload pushed when any provider flips state (optional v1.1)
3. Admin-ui topbar widget – left of the user avatar, always visible
4. Pop-over card – on click, full provider table with copy-able diagnostics

## Backend
### GET `/api/admin/trust` – response schema
```json
{
  "schema_version": 1,
  "summary": "all_ok | degraded | critical",
  "providers": [
    {
      "id": "openai",
      "category": "llm",
      "display_name": "OpenAI",
      "status": "ok | slow | error | unknown",
      "last_check": "2026-05-20T14:23:45Z",
      "last_success": "2026-05-20T14:23:45Z",
      "fail_reason": "", // empty when status ≠ error
      "latency_ms": 234, // -1 when unknown
      "region": "us-east-1"
    },
    {
      "id": "scanner",
      "category": "sidecar",
      "display_name": "AgentGuard Scanner",
      "status": "ok",
      "last_check": "2026-05-20T14:23:43Z",
      "last_success": "2026-05-20T14:23:43Z",
      "fail_reason": "",
      "latency_ms": 89,
      "region": "local"
    },
    {
      "id": "vault",
      "category": "storage",
      "display_name": "FileVault",
      "status": "ok",
      "last_check": "2026-05-20T14:23:42Z",
      "last_success": "2026-05-20T14:23:42Z",
      "fail_reason": "",
      "latency_ms": 12,
      "region": "local"
    }
  ]
}
```

### Provider categories (extensible)
- `llm` – any model endpoint the substrate calls
- `sidecar` – scanner-worker, future enrichers
- `storage` – vault store, audit log writer
- `policy` – rule-pack loader / evaluator
- `memory` – vector store (v1.1)

### Status mapping
| Provider status | Summary color | Icon |
|-----------------|---------------|------|
| all providers = ok | green | shield-check |
| any slow, none error | amber | shield-exclamation |
| any error | red | shield-x |
| all unknown | gray | shield-question |

### Polling cadence
- Admin-ui polls every 30 s when window is focused
- Daemon runs background checks every 60 s per provider (jittered ±5 s)
- On any state change daemon pushes WebSocket frame (if client connected)

### Failure handling
- After 3 consecutive failures provider flips to `error`
- Recovery requires 2 consecutive successes
- `fail_reason` must be safe to render (no secrets, ≤120 chars)
- Latency > 2 s threshold marks `slow`, > 10 s marks `error`

## Frontend
### Topbar widget (shell.tsx)
- 24 × 24 icon, same height as avatar
- Accessible label: “Trust status: all_ok”
- Badge dot when summary ≠ all_ok
- Click opens pop-over, ESC or click-outside closes

### Pop-over card (TrustPanel.tsx)
- Table with columns: Provider | Region | Status | Latency | Last check
- Sort: error → slow → ok → unknown, then alphabetically
- Copy button on fail_reason row (if present)
- Auto-refresh every 30 s while open
- Footer timestamp: “Updated just now / 2 min ago”

### State management
- React query key: `['trust', tenantId]`
- Stale time: 25 s (allows 5 s grace before next poll)
- Retry: 2 attempts, exponential back-off 1 s → 3 s
- On HTTP 401/403 redirect to login

## Out of scope
- Provider credential rotation UI
- Historical metrics / SLAs page
- Pager-duty style alerting (v1.1)
- Non-admin visibility (operators see only summary icon, no pop-over)
- Mobile responsive tweaks (admin-ui desktop-first)

## Open questions
1. Do we need a “snooze” button for known outages? (deferred to v1.1)
2. Should latency histograms be surfaced in pop-over? (risk of clutter)
3. WebSocket push – worth the infra cost for v1 or keep polling only?
4. Region field – expose actual cloud region or simplify to “us”, “eu”, “local”?
