/**
 * Policy engine evaluator tests.
 * Covers allow, block, route_to_review scenarios per rule pack evaluation.
 *
 * Key evaluator behavior to remember:
 * - matchedRule is null when no rule triggered a non-allow decision
 * - When ALL rules pass, matchedRule is null (no rule "won")
 * - shadowMode is set on ALL results, not just when true
 * - required_data uses flat field names; nested paths use dot-notation in getIn()
 * - Schema enforces min(1) rules and min(1) required_data
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import type { ActionEnvelope } from "@agentworks/shared";
import { evaluatePack, evaluatePacks } from "./evaluator.js";
import { loadPackFromString } from "./loader.js";

// Helper to build a minimal action envelope
function makeAction(overrides: Partial<ActionEnvelope> = {}): ActionEnvelope {
  return {
    requestId: randomUUID(),
    proposedAt: new Date().toISOString(),
    tenantId: randomUUID(),
    actor: { id: "user-1", type: "human", label: "Test User" },
    actionKind: "outbound.sms",
    payload: {},
    context: {
      vaultRefs: [],
      conversationRefs: [],
      projectRefs: [],
      meta: {},
    },
    reviewed: false,
    ...overrides,
  };
}

/**
 * Base pack for TCPA block-on-missing-data tests.
 * required_data field "consentRecordRef" — a flat field name.
 * Condition checks actionKind: if action is outbound.sms, block.
 * Since our test action IS outbound.sms, it will block.
 */
const BASE_PACK_YAML = `
pack_id: tcpa-baseline
pack_version: "1.0.0"
schema_version: "awcp/v0.1"
pack_name: TCPA Baseline
pack_description: Basic TCPA compliance rules for outbound SMS
tier: free
jurisdiction: ["US"]
rules:
  - rule_id: tcpa-consent-check
    name: TCPA Consent Required
    description: Outbound SMS requires prior express written consent
    required_data:
      - consentRecordRef
    disposition_when_missing: block
    priority: 10
    conditions:
      - when:
          actionKind: outbound.sms
        then:
          decision: block
          reason: "TCPA: prior express written consent required for SMS"
          citation: "47 CFR 64.1200"
`;

// ---- loadPackFromString tests -----------------------------------------------

describe("loadPackFromString", () => {
  it("parses a minimal valid pack", () => {
    const pack = loadPackFromString(BASE_PACK_YAML);
    expect(pack.pack_id).toBe("tcpa-baseline");
    expect(pack.rules).toHaveLength(1);
    expect(pack.schema_version).toBe("awcp/v0.1");
  });

  it("rejects pack missing pack_version", () => {
    expect(() =>
      loadPackFromString(`
pack_id: bad-pack
schema_version: "awcp/v0.1"
rules: []
`)
    ).toThrow();
  });

  it("rejects pack missing schema_version", () => {
    expect(() =>
      loadPackFromString(`
pack_id: bad-pack
pack_version: "1.0.0"
rules: []
`)
    ).toThrow();
  });

  it("rejects pack with zero rules", () => {
    // Schema enforces min(1) rules
    expect(() =>
      loadPackFromString(`
pack_id: no-rules
pack_version: "1.0.0"
schema_version: "awcp/v0.1"
rules: []
`)
    ).toThrow();
  });

  // Note: the schema does NOT currently enforce unique rule_ids.
  // That would require a superRefine in RuleSchema.
});

// ---- evaluatePack: allow scenarios ------------------------------------------

