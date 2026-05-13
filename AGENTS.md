# AGENTS.md — agent conventions for AgentWorks OS

This file documents how AI coding agents should behave when working in this
repo. It supplements `CLAUDE.md` (which orients all contributors).

## Customer-facing vocabulary discipline

Every label, button, error toast, tooltip, page title, empty-state, and
onboarding step uses AgentWorks vocabulary only. Customer-discoverable
surfaces — `README.md`, `docs/install-runbook.md`,
`docs/rule-pack-authoring.md`, `docs/awcp*.md`, `docs/backup-restore.md`,
`docs/support-bundle.md`, `docs/update-procedure.md`,
`docs/error-messages.md`, `docs/onboarding-wizard-copy.md`,
`docs/disclaimer-text.md`, `docs/required-data-declarations.md`, the admin
UI, the CLI `agentworks --help` output, and MCP tool descriptions — must use
AgentWorks names: `agentos-d`, `AgentWorks API`, `vault`, `the substrate`,
`the daemon`.

Internal architecture documents (`docs/rfc/*.md`, `agents/*/AGENTS.md`) may
reference upstream component history. Customer-facing surfaces may not.

## Roles in this repo

Per-role conventions live under `agents/<role>/AGENTS.md`:

- **BackendEngineer** — `packages/agentos-d`, `packages/awcp`,
  `packages/shared`, db migrations
- **FrontendEngineer** — `packages/admin-ui` (Next.js + React)
- **PythonEngineer** — `packages/scanner-worker` (FastAPI + scanner core)
- **TechnicalWriter** — `docs/`, READMEs
- **TechLead** — `docs/rfc/`, shared types, cross-cutting architecture
- **QAEngineer** — `tests/`, `*.test.ts` files
- **ComplianceConsultant** — `rule-packs/` (YAML rule pack content)

## Forbidden

- Force-push, `--no-verify`, history rewrites
- Bypassing the policy engine in code paths that exist for compliance review
- Leaking customer-internal vocabulary (see "Customer-facing vocabulary
  discipline" above) into customer-discoverable surfaces

## See also

- `CLAUDE.md` — repo conventions for everyone
- `CONTRIBUTING.md` — how to contribute as an external contributor
- `agents/_shared/STANDALONE-PRODUCT-DOCS.md` — full vocabulary policy

---

# Karpathy Coding Guidelines

Behavioral guardrails to reduce LLM coding mistakes. Bias toward caution over
speed. For trivial tasks (typos, one-liners), use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If 200 lines could be 50, rewrite.

Test: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans: remove imports/variables/functions YOUR
changes made unused. Don't remove pre-existing dead code unless asked.

Test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
```

Strong criteria let the agent loop independently. Weak criteria ("make it
work") require constant clarification.

## Verification

These guidelines are working if: fewer unnecessary diffs, fewer rewrites from
overcomplication, clarifying questions come before implementation, not after
mistakes.

## Source

Derived from
[forrestchang/andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills),
based on
[Karpathy's observations](https://x.com/karpathy/status/2015883857489522876).
