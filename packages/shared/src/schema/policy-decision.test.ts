import { describe, it, expect } from "vitest";
import {
  PolicyDecisionSchema,
  ContactSchema,
  ConsentSchema,
  ToolSchema,
  EvidenceSchema,
  OverrideSchema,
  ReviewSchema,
} from "./policy-decision.js";

describe("ContactSchema", () => {
  it("parses a valid person contact", () => {
    const contact = {
      type: "person",
      label: "John Doe",
      address: "+15551234567",
    };
    expect(ContactSchema.parse(contact)).toEqual(contact);
  });

  it("parses a valid business contact", () => {
    const contact = {
      type: "business",
      label: "Acme Corp",
      address: "info@acme.com",
    };
    expect(ContactSchema.parse(contact)).toEqual(contact);
  });

  it("allows optional id", () => {
    const contact = {
      id: "contact-1",
      type: "person",
      label: "John Doe",
      address: "+15551234567",
    };
    expect(ContactSchema.parse(contact).id).toBe("contact-1");
  });

  it("rejects invalid contact type", () => {
    expect(() =>
      ContactSchema.parse({ type: "organization", label: "X", address: "x@y.com" })
    ).toThrow();
  });
});

describe("ConsentSchema", () => {
  it("parses all valid sources", () => {
    const sources = ["written", "verbal", "inferred", "none", "unknown"] as const;
    for (const source of sources) {
      const consent = { source, label: "Test", address: "+15551234567", type: "person" as const };
      expect(ConsentSchema.parse({ source })).toMatchObject({ source });
    }
  });

  it("defaults verified to false", () => {
    const parsed = ConsentSchema.parse({ source: "written" });
    expect(parsed.verified).toBe(false);
  });

  it("defaults scope to empty array", () => {
    const parsed = ConsentSchema.parse({ source: "verbal" });
    expect(parsed.scope).toEqual([]);
  });
});

describe("ToolSchema", () => {
  it("parses a valid tool", () => {
    const tool = {
      id: "tool-1",
      name: "Claude",
      adapterKey: "claude-local",
      policyMode: "shadow",
    };
    expect(ToolSchema.parse(tool)).toEqual(tool);
  });

  it("rejects invalid policyMode", () => {
    expect(() =>
      ToolSchema.parse({ id: "x", name: "X", policyMode: "enforced" })
    ).toThrow();
  });
});

describe("OverrideSchema", () => {
  it("parses a valid override", () => {
    const override = {
      overriddenBy: "user-1",
      overriddenByLabel: "Jane Doe",
      originalDecision: "block",
      overrideReason: "Business relationship established",
      overriddenAt: "2026-04-27T14:00:00.000Z",
    };
    expect(OverrideSchema.parse(override)).toEqual(override);
  });

  it("rejects invalid originalDecision in override", () => {
    expect(() =>
      OverrideSchema.parse({
        overriddenBy: "user-1",
        overriddenByLabel: "Jane",
        originalDecision: "denied",
        overrideReason: "test",
        overriddenAt: "2026-04-27T14:00:00.000Z",
      })
    ).toThrow();
  });
});

describe("ReviewSchema", () => {
  it("parses a completed review", () => {
    const review = {
      reviewedBy: "user-1",
      reviewedByLabel: "Jane Doe",
      reviewDecision: "approve",
      reviewNote: "Looks good",
      reviewedAt: "2026-04-27T15:00:00.000Z",
    };
    expect(ReviewSchema.parse(review)).toEqual(review);
  });

  it("parses empty review (not yet reviewed)", () => {
    const review = ReviewSchema.parse({});
    expect(review.reviewDecision).toBeUndefined();
  });

  it("rejects invalid reviewDecision", () => {
    expect(() =>
      ReviewSchema.parse({ reviewDecision: "maybe" })
    ).toThrow();
  });
});