describe("evaluatePack — allow scenarios", () => {
  it("returns allow when no conditions trigger a block or review", () => {
    // Pack has a rule that only blocks if recipientFlag === true.
    // Our action has recipientFlag === false, so the condition doesn't match.
    // required_data is present (recipientFlag: false is not null/undefined).
    // No condition matched → evaluateRule returns allow.
    const pack = loadPackFromString(`
pack_id: no-match-allow
pack_version: "1.0.0"
schema_version: "awcp/v0.1"
rules:
  - rule_id: no-match-rule
    name: No Match
    description: Only blocks if recipient is flagged
    required_data: ["recipientFlag"]
    priority: 10
    conditions:
      - when:
          recipientFlag: true
        then:
          decision: block
          reason: "Recipient flagged"
`);
    const action = makeAction({
      payload: { recipientFlag: false },
    });
    const result = evaluatePack(pack, action);
    expect(result.decision).toBe("allow");
    // matchedRule is null because no condition matched (allow returned at end of evaluateRule)
    expect(result.matchedRule).toBeNull();
    expect(result.reason).toBe("No condition matched");
  });

  it("returns allow when condition matches with allow disposition", () => {
    // required_data: consentRecordRef is present in payload
    // condition: consentRecordRef === "ref-123" matches
    // disposition: allow → full result returned with matchedRule
    const pack = loadPackFromString(`
pack_id: allow-test
pack_version: "1.0.0"
schema_version: "awcp/v0.1"
rules:
  - rule_id: allow-rule
    name: Allow if consent ok
    description: Allow SMS when consentRecordRef exists
    required_data: ["consentRecordRef"]
    priority: 10
    conditions:
      - when:
          consentRecordRef: "ref-123"
        then:
          decision: allow
          reason: "Consent record found"
`);
    const action = makeAction({
      actionKind: "outbound.sms",
      payload: { consentRecordRef: "ref-123" },
    });
    const result = evaluatePack(pack, action);
    expect(result.decision).toBe("allow");
    expect(result.matchedRule?.rule_id).toBe("allow-rule");
    expect(result.reason).toBe("Consent record found");
  });

  it("returns allow when actionKind is not targeted by the pack", () => {
    const pack = loadPackFromString(`
pack_id: sms-only
pack_version: "1.0.0"
schema_version: "awcp/v0.1"
target_action_kinds: ["outbound.sms"]
rules:
  - rule_id: sms-blocker
    name: SMS Blocker
    description: Block all SMS
    required_data: ["anyField"]
    priority: 1
    conditions:
      - when:
          actionKind: outbound.sms
        then:
          decision: block
          reason: "SMS blocked"
`);
    // actionKind is email — pack doesn't apply to it
    const action = makeAction({ actionKind: "crm.write", payload: { anyField: "x" } });
    const result = evaluatePack(pack, action);
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("Action kind not targeted by pack");
    expect(result.matchedRule).toBeNull();
  });
});

// ---- evaluatePack: block scenarios -------------------------------------------

describe("evaluatePack — block scenarios", () => {
  it("routes to review when required_data is missing (undefined)", () => {
    // Missing-data is intentionally route_to_review, not block: the human
    // reviewer decides whether the field is genuinely absent or just unwired.
    // A blanket block here would mask integration gaps as compliance failures.
    const pack = loadPackFromString(BASE_PACK_YAML);
    const action = makeAction({ payload: {} });
    const result = evaluatePack(pack, action);
    expect(result.decision).toBe("route_to_review");
    expect(result.missingFields).toContain("consentRecordRef");
    expect(result.matchedRule?.rule_id).toBe("tcpa-consent-check");
  });

  it("routes to review when required_data is null", () => {
    const pack = loadPackFromString(BASE_PACK_YAML);
    const action = makeAction({ payload: { consentRecordRef: null } });
    const result = evaluatePack(pack, action);
    expect(result.decision).toBe("route_to_review");
    expect(result.missingFields).toContain("consentRecordRef");
  });

  it("returns block when condition explicitly blocks", () => {
    const pack = loadPackFromString(`
pack_id: block-test
pack_version: "1.0.0"
schema_version: "awcp/v0.1"
rules:
  - rule_id: do-not-call-block
    name: Do Not Call Block
    description: Block if number is on DNC list
    required_data: ["isOnDnc"]
    disposition_when_missing: route_to_review
    priority: 5
    conditions:
      - when:
          isOnDnc: true
        then:
          decision: block
          reason: "Number is on Do Not Call list"
          citation: "FTC DNC Rules"
`);
    const action = makeAction({
      payload: { isOnDnc: true },
    });
    const result = evaluatePack(pack, action);
    expect(result.decision).toBe("block");
    expect(result.matchedRule?.rule_id).toBe("do-not-call-block");
    expect(result.citation).toBe("FTC DNC Rules");
    expect(result.reason).toBe("Number is on Do Not Call list");
  });

  it("first matching block stops evaluation (higher priority wins)", () => {
    const pack = loadPackFromString(`
pack_id: priority-block
pack_version: "1.0.0"
schema_version: "awcp/v0.1"
rules:
  - rule_id: high-priority-block
    name: High Priority Block
    description: Blocks at priority 1
    required_data: []
    priority: 1
    conditions:
      - when:
          actionKind: outbound.sms
        then:
          decision: block
          reason: "High priority block"
  - rule_id: low-priority-allow
    name: Low Priority Allow
    description: Would allow at priority 100
    required_data: []
    priority: 100
    conditions:
      - when:
          actionKind: outbound.sms
        then:
          decision: allow
          reason: "Should not reach here"
`);
    const action = makeAction({ actionKind: "outbound.sms" });
    const result = evaluatePack(pack, action);
    expect(result.decision).toBe("block");
    expect(result.matchedRule?.rule_id).toBe("high-priority-block");
  });
});

