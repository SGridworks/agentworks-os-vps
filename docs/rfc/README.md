# RFCs — Internal Architecture Decision Records

These RFCs are **internal architecture documents** for the engineers building AgentWorks OS. They are not customer documentation.

RFCs in this folder may reference upstream substrate origins (paperclip, vault patterns) where it helps the reader understand a design decision. Customer-facing docs (`README.md`, `docs/install-runbook.md`, `docs/rule-pack-authoring.md`, `docs/awcp.md`, etc.) do not reference upstream projects — see `agents/_shared/STANDALONE-PRODUCT-DOCS.md`.

If you are reading this as a customer or integrator: you probably want `docs/awcp.md` (the wire-format specification) instead.

## Index

- `001-canonical-action-schema.md` — wire format for agent actions
- `002-policy-decision-data-model.md` — policy decision shape and hash chain
- `003-scanner-worker-api-contract.md` — TS ↔ Python sidecar HTTP contract
- `004-contracts-gap-analysis.md` — gaps and follow-ups identified during 001-003
- `007-agent-org-chart.md` — AgentWorks agent org chart and reportsTo structure
- `008-workflow-discipline-processwatcher-auto-assign.md` — ProcessWatcher detection + Auto-Assign router prevention
