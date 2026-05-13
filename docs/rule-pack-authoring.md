# Rule Pack Authoring Guide

A rule pack is a YAML file that declares compliance rules the policy engine evaluates. Each pack is self-contained: rule definitions, metadata, required-data declarations, and test fixtures all live in one file.

The policy engine evaluates every action against active rule packs and returns `allow`, `block`, or `route_to_review`.

This guide covers the YAML schema, how to write rules, how to validate a pack, and the most common mistakes.

**Reference implementation:** `rule-packs/smb-starter/smb-starter-v0.1.yaml`

---

## Pack Structure

```yaml
schema_version: "awcp/v0.1"     # AWCP schema version — must match this exact string
pack_id: "my-pack"              # unique identifier (kebab-case, stable across versions)
pack_version: "0.1.0"          # semver
pack_name: "My Pack"            # human-readable name
pack_description: |             # longer description for the admin UI
  One or more paragraphs.
tier: free | paid | attorney-reviewed
credentialed_by: "SGridworks"   # or attorney name for attorney-reviewed packs
attorney_reviewed: false        # true only when engagement letter on file
missing_data_disposition: allow | block | route_to_review  # default when required data absent

rules:
  - rule_id: MY-RULE-001
    name: "Human-readable rule name"
    description: |
      What this rule does and why.
    required_data:
      - field_name              # fields this rule needs from the action record
    disposition_when_missing: allow | block | route_to_review
    conditions:
      - when:                   # condition block — all keys must match for rule to fire
          field_name: value     # value or list of values
          another_field: [val1, val2]
        then:
          decision: allow | block | route_to_review
          reason: "Explanation shown to the actor or reviewer"
          citation: "47 U.S.C. § 227" | "Internal policy" | null
```

---

## Fields Reference

### pack_id

Stable unique identifier. Once published, never change this. The system uses it to track which packs are active in logs and reports. Use kebab-case.

### pack_version

Semver. Increment:
- **patch** — rule logic unchanged, bug fix in description or test fixture
- **minor** — new rules added, old rules removed, or rule logic changed
- **major** — breaking structural change to the pack

### tier

| Value | Credentialing | Ships with |
|---|---|---|
| `free` | SGridworks | AgentWorks OS free tier |
| `paid` | SGridworks | Commercial rule pack library |
| `attorney-reviewed` | Named attorney + SGridworks | Requires signed engagement letter |

`attorney_reviewed: true` is only set when:
1. A signed engagement letter is on file with the attorney's name
2. The attorney has reviewed the rule definitions in writing
3. Both are recorded in pack metadata

### missing_data_disposition

Default disposition when a rule's `required_data` fields are absent from the action record. Applied per-rule via `disposition_when_missing`, but can be overridden at pack level as a fallback.

---

## Writing Rules

### Anatomy of a Rule

```yaml
- rule_id: MY-001
  name: "Block SMS to DNC numbers"
  description: |
    Blocks outbound SMS to numbers on the internal do-not-call list.
    Does not replace external DNC registry checks.
  required_data:
    - contact_id
    - dnc_status
  disposition_when_missing: route_to_review
  conditions:
    - when:
        dnc_status: true
      then:
        decision: block
        reason: "Contact is on internal do-not-call list"
        citation: "Internal policy"
```

### required_data

Lists the fields this rule needs from the action record. If any listed field is `null` or absent, `disposition_when_missing` applies instead of evaluating conditions.

Field names match keys in the action record's `payload` and top-level objects (`actor`, `contact`, `consent`). Use dot-notation for nested fields: `consent.source`.

