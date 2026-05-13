# Memory Provenance Overlay – Design Specification

## Goal
Give tenant administrators an always-visible audit trail that shows who created, last modified, and last read every memory document stored in the tenant-scoped vault. The overlay is surfaced as optional frontmatter fields on every `.md` file and exposed through a lightweight REST endpoint for dashboard and programmatic consumption.

## Surfaces

### 1. File-level frontmatter (markdown vault)
Every memory document MAY carry the following YAML frontmatter block immediately after the opening `---`:

```yaml
---
authoringAgent: <uuid>        # agent that first wrote the file
lastUpdatedBy: <uuid>         # agent that most recently mutated content
lastUpdatedAt: <ISO-8601>     # wall-clock time of last mutation
lastUsedBy:                   # agents that read the doc in last 30 d
  - <uuid>
  - <uuid>
---
```

- Fields are additive; omission is legal and means “no data yet.”
- `lastUsedBy` is a rolling window: on read, append reader UUID if not present; older than 30 d entries are silently dropped on next write.
- All UUIDs are the canonical agent identifier issued by the substrate at registration time.

### 2. REST endpoint
`GET /api/memory/provenance?path=<url-encoded-vault-path>`

**Auth:** tenant-scoped JWT required (same guard as memory CRUD).

**Response 200**
```json
{
  "path": "campaigns/2026-spring/newsletter.md",
  "authoringAgent": "018f...",
  "lastUpdatedBy": "018f...",
  "lastUpdatedAt": "2026-04-27T18:12:34.444Z",
  "lastUsedBy": ["018f...", "019a..."],
  "readWindowDays": 30
}
```

**Response 404** – path does not exist in tenant vault.

**Response 400** – missing or malformed path parameter.

### 3. Capacity & performance invariants
- Frontmatter is inline; no secondary index. File count scaling follows existing vault limits (≤ 50 k files per tenant).
- `lastUsedBy` array capped at 100 UUIDs; overflow drops oldest.
- Endpoint latency target ≤ 25 ms p99 on cold file (single disk stat + read). Cached reads (memory layer) ≤ 5 ms.
- No pagination needed – single document scope.

## Backend

### FileVaultStore extension (`packages/memory`)
- `writeProvenance(meta: ProvenanceMeta, content: string): Promise<void>`
  - Reads existing frontmatter if present, merges new meta, writes atomically.
- `readProvenance(path: string): Promise<ProvenanceMeta | null>`
  - Parses YAML frontmatter; returns null if none.
- `touchProvenance(path: string, readerId: string): Promise<void>`
  - Updates `lastUsedBy` array only; no content mutation.

### Policy engine integration
- Scanner rules may reference provenance fields (`lastUpdatedAt` older than X, `authoringAgent` in deny-list, etc.).
- No new severity level; provenance is treated as context meta inside ActionEnvelope.

### Migration strategy
- Backfill not required. Files without frontmatter return `null` fields from endpoint; UI renders “—”.
- Frontmatter added lazily on first mutation or explicit touch.

## Frontend

### Admin UI – Memory viewer pane
- New sub-heading “Provenance” under document meta.
- Fields rendered as read-only chips: Author, Last Updated, Last Readers (avatars + timestamp on hover).
- If all fields null, show “No provenance data” with subtle icon; no call-to-action.

### No auto-merge UI
- Out of scope for v1. Human resolves merge conflicts; provenance updated on final write.

## Out of scope
- Cross-tenant provenance (tenant boundary remains hard).
- Provenance for non-markdown vault objects (binary blobs, JSON configs).
- Cryptographic signing or tamper-evidence (deferred to v1.1).
- Historical timeline view (full changelog) – only latest snapshot kept.
- Bulk provenance export; single-document endpoint only.

## Open questions
1. Do we need a `createdAt` field separate from `lastUpdatedAt`? (Currently derivable from git if repo-backed vault is enabled.)
2. Should `lastUsedBy` preserve ordering by recency or alphabetical for determinism?
3. Retention policy for `lastUsedBy` when a document is archived (moved to `.archive/` folder)?

## Acceptance checklist (GATE ticket)
- FileVaultStore supports provenance read/write/touch.
- Endpoint returns correct JSON shape, 400/404 handling.
- Admin UI renders provenance panel without layout shift.
- E2E test: write doc → touch → read provenance → assert fields.
- No regression on existing memory CRUD latency budget.