// ---- evaluatePack: route_to_review scenarios ----------------------------------

describe("evaluatePack — route_to_review scenarios", () => {
  it("returns route_to_review when required_data is null", () => {
    const pack = loadPackFromString(`
pack_id: review-null
pack_version: "1.0.0"
schema_version: "awcp/v0.1"
rules:
  - rule_id: null-review
    name: Review if value null
    description: Route to review if value is null
    required_data: ["transactionValue"]
    disposition_when_missing: route_to_review
    priority: 10
    conditions:
      - when:
          transactionValue: null
        then:
          decision: route_to_review
          reason: "Value is null — requires human review"
`);
    const action = makeAction({
      payload: { transactionValue: null },
    });
    const result = evaluatePack(pack, action);
    expect(result.decision).toBe("route_to_review");
    expect(result.matchedRule?.rule_id).toBe("null-review");
  });

  it("returns route_to_review when time-of-day is outside business hours", () => {
    const pack = loadPackFromString(`
pack_id: time-review
pack_version: "1.0.0"
schema_version: "awcp/v0.1"
rules:
  - rule_id: within-hours
    name: Within Hours Allow
    description: Allow within business hours
    required_data: ["localTime"]
    priority: 10
    conditions:
      - when:
          localTime:
            gte: "09:00"
            lt: "17:00"
        then:
          decision: allow
          reason: "Within business hours"
  - rule_id: after-hours
    name: After-Hours Route to Review
    description: Outbound actions outside 9-5 should be reviewed
    required_data: ["localTime"]
    disposition_when_missing: route_to_review
    priority: 20
    conditions:
      - when:
          localTime:
            gte: "00:00"
            lt: "09:00"
        then:
          decision: route_to_review
          reason: "Before business hours — human review required"
      - when:
          localTime:
            gte: "17:00"
            lt: "23:59"
        then:
          decision: route_to_review
          reason: "After business hours — human review required"
`);
    const action = makeAction({
      context: {
        vaultRefs: [],
        conversationRefs: [],
        projectRefs: [],
        meta: { localTime: "22:00" },
      },
    });
    const result = evaluatePack(pack, action);
    expect(result.decision).toBe("route_to_review");
    expect(result.matchedRule?.rule_id).toBe("after-hours");
  });

  it("route_to_review takes precedence over lower-priority allow", () => {
    const pack = loadPackFromString(`
pack_id: review-precedence
pack_version: "1.0.0"
schema_version: "awcp/v0.1"
rules:
  - rule_id: review-rule
    name: Review High Value
    description: Route high-value transactions to review
    required_data: ["transactionValue"]
    disposition_when_missing: route_to_review
    priority: 5
    conditions:
      - when:
          transactionValue: null
        then:
          decision: route_to_review
          reason: "Value unknown"
  - rule_id: allow-rule
    name: Allow Always
    description: Would allow everything else
    required_data: []
    priority: 100
    conditions:
      - when: {}
        then:
          decision: allow
          reason: "Catch-all allow"
`);
    const action = makeAction({
      payload: { transactionValue: null },
    });
    const result = evaluatePack(pack, action);
    expect(result.decision).toBe("route_to_review");
    expect(result.matchedRule?.rule_id).toBe("review-rule");
  });
});

