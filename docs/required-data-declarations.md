# Required-Data Declarations — SMB Starter Pack

This document records, for each rule in the SMB Starter Pack, what data the policy engine must have to evaluate it, where that data comes from, and what happens when it is absent.

**Data provider types:**
- `substrate` — the substrate provides this automatically (e.g., `action_kind`, `actor.type`)
- `customer_integration` — customer must configure their own data source via the adapter pattern
- `external_api` — Twilio, RealPhoneValidation, etc. must be integrated

---

## Rule: SMB-001 — Do-Not-Contact Check

| Field | Required | Provided By | Notes |
|---|---|---|---|
| `contact_id` | Yes | Substrate | Internal contact record ID. Substrate provides this from the contact being targeted. |
| `dnc_status` | Yes | Customer integration | Internal do-not-contact list. Customer must maintain and integrate this. NOT the National DNC or RNDB. |

**Disposition when missing:** `route_to_review`

**Integration guidance:** The customer must maintain an internal DNC list and expose it via the substrate's contact adapter. This is NOT a substitute for checking the National Do-Not-Call Registry or the Reassigned Numbers Database.

---

## Rule: SMB-002 — Outbound SMS Disclosure

| Field | Required | Provided By | Notes |
|---|---|---|---|
| `action_kind` | Yes | Substrate | Must be `outbound.sms`. Substrate provides from the action envelope. |
| `message_body` | Yes | Substrate | Content of the SMS. Substrate provides from action payload. |
| `sender_id` | Yes | Substrate | Sender ID (phone number or alpha sender ID). |

**Disposition when missing:** `block`

**Note:** This rule checks for required sender disclosure in the message body. The substrate provides the message body; the rule evaluates whether required disclosures are present.

---

## Rule: SMB-003 — Email Unsubscribe Compliance

| Field | Required | Provided By | Notes |
|---|---|---|---|
| `contact_id` | Yes | Substrate | Internal contact record. |
| `email_address` | Yes | Substrate | The contact's email address. |
| `subscription_status` | Yes | Customer integration | `subscribed`, `unsubscribed`, or `none`. Customer must track this in their contact record or CRM integration. |

**Disposition when missing:** `route_to_review`

**Integration guidance:** Customer's CRM or email platform (Mailchimp, HubSpot, etc.) should push subscription status to the substrate contact record. When `subscription_status` is `none`, the rule routes to review — the system cannot determine whether consent exists.

---

## Rule: SMB-004 — No PII in Agent Prompts

| Field | Required | Provided By | Notes |
|---|---|---|---|
| `payload_content` | Yes | Substrate | The content being submitted to the LLM. Substrate provides from action payload. |

**Disposition when missing:** `route_to_review`

**What the rule checks:** Whether the payload contains SSN, driver's license number, or financial account number. Detection is pattern-based (regex on payload content). This is a guard, not a guarantee of PII detection.

**Integration guidance:** For production use, customers should integrate a PII detection library or service. The substrate's `llm.completion` adapter can be configured to scan payload content before forwarding.

---

## Rule: SMB-005 — No Protected-Class Discrimination

| Field | Required | Provided By | Notes |
|---|---|---|---|
| `targeting_criteria` | Yes | Substrate | Structured object describing who the action targets. Substrate provides from action payload. |

**Disposition when missing:** `route_to_review`

**What the rule checks:** Whether `targeting_criteria` uses protected-class membership (race, color, national origin, religion, sex, familial status, handicap, disability, age 40+) as a filtering or exclusion criterion.

**Note:** The rule cannot detect all forms of discriminatory intent. It flags clear protected-class indicators. Human review is required for nuanced cases.

---

## Rule: SMB-006 — Outbound Content Review for Sensitive Offers

| Field | Required | Provided By | Notes |
|---|---|---|---|
| `action_kind` | Yes | Substrate | |
| `offer_type` | Yes | Substrate | `financial`, `insurance`, `health`, `legal` |
| `geographic_scope` | Yes | Substrate | `census_tract`, `zip_code`, `city`, `county`, `state` |
| `target_demographic` | No | Substrate | Demographic targeting criteria, if any |

