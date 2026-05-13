# AgentWorks OS — repo conventions

This file orients human and AI contributors working in this repo. Read it
before making changes.

## What this is

AgentWorks OS is a local-first compliance gateway for SMBs running AI agents.
Agents propose actions; the substrate evaluates them against rule packs (TCPA,
Fair Housing, HIPAA-placeholder, SMB-baseline) and returns
`allow | block | route_to_review`. The substrate also maintains a tenant-scoped
vault, a hash-chained audit log, and an approval queue for human review.

See [README.md](./README.md) for the product overview and
[CHANGELOG.md](./CHANGELOG.md) for the v0.1.0 scope.

## Repo layout

```
agentworks-os/
├─ packages/
│  ├─ shared/            # zod schemas + RFC 001 ActionEnvelope shape
│  ├─ policy-engine/     # rule pack loader + evaluator (severity-aware)
│  ├─ memory/            # tenant-scoped FileVaultStore (markdown on disk)
│  ├─ agentos-d/         # the daemon: REST + MCP server
│  │  ├─ src/cli.ts      # entry point, exposed as `bin: agentos-d`
│  │  ├─ src/app.ts      # express app + route mounting
│  │  ├─ src/routes/     # mcp.ts, tenants.ts, policy.ts, scanner.ts, ...
│  │  ├─ src/db/         # drizzle schema + forward-only migrations
│  │  └─ Dockerfile      # multi-stage build, bundles rule-packs/
│  ├─ admin-ui/          # Next.js 14 app router (dashboard, approvals, ...)
│  └─ scanner-worker/    # Python FastAPI sidecar (AgentGuard scan engine)
├─ rule-packs/           # YAML rule packs, one dir per pack
│  ├─ smb-starter/
│  ├─ tcpa-real-estate/
│  ├─ fair-housing/
│  └─ ...
├─ apps/installer/       # one-command setup (install.sh, agentworks.sh)
├─ tests/                # cross-package E2E tests (substrate-e2e.test.ts)
└─ docker-compose.yml    # agentos-d + scanner-worker + n8n
```

## How to run locally

```bash
# Install deps
pnpm install

# Build all packages
pnpm -r build

# Start the daemon on a free port
cd packages/agentos-d
AGENTOS_PORT=7710 \
  RULE_PACKS_DIR=$(pwd)/../../rule-packs \
  VAULT_ROOT=/tmp/awo-vault \
  AGENTOS_DATA_DIR=/tmp/awo-data \
  node dist/cli.js

# Health check
curl http://127.0.0.1:7710/api/health

# Run the substrate E2E suite (boots its own daemon)
npx vitest run tests/substrate-e2e.test.ts
```

## Conventions

**TypeScript**: strict mode, ESM only, `unknown` over `any`, Zod for any
crossing of a system boundary. Files under 400 lines, functions under 50.

**No emojis** in code, comments, or commit messages.

**Conventional commits**: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`,
`chore:`. Subject explains *what*; body explains *why*.

**No comments unless WHY is non-obvious.** Don't paraphrase the code in
comments. Do leave a note when there's a hidden constraint, a workaround for
a specific bug, or a non-obvious invariant.

**Forward-only DB migrations.** Numbered `0000_init.ts`, `0001_*.ts`, etc.
Each registers an idempotency hash in `__drizzle_migrations`. Never edit a
landed migration; add a new one.

**Rule packs are YAML, multi-doc.** Manifest first, then test fixtures, then
optional changelog — separated by `\n---`. Loader handles multi-doc; do not
collapse into a single doc.

**Severity-aware aggregation.** Across packs, `block` beats `route_to_review`
beats `allow`. Within ties, first-evaluated wins. Do NOT change to first-match
without thinking through the missing-data masking failure mode.

**Action envelope is canonical.** Anything calling the policy engine MUST
build the RFC 001 ActionEnvelope shape
(`packages/shared/src/schema/action.ts`). Both payload (snake_case) and
context.meta carry evidence — rules read from both.

## Testing

- Package-level: `pnpm -r test` runs vitest in each package
- Substrate E2E: `npx vitest run tests/substrate-e2e.test.ts` boots a real
  daemon and exercises every pilot-install criterion through HTTP. If this
  passes, the install is shippable.
- Admin-ui build smoke: `pnpm --dir packages/admin-ui build` — Next.js
  production build must succeed before merging UI changes.

## Customer-facing vocabulary

Customer-discoverable surfaces use AgentWorks vocabulary only. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for the full list. Internal architecture
notes live under `docs/rfc/` and `agents/` and may reference the substrate's
internal lineage.

## See also

- [README.md](./README.md) — product overview
- [CONTRIBUTING.md](./CONTRIBUTING.md) — how to contribute
- [SECURITY.md](./SECURITY.md) — responsible disclosure
- [CHANGELOG.md](./CHANGELOG.md) — release history
