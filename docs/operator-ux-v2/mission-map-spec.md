# Mission Map Graph Schema + Node-Kind Palette

**Issue:** AGE-241  |  **Wave:** 3  |  **Owner:** CEO

## Goal
Define a canonical graph schema that lets operators visualize the entire AgentWorks substrate as a single explorable map: companies, projects, issues, agents, runs, evidence, and memory—all wired by typed edges with deterministic color rules and drill-down targets. The map becomes the primary navigation surface for v2.

## Surfaces

### 1. Global Map View (`/map`)
- Full-graph canvas (zoom/pan) seeded from the tenant root node.
- Node badges show live counts (open issues, running agents, unseen evidence).
- Edge thickness = event volume over last 24 h.
- Color rules (see Palette) applied server-side so color is consistent across clients.

### 2. Mini-Map Component
- Re-usable React component for embedding inside any entity page (issue, agent, run, evidence, memory).
- Displays 1-hop neighborhood only; click "expand" to open full map.

### 3. Drill-Down Panels
- Clicking any node slides in a side panel with the canonical detail view for that entity (same components used in standalone pages).
- Right-click → "Center map here" re-renders graph with selected node as root.

## Backend

### Graph Schema (PostgreSQL + Drizzle)
```sql
nodes
  id            uuid primary key
  tenant_id     uuid fk → tenants.id
  kind          text check (kind in ('company','project','issue','agent','run','evidence','memory'))
  title         text not null
  status        text -- domain-specific enum per kind
  meta          jsonb -- kind-specific blob (see below)
  created_at    timestamptz
  updated_at    timestamptz
  deleted_at    timestamptz -- soft delete

edges
  id            uuid primary key
  tenant_id     uuid fk → tenants.id
  from_node_id  uuid fk → nodes.id
  to_node_id    uuid fk → nodes.id
  kind          text check (kind in ('owns','blocks','assigned','generated','references','depends','follows'))
  meta          jsonb -- weight, confidence, scan-result pointer, etc.
  created_at    timestamptz
  
unique (tenant_id, from_node_id, to_node_id, kind)
```

### Node-Kind Meta Shape
```ts
// company
{ domain, plan_tier, seats, billing_status }

// project
{ slug, visibility, repo_url, lead_agent_id }

// issue
{ priority, estimate, assignee_agent_id, status, tags[] }

// agent
{ role, lane, status, last_heartbeat, budget_cents }

// run
{ trigger, exit_code, cost_cents, log_url, artifact_urls[] }

// evidence
{ rule_pack_id, severity, verdict, scanner, sha256 }

// memory
{ mime_type, size_bytes, vault_path, indexed_at }
```

### Edge-Kind Semantics
- **owns** – parent → child containment (company → project, project → issue, agent → run)
- **blocks** – directional blocker (issue → issue)
- **assigned** – agent ↔ issue
- **generated** – run → evidence/memory
- **references** – any node → memory (markdown link resolution)
- **depends** – soft dependency (project → project, issue → issue)
- **follows** – temporal order (run → run for same agent)

### Color Rules (deterministic, server-side)
```ts
const palette = {
  company:   { default: '#0ea5e9',  hover: '#0284c7' },
  project:   { default: '#10b981',  hover: '#059669' },
  issue:     { default: '#f59e0b',  hover: '#d97706' },
  agent:     { default: '#8b5cf6',  hover: '#7c3aed' },
  run:       { default: '#6b7280',  hover: '#4b5563' },
  evidence:  { default: '#ef4444',  hover: '#dc2626' },
  memory:    { default: '#06b6d4',  hover: '#0891b2' }
} as const;

function nodeColor(n: Node): string {
  if (n.deleted_at) return '#d1d5db';
  if (n.kind === 'issue') {
    switch (n.status) {
      case 'done':  return '#10b981';
      case 'review':return '#8b5cf6';
      case 'blocked':return '#ef4444';
    }
  }
  if (n.kind === 'run' && n.status === 'failed') return '#ef4444';
  if (n.kind === 'evidence' && n.meta.severity === 'block') return '#991b1b';
  return palette[n.kind].default;
}
```

### API Contract
```http
GET /api/map/graph?tenant_id=...&root=...&depth=...
→ { nodes: Node[], edges: Edge[] }  -- full shape above

POST /api/map/node
Body = { tenant_id, kind, title, meta }
→ Node (201)

PATCH /api/map/node/:id
Body = Partial<Node>
→ Node (200)

DELETE /api/map/node/:id  -- soft delete
→ 204

POST /api/map/edge
Body = { tenant_id, from_node_id, to_node_id, kind, meta }
→ Edge (201)

DELETE /api/map/edge/:id  -- hard delete
→ 204
```

### Performance Notes
- Materialized path column on nodes for fast subtree queries.
- Edge table indexed `(tenant_id, from_node_id)` and `(tenant_id, to_node_id)`.
- Graph endpoint capped at depth 5; deeper on demand via `?depth=expand`.
- WebSocket push (`/api/ws/map`) broadcasts node/edge mutations so open maps stay live.

## Frontend

### State Shape (Zustand)
```ts
type MapStore = {
  tenantId: string;
  nodes: Map<string, Node>;
  edges: Map<string, Edge>;
  selected: string | null;
  viewport: { x: number; y: number; zoom: number };
  setViewport: (v: Partial<viewport>) => void;
  upsertNode: (n: Node) => void;
  removeNode: (id: string) => void;
  upsertEdge: (e: Edge) => void;
  removeEdge: (id: string) => void;
  loadGraph: (root?: string, depth?: number) => Promise<void>;
}
```

### Canvas Tech
- React-Flow 12.x (Svelte-free, MIT).
- Custom node types per kind; SVG badges for status overlays.
- Edge labels shown on hover only to reduce clutter.
- Keyboard shortcuts: `+/-` zoom, `r` re-center, `f` focus selected.

### Accessibility
- Nodes render as `<button>` with `aria-label="${kind}: ${title}"`.
- Color is never the sole indicator—shape + icon + text label all present.
- High-contrast mode toggle swaps palette for WCAG 2.2 AA.

## Out of Scope
- Real-time layout physics (milestone v2.1).
- Full-text search inside map (use global search surface).
- Mobile-optimized canvas (tablet only for v2).
- Bulk mutations (multi-select + group actions).
- Custom node icons per tenant.

## Open Questions
1. Do we keep historical edge snapshots for audit, or mutate in place?
2. Should evidence nodes auto-expire or live forever?
3. Cap on number of nodes per tenant before we paginate graph?
4. Do we expose the WebSocket to external clients or keep it admin-only?

## Deliverable Checklist
- [x] `docs/operator-ux-v2/mission-map-spec.md` created
- [x] All sections present per CEO-REVIEW-GATE
- [x] API contracts spelled out
- [x] Color rules deterministic
- [x] No code changes, spec only