**Disposition when missing:** `allow`

**Note:** Default is `allow` because these fields may not always be present. When `offer_type` and `geographic_scope: census_tract` both apply, route to review for disparate impact review.

---

## Rule: SMB-007 — Consent Provenance for Lead-Gen

| Field | Required | Provided By | Notes |
|---|---|---|---|
| `action_kind` | Yes | Substrate | Must be `lead.generation` |
| `contact_id` | Yes | Substrate | |
| `consent.source` | Yes | Customer integration | Where consent originated: `written`, `verbal`, `inferred`, `none` |
| `consent.captured_at` | Yes | Customer integration | ISO-8601 date consent was captured |
| `consent.verified` | Yes | Customer integration | Boolean — has consent been verified, not just self-asserted |

**Disposition when missing:** `route_to_review`

**Integration guidance:** Consent records must come from a documented source (web form, signed document, etc.). Self-asserted consent (e.g., a checkbox with no verification) should be recorded as `verified: false`.

---

## Rule: SMB-008 — No Action on Minor Contact

| Field | Required | Provided By | Notes |
|---|---|---|---|
| `contact_age` | Yes | Customer integration | Integer age if known |
| `contact_age_known` | Yes | Substrate | Boolean — does the system know the contact's age? |

**Disposition when missing:** `allow`

**Note:** Default `allow` when age is unknown — the rule cannot block what it cannot see. Customer should integrate age data for contacts where outbound action is planned.

---

## Rule: SMB-009 — Data Retention Notice

| Field | Required | Provided By | Notes |
|---|---|---|---|
| `action_kind` | Yes | Substrate | |
| `storage_destination` | Yes | Substrate | `internal` or `external` |
| `data_retention_disclosure` | Yes | Substrate | Boolean — was retention disclosure provided? |

**Disposition when missing:** `allow`

**Note:** Default `allow` when fields are missing. When `storage_destination: external` and `data_retention_disclosure: false`, the rule routes to review.

---

## Rule: SMB-010 — Jurisdiction Declaration

| Field | Required | Provided By | Notes |
|---|---|---|---|
| `action_kind` | Yes | Substrate | Must be an outbound action kind |
| `target_jurisdiction` | Yes | Substrate | US state code or `federal` |

**Disposition when missing:** `route_to_review`

**Integration guidance:** For outbound actions, the substrate should default to the customer's business state as `target_jurisdiction` if not explicitly set. The customer should configure their primary jurisdiction during onboarding.

---

## Summary Table

| Rule | Field | Provider | Missing Disposition |
|---|---|---|---|
| SMB-001 | `contact_id` | substrate | route_to_review |
| SMB-001 | `dnc_status` | customer_integration | route_to_review |
| SMB-002 | `action_kind` | substrate | block |
| SMB-002 | `message_body` | substrate | block |
| SMB-002 | `sender_id` | substrate | block |
| SMB-003 | `contact_id` | substrate | route_to_review |
| SMB-003 | `email_address` | substrate | route_to_review |
| SMB-003 | `subscription_status` | customer_integration | route_to_review |
| SMB-004 | `payload_content` | substrate | route_to_review |
| SMB-005 | `targeting_criteria` | substrate | route_to_review |
| SMB-006 | `offer_type` | substrate | allow |
| SMB-006 | `geographic_scope` | substrate | allow |
| SMB-006 | `action_kind` | substrate | allow |
| SMB-007 | `action_kind` | substrate | route_to_review |
| SMB-007 | `contact_id` | substrate | route_to_review |
| SMB-007 | `consent.source` | customer_integration | route_to_review |
| SMB-007 | `consent.captured_at` | customer_integration | route_to_review |
| SMB-007 | `consent.verified` | customer_integration | route_to_review |
| SMB-008 | `contact_age_known` | substrate | allow |
| SMB-008 | `contact_age` | customer_integration | allow |
| SMB-009 | `storage_destination` | substrate | allow |
| SMB-009 | `data_retention_disclosure` | substrate | allow |
| SMB-010 | `target_jurisdiction` | substrate | route_to_review |

