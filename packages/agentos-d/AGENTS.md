# AgentWorks `packages/agentos-d`

The substrate daemon. REST + MCP server, DB migrations, paperclip adapter integration, and the core orchestration service that routes agent actions through policy checks before execution. This is the runtime heart of AgentWorks OS.

## Your lane

- **BackendEngineer** — `^packages/agentos-d/`

## Public API surface

Other packages may import:

- `src/routes/*.ts` — HTTP route handlers (internal use only; external callers use the REST API)
- `src/services/*.ts` — business logic services
- `src/migrations/` — Drizzle migrations (run by the daemon at startup)

Other packages must NOT import:
- `src/circuit-breaker/*` — internal resilience layer
- `src/cost-meter/*` — internal metering (v1.1)

## Do not edit

- `packages/policy-engine/**` (consume evaluator; don't edit it)
- `packages/scanner-worker/**` (PythonEngineer)
- `packages/admin-ui/**` (FrontendEngineer)
- `docs/**` (TechnicalWriter)
- `/Users/example/Projects/paperclip/**` (orchestrator runtime — read-only)

## Relevant LEARNINGS

- §4 — Schema drift without migrations = comments break instance-wide. Add a migration in the SAME commit as any schema change.
- §6 — Repo-boundary violations. agentos-d is NEW code in agentworks-os, NOT a fork of paperclip.
- §16 — Substrate idempotency: one POST can create two tickets. Use unique constraints and retries.
- §17 — Auto-commit + off-scope work = noise on `main`. Keep commits scoped to the ticket.


---

# Karpathy Coding Guidelines

Behavioral guardrails to reduce LLM coding mistakes. Bias toward caution over speed. For trivial tasks (typos, one-liners), use judgment.

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

When your changes create orphans: remove imports/variables/functions YOUR changes made unused. Don't remove pre-existing dead code unless asked.

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

Strong criteria let the agent loop independently. Weak criteria ("make it work") require constant clarification.

## Verification

These guidelines are working if: fewer unnecessary diffs, fewer rewrites from overcomplication, clarifying questions come before implementation, not after mistakes.

## Source

Derived from [forrestchang/andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills), based on [Karpathy's observations](https://x.com/karpathy/status/2015883857489522876).
