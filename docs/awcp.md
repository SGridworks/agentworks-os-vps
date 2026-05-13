# AgentWorks Compliance Protocol (AWCP)

**Spec version:** awcp/v0.1
**Status:** DRAFT v0.1 — breaking changes allowed until v1.0 stable
**Last updated:** 2026-04-30
**Schema source:** [`packages/shared/src/schema/action.ts`](https://github.com/SGridworks/agentworks-os/blob/v0.1.9/packages/shared/src/schema/action.ts)
**Policy engine types:** [`packages/policy-engine/src/types.ts`](https://github.com/SGridworks/agentworks-os/blob/v0.1.9/packages/policy-engine/src/types.ts)

**Authors:** ComplianceConsultant (prose and legal), TechLead (technical review)

**Sign-off required before v1.0 stable:**
- TechLead confirms technical correctness
- ComplianceConsultant confirms legal accuracy

---

AWCP is the wire format, API surface, and data model that every agent action must map into before the policy engine evaluates it. The policy engine never sees raw provider API calls. It sees a normalized action record.

## 1. Goals and Non-Goals

### Goals

- Normalize every action that could have compliance implications into one schema
- Give operators a readable audit trail of every decision
- Let compliance teams author rules once and have them enforced across all channels
- Make the policy decision process explainable: every block or review-routing cites the specific rule and regulatory authority

### Non-Goals

- AWCP does not enforce rules — it provides the data that the policy engine evaluates
- AWCP does not own CRM integrations, telephony providers, or LLM proxies — adapters normalize those into the schema
- AWCP does not provide per-employee cost attribution (deferred to v1.1)
- AWCP does not support per-employee SSO (deferred to v1.2)

## 2. Canonical Action Schema

Every agent action that crosses the substrate — MCP tool call, n8n node execution, REST API submission, custom adapter invocation — must map into this schema before the policy engine evaluates it.

### Wire Format

```json
{
  "request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "proposed_at": "2026-04-30T14:22:01.000Z",
  "tenant_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "actor": {
    "id": "agent-001",
    "type": "human",
    "label": "Sarah Chen",
    "role": "sales_rep",
    "adapter_key": "salesforce-crm"
  },
  "action_kind": "outbound.sms",
  "payload": {
    "message_body": "Hi, following up on our conversation.",
    "sender_id": "+15551234567",
    "contact_phone": "+15559876543"
  },
  "context": {
    "vault_refs": ["vault:doc/abc123"],
    "conversation_refs": ["conv/xyz789"],
    "project_refs": ["proj/sales-campaign-q2"],
    "raw": {},
    "meta": {}
  },
  "reviewed": false,
  "reviewer_id": null,
  "reviewed_at": null
}
```

### Field-by-Field Semantics

**`request_id`** — UUIDv4. Unique per action submission. Correlates the policy check request with the audit log entry. Must be stable across retries: resubmitting the same action uses the same `request_id`.

**`proposed_at`** — ISO-8601 datetime with timezone. Wall-clock time when the action was submitted for evaluation. Used for time-of-day rule evaluation and audit timestamps.

**`tenant_id`** — UUIDv4. Identifies the organization whose policy applies. The policy engine resolves active rule packs against this ID.

**`actor`** — Who initiated the action.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Internal identifier for the actor — agent ID, user ID, or system service name |
| `type` | `human \| agent \| system` | `human`: end user. `agent`: AI agent. `system`: substrate-internal (scheduler, scanner, etc.) |
| `label` | `string` | Human-readable name for display in audit logs and the admin UI |
| `role` | `string \| undefined` | Optional role label such as `sales_rep` or `support_agent` |
| `adapter_key` | `string \| undefined` | Which adapter originated this action, if any |

**`action_kind`** — Dot-separated lowercase string matching `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$`. Registered values are in the action.kind Registry below. Custom kinds must be registered here before use.

**`payload`** — Action-specific data. Structure varies by `action_kind`. See Payload Structure by action.kind below.

**`context`** — References to external state. Data itself lives in those systems; only refs cross the wire.

| Field | Type | Description |
|---|---|---|
| `vault_refs` | `string[]` | Vault documents referenced by this action |
| `conversation_refs` | `string[]` | Conversation threads this action relates to |
| `project_refs` | `string[]` | Projects this action belongs to |
| `raw` | `Record<string, unknown> \| undefined` | Raw fields from the adapter that don't map to the schema |
| `meta` | `Record<string, unknown>` | Arbitrary metadata attached by the adapter or operator |

**`reviewed`** — `false` until a human reviewer inspects and signs off on this action. Defaults to `false`.

**`reviewer_id`** — UUID of the human reviewer, if any. `null` when `reviewed` is `false`.

**`reviewed_at`** — ISO-8601 datetime when review occurred. `null` when `reviewed` is `false`.

### action.kind Registry

| Kind | Description |
|---|---|
| `outbound.sms` | SMS message sent to a contact |
| `outbound.email` | Email sent to a contact |
| `outbound.call` | Voice call initiated to a contact |
| `outbound.direct_message` | Direct message via messaging platform |
| `lead.generation` | Lead capture or enrichment operation |
| `lead.enrich` | Third-party data appended to a lead record |
| `crm.write` | Record written to CRM or contact database |
| `llm.completion` | LLM API call with prompt content |
| `data.export` | Bulk export of contact or transaction data |
| `data.delete` | Deletion request for contact PII |

New `action_kind` values must be registered in this spec before use. Submit a PR adding the value to this registry.

### Payload Structure by action.kind

**outbound.sms**
```json
{
  "message_body": "string",
  "sender_id": "string",
  "contact_phone": "string"
}
```

**outbound.email**
```json
{
  "subject": "string",
  "body_html": "string | null",
  "body_text": "string",
  "sender_address": "string",
  "recipient_addresses": ["string"],
  "unsubscribe_url": "string"
}
```

**lead.generation**
```json
{
  "source": "string",
  "contact_fields": {},
  "consent_provenance": "string | null"
}
```

**llm.completion**
```json
{
  "prompt_content": "string",
  "system_prompt": "string | null",
  "model": "string"
}
```

## 3. Policy Decision Lifecycle

Every action submitted to the policy engine moves through the same lifecycle:

```
proposed → evaluated → enforced or shadowed
                        ↓
               route_to_review → human decision → override recorded
```

### proposed

The adapter normalizes the raw provider call into an `ActionEnvelope` and submits it to `POST /api/policy/check`. The envelope is at rest in the `proposed` state until the policy engine evaluates it.

### evaluated

The policy engine loads the active rule packs for the `tenant_id`, evaluates each rule in priority order, and returns a `PolicyCheckResponse`.

### enforced vs. shadowed

- **enforce mode**: The API response disposition (`allow`, `block`, `route_to_review`) is authoritative. `block` stops the action. `route_to_review` holds it for human sign-off.
- **shadow mode**: The policy engine logs the decision but does not enforce it. Use shadow mode to test new rule packs without disrupting live traffic.

### route_to_review

When the disposition is `route_to_review`, the action enters the approval queue. A reviewer can:

- **Approve**: set `decision: allow` with written justification — this writes the `override` field into the audit log
- **Reject**: set `decision: block` with written justification — same
- **Send back**: leave `reviewed: false` and return the action to the originating agent for revision and resubmission

Override decisions are logged with reviewer identity, timestamp, and justification. The original rule-pack decision is preserved in the audit log alongside the override record.

## 4. Wire Format

### Transport

JSON over HTTP. The policy check endpoint accepts `Content-Type: application/json`.

```
POST /api/policy/check
```

### Request

```json
{
  "action": { /* ActionEnvelope — Section 2 */ },
  "rule_pack_ids": ["tcpa-starter-pack"],
  "mode": "enforce",
  "tenant_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

| Field | Type | Description |
|---|---|---|
| `action` | `ActionEnvelope` | The action to evaluate |
| `rule_pack_ids` | `string[] \| undefined` | Specific packs to evaluate. Omit to evaluate all active packs for the tenant |
| `mode` | `enforce \| shadow` | `enforce`: apply decisions. `shadow`: log only. Default: `enforce` |
| `tenant_id` | `string (UUID)` | Tenant whose active rule packs apply |

### Response

```json
{
  "request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "decision": "allow",
  "evaluated_at": "2026-04-30T14:22:02.000Z",
  "decisions": [
    {
      "rule_pack_id": "tcpa-starter-pack",
      "rule_pack_version": "1.0.0",
      "rule_id": "tcpa-express-written-consent",
      "decision": "allow",
      "reason": "Express written consent on file for this contact",
      "citation": "47 C.F.R. § 64.1200(a)(2)",
      "data_missing": []
    }
  ],
  "missing_data": [],
  "override": null
}
```

**`decision`** — The overall disposition:
- `allow` if no rule returned `block` or `route_to_review`
- `block` if any rule returned `block`
- `route_to_review` if no rule returned `block` but one or more returned `route_to_review`

**`decisions`** — One entry per rule evaluated, in evaluation order. Rules are evaluated in `priority` ascending order within a pack; packs are evaluated in the order declared in `rule_pack_ids`.

**`missing_data`** — Union of all `data_missing` arrays across evaluated rules. If non-empty and no rule returned `block`, the overall decision is `route_to_review` by default.

**`override`** — Present only when a human reviewer has overridden an earlier decision.

### Error Responses

| HTTP Status | Condition |
|---|---|
| `200 OK` | Evaluation completed (decision may be block or route_to_review) |
| `400 Bad Request` | Malformed action envelope or invalid `rule_pack_ids` |
| `404 Not Found` | Tenant not found |
| `422 Unprocessable Entity` | Action schema version not supported |
| `500 Internal Server Error` | Policy engine internal failure |

On any non-200 response, the substrate must not allow the action to proceed. Treat 4xx as `route_to_review`; treat 5xx as `route_to_review` with a note. System failure is not a pass.

## 5. Examples

### Example: SMS to DNC number — block

```
Agent proposes: outbound.sms to a number on the national DNC registry
Rule: TCPA DNC block — no established business relationship
Disposition: block
```

```json
{
  "request_id": "b9a3c2d1-1111-2222-3333-444455556666",
  "proposed_at": "2026-04-30T09:15:00.000Z",
  "tenant_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "actor": {
    "id": "agent-outbound-01",
    "type": "agent",
    "label": "Outbound Agent",
    "role": "outbound_scheduler",
    "adapter_key": "twilio"
  },
  "action_kind": "outbound.sms",
  "payload": {
    "message_body": "Hi, just following up on your inquiry.",
    "sender_id": "+15551234567",
    "contact_phone": "+15550001111"
  },
  "context": {
    "vault_refs": [],
    "conversation_refs": ["conv/lead-12345"],
    "project_refs": ["proj/outbound-q2"],
    "raw": {},
    "meta": {}
  },
  "reviewed": false,
  "reviewer_id": null,
  "reviewed_at": null
}
```

Policy engine response:
```json
{
  "request_id": "b9a3c2d1-1111-2222-3333-444455556666",
  "decision": "block",
  "evaluated_at": "2026-04-30T09:15:01.000Z",
  "decisions": [
    {
      "rule_pack_id": "tcpa-starter-pack",
      "rule_pack_version": "1.0.0",
      "rule_id": "tcpa-dnc-block",
      "decision": "block",
      "reason": "Contact phone number is registered on the national DNC registry. No established business relationship exemption applies.",
      "citation": "47 C.F.R. § 64.1200(c)",
      "data_missing": []
    }
  ],
  "missing_data": [],
  "override": null
}
```

### Example: Email to opted-in lead — allow

```
Agent proposes: outbound.email to a contact with verified written consent on file
Rule: TCPA express written consent — contact has signed consent record
Disposition: allow
```

```json
{
  "request_id": "c8b4d3e2-aaaa-bbbb-cccc-555566667777",
  "proposed_at": "2026-04-30T10:00:00.000Z",
  "tenant_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "actor": {
    "id": "user-002",
    "type": "human",
    "label": "Marcus Johnson",
    "role": "account_executive",
    "adapter_key": "hubspot-crm"
  },
  "action_kind": "outbound.email",
  "payload": {
    "subject": "Your demo follow-up",
    "body_html": "<p>Thanks for attending...</p>",
    "body_text": "Thanks for attending...",
    "sender_address": "marcus@acme.com",
    "recipient_addresses": ["prospect@company.com"],
    "unsubscribe_url": "https://acme.com/unsubscribe/xyz"
  },
  "context": {
    "vault_refs": ["vault:doc/demo-notes-456"],
    "conversation_refs": ["conv/demo-2026-04-28"],
    "project_refs": ["proj/acme-pilot"],
    "raw": {},
    "meta": {}
  },
  "reviewed": false,
  "reviewer_id": null,
  "reviewed_at": null
}
```

Policy engine response:
```json
{
  "request_id": "c8b4d3e2-aaaa-bbbb-cccc-555566667777",
  "decision": "allow",
  "evaluated_at": "2026-04-30T10:00:01.000Z",
  "decisions": [
    {
      "rule_pack_id": "tcpa-starter-pack",
      "rule_pack_version": "1.0.0",
      "rule_id": "tcpa-express-written-consent",
      "decision": "allow",
      "reason": "Express written consent verified for this contact and action kind",
      "citation": "47 C.F.R. § 64.1200(a)(2)",
      "data_missing": []
    }
  ],
  "missing_data": [],
  "override": null
}
```

### Example: High-risk channel without consent record — route_to_review

```
Agent proposes: outbound.call to a new contact via a high-risk channel
Rule: TCPA consent required — no consent record on file
Disposition: route_to_review
```

```json
{
  "request_id": "d7e5f4a3-8888-9999-aaaa-666677778888",
  "proposed_at": "2026-04-30T11:30:00.000Z",
  "tenant_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "actor": {
    "id": "agent-outbound-02",
    "type": "agent",
    "label": "Outbound Dialer",
    "role": "telemarketing_agent",
    "adapter_key": "twilio"
  },
  "action_kind": "outbound.call",
  "payload": {
    "caller_id": "+15551234567",
    "contact_phone": "+15552223333",
    "dialer_type": "predictive"
  },
  "context": {
    "vault_refs": [],
    "conversation_refs": [],
    "project_refs": ["proj/cold-outreach-may"],
    "raw": {},
    "meta": {}
  },
  "reviewed": false,
  "reviewer_id": null,
  "reviewed_at": null
}
```

Policy engine response:
```json
{
  "request_id": "d7e5f4a3-8888-9999-aaaa-666677778888",
  "decision": "route_to_review",
  "evaluated_at": "2026-04-30T11:30:01.000Z",
  "decisions": [
    {
      "rule_pack_id": "tcpa-starter-pack",
      "rule_pack_version": "1.0.0",
      "rule_id": "tcpa-consent-required",
      "decision": "route_to_review",
      "reason": "No consent record found for this contact and action kind. Predictive dialer is a high-risk channel under TCPA.",
      "citation": "47 C.F.R. § 64.1200(a)(1)",
      "data_missing": ["consent.status", "consent.record_ref"]
    }
  ],
  "missing_data": ["consent.status", "consent.record_ref"],
  "override": null
}
```

## 6. AWCP Versioning Policy

### Version Lifecycle

| Stage | Version pattern | Breaking changes | Stability |
|---|---|---|---|
| Draft | `v0.N` | Allowed without notice | Internal — do not implement against |
| Stable | `v1.N` | Prohibited within major version | Public — implementers may adopt |
| Deprecated | `v1.N` (marked deprecated) | Prohibited | Sunset in 6 months |
| Retired | Removed | N/A | Do not use |

### v0.1 Draft Posture

AWCP v0.1 is a draft. It reflects the design decisions locked in PLAN.md as of 2026-04-27. It is:

- Intended for internal review and early implementer feedback
- Subject to breaking changes without a deprecation notice
- Not stable enough for external implementers to build against

The protocol advances to v1.0 stable when one of the following is true:

- External implementer #1 commits to adoption (signs the AWCP implementer agreement)
- Six months of customer learning from v1 production use (2026-10-25)

### Change Classification

**Breaking changes** (require major version bump):
- Removal of any field from the `ActionEnvelope`
- Changes to field types in the `ActionEnvelope`
- New required fields in the `ActionEnvelope`
- Changes to the decision values (`allow`/`block`/`route_to_review`)
- Changes to the hash algorithm or hash chain structure
- Removal of any API endpoint

**Non-breaking additions** (minor version bump):
- New optional fields in the `ActionEnvelope`
- New `action_kind` values
- New optional fields in request/response
- New fields in rule pack manifest
- New test fixture types

**Clarifications** (patch version bump):
- Documentation improvements that do not change behavior
- Corrections to examples that did not match spec
- Typo fixes in field names or enum values

### Version Announcement

Version changes are announced via:
1. GitHub release on the agentworks-os repository
2. Entry in `CHANGELOG-AWCP.md`
3. Notification to all registered implementers

### Implementer Registration

External implementers who build against AWCP should register with SGridworks. Registration is non-binding but ensures notification of version changes. To register, open a GitHub issue titled `[AWCP Implementer] <your organization name>`.

SGridworks will not ship a "Powered by AWCP" badge until at least one external implementer signs on.

---

## Appendix: Disposition Reference

The policy engine returns one of three dispositions:

| Disposition | Meaning | What happens |
|---|---|---|
| `allow` | All rules passed or no rules targeted this action kind | Action proceeds |
| `block` | At least one rule returned `block` | Action is stopped; audit log entry created with `decision: block` |
| `route_to_review` | No `block` returned but at least one rule requires human review, or required data is missing | Action is held; assigned reviewer must approve, reject, or send back |

## Appendix: action_kind Format Rule

Every `action_kind` value must match this regular expression:

```
^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$
```

This means:
- At least one dot (e.g., `outbound.sms`)
- No uppercase, no underscores, no leading digits
- Each segment starts with a lowercase letter and may be followed by digits

Valid: `outbound.sms`, `crm.write`, `lead.enrich_v2` (segments can contain digits after the first char)
Invalid: `OutboundSMS`, `outbound-sms`, `sms`, `lead..enrich`
