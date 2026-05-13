# AgentWorks `packages/n8n-nodes`

Custom n8n nodes for AgentWorks substrate integration. Exposes `policy_check`, `memory.read`, `memory.write`, and `dispatch` nodes that n8n workflows can use to interact with the AgentWorks policy engine and memory store.

## Your lane

- **BackendEngineer** — `^packages/n8n-nodes/`

## Public API surface

Other packages do NOT import from n8n-nodes. It is a leaf package consumed by n8n at runtime.

## Do not edit

- `packages/agentos-d/**` (call APIs; don't edit the daemon)
- `packages/policy-engine/**` (BackendEngineer)
- `packages/admin-ui/**` (FrontendEngineer)
- `docs/**` (TechnicalWriter)

## Relevant LEARNINGS

- §6 — Repo-boundary violations. These nodes are NEW code for agentworks-os, not modifications to n8n core.
- §16 — Substrate idempotency. Node execution must be idempotent; use deterministic node IDs.


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
