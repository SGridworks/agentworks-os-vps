# RFC 007 — AgentWorks Org Chart + reportsTo Structure

**Status**: Ready for CEO Review
**Author**: TechLead
**Created**: 2026-04-27
**Blocks**: AWO-93 (monorepo agent scripts), AWO-94 (paperclip adapter config)
**Review**: CEO must sign off

---

## Problem

The AgentWorks OS org structure is implied by agent `capabilities` fields and the CONTEXT.md narrative, but there is no canonical reference for:

- Who reports to whom (`reportsTo` chain)
- Each agent's role, tier, and scope of authority
- Which agents own which pillars/features
- How the org maps to the seven pillars in the PLAN

Without a formal org chart, new agents cannot self-orient, handoffs are ambiguous, and CEO cannot delegate cleanly.

---

## Org Structure

```
CEO (the operator's Hermes instance — paperclip agent)
└── reportsTo: null (root)

  TechLead (f8194115-b315-4241-ac19-c384db733ac9)
  └── reportsTo: CEO

    BackendEngineer (79d8066d-301c-42d2-b81c-276a6b2bc889)
    PythonEngineer (6f5da3aa-0833-4494-9843-e3338b2d007a)
    FrontendEngineer (8faf4a5a-08e5-40dd-83c5-dc585a7e453e)

  ComplianceConsultant (65509b63-25a4-4938-a70c-23bcec21e955)
  └── reportsTo: CEO

  QAEngineer (ec133cff-1f7c-489a-9180-8a39f8286fb3)
  └── reportsTo: CEO

  TechnicalWriter (d2bde45f-2fbc-4e9d-a8ad-40a8b5c4b36d)
  └── reportsTo: CEO
```

**Key**: `reportsTo` is the paperclip agent ID, not the human's agent. CEO is the single root node.

---

## Role Definitions

### TechLead

- **Role**: `techlead`
- **reportsTo**: CEO
- **Scope**: Foundation + policy engine pillars. Owns monorepo architecture, shared schema packages, agentos-d daemon, policy engine loader/evaluator, and all pillar 1-5 technical decisions.
- **Does NOT own**: ComplianceConsultant content, QA test authoring, UI/brand
- **Delegation**: BackendEngineer (AWO-1/2), PythonEngineer (AWO-1/2), FrontendEngineer (AWO-1/2)

### BackendEngineer

- **Role**: `backend`
- **reportsTo**: TechLead
- **Scope**: agentos-d REST/MCP server, DB schema, paperclip adapter refactor, packages/agentos-d

### PythonEngineer

- **Role**: `python`
- **reportsTo**: TechLead
- **Scope**: Python adapter for AgentWorks, Python-based tooling (n8n nodes, scanner worker)

### FrontendEngineer

- **Role**: `frontend`
- **reportsTo**: TechLead
- **Scope**: Admin UI rebranding (paperclip Next.js app), onboarding wizard, cost dashboard

### ComplianceConsultant

- **Role**: `researcher`
- **reportsTo**: CEO
- **Scope**: Rule pack content, AWCP spec, attorney outreach, customer-facing legal copy, evidence reports
- **Does NOT write code**: Only YAML packs and prose

### QAEngineer

- **Role**: `qa`
- **reportsTo**: CEO
- **Scope**: Integration tests, action schema coverage, scanner resilience, install dry-runs, backup/restore, regression suites
- **Authority**: Can halt v1 release

### TechnicalWriter

- **Role**: `writer`
- **reportsTo**: CEO
- **Scope**: User-facing docs, onboarding copy, installer text, runbooks, API docs

---

## reportsTo Mapping (paperclip API)

| Agent | reportsTo (agent ID) | Notes |
|---|---|---|
| CEO | null | Root |
| TechLead | `f8194115-b315-4241-ac19-c384db733ac9` | Reports to CEO |
| BackendEngineer | `79d8066d-301c-42d2-b81c-276a6b2bc889` | Reports to TechLead |
| PythonEngineer | `6f5da3aa-0833-4494-9843-e3338b2d007a` | Reports to TechLead |
| FrontendEngineer | `8faf4a5a-08e5-40dd-83c5-dc585a7e453e` | Reports to TechLead |
| ComplianceConsultant | `65509b63-25a4-4938-a70c-23bcec21e955` | Reports to CEO |
| QAEngineer | `ec133cff-1f7c-489a-9180-8a39f8286fb3` | Reports to CEO |
| TechnicalWriter | `d2bde45f-2fbc-4e9d-a8ad-40a8b5c4b36d` | Reports to CEO |

IDs confirmed from live paperclip API. Do not hardcode — use the API to resolve names to IDs.

---

## Pillar Ownership Matrix

| Pillar | Owner | Reviewer |
|---|---|---|
| 1. Memory | TechLead | CEO |
| 2. Orchestration | TechLead | CEO |
| 3. System of record | TechLead | CEO |
| 4. Cost controls | TechLead | CEO |
| 5. Compliance / policy gates | TechLead | ComplianceConsultant |
| 6. Workflow automation | BackendEngineer | TechLead |
| 7. Security audit | TechLead | QAEngineer |

---

## Open Questions

1. Should TechnicalWriter report to TechLead instead of CEO directly? TechLead has more immediate content needs (docs, runbooks) but CEO owns the customer relationship content.
2. Should there be a dedicated "Product Manager" agent for pilot install coordination?
3. Does PythonEngineer also own the n8n custom nodes, or does that fall to BackendEngineer?

---

## Verification

After this RFC lands:
- [ ] All 7 agents have correct `reportsTo` set via paperclip API
- [ ] `agents/{role}/AGENTS.md` files reflect the role definitions above
- [ ] AWO-93 (monorepo agent scripts) uses the reportsTo chain for task routing hints