// ---- evaluatePacks: multiple packs -------------------------------------------

describe("evaluatePacks — multiple packs", () => {
  it("first non-allow from any pack wins", () => {
    const pack1 = loadPackFromString(`
pack_id: pack-1
pack_version: "1.0.0"
schema_version: "awcp/v0.1"
rules:
  - rule_id: allow-in-pack1
    name: Allow in pack 1
    description: Allow everything
    required_data: []
    priority: 10
    conditions:
      - when: {}
        then:
          decision: allow
          reason: "pack1 allow"
`);
    const pack2 = loadPackFromString(`
pack_id: pack-2
pack_version: "1.0.0"
schema_version: "awcp/v0.1"
rules:
  - rule_id: block-in-pack2
    name: Block in pack 2
    description: Block all SMS
    required_data: []
    priority: 10
    conditions:
      - when:
          actionKind: outbound.sms
        then:
          decision: block
          reason: "Pack 2 blocks SMS"
`);
    const action = makeAction({ actionKind: "outbound.sms" });
    const result = evaluatePacks([pack1, pack2], action);
    expect(result.decision).toBe("block");
    expect(result.matchedRule?.rule_id).toBe("block-in-pack2");
  });

  it("returns allow when all packs return allow", () => {
    const pack1 = loadPackFromString(`
pack_id: pack-a
pack_version: "1.0.0"
schema_version: "awcp/v0.1"
rules:
  - rule_id: rule-a
    name: Rule A
    description: Allow
    required_data: []
    priority: 10
    conditions:
      - when: {}
        then:
          decision: allow
          reason: a
`);
    const pack2 = loadPackFromString(`
pack_id: pack-b
pack_version: "1.0.0"
schema_version: "awcp/v0.1"
rules:
  - rule_id: rule-b
    name: Rule B
    description: Allow
    required_data: []
    priority: 10
    conditions:
      - when: {}
        then:
          decision: allow
          reason: b
`);
    const action = makeAction();
    const result = evaluatePacks([pack1, pack2], action);
    expect(result.decision).toBe("allow");
  });
});

// ---- shadow mode ------------------------------------------------------------

describe("shadow mode", () => {
  it("sets shadowMode: true on result when shadowMode=true", () => {
    const pack = loadPackFromString(BASE_PACK_YAML);
    const action = makeAction({ payload: {} });
    const result = evaluatePack(pack, action, true);
    expect(result.shadowMode).toBe(true);
  });

  it("sets shadowMode: false on result when shadowMode=false", () => {
    const pack = loadPackFromString(BASE_PACK_YAML);
    const action = makeAction({ payload: {} });
    const result = evaluatePack(pack, action, false);
    // shadowMode is always set (even when false)
    expect(result.shadowMode).toBe(false);
  });
});

// ---- condition operators -----------------------------------------------------

