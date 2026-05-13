# AgentWorks `packages/policy-engine`

YAML rule pack loader, evaluator, and shadow-mode execution engine. Consumes rule packs authored by ComplianceConsultant, evaluates proposed actions against tenant policy, and emits allow / block / route_to_review decisions with evidence hashes.

## Your lane

- **TechLead** (escalated) — `^packages/policy-engine/`
- **BackendEngineer** — `^packages/policy-engine/` (implementation of loader + evaluator)

Architecture decisions (schema changes, new decision types, evaluator sequencing) require TechLead RFC sign-off. Routine implementation (loader bug fixes, evaluator performance) is BackendEngineer's lane.

## Public API surface

Other packages may import:

- `src/evaluator.ts` — `evaluateAction(proposedAction, context)` → `PolicyDecision`
- `src/loader.ts` — `loadRulePack(tenantId, packPath)` → `RulePack`
- `src/shadow.ts` — `shadowEvaluate(...)` — logs decision without enforcing
- `src/types.ts` — `PolicyDecision`, `RulePack`, `EvidenceItem` interfaces

Do NOT import UI concerns or HTTP handlers into this package. It is pure business logic.

## Do not edit

- `rule-packs/**` (ComplianceConsultant owns YAML content)
- `packages/admin-ui/**` (FrontendEngineer)
- `packages/scanner-worker/**` (PythonEngineer)
- `docs/awcp.md` without ComplianceConsultant sign-off

## Relevant LEARNINGS

- §4 — Schema drift without migrations. New decision fields need a DB migration in agentos-d.
- §15 — Cross-cutting destructive edits + silent peer-review skip. Policy engine changes affect every tenant; get review.
- §17 — Auto-commit + off-scope work = noise. Don't let unrelated fixes creep into policy-engine commits.


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
