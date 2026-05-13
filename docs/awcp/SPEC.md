# AgentWorks Compliance Protocol (AWCP) — v0.1 Draft

**Status:** DRAFT v0.1 — breaking changes allowed until v1.0 stable
**Authors:** ComplianceConsultant (prose), TechLead (technical review)
**Last updated:** 2026-04-27
**Spec version:** awcp/v0.1

**Technical review note:** Resolved discrepancies vs RFC 001/002 (TechLead, 2026-04-27):
- `actor.name` renamed to `actor.label` throughout — RFC 001 is authoritative.
- `action` object wrapper removed; fields are top-level in the wire format — RFC 001 is authoritative.
- `system` added to actor type enum — required for substrate-internal actions (scheduler, cron, scanner).
- Wire format now matches RFC 001 `ActionEnvelope` exactly. Policy check request/response aligns with RFC 002 `PolicyDecision`.

---

This document specifies the wire formats, API surfaces, and data models the AgentWorks policy engine evaluates against. It is a specification, not an implementation guide. The reference implementation is owned by TechLead and BackendEngineer.

## Table of Contents

1. [Canonical Action Schema](#1-canonical-action-schema) — wire format for all agent actions
2. [Policy Check Request/Response](#2-policy-check-requestresponse) — the evaluate endpoint
3. [Audit Log Entry Format](#3-audit-log-entry-format) — append-only decision record
4. [Rule Pack Manifest Format](#4-rule-pack-manifest-format) — pack metadata and versioning
5. [AWCP Versioning Policy](#5-awcp-versioning-policy) — how the spec evolves

---

## 1. Canonical Action Schema

**Spec section:** AWO-92
**Owner:** ComplianceConsultant (prose), TechLead (technical correctness)
**Status in PLAN.md:** Locked as blocker for policy engine

### Overview

Every agent action that crosses the substrate — MCP tool call, n8n node execution, REST API submission, custom adapter invocation — must map into this schema before the policy engine evaluates it. The policy engine never sees raw provider API calls. It sees a normalized action record.

### Wire Format

```json
{
  "request_id": "uuid-v4",
  "proposed_at": "ISO-8601 datetime with timezone",
  "tenant_id": "uuid-v4",
  "actor": {
    "id": "uuid-v4 | string",
    "type": "agent | human | system",
    "label": "string",
    "role": "string | null",
    "adapter_key": "string | null"
  },
  "action_kind": "string",
  "payload": { },
  "context": {
    "vault_refs": ["string"],
    "conversation_refs": ["string"],
    "project_refs": ["string"],
    "raw": { },
    "meta": { }
  },
  "contact": {
    "id": "uuid-v4 | null",
    "type": "person | business",
    "label": "string",
    "address": "string"
  },
  "channel": "sms | email | voice | chat | api | crm | other | null",
  "jurisdiction": "string | null",
  "consent": {
    "status": "verified | unverified | none",
    "source": "written | verbal | inferred | none | unknown",
    "captured_at": "ISO-8601 datetime | null",
    "captured_by": "string | null",
    "record_ref": "string | null",
    "verified": "boolean",
    "scope": ["string"],
    "expires_at": "ISO-8601 datetime | null"
  },
  "metadata": {
    "reviewed": "boolean",
    "reviewer_id": "uuid-v4 | null",
    "reviewed_at": "ISO-8601 datetime | null"
  }
}
```

### `action.kind` Registry

| Value | Description |
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

New `action.kind` values must be registered in the AWCP spec before use. Submit a PR to this document adding the value to the registry.

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
  "contact_fields": { },
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

### Required Data vs. Optional Data

Every action schema field is either **required** or **optional**. Required fields are present in all action records of that kind. Optional fields may be absent; the policy engine treats missing optional fields as `null`.

Rules declare which fields they require via `required_data` declarations. If a rule requires a field that is `null` in the action record, the rule's `disposition_when_missing` applies.

### Schema Versioning

Schema changes are versioned under `awcp/vX.Y`. The schema version appears in every action record's `metadata.schema_version` field.

Breaking changes — field removal, type changes, new required fields — increment the major version. Additive changes — new optional fields, new `action.kind` values — increment the minor version.

The substrate must support action records at the schema version they declare. Down-level compatibility is the responsibility of the adapter, not the policy engine.

---

## 2. Policy Check Request/Response

**Spec section:** AWO-93
**Owner:** ComplianceConsultant (prose), TechLead (technical review)
**Status:** Aligned with PLAN.md locked policy decision data model

### Policy Check Endpoint

```
POST /api/policy/check
Content-Type: application/json
```

### Request

```json
{
  "action": { /* Canonical Action Schema — Section 1 */ },
  "rule_pack_ids": ["string"],
  "mode": "enforce | shadow",
  "tenant_id": "uuid-v4"
}
```

**`rule_pack_ids`** — list of active rule pack IDs to evaluate against. If omitted, all active packs for the tenant are applied.

**`mode`** — `enforce` (apply decisions) or `shadow` (log decisions without blocking). Default: `enforce`.

### Response

```json
{
  "request_id": "uuid-v4",
  "decision": "allow | block | route_to_review",
  "evaluated_at": "ISO-8601 datetime with timezone",
  "decisions": [
    {
      "rule_pack_id": "string",
      "rule_pack_version": "string",
      "rule_id": "string",
      "decision": "allow | block | route_to_review",
      "reason": "string",
      "citation": "string | null",
      "data_missing": ["string"]
    }
  ],
  "missing_data": ["string"],
  "override": null | {
    "applied": true,
    "reviewer_id": "uuid-v4",
    "justification": "string"
  }
}
```

**`decision`** — the overall decision:
- `allow` if no rule returned `block` or `route_to_review`
- `block` if any rule returned `block`
- `route_to_review` if no rule returned `block` but one or more returned `route_to_review`

**`decisions`** — one entry per rule evaluated, in evaluation order. Rules are evaluated in `priority` order within a pack; packs are evaluated in the order declared in `rule_pack_ids`.

**`missing_data`** — union of all `data_missing` arrays across evaluated rules. If non-empty and no rule returned `block`, the overall decision is `route_to_review` by default (unless the rule pack overrides this).

**`override`** — present only when a human reviewer has overridden an earlier decision. The override replaces the original decision for audit purposes.

### Override Flow

A `route_to_review` decision places the action in the approval queue. A reviewer can:

- **Approve**: set `decision: allow` with justification
- **Reject**: set `decision: block` with justification
- **Send back**: request the originating agent revise and resubmit

Override decisions are logged with reviewer identity, timestamp, and written justification. The original rule-pack decision is preserved in the audit log alongside the override record.

### Error Responses

| HTTP Status | Condition |
|---|---|
| `200 OK` | Evaluation completed (decision may be block/route_to_review) |
| `400 Bad Request` | Malformed action schema or invalid rule_pack_ids |
| `404 Not Found` | Tenant not found |
| `422 Unprocessable Entity` | Action schema version not supported |
| `500 Internal Server Error` | Policy engine internal failure |

On any non-200 response, the substrate must not allow the action to proceed. The appropriate disposition is `route_to_review` for 4xx errors and `route_to_review` with a note for 5xx errors. System failure is not a pass.

---

## 3. Audit Log Entry Format

**Spec section:** AWO-94
**Owner:** ComplianceConsultant (prose), TechLead (technical review)
**Status:** Aligned with PLAN.md locked policy decision data model

### Overview

Every action evaluated by the policy engine produces one audit log entry. Entries are append-only and hash-chained for tamper evidence. Entries are retained for the tenant-configured retention period (default: 30 days, configurable up to 365 days).

### Entry Format

```json
{
  "entry_id": "uuid-v4",
  "request_id": "uuid-v4",
  "tenant_id": "uuid-v4",
  "actor": {
    "id": "string",
    "type": "agent | human"
  },
  "contact": {
    "id": "uuid-v4 | null",
    "channel": "string"
  },
  "action_kind": "string",
  "decision": "allow | block | route_to_review",
  "decisions": [
    {
      "rule_pack_id": "string",
      "rule_pack_version": "string",
      "rule_id": "string",
      "rule_pack_name": "string",
      "rule_name": "string",
      "decision": "allow | block | route_to_review",
      "reason": "string",
      "citation": "string | null",
      "data_missing": ["string"]
    }
  ],
  "missing_data": ["string"],
  "mode": "enforce | shadow",
  "override": null | {
    "reviewer_id": "uuid-v4",
    "reviewer_name": "string",
    "original_decision": "allow | block | route_to_review",
    "override_decision": "allow | block | route_to_review",
    "justification": "string",
    "decided_at": "ISO-8601 datetime with timezone"
  },
  "hash": "string",
  "previous_hash": "string",
  "logged_at": "ISO-8601 datetime with timezone"
}
```

### Hash Chain

`hash` is computed over: `entry_id + request_id + tenant_id + actor.id + action_kind + decision + decisions + missing_data + override + previous_hash + logged_at`.

The algorithm is SHA-256. The hash of the first entry in a chain uses a tenant-specific seed value as `previous_hash`.

`previous_hash` is the `hash` of the most recent prior entry for the same tenant. This creates a forward chain that can be verified by re-computing hashes in order.

Detection of a broken chain surfaces as a flag in the admin UI and in the Compliance Evidence Report. The system of record remains authoritative. The hash chain provides evidence of tampering, not replacement.

### Retention

Entries are retained for the configured period and then purged. Purge is a hard delete. For long-term retention, export to cold storage via the CSV export endpoint before the retention window closes.

### Export

```
GET /api/audit-log/export?tenant_id=<uuid>&from=<ISO-8601>&to=<ISO-8601>&format=csv
```

Returns all entries within the date range for the specified tenant. The export includes the full entry payload and is suitable for ingestion by external compliance tooling.

---

## 4. Rule Pack Manifest Format

**Spec section:** AWO-95
**Owner:** ComplianceConsultant (prose), TechLead (technical review)
**Status:** Draft — pending YAML schema finalization

### Manifest Structure

Every rule pack ships with a manifest that declares its identity, authorship, and data requirements.

```json
{
  "pack_id": "string",
  "pack_version": "semver string",
  "pack_name": "string",
  "pack_description": "string",
  "schema_version": "awcp/v0.1",
  "tier": "free | paid | attorney-reviewed",
  "credentialed_by": "string",
  "attorney_reviewed": false | true,
  "attorney_name": "string | null",
  "attorney_engagement_letter_on_file": false | true,
  "jurisdiction": ["string"],
  "industry": ["string | null"],
  "target_action_kinds": ["string"],
  "required_data_declarations": [
    {
      "field": "string",
      "description": "string",
      "data_provider": "substrate | customer_integration | external_api"
    }
  ],
  "missing_data_disposition": "allow | block | route_to_review",
  "rules": [
    {
      "rule_id": "string",
      "name": "string",
      "description": "string",
      "required_data": ["string"],
      "disposition_when_missing": "allow | block | route_to_review",
      "priority": "integer",
      "conditions": [
        {
          "when": { },
          "then": {
            "decision": "allow | block | route_to_review",
            "reason": "string",
            "citation": "string | null"
          }
        }
      ]
    }
  ],
  "test_fixtures": [
    {
      "name": "string",
      "input": { },
      "expected": {
        "decision": "allow | block | route_to_review",
        "rule_id": "string | null"
      }
    }
  ],
  "changelog": [
    {
      "version": "semver",
      "date": "ISO-8601 date",
      "changes": "string"
    }
  ]
}
```

### Tier Definitions

| Tier | Description | Credentialing |
|---|---|---|
| `free` | Generic SMB starter pack. Not tailored to any industry or regulation. | SGridworks |
| `paid` | Industry-specific pack built by SGridworks or partners. Not yet attorney-reviewed. | SGridworks |
| `attorney-reviewed` | Industry-specific pack reviewed and signed off by a named attorney. Engagement letter on file. | Named attorney + SGridworks |

The `attorney_reviewed: true` flag is only set when:
1. A signed engagement letter is on file with the attorney's name
2. The attorney has reviewed the rule definitions in writing
3. Both are recorded in the pack metadata

SGridworks ships the `free` and `paid` tier packs. Attorney-reviewed packs are a commercial tier above `paid`.

### Data Provider Declaration

`required_data_declarations` tells the operator what data the pack needs and where it should come from:

| Value | Meaning |
|---|---|
| `substrate` | The substrate provides this data (e.g., `actor.type`, `action_kind`) |
| `customer_integration` | The customer must configure their own data source via the adapter pattern |
| `external_api` | An external API (Twilio, RealPhoneValidation, etc.) must be integrated |

The substrate's adapter pattern is the mechanism for connecting external data sources. Pack authors should not assume any specific provider.

### Rule Evaluation Order

Rules within a pack are evaluated in `priority` ascending order (1 is evaluated before 10). The first rule that returns `block` or `route_to_review` terminates evaluation for that pack. Earlier `allow` decisions do not prevent later rules from running.

Multiple packs are evaluated in the order declared in the policy check request.

---

## 5. AWCP Versioning Policy

**Spec section:** AWO-96
**Owner:** ComplianceConsultant (prose), TechLead (technical review)
**Status:** Draft

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
- Removal of any field from the canonical action schema
- Changes to field types in the action schema
- New required fields in the action schema
- Changes to the decision values (allow/block/route_to_review)
- Changes to the hash algorithm or hash chain structure
- Removal of any API endpoint

**Non-breaking additions** (minor version bump):
- New optional fields in the action schema
- New `action.kind` values
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

## Appendix: Regulatory Citations

This section records the primary legal authorities that informed the rule definitions in this spec. It is not exhaustive and does not constitute legal advice.

| Regulation | Citation | Covers |
|---|---|---|
| TCPA | 47 U.S.C. § 227; 47 C.F.R. § 64.1200 | Automated telephone calls, SMS, do-not-call |
| Fair Housing Act | 42 U.S.C. § 3601 et seq. | Discrimination in housing-related marketing |
| CAN-SPAM | 15 U.S.C. § 7704 | Commercial email unsubscribe requirements |
| ECOA | 15 U.S.C. § 1691 et seq. | Discrimination in credit transactions |
| COPPA | 15 U.S.C. § 6501 et seq. | Data collection from minors |
| CCPA | Cal. Civ. Code § 1798.100 et seq. | Consumer data rights |
| State DNC laws | Varies by state | State-level do-not-call registries |
| Reassigned Numbers Database | FCC Order 12-21 | Phone number reassignment detection |

Rule pack authors should consult the current version of each regulation before authoring or updating rules. Regulations change; this spec does not automatically track regulatory updates.