Common fields:
- `action_kind` — the action type (e.g., `outbound.sms`, `lead.generation`)
- `contact_id` — internal ID of the target contact
- `dnc_status` — boolean, whether contact is on internal DNC list
- `consent.status` — `verified`, `unverified`, or `none`
- `consent.source` — where consent came from: `written`, `verbal`, `inferred`, `none`, `unknown`
- `consent.captured_at` — ISO-8601 datetime when consent was captured
- `subscription_status` — `subscribed`, `unsubscribed`, `none`
- `target_jurisdiction` — US state code or `federal`
- `payload.contact.address` — phone number or email address
- `message_body` — SMS or email body text
- `offer_type` — `financial`, `insurance`, `health`, `legal`, `housing`
- `geographic_scope` — `census_tract`, `zip_code`, `city`, `county`, `state`
- `targeting_criteria` — structured object describing who the action targets
- `contact_age` — integer, if known
- `contact_age_known` — boolean

### conditions

A list of condition blocks. All top-level keys in a `when` block must match the action record for the `then` block to fire.

**Matching semantics:**
- Boolean: `true` or `false` literal
- String: exact match, or use a list for "matches any of"
- List: matches if the field value is in the list
- `null`: matches if the field is absent or `null`

**Example: multiple values**

```yaml
conditions:
  - when:
      action_kind: ["outbound.sms", "outbound.email", "outbound.call"]
    then:
      decision: block
      reason: "No outreach without verified consent"
      citation: "47 U.S.C. § 227"
```

**Example: negation via non-match**

```yaml
conditions:
  - when:
      consent.verified: false
    then:
      decision: block
      reason: "Consent not verified"
      citation: "TCPA, 47 U.S.C. § 227"
```

### disposition_when_missing

Applied when any `required_data` field is `null` or absent. Overrides condition evaluation entirely. The rule fires with this disposition and does not evaluate `conditions`.

### Priority

Rules are evaluated in priority order (lowest number first). The first rule that returns `block` or `route_to_review` terminates evaluation for that pack.

Default priority is 100. Explicit priorities are recommended when rule order matters:

```yaml
- rule_id: MY-EARLY
  priority: 1
  ...
- rule_id: MY-LATE
  priority: 10
  ...
```

---

## Action Kinds

Every action has a `kind` field that identifies what type of action it is. Rule packs declare which action kinds they apply to via `target_action_kinds` in the manifest.

Common action kinds:

| Kind | Triggers when |
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

New `action.kind` values must be registered in the AWCP spec before use.

---

## Test Fixtures

Every pack should include test fixtures: known-input and expected-output pairs that verify the pack behaves as intended.

```yaml
test_fixtures:
  - name: "DNC contact — should block"
    input:
      action_kind: "outbound.email"
      contact_id: "contact-001"
      dnc_status: true
      message_body: "Hi, we noticed your property is listed..."
    expected:
      decision: block
      rule_id: "SMB-001"
```

Run fixtures:

```bash
agentworks pack dry-run rule-packs/smb-starter/smb-starter-v0.1.yaml --fixture="DNC contact — should block"
```

Or run all fixtures:

```bash
agentworks pack dry-run rule-packs/smb-starter/smb-starter-v0.1.yaml --all
```

**Fixture naming convention:** `<scenario> — <expected decision>`

---

## Validating a Pack

Before loading a pack, validate it:

```bash
agentworks pack validate /path/to/pack.yaml
```

Validation checks:
- YAML syntax
- Required fields present (`pack_id`, `pack_version`, `rules`)
- `tier` is a valid value
- `attorney_reviewed` is boolean
- Each rule has `rule_id`, `name`, `conditions`, and valid `disposition_when_missing`
- Each condition's `when` block uses supported operators
- Each `then` block has valid `decision` value
- `test_fixtures` (if present) have valid `input` and `expected` shapes

A pack that passes validation still might not do what you intended. Read the output.

---

## Loading and Modes

### Loading a Pack

Loading and mode switching are done through the REST API. You can also use
**Policy > Rule Packs > Add Pack** and the pack **Mode** control in the
Admin UI.

**REST API:**

