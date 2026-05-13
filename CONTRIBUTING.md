# Contributing to AgentWorks OS

Thanks for your interest in contributing. AgentWorks OS is an
Apache-2.0-licensed compliance gateway for SMBs running AI agents.

## Quick start

```bash
git clone https://github.com/SGridworks/agentworks-os.git
cd agentworks-os
pnpm install
pnpm verify   # typecheck + build + test
```

See [CLAUDE.md](./CLAUDE.md) for the full repo layout and run-locally
recipe.

## Ground rules

- **Conventional commits.** `feat:`, `fix:`, `docs:`, `refactor:`,
  `test:`, `chore:`. Subject explains *what*; body explains *why*.
- **No emojis** in code, comments, or commit messages.
- **TypeScript:** strict mode, ESM only, `unknown` over `any`, Zod for any
  crossing of a system boundary. Files under 400 lines, functions under 50.
- **Forward-only DB migrations.** Numbered `0000_init.ts`, `0001_*.ts`, etc.
  Each registers an idempotency hash in `__drizzle_migrations`. Never edit
  a landed migration; add a new one.
- **No comments unless the WHY is non-obvious.**

## PR process

1. Open an issue first for non-trivial changes — describe the problem and
   the proposed approach. This keeps reviews fast and avoids wasted work.
2. Fork the repo, branch from `main`, push to your fork.
3. Open a PR. The PR description should explain *why* and link the issue.
4. Run `pnpm verify` locally. CI will too.
5. A maintainer will review. Expect feedback within ~5 business days for
   non-urgent changes.

## Customer-facing vocabulary discipline

Customer-discoverable surfaces must use AgentWorks vocabulary only. The
authoritative list and rules live in
[`agents/_shared/STANDALONE-PRODUCT-DOCS.md`](./agents/_shared/STANDALONE-PRODUCT-DOCS.md).

Customer-facing files (must use AgentWorks names only — `agentos-d`,
`AgentWorks API`, `vault`, `the substrate`, `the daemon`):

- `README.md`
- `docs/install-runbook.md`, `docs/rule-pack-authoring.md`,
  `docs/awcp.md`, `docs/awcp/`, `docs/backup-restore.md`,
  `docs/support-bundle.md`, `docs/update-procedure.md`,
  `docs/error-messages.md`, `docs/onboarding-wizard-copy.md`,
  `docs/disclaimer-text.md`, `docs/required-data-declarations.md`
- the admin UI itself (every label, button, error, tooltip)
- the CLI `agentworks --help` output
- the MCP server's tool descriptions

Architecture/reference paths (technical lineage may appear when needed):

- `docs/brand-naming-convention.md`
- `docs/rfc/*.md`
- `agents/*/AGENTS.md`
- `packages/*/AGENTS.md`

Reviewers will block PRs that leak internal vocabulary into customer-facing
surfaces.

## Tests

- Package-level: `pnpm -r test` runs vitest in each package
- Substrate end-to-end: `npx vitest run tests/substrate-e2e.test.ts` boots
  a real daemon and exercises every pilot-install criterion through HTTP.
  If this passes, the install is shippable.
- Admin-ui build smoke: `pnpm --dir packages/admin-ui build` — the Next.js
  production build must succeed before merging UI changes.

Any bug fix should land with a regression test.

## Reporting bugs / requesting features

Use the issue templates under `.github/ISSUE_TEMPLATE/`. For security
issues, see [SECURITY.md](./SECURITY.md) — do **not** open a public issue.

## License

By contributing, you agree your contributions will be licensed under the
project's [Apache 2.0 license](./LICENSE).
