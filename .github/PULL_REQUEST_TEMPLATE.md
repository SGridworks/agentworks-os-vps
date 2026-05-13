## Why

<!-- What problem does this PR solve? Link the issue. -->

## What changed

<!-- One paragraph. The diff explains the rest. -->

## Verification

- [ ] `pnpm verify` passes locally (typecheck + build + tests)
- [ ] `npx vitest run tests/substrate-e2e.test.ts` passes (if daemon /
      policy / memory / approval-queue paths are touched)
- [ ] Bug fixes include a regression test
- [ ] Customer-facing strings use AgentWorks vocabulary only (see
      [CONTRIBUTING.md](../CONTRIBUTING.md))
- [ ] Docs updated (if behavior or env vars change)

## Risks / rollback

<!-- What could this break? How would you roll it back? -->