```bash
# Load a pack
curl -X POST http://localhost:7710/api/policy/packs \
  -H "Content-Type: application/yaml" \
  --data-binary @/path/to/pack.yaml

# List active packs
curl http://localhost:7710/api/policy/packs

# Switch pack mode (replace PACK_ID and MODE)
curl -X PATCH http://localhost:7710/api/policy/packs/PACK_ID \
  -H "Content-Type: application/json" \
  -d '{"mode": "enforce"}'
```

Valid modes: `shadow` (advisory only) or `enforce` (blocking). Newly loaded packs start in `shadow`. Switching from shadow to enforce is logged in the audit trail with timestamp and actor.

### Shadow Mode

In shadow mode, the policy engine evaluates rules and logs decisions but never blocks or routes. Use shadow when:
- Testing a new pack before activation
- Enabling a pack that might over-fire
- Onboarding a new customer onto an existing pack

---

## Required-Data Declarations

Each rule must declare what data it needs to evaluate. This serves two purposes:
1. The admin UI shows operators what data sources to configure
2. The policy engine knows when it cannot fully evaluate a rule

| Field | Meaning |
|---|---|
| `contact_id` | Internal ID of the target contact |
| `dnc_status` | Boolean — is contact on internal DNC list? |
| `consent.status` | `verified`, `unverified`, or `none` |
| `consent.source` | Where consent originated |
| `consent.captured_at` | When consent was captured |
| `subscription_status` | `subscribed`, `unsubscribed`, or `none` |
| `target_jurisdiction` | US state code or `federal` |
| `contact_age_known` | Boolean — do we know the contact's age? |
| `contact_age` | Integer age if known |
| `message_body` | Content of the outbound message |
| `offer_type` | Category of the offer being made |
| `geographic_scope` | Granularity of geographic targeting |
| `payload.contact.address` | Phone number or email of the contact |

---

## Common Mistakes

### Wrong field name in required_data

```yaml
# Wrong — field doesn't exist in the action record
required_data:
  - do_not_call_status

# Right — must match the field name in the action schema
required_data:
  - dnc_status
```

### Condition on a field that might not exist

```yaml
# Wrong — if contact_age is absent, the rule never fires as intended
conditions:
  - when:
      contact_age: "< 18"

# Right — use contact_age_known as a guard
conditions:
  - when:
      contact_age_known: true
      contact_age: "< 18"
    then:
      decision: block
```

### Missing disposition_when_missing

Every rule needs an explicit disposition for when `required_data` is absent. Without it, the policy engine cannot decide.

### Priority collisions

Rules with the same priority evaluate in undefined order. Use explicit priorities to control sequence:

```yaml
- rule_id: CHECK-DNC-FIRST
  priority: 1
  ...
- rule_id: CHECK-CONSENT-SECOND
  priority: 2
  ...
```

### No test fixtures

A pack without test fixtures cannot be verified. At minimum, cover:
- One `allow` case
- One `block` case
- One `route_to_review` case
- One case where required data is missing

---

## Required-Data Declaration Table

For each rule in a pack, document:

| Rule ID | Data Field | Provided By | Notes |
|---|---|---|---|
| SMB-001 | `contact_id` | Substrate | Internal contact record |
| SMB-001 | `dnc_status` | Customer integration | Internal DNC list, not RNDB |
| SMB-007 | `consent.verified` | Customer integration | Written consent record |

**Data provider types:**
- `substrate` — the substrate provides this automatically (for example: `action_kind`, `actor.type`)
- `customer_integration` — customer must configure their own data source via the adapter pattern
- `external_api` — Twilio, RealPhoneValidation, etc. must be integrated

---

## What's Not in This Guide

- Authoring credentialed rule pack content (TCPA, fair-housing, HIPAA) — those packs ship reviewed and signed. This guide covers writing your own.
- Policy engine internals — see the AWCP specification.
- Action envelope schema details — see `docs/awcp.md` (Wire format section).
- Hash-chained audit log internals — see `docs/awcp.md` (Audit log section).