---

## Customer Integration Checklist

For the SMB Starter Pack to evaluate correctly, customers must integrate:

1. **Internal DNC list** — expose `dnc_status` per contact
2. **Subscription status tracking** — `subscribed` / `unsubscribed` / `none` per contact
3. **Consent records** — `consent.source`, `consent.captured_at`, `consent.verified` for lead-gen contacts
4. **Contact age data** — `contact_age`, `contact_age_known` for contacts where minor check is relevant
5. **Target jurisdiction** — configured at onboarding, overridden per action

The substrate's adapter pattern is the integration mechanism. Customers configure data providers (CRMs, consent platforms, DNC services) via the adapter config. The policy engine reads from the adapter, not directly from external systems.

---

# Required-Data Declarations — TCPA + Fair Housing Real Estate Pack

This document records, for each rule in the TCPA + Fair Housing Real Estate pack, what data the policy engine must have to evaluate it, where that data comes from, and what happens when it is absent.

---

## Rule: TCPA-RE-001 — Block SMS to internal DNC list

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `dnc_status` | Yes | Customer integration | Internal do-not-call list. Customer must maintain and integrate this. NOT the National DNC or RNDB. |
| `action_kind` | Yes | Substrate | Must be `outbound.sms`. |

**Disposition when missing:** `route_to_review`

---

## Rule: TCPA-RE-002 — Block SMS to reassigned numbers without fresh consent

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `phone_type` | Yes | External API | `mobile`, `landline`, or `unknown` |
| `reassigned_number` | Yes | External API | Boolean — has number been reassigned since consent capture? |
| `consent.captured_at` | Yes | Customer integration | ISO-8601 date consent was captured |
| `action_kind` | Yes | Substrate | Must be `outbound.sms` |

**Disposition when missing:** `route_to_review`

**Integration guidance:** RNDB lookup via an external API (TeliStream, REscorpion, or similar). Consent date must be from customer's CRM or consent platform.

---

## Rule: TCPA-RE-003 — Block SMS to landline without human intervention

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `phone_type` | Yes | External API | Must be `landline` to trigger |
| `action_kind` | Yes | Substrate | Must be `outbound.sms` |

**Disposition when missing:** `route_to_review`

---

## Rule: TCPA-RE-004 — Block outbound without written consent for mobile

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `phone_type` | Yes | External API | Must be `mobile` to trigger |
| `consent.source` | Yes | Customer integration | `written` required; `verbal`, `inferred`, `none` trigger block |
| `action_kind` | Yes | Substrate | Must be `outbound.sms` or `outbound.call` |

**Disposition when missing:** `route_to_review`

---

## Rule: TCPA-RE-005 — Block outreach without declared jurisdiction

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `target_jurisdiction` | Yes | Substrate | US state code or `federal` |
| `action_kind` | Yes | Substrate | Outbound action kinds |

**Disposition when missing:** `route_to_review`

---

## Rule: TCPA-RE-006 — Route to review for EBR exemption on SMS

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `relationship_to_contact` | Yes | Customer integration | `existing_customer`, `former_customer`, `prospect`, `unknown` |
| `phone_type` | Yes | External API | Must be `mobile` to trigger |
| `consent.source` | Yes | Customer integration | `none`, `unknown`, `verbal` trigger route_to_review even with EBR |
| `action_kind` | Yes | Substrate | Outbound SMS/call |

**Disposition when missing:** `route_to_review`

---

## Rule: TCPA-RE-007 — Block outreach outside permitted hours

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `local_time_of_contact` | Yes | Substrate | HH:MM in 24-hour format, caller's local time |
| `action_kind` | Yes | Substrate | `outbound.sms` or `outbound.call` |

**Disposition when missing:** `allow` (time-of-day check cannot fire without time data)

---

