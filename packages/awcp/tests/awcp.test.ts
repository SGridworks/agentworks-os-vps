import { describe, it, expect } from "vitest";
import {
  AWCP_SPEC_VERSION,
  AWCP_SPEC_STATUS,
  AWCP_SPEC_STATUS_LABEL,
} from "../src/index.js";
import {
  ACTION_KINDS,
  REGISTERED_ACTION_KINDS,
  isRegisteredActionKind,
} from "../src/action.js";
import {
  PolicyCheckRequestSchema,
  PolicyCheckResponseSchema,
  RuleDecisionSchema,
  PolicyCheckErrorSchema,
} from "../src/policy-check.js";
import {
  AuditLogEntrySchema,
  AuditActorSchema,
  AuditContactSchema,
  AuditRuleDecisionSchema,
  AuditOverrideSchema,
  computeAuditLogHash,
} from "../src/audit-log.js";
import {
  isAttorneyReviewed,
  TIER_LABELS,
  TIER_CREDENTIALS,
  AWCP_VERSION,
} from "../src/rule-pack.js";

describe("AWCP v0.1 reference implementation", () => {
  describe("index exports", () => {
    it("exports the correct spec version", () => {
      expect(AWCP_SPEC_VERSION).toBe("awcp/v0.1");
    });

    it("exports draft status", () => {
      expect(AWCP_SPEC_STATUS).toBe("draft");
    });

    it("exports a status label containing DRAFT", () => {
      expect(AWCP_SPEC_STATUS_LABEL).toContain("DRAFT");
    });
  });

  describe("action kinds", () => {
    it("has exactly 10 registered action kinds", () => {
      expect(REGISTERED_ACTION_KINDS).toHaveLength(10);
    });

    it("recognizes all canonical action kinds", () => {
      for (const kind of REGISTERED_ACTION_KINDS) {
        expect(isRegisteredActionKind(kind)).toBe(true);
      }
    });

    it("rejects unknown action kinds", () => {
      expect(isRegisteredActionKind("not.a.kind")).toBe(false);
      expect(isRegisteredActionKind("")).toBe(false);
    });

    it("includes outbound.sms and data.delete", () => {
      expect(ACTION_KINDS.OUTBOUND_SMS).toBe("outbound.sms");
      expect(ACTION_KINDS.DATA_DELETE).toBe("data.delete");
    });
  });

  describe("policy check schemas", () => {
    it("accepts a valid enforce request", () => {
      const req = {
        action: { kind: "outbound.sms", to: "+15551234567" },
        tenant_id: "550e8400-e29b-41d4-a716-446655440000",
        mode: "enforce",
      };
      const parsed = PolicyCheckRequestSchema.parse(req);
      expect(parsed.mode).toBe("enforce");
    });

    it("defaults mode to enforce", () => {
      const req = {
        action: { kind: "outbound.email" },
        tenant_id: "550e8400-e29b-41d4-a716-446655440000",
      };
      const parsed = PolicyCheckRequestSchema.parse(req);
      expect(parsed.mode).toBe("enforce");
    });

    it("rejects an invalid mode", () => {
      expect(() =>
        PolicyCheckRequestSchema.parse({
          action: {},
          tenant_id: "550e8400-e29b-41d4-a716-446655440000",
          mode: "permissive",
        })
      ).toThrow();
    });

    it("rejects a missing tenant_id", () => {
      expect(() =>
        PolicyCheckRequestSchema.parse({ action: {} })
      ).toThrow();
    });

    it("accepts a valid response shape", () => {
      const res = {
        request_id: "550e8400-e29b-41d4-a716-446655440000",
        decision: "allow",
        evaluated_at: "2026-04-28T12:00:00Z",
        decisions: [
          {
            rule_pack_id: "pack-1",
            rule_pack_version: "1.0.0",
            rule_id: "rule-1",
            decision: "allow",
            reason: "All checks passed",
            data_missing: [],
          },
        ],
        missing_data: [],
        override: null,
      };
      const parsed = PolicyCheckResponseSchema.parse(res);
      expect(parsed.decision).toBe("allow");
    });

    it("accepts route_to_review decision", () => {
      const res = {
        request_id: "550e8400-e29b-41d4-a716-446655440000",
        decision: "route_to_review",
        evaluated_at: "2026-04-28T12:00:00Z",
        decisions: [],
        missing_data: ["consent_record"],
        override: null,
      };
      const parsed = PolicyCheckResponseSchema.parse(res);
      expect(parsed.missing_data).toContain("consent_record");
    });

    it("accepts a valid error response", () => {
      const err = {
        error: "Policy engine unavailable",
        details: [{ code: "ENGINE_DOWN", message: "Connection refused" }],
      };
      const parsed = PolicyCheckErrorSchema.parse(err);
      expect(parsed.error).toBe("Policy engine unavailable");
    });
  });

  describe("audit log schemas", () => {
    it("accepts a valid audit log entry", () => {
      const entry = {
        entry_id: "550e8400-e29b-41d4-a716-446655440000",
        request_id: "550e8400-e29b-41d4-a716-446655440001",
        tenant_id: "550e8400-e29b-41d4-a716-446655440002",
        actor: { id: "agent-1", type: "agent" },
        contact: { id: "550e8400-e29b-41d4-a716-446655440003", channel: "sms" },
        action_kind: "outbound.sms",
        decision: "allow",
        decisions: [],
        missing_data: [],
        mode: "enforce",
        override: null,
        hash: "abc123",
        previous_hash: "000000",
        logged_at: "2026-04-28T12:00:00Z",
      };
      const parsed = AuditLogEntrySchema.parse(entry);
      expect(parsed.actor.type).toBe("agent");
    });

    it("accepts a null contact", () => {
      const entry = {
        entry_id: "550e8400-e29b-41d4-a716-446655440000",
        request_id: "550e8400-e29b-41d4-a716-446655440001",
        tenant_id: "550e8400-e29b-41d4-a716-446655440002",
        actor: { id: "agent-1", type: "agent" },
        contact: null,
        action_kind: "llm.completion",
        decision: "allow",
        decisions: [],
        missing_data: [],
        mode: "shadow",
        override: null,
        hash: "abc123",
        previous_hash: "000000",
        logged_at: "2026-04-28T12:00:00Z",
      };
      const parsed = AuditLogEntrySchema.parse(entry);
      expect(parsed.contact).toBeNull();
    });

    it("accepts a valid override record", () => {
      const override = {
        reviewer_id: "550e8400-e29b-41d4-a716-446655440000",
        reviewer_name: "Alice",
        original_decision: "route_to_review",
        override_decision: "allow",
        justification: "Customer explicitly consented via phone",
        decided_at: "2026-04-28T12:05:00Z",
      };
      const parsed = AuditOverrideSchema.parse(override);
      expect(parsed.justification).toBe("Customer explicitly consented via phone");
    });

    it("computes deterministic SHA-256 hashes", () => {
      const input = {
        entry_id: "e1",
        request_id: "r1",
        tenant_id: "t1",
        actor_id: "a1",
        action_kind: "outbound.sms",
        decision: "allow",
        decisions: [],
        missing_data: [],
        override: null,
        previous_hash: "000000",
        logged_at: "2026-04-28T12:00:00Z",
      };
      const h1 = computeAuditLogHash(input);
      const h2 = computeAuditLogHash(input);
      expect(h1).toBe(h2);
      expect(h1).toMatch(/^[a-f0-9]{64}$/);
    });

    it("produces different hashes for different inputs", () => {
      const base = {
        entry_id: "e1",
        request_id: "r1",
        tenant_id: "t1",
        actor_id: "a1",
        action_kind: "outbound.sms",
        decision: "allow",
        decisions: [],
        missing_data: [],
        override: null,
        previous_hash: "000000",
        logged_at: "2026-04-28T12:00:00Z",
      };
      const h1 = computeAuditLogHash(base);
      const h2 = computeAuditLogHash({ ...base, decision: "block" });
      expect(h1).not.toBe(h2);
    });
  });

  describe("rule pack helpers", () => {
    it("identifies attorney-reviewed packs correctly", () => {
      expect(
        isAttorneyReviewed({
          attorney_reviewed: true,
          attorney_name: "Jane Doe",
          attorney_engagement_letter_on_file: true,
        })
      ).toBe(true);
    });

    it("rejects attorney-reviewed when letter is missing", () => {
      expect(
        isAttorneyReviewed({
          attorney_reviewed: true,
          attorney_name: "Jane Doe",
          attorney_engagement_letter_on_file: false,
        })
      ).toBe(false);
    });

    it("rejects attorney-reviewed when name is missing", () => {
      expect(
        isAttorneyReviewed({
          attorney_reviewed: true,
          attorney_name: null,
          attorney_engagement_letter_on_file: true,
        })
      ).toBe(false);
    });

    it("exports tier labels for all tiers", () => {
      expect(TIER_LABELS.free).toContain("Free");
      expect(TIER_LABELS.paid).toContain("Paid");
      expect(TIER_LABELS["attorney-reviewed"]).toContain("Attorney-Reviewed");
    });

    it("exports tier credentials", () => {
      expect(TIER_CREDENTIALS.free).toBe("SGridworks");
      expect(TIER_CREDENTIALS["attorney-reviewed"]).toContain("Named attorney");
    });

    it("exports the correct package version", () => {
      expect(AWCP_VERSION).toBe("0.1.0");
    });
  });
});
