import { describe, it, expect } from "vitest";
import { renderSessionBrief, type Session } from "./session-brief.js";
import type { SessionEvent } from "./session-brief-types.js";

const makeSession = (overrides: Partial<Session> & { openedAt: string; closedAt: string }): Session =>
  ({
    ...overrides,
    id: overrides.id ?? "test-session-001",
    tenantId: overrides.tenantId ?? "tenant-abc",
  }) as Session;

describe("renderSessionBrief", () => {
  // -------------------------------------------------------------------------
  // Normal session with mixed events → correct summary, duration, importance
  // -------------------------------------------------------------------------
  it("normal session with mixed events → correct summary, duration, importance", () => {
    const events: SessionEvent[] = [
      { at: "2026-04-30T10:05:00.000Z", type: "vault_write", description: "Wrote vault page project/sprint-42" },
      { at: "2026-04-30T10:07:00.000Z", type: "vault_write", description: "Wrote vault page project/sprint-43" },
      { at: "2026-04-30T10:09:00.000Z", type: "vault_write", description: "Wrote vault page project/sprint-44" },
      { at: "2026-04-30T10:15:00.000Z", type: "policy_evaluated", description: "Approved SMS to John Doe" },
      { at: "2026-04-30T10:16:00.000Z", type: "policy_evaluated", description: "Blocked outreach to Jane Smith" },
      { at: "2026-04-30T10:20:00.000Z", type: "agent_spawned", description: "BackendEngineer started" },
      { at: "2026-04-30T10:21:00.000Z", type: "agent_spawned", description: "QAEngineer started" },
    ];

    const session = makeSession({
      openedAt: "2026-04-30T10:00:00.000Z",
      closedAt: "2026-04-30T10:30:00.000Z",
    });

    const brief = renderSessionBrief(session, events);

    // Duration: 30 minutes = 1800 seconds
    expect(brief.durationSec).toBe(1800);
    expect(brief.sessionId).toBe("test-session-001");
    expect(brief.tenantId).toBe("tenant-abc");
    expect(brief.closedAt).toBe("2026-04-30T10:30:00.000Z");
    expect(brief.events).toHaveLength(7);
    // 7 events → base importance 2; < 1h session → no duration bump
    expect(brief.importance).toBe(2);

    // Summary groups by type
    expect(brief.summary).toContain("Vault Write");
    expect(brief.summary).toContain("2 Agent Spawned");
  });

  // -------------------------------------------------------------------------
  // Session with no events → summary "No significant activity", importance 1
  // -------------------------------------------------------------------------
  it("session with no events → summary 'No significant activity', importance 1", () => {
    const session = makeSession({
      openedAt: "2026-04-30T10:00:00.000Z",
      closedAt: "2026-04-30T10:30:00.000Z",
    });

    const brief = renderSessionBrief(session, []);

    expect(brief.summary).toBe("No significant activity");
    expect(brief.events).toHaveLength(0);
    expect(brief.importance).toBe(1);
    expect(brief.durationSec).toBe(1800);
  });

  // -------------------------------------------------------------------------
  // Very long session (duration > 3600s) → importance boosted
  // -------------------------------------------------------------------------
  it("very long session (duration > 3600s) → importance boosted", () => {
    // 2-hour session with 2 events
    const events: SessionEvent[] = [
      { at: "2026-04-30T10:05:00.000Z", type: "vault_write", description: "Wrote summary" },
      { at: "2026-04-30T11:55:00.000Z", type: "vault_write", description: "Updated summary" },
    ];

    const session = makeSession({
      openedAt: "2026-04-30T10:00:00.000Z",
      closedAt: "2026-04-30T12:00:00.000Z", // 2 hours = 7200s
    });

    const brief = renderSessionBrief(session, events);

    // 2 events → base importance 1; duration 7200s > 3600s → bump to 2
    expect(brief.durationSec).toBe(7200);
    expect(brief.importance).toBe(2);
  });

  // -------------------------------------------------------------------------
  // High event count session → importance 5
  // -------------------------------------------------------------------------
  it("high event count session → importance 5", () => {
    const events: SessionEvent[] = Array.from({ length: 60 }, (_, i) => ({
      at: new Date(Date.now() + i * 1000).toISOString(),
      type: "vault_write",
      description: `Write ${i}`,
    }));

    const session = makeSession({
      openedAt: "2026-04-30T10:00:00.000Z",
      closedAt: "2026-04-30T11:00:00.000Z",
    });

    const brief = renderSessionBrief(session, events);

    expect(brief.events).toHaveLength(60);
    expect(brief.importance).toBe(5);
  });

  // -------------------------------------------------------------------------
  // Rejects open session (no closedAt)
  // -------------------------------------------------------------------------
  it("throws when session has no closedAt", () => {
    const openSession = {
      id: "open-session",
      tenantId: "tenant-abc",
      openedAt: "2026-04-30T10:00:00.000Z",
    } as Session;

    expect(() => renderSessionBrief(openSession, [])).toThrow(
      "closedAt is required",
    );
  });

  // -------------------------------------------------------------------------
  // Duration computed correctly (ms → seconds)
  // -------------------------------------------------------------------------
  it("duration is computed in seconds", () => {
    const session = makeSession({
      openedAt: "2026-04-30T10:00:00.500Z",
      closedAt: "2026-04-30T10:01:01.500Z", // 61 seconds
    });

    const brief = renderSessionBrief(session, []);
    expect(brief.durationSec).toBe(61);
  });
});