## Rule: TCPA-RE-008 — Block lead-gen without verified written consent

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `consent.verified` | Yes | Customer integration | Boolean — has consent been independently verified? |
| `consent.source` | Yes | Customer integration | Must be `written` for verified consent |
| `consent.captured_at` | Yes | Customer integration | ISO-8601 date |
| `action_kind` | Yes | Substrate | Must be `lead.generation` |

**Disposition when missing:** `route_to_review`

---

## Rule: TCPA-RE-009 — Block lead enrichment without consent record

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `consent.status` | Yes | Customer integration | `verified`, `unverified`, `none` |
| `action_kind` | Yes | Substrate | Must be `lead.enrich` |

**Disposition when missing:** `route_to_review`

---

## Rule: FH-RE-001 / FH-001 — Block housing action that excludes by protected class

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `housing_related` | Yes | Substrate | Boolean — does the action relate to housing? |
| `protected_class_indicator_present` | Yes | Customer integration | Boolean — does targeting use a protected class criterion? |

**Disposition when missing:** `route_to_review`

---

## Rule: FH-RE-002 / FH-002 — Block housing action with discriminatory intent

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `housing_related` | Yes | Substrate | |
| `targeting_criteria` | Yes | Substrate | Structured targeting object |
| `message_body` | Yes | Substrate | Content of outbound message |

**Disposition when missing:** `route_to_review`

---

## Rule: FH-RE-003 / FH-003 — Block housing action with discriminatory disparate impact

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `housing_related` | Yes | Substrate | |
| `targeting_criteria` | Yes | Substrate | |
| `geographic_scope` | Yes | Substrate | |

**Disposition when missing:** `route_to_review`

---

## Rule: FH-004 — Block housing advertisement with discriminatory content

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `housing_related` | Yes | Substrate | |
| `message_body` | Yes | Substrate | |

**Disposition when missing:** `route_to_review`

---

## Rule: FH-005 — Block housing advertisement that steers by neighborhood

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `housing_related` | Yes | Substrate | |
| `message_body` | Yes | Substrate | |
| `geographic_scope` | Yes | Substrate | |

**Disposition when missing:** `route_to_review`

---

## Rule: FH-007 — Route to review for housing offers at fine geographic granularity

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `housing_related` | Yes | Substrate | |
| `offer_type` | Yes | Customer integration | `listing`, `buyer_agent`, `mortgage`, `insurance`, `rental` |
| `geographic_scope` | Yes | Substrate | Must be `census_tract` to trigger |

**Disposition when missing:** `allow`

---

## Rule: OH-FH-001 — Block housing discrimination under Ohio Fair Housing Act

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `housing_related` | Yes | Substrate | |
| `target_jurisdiction` | Yes | Substrate | Must be `US-OH` to trigger |
| `protected_class_indicator_present` | Yes | Customer integration | |

**Disposition when missing:** `route_to_review`

---

## Rule: DATA-001 — Block CRM write without contact consent

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `consent.status` | Yes | Customer integration | `verified`, `unverified`, `none` |
| `relationship_to_contact` | Yes | Customer integration | `existing_customer`, `former_customer`, `prospect`, `unknown` |
| `action_kind` | Yes | Substrate | Must be `crm.write` |

**Disposition when missing:** `route_to_review`

---

## TCPA + Fair Housing Integration Checklist

For the TCPA + Fair Housing Real Estate pack to evaluate correctly, customers must integrate:

1. **Phone type detection** — external API (Twilio, RealPhoneValidation, etc.) providing `mobile | landline | unknown`
2. **Reassigned Numbers Database** — FCC RNDB lookup for numbers where consent was captured
3. **Internal DNC list** — `dnc_status: true/false` per contact
4. **Consent records** — `consent.source`, `consent.captured_at`, `consent.verified` per contact
5. **Relationship to contact** — `existing_customer | former_customer | prospect | unknown`
6. **Local time of contact** — computed from contact's timezone for time-of-day rules
7. **Protected class indicator** — structured data about whether targeting criteria uses protected class membership
8. **Target jurisdiction** — US state code per contact, configured at onboarding

---

# Required-Data Declarations — Fair Housing Pack