describe("PolicyDecisionSchema", () => {
  const baseRecord = {
    id: "770e8400-e29b-41d4-a716-446655440000",
    actionId: "880e8400-e29b-41d4-a716-446655440000",
    actorId: "agent-1",
    actorType: "agent" as const,
    actorLabel: "Claude",
    tenantId: "990e8400-e29b-41d4-a716-446655440000",
    proposedActionKind: "outbound.sms",
    proposedActionSummary: "Send SMS to +15551234567",
    evidence: {
      ruleIds: ["tcpa-001"],
      ruleNames: ["TCPA Do-Not-Call"],
      ruleCitations: [],
      missingFields: [],
      actionSnapshot: {},
    },
    decision: "block" as const,
    decisionReason: "TCPA violation: number on do-not-call list",
    shadowMode: false,
    prevDecisionHash: undefined,
    decisionHash: "abc123def456abc123def456abc123def456abc123def456abc123def456abcd",
    proposedAt: "2026-04-27T12:00:00.000Z",
    decidedAt: "2026-04-27T12:00:01.000Z",
    createdAt: "2026-04-27T12:00:01.000Z",
  };

  it("parses a valid block decision", () => {
    expect(PolicyDecisionSchema.parse(baseRecord)).toEqual(baseRecord);
  });

  it("parses a valid allow decision", () => {
    const allow = { ...baseRecord, decision: "allow", decisionReason: "No rules matched" };
    expect(PolicyDecisionSchema.parse(allow)).toEqual(allow);
  });

  it("parses a valid route_to_review decision", () => {
    const review = {
      ...baseRecord,
      decision: "route_to_review" as const,
      decisionReason: "Missing consent field",
      evidence: {
        ...baseRecord.evidence,
        missingFields: ["consent.source"],
      },
    };
    expect(PolicyDecisionSchema.parse(review).decision).toBe("route_to_review");
  });

  it("defaults shadowMode to false", () => {
    const { shadowMode, ...rest } = baseRecord;
    const parsed = PolicyDecisionSchema.parse(rest);
    expect(parsed.shadowMode).toBe(false);
  });

  it("rejects decision not in allow/block/route_to_review", () => {
    expect(() =>
      PolicyDecisionSchema.parse({ ...baseRecord, decision: "deny" })
    ).toThrow();
  });

  it("rejects invalid actorType", () => {
    expect(() =>
      PolicyDecisionSchema.parse({ ...baseRecord, actorType: "bot" })
    ).toThrow();
  });

  it("parses contact and channel when present", () => {
    const withContact = {
      ...baseRecord,
      contact: { type: "person", label: "John Doe", address: "+15551234567" },
      channel: "sms" as const,
      jurisdiction: "OH",
    };
    expect(PolicyDecisionSchema.parse(withContact).channel).toBe("sms");
  });

  it("parses consent when present", () => {
    const withConsent = {
      ...baseRecord,
      consent: {
        source: "written" as const,
        capturedAt: "2026-04-20T10:00:00.000Z",
        verified: true,
        scope: ["marketing", "promotional"],
      },
    };
    const parsed = PolicyDecisionSchema.parse(withConsent);
    expect(parsed.consent?.source).toBe("written");
    expect(parsed.consent?.verified).toBe(true);
  });

  it("parses tool when present", () => {
    const withTool = {
      ...baseRecord,
      tool: { id: "tool-1", name: "Claude", adapterKey: "claude-local", policyMode: "enforce" as const },
    };
    expect(PolicyDecisionSchema.parse(withTool).tool?.policyMode).toBe("enforce");
  });

  it("parses override when present", () => {
    const withOverride = {
      ...baseRecord,
      override: {
        overriddenBy: "user-1",
        overriddenByLabel: "Jane Doe",
        originalDecision: "block" as const,
        overrideReason: "Existing business relationship",
        overriddenAt: "2026-04-27T13:00:00.000Z",
      },
    };
    expect(PolicyDecisionSchema.parse(withOverride).override?.originalDecision).toBe("block");
  });

  it("parses review when present", () => {
    const withReview = {
      ...baseRecord,
      decision: "route_to_review" as const,
      review: {
        reviewedBy: "user-1",
        reviewedByLabel: "Jane Doe",
        reviewDecision: "approve" as const,
        reviewNote: "Consent on file",
        reviewedAt: "2026-04-27T14:00:00.000Z",
      },
    };
    expect(PolicyDecisionSchema.parse(withReview).review?.reviewDecision).toBe("approve");
  });

  it("accepts evidence with ruleCitations", () => {
    const withCitations = {
      ...baseRecord,
      evidence: {
        ruleIds: ["tcpa-001"],
        ruleNames: ["TCPA Do-Not-Call"],
        ruleCitations: [
          {
            ruleId: "tcpa-001",
            matchedField: "recipient",
            matchedValue: "+15551234567",
            operator: "in_dnc_list",
          },
        ],
        missingFields: [],
        actionSnapshot: {},
      },
    };
    expect(PolicyDecisionSchema.parse(withCitations).evidence.ruleCitations).toHaveLength(1);
  });

  it("requires decisionHash", () => {
    const { decisionHash, ...withoutHash } = baseRecord;
    expect(() => PolicyDecisionSchema.parse(withoutHash)).toThrow();
  });
});
