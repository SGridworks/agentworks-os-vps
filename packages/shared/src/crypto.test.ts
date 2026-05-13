import { describe, it, expect } from "vitest";
import {
  computeDecisionHash,
  verifyDecisionHash,
  verifyChainIntegrity,
} from "./crypto.js";

describe("computeDecisionHash", () => {
  it("produces a 64-char hex SHA-256 hash", () => {
    const hash = computeDecisionHash({
      id: "a".repeat(36),
      actionId: "b".repeat(36),
      decision: "allow",
      decisionReason: "No rules matched",
      prevDecisionHash: undefined,
      createdAt: "2026-04-27T12:00:00.000Z",
    });
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces different hashes for different inputs", () => {
    const base = {
      id: "a".repeat(36),
      actionId: "b".repeat(36),
      decision: "allow",
      decisionReason: "No rules matched",
      createdAt: "2026-04-27T12:00:00.000Z",
    };
    const h1 = computeDecisionHash({ ...base, prevDecisionHash: undefined });
    const h2 = computeDecisionHash({ ...base, prevDecisionHash: "abc123" });
    expect(h1).not.toBe(h2);
  });

  it("uses GENESIS when prevDecisionHash is undefined", () => {
    const withGenesis = computeDecisionHash({
      id: "a".repeat(36),
      actionId: "b".repeat(36),
      decision: "block",
      decisionReason: "TCPA violation",
      prevDecisionHash: undefined,
      createdAt: "2026-04-27T12:00:00.000Z",
    });
    const withExplicit = computeDecisionHash({
      id: "a".repeat(36),
      actionId: "b".repeat(36),
      decision: "block",
      decisionReason: "TCPA violation",
      prevDecisionHash: "GENESIS",
      createdAt: "2026-04-27T12:00:00.000Z",
    });
    expect(withGenesis).toBe(withExplicit);
  });
});

describe("verifyDecisionHash", () => {
  it("returns true for a valid hash", () => {
    const params = {
      id: "a".repeat(36),
      actionId: "b".repeat(36),
      decision: "route_to_review",
      decisionReason: "Missing consent",
      prevDecisionHash: "abc123",
      createdAt: "2026-04-27T12:00:00.000Z",
    };
    const hash = computeDecisionHash(params);
    expect(
      verifyDecisionHash({ ...params, decisionHash: hash })
    ).toBe(true);
  });

  it("returns false for a tampered record", () => {
    const params = {
      id: "a".repeat(36),
      actionId: "b".repeat(36),
      decision: "allow",
      decisionReason: "No rules matched",
      prevDecisionHash: undefined,
      createdAt: "2026-04-27T12:00:00.000Z",
    };
    const hash = computeDecisionHash(params);
    // Tamper with the decision
    expect(
      verifyDecisionHash({ ...params, decisionHash: hash, decision: "block" })
    ).toBe(false);
  });
});

describe("verifyChainIntegrity", () => {
  it("returns valid for a clean chain", () => {
    const records = [
      {
        id: "1",
        actionId: "action-1",
        decision: "allow",
        decisionReason: "OK",
        prevDecisionHash: undefined,
        decisionHash: "",
        createdAt: "2026-04-27T10:00:00.000Z",
      },
      {
        id: "2",
        actionId: "action-2",
        decision: "block",
        decisionReason: "violation",
        prevDecisionHash: "",
        decisionHash: "",
        createdAt: "2026-04-27T11:00:00.000Z",
      },
    ];

    // Compute hashes sequentially
    records[0].decisionHash = computeDecisionHash({
      ...records[0],
      prevDecisionHash: undefined,
    });
    records[1].prevDecisionHash = records[0].decisionHash;
    records[1].decisionHash = computeDecisionHash(records[1]);

    expect(verifyChainIntegrity(records)).toEqual({ valid: true });
  });

  it("detects a broken prevHash reference", () => {
    // Build a valid chain for record 0, then break the link at record 1
    const record0 = {
      id: "1",
      actionId: "action-1",
      decision: "allow",
      decisionReason: "OK",
      prevDecisionHash: undefined,
      decisionHash: "",
      createdAt: "2026-04-27T10:00:00.000Z",
    };
    record0.decisionHash = computeDecisionHash(record0);

    const record1 = {
      id: "2",
      actionId: "action-2",
      decision: "block",
      decisionReason: "violation",
      prevDecisionHash: "WRONG_HASH", // broken link — does not match record0.decisionHash
      decisionHash: "cafebabe",
      createdAt: "2026-04-27T11:00:00.000Z",
    };

    const result = verifyChainIntegrity([record0, record1]);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1); // link breaks at record 1
  });

  it("detects a tampered decision in the chain", () => {
    const records = [
      {
        id: "1",
        actionId: "action-1",
        decision: "allow",
        decisionReason: "OK",
        prevDecisionHash: undefined,
        decisionHash: "",
        createdAt: "2026-04-27T10:00:00.000Z",
      },
    ];
    records[0].decisionHash = computeDecisionHash(records[0]);

    // Tamper after hashing
    const tampered = { ...records[0], decision: "block" };

    const result = verifyChainIntegrity([tampered]);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(0);
  });
});