This document records, for each rule in the Fair Housing pack, what data the policy engine must have to evaluate it, where that data comes from, and what happens when it is absent.

---

## Rule: FH-001 — Block housing action that excludes by protected class

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `housing_related` | Yes | Substrate | Boolean |
| `protected_class_indicator_present` | Yes | Customer integration | Boolean |

**Disposition when missing:** `route_to_review`

---

## Rule: FH-002 — Block housing action with discriminatory intent

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `housing_related` | Yes | Substrate | |
| `targeting_criteria` | Yes | Substrate | Structured object |
| `message_body` | Yes | Substrate | |

**Disposition when missing:** `route_to_review`

---

## Rule: FH-003 — Block housing action with discriminatory disparate impact

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `housing_related` | Yes | Substrate | |
| `targeting_criteria` | Yes | Substrate | |
| `geographic_scope` | Yes | Substrate | |

**Disposition when missing:** `route_to_review`

---

## Rule: FH-004 — Block housing advertisement with discriminatory content

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `housing_related` | Yes | Substrate | |
| `message_body` | Yes | Substrate | |

**Disposition when missing:** `route_to_review`

---

## Rule: FH-005 — Block housing advertisement that steers by neighborhood

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `housing_related` | Yes | Substrate | |
| `message_body` | Yes | Substrate | |
| `geographic_scope` | Yes | Substrate | |

**Disposition when missing:** `route_to_review`

---

## Rule: FH-006 — Block advertisement missing equal housing opportunity notice

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `housing_related` | Yes | Substrate | |
| `message_body` | Yes | Substrate | |
| `advertising_platform` | Yes | Substrate | `print`, `display`, `direct_mail`, `digital` |

**Disposition when missing:** `allow`

---

## Rule: FH-007 — Route to review for housing offers at fine geographic granularity

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `housing_related` | Yes | Substrate | |
| `offer_type` | Yes | Customer integration | |
| `geographic_scope` | Yes | Substrate | Must be `census_tract` |

**Disposition when missing:** `allow`

---

## Rule: OH-FH-001 — Block housing discrimination under Ohio Fair Housing Act

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `housing_related` | Yes | Substrate | |
| `target_jurisdiction` | Yes | Substrate | Must be `US-OH` |
| `protected_class_indicator_present` | Yes | Customer integration | |

**Disposition when missing:** `route_to_review`

---

## Rule: FH-008 — Block agent action that facilitates discriminatory housing

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `housing_related` | Yes | Substrate | |
| `targeting_criteria_uses_protected_class` | Yes | Substrate | |
| `actor_type` | Yes | Substrate | `agent`, `human`, `system` |

**Disposition when missing:** `route_to_review`

---

## Rule: FH-009 — Block lead-gen that collects protected-class data discriminatorily

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `housing_related` | Yes | Substrate | |
| `lead_gen_collects_protected_class_data` | Yes | Customer integration | Boolean |

**Disposition when missing:** `route_to_review`

---

## Rule: FH-010 — Block CRM write that tags contact with protected class discriminatorily

|| Field | Required | Provided By | Notes |
|---|---|---|---|
| `housing_related` | Yes | Substrate | |
| `action_kind` | Yes | Substrate | Must be `crm.write` |
| `crm_tags_include_protected_class` | Yes | Customer integration | Boolean |

**Disposition when missing:** `route_to_review`

---

## Fair Housing Pack Integration Checklist

For the Fair Housing pack to evaluate correctly, customers must integrate:

1. **`housing_related` flag** — set per action by the adapter based on offer_type or action context
2. **`protected_class_indicator_present`** — structured determination of whether targeting criteria uses protected class membership (requires customer business logic to assess targeting parameters)
3. **`targeting_criteria_uses_protected_class`** — evaluated from the targeting_criteria object; substrate provides the structure, customer integration provides the assessment
4. **`lead_gen_collects_protected_class_data`** — boolean from customer's data collection assessment
5. **`crm_tags_include_protected_class`** — boolean from customer's CRM tag assessment
6. **`advertising_platform`** — set per action by the substrate based on which channel the action uses