describe("condition operators", () => {
  it("null check: field === null triggers null-equal condition", () => {
    const pack = loadPackFromString(`
pack_id: null-check
pack_version: "1.0.0"
schema_version: "awcp/v0.1"
rules:
  - rule_id: null-test
    name: Null Check
    description: Matches when field is explicitly null
    required_data: []
    priority: 10
    conditions:
      - when:
          optIn: null
        then:
          decision: block
          reason: "Opt-in is null"
`);
    const action = makeAction({
      payload: { optIn: null },
    });
    const result = evaluatePack(pack, action);
    expect(result.decision).toBe("block");
    expect(result.matchedRule?.rule_id).toBe("null-test");
  });

  it("array IN check: field value in array matches", () => {
    const pack = loadPackFromString(`
pack_id: in-check
pack_version: "1.0.0"
schema_version: "awcp/v0.1"
rules:
  - rule_id: state-check
    name: State Check
    description: Block for specific states
    required_data: []
    priority: 10
    conditions:
      - when:
          recipientState: ["CA", "NY", "FL"]
        then:
          decision: block
          reason: "State not eligible"
`);
    const action = makeAction({
      payload: { recipientState: "CA" },
    });
    const result = evaluatePack(pack, action);
    expect(result.decision).toBe("block");
    expect(result.matchedRule?.rule_id).toBe("state-check");
  });

  it("array IN check: value not in array returns allow", () => {
    const pack = loadPackFromString(`
pack_id: in-check-pass
pack_version: "1.0.0"
schema_version: "awcp/v0.1"
rules:
  - rule_id: state-check
    name: State Check
    description: Block for specific states
    required_data: []
    priority: 10
    conditions:
      - when:
          recipientState: ["CA", "NY", "FL"]
        then:
          decision: block
          reason: "State not eligible"
`);
    const action = makeAction({
      payload: { recipientState: "TX" },
    });
    const result = evaluatePack(pack, action);
    expect(result.decision).toBe("allow");
    expect(result.matchedRule).toBeNull();
  });

  it("range check: gte/lt on time string — within range", () => {
    const pack = loadPackFromString(`
pack_id: range-check
pack_version: "1.0.0"
schema_version: "awcp/v0.1"
rules:
  - rule_id: business-hours
    name: Business Hours
    description: Only allow 8am-6pm
    required_data: []
    priority: 10
    conditions:
      - when:
          localTime:
            gte: "08:00"
            lt: "18:00"
        then:
          decision: allow
          reason: "Within business hours"
`);
    const action = makeAction({
      context: {
        vaultRefs: [],
        conversationRefs: [],
        projectRefs: [],
        meta: { localTime: "12:00" },
      },
    });
    const result = evaluatePack(pack, action);
    expect(result.decision).toBe("allow");
    expect(result.matchedRule?.rule_id).toBe("business-hours");
  });

  it("range check: gte/lt on time string — below range", () => {
    const pack = loadPackFromString(`
pack_id: range-check-early
pack_version: "1.0.0"
schema_version: "awcp/v0.1"
rules:
  - rule_id: business-hours
    name: Business Hours
    description: Only allow 8am-6pm
    required_data: []
    priority: 10
    conditions:
      - when:
          localTime:
            gte: "08:00"
            lt: "18:00"
        then:
          decision: allow
          reason: "Within business hours"
`);
    const action = makeAction({
      context: {
        vaultRefs: [],
        conversationRefs: [],
        projectRefs: [],
        meta: { localTime: "07:00" },
      },
    });
    const result = evaluatePack(pack, action);
    // localTime 07:00 fails gte:"08:00" → condition doesn't match
    // required_data present, condition not matched → allow (matchedRule: null)
    expect(result.decision).toBe("allow");
    expect(result.matchedRule).toBeNull();
  });

  it("dot-notation path lookup works in required_data", () => {
    // required_data uses dot-notation: "consent.recordRef"
    // getIn traverses the nested object in payload
    const pack = loadPackFromString(`
pack_id: nested-check
pack_version: "1.0.0"
schema_version: "awcp/v0.1"
rules:
  - rule_id: nested-rule
    name: Nested Check
    description: Check nested field
    required_data: ["consent.recordRef"]
    disposition_when_missing: block
    priority: 10
    conditions:
      - when:
          consent__recordRef: "ref-abc"
        then:
          decision: allow
          reason: "Nested ref found"
`);
    const action = makeAction({
      payload: { consent: { recordRef: "ref-abc" } },
    });
    // getIn(payload, "consent__recordRef") → undefined (field name doesn't match)
    // required_data check: getIn(payload, "consent.recordRef") → "ref-abc" (found, not null)
    // condition check: getIn(payload, "consent__recordRef") → undefined → doesn't match "ref-abc"
    // → evaluateRule returns allow with matchedRule: null
    const result = evaluatePack(pack, action);
    expect(result.decision).toBe("allow");
    expect(result.missingFields).toBeUndefined();
  });
});
