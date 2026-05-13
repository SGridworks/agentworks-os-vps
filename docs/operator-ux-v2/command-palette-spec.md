# Command Palette UX Specification

## Goal
Deliver a keyboard-driven command palette that lets operators invoke any substrate action without leaving the keyboard. The palette surfaces every verb the daemon exposes, provides fuzzy search, and keeps the action-registry shape stable for future extensibility.

## Surfaces

### Modal UX
- Trigger: `Cmd+K` (macOS) / `Ctrl+K` (Linux/Win)
- Dismiss: `Escape` or clicking the backdrop
- Width: 600 px max, centered, 80 px top margin
- Height: auto, max 60 % of viewport, scrollable list
- Dark theme only (matches admin-ui palette)
- Z-index: 50 (above drawer, below confirmation overlays)

### Input bar
- Placeholder text: "Type a command or search…"
- Debounced search: 150 ms
- Prefix hint: show ">" glyph left of input
- Clear button (×) appears when text length > 0

### Result list
- Max visible items: 7
- Item height: 44 px
- Active item: slate-700 background, white text
- Inactive item: slate-900 background, slate-300 text
- Icon: 20 × 20 px left-aligned, 12 px right margin
- Primary label: 14 px font, font-medium
- Secondary label: 12 px font, slate-400, 4 px top margin
- Keyboard shortcut (if any): right-aligned, monospace, slate-500
- No-results state: "No matching commands" with ghost icon

### Keyboard contract
- `↑` / `↓` : navigate list (wraps)
- `Enter` : execute selected item
- `Cmd+Enter` : execute in background (closes palette, no toast)
- `Tab` : accept auto-complete token if unique match
- `Shift+Tab` : jump to category header (if present)
- `/` : quick filter prefix ("/tenant ", "/policy ", "/scanner ")

## Backend

### Action-registry shape (v1)
```typescript
export const ActionRegistry = z.object({
  id: z.string(),                 // unique slug, kebab-case
  category: z.enum([
    "tenant",
    "policy",
    "scanner",
    "queue",
    "vault",
    "system"
  ]),
  label: z.string(),              // short human name
  description: z.string(),        // one-sentence help
  icon: z.string(),               // lucide icon name
  shortcut: z.array(z.string()).optional(), // e.g. ["Ctrl","Shift","R"]
  dangerous: z.boolean().default(false),    // requires confirmation
  background: z.boolean().default(false),   // allow background run
  handler: z.function().args(z.any()).returns(z.promise(z.any()))
});
```

### Index endpoint
`GET /api/commands?search=<q>`
- Returns array of `ActionRegistry` (without handler)
- Sorted: category → label asc
- Filtered by fuzzy match on label + description
- Cached in memory; TTL 5 min

### Execute endpoint
`POST /api/commands/:id/execute`
- Body: `{ payload?: any }`
- Returns: `{ ok:true, result:any } | { ok:false, error:string }`
- Logs action to audit log (tenant-scoped)
- If `dangerous=true`, requires confirmation token in header `X-Confirm: yes`

### Registration
Daemon scans `src/commands/*.ts` at boot, registers each default export that satisfies `ActionRegistry`. Third-party packs can append via `POST /api/commands/register` (admin-only).

## Frontend

### React component tree
```
CommandPaletteProvider (context)
└── CommandPaletteModal
    ├── SearchInput
    ├── ResultList
    │   └── ResultItem (memo)
    └── HelpFooter (shortcuts legend)
```

### State shape
```typescript
type State = {
  open: boolean;
  query: string;
  activeId: string | null;
  items: ActionRegistry[];
  loading: boolean;
};
```

### Hooks
- `useCommandPalette()` → `{ open, toggle, register }`
- `useRegisterCommand(action)` → call inside feature modules to append verbs

### Routing
No new routes. Palette is a portal-mounted overlay at `/`.

### Accessibility
- Focus trap inside modal
- aria-labels on every interactive element
- role="listbox", role="option" on items
- aria-live region announcing result count

## v1 Verb List

### tenant
- `tenant:switch` — Switch active tenant
- `tenant:new` — Create tenant
- `tenant:delete` — Delete tenant (dangerous)

### policy
- `policy:reload` — Reload rule packs
- `policy:test` — Dry-run action against rules
- `policy:export` — Export active rule set

### scanner
- `scanner:trigger` — Trigger AgentGuard scan
- `scanner:pause` — Pause scanner worker
- `scanner:resume` — Resume scanner worker

### queue
- `queue:clear` — Clear approval queue
- `queue:export` — Export queue as CSV

### vault
- `vault:search` — Search vault entries
- `vault:export` — Export vault (encrypted)

### system
- `system:health` — Show health check
- `system:restart` — Restart daemon (dangerous)
- `system:logs` — Tail daemon logs

## Out of scope
- Custom user-defined commands
- Command scripting / chaining
- Telemetry on usage frequency
- Theming beyond dark mode
- Voice invocation
- Mobile gesture triggers

## Open questions
1. Do we expose scanner-worker commands (Python) through the same registry or keep them RPC-only?
2. Should dangerous commands require typing the command name as confirmation instead of a simple header?
3. Do we ship a default keyboard shortcut map viewable via `?` inside the palette?
4. How will localization work for label/description fields — separate registry per locale or inline keys?
5. Do we allow plugins to override built-in commands (last-registration-wins)?
