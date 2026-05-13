# Morning Brief — Operator UX v2 Spec

## Goal
Deliver a daily, tenant-scoped digest that surfaces overnight agent activity, policy hits, and recommended next actions in a single dismissible card shown on first dashboard load each day.

## Surfaces

### Primary card
- Location: top of `/dashboard` above the approval queue
- Layout: single column, 640 px max-width, responsive collapse
- Header: "Morning Brief — {today}" + dismiss (X) button
- Body: stacked sections (see below)
- Footer: "Generated at 06:00 local" + refresh icon (manual re-gen)

### Sections (order fixed)
1. Overnight summary
   - Agents active: N
   - Actions proposed: N
   - Actions auto-allowed: N
   - Actions routed to review: N
2. Top policy hits (max 3)
   - Rule pack name, severity badge (block / review), truncated action text (60 char), link to full approval queue item
3. Recommendations (max 2)
   - Heuristic-driven next best actions (see Backend)
4. Vault delta
   - New secrets added: N (with link to vault view)

## Backend

### Generation trigger
- Scheduled: 06:00 tenant-local time via existing cron table
- Manual: POST `/api/tenant/{id}/morning-brief/refresh` (idempotent, returns 204)

### Response schema (zod)
```ts
export const MorningBriefSchema = z.object({
  tenantId: z.string().uuid(),
  generatedAt: z.string().datetime(),
  summary: z.object({
    agentsActive: z.number().int().min(0),
    actionsProposed: z.number().int().min(0),
    actionsAutoAllowed: z.number().int().min(0),
    actionsRouted: z.number().int().min(0)
  }),
  topHits: z.array(z.object({
    approvalId: z.string().uuid(),
    rulePack: z.string(),
    severity: z.enum(['block','review']),
    actionSnippet: z.string().max(60)
  })).max(3),
  recommendations: z.array(z.object({
    type: z.enum(['review_backlog','rotate_secret','add_contact']),
    title: z.string().max(40),
    description: z.string().max(80),
    ctaLink: z.string() // relative path within admin-ui
  })).max(2),
  vaultDelta: z.object({
    newSecrets: z.number().int().min(0)
  })
});
```

### Heuristics for recommendations
1. review_backlog: if routed > 5 AND oldest > 24 h
2. rotate_secret: if any vault entry older than 90 days
3. add_contact: if tenant has zero contacts (future CRM sync)
Ties broken by priority order above; only top two emitted.

### Persistence
- Table `morning_briefs(tenant_id PK, generated_at, json_blob)`
- Row replaced daily; no history kept
- Dismiss state stored per tenant in `tenant_prefs(morning_brief_dismissed_at)`

## Frontend

### Card component
- File: `packages/admin-ui/src/components/MorningBriefCard.tsx`
- Props: `brief: MorningBriefSchema` + `onDismiss: () => void`
- Accessibility: aria-labels, keyboard-dismiss (Escape), focus return to dashboard heading
- Styling: neutral background, border subtle, severity badges use existing color tokens

### Dismiss semantics
- Clicking X sets `tenant_prefs.morning_brief_dismissed_at = now()`
- Card hidden when `generated_at <= dismissed_at` (same calendar day)
- Refresh button clears dismissed flag and re-fetches

### Routing
- Links inside card use Next.js `Link` component
- Vault link: `/vault`
- Approval queue link: `/approvals?highlight={approvalId}` (scroll-to via query param)

## Out of scope
- Email or push delivery
- Historical briefs or trend graphs
- Customizable generation time
- Multi-language support
- Rich formatting (markdown, images)

## Open questions
1. Should we cap the overnight window (e.g., 00:00–06:00) or use last 24 h?
2. Do we surface scanner-worker health issues here or keep those in a separate banner?
3. When a tenant has no activity overnight, do we still show the card with zeros or suppress entirely?
4. Do we need an explicit “Mark as read” API or is dismiss sufficient for audit?

## Lo-fi mockup (ASCII)
```
┌────────────────────────────────────────────── Morning Brief — May 25 ──┐
│ ┌─ Summary ──────────────────────────────────────────────────────────┐ │
│ │ Overnight: 3 agents active • 42 actions proposed • 38 auto-allowed │ │
│ │            4 routed to review                                      │ │
│ └────────────────────────────────────────────────────────────────────┘ │
│ ┌─ Top Policy Hits ──────────────────────────────────────────────────┐ │
│ │ 🔴 TCPA-real-estate   block   "Send SMS to 555-1234 about list..." │ │
│ │ 🟡 Fair-housing       review  "Draft email to buyer with zipcod..."│ │
│ │ 🟡 SMB-starter        review  "Export customer CSV to /tmp/out..." │ │
│ └────────────────────────────────────────────────────────────────────┘ │
│ ┌─ Recommendations ──────────────────────────────────────────────────┐ │
│ │ 1. Review backlog   6 items waiting >24 h  [Go to approvals]       │ │
│ │ 2. Rotate secret    Vault entry "ml_api_key
