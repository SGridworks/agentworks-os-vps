/**
 * Evidence-report service tests.
 *
 *   - aggregate computes per-decision counts inside the period
 *   - aggregate excludes decisions outside the period (boundary checks)
 *   - aggregate groups violations by rule pack and humanizes labels
 *   - aggregate fetches tenant label when present
 *   - generate persists a row with PDF + summary JSON
 *   - re-running generate updates the existing row (unique key per period)
 *   - generate rejects inverted period
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { FakePdfEngine } from "@agentworks/pdf";
import { initDb, resetDb, getDb } from "../db/client.js";
import { migrate } from "../db/migrations/index.js";
import {
  policyDecisions,
  scannerFindings,
  evidenceReports,
  tenants,
} from "../db/schema.js";
import {
  generateEvidenceReport,
  aggregateEvidenceReportData,
} from "./evidence-report.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const PERIOD_START = "2026-03-01T00:00:00.000Z";
const PERIOD_END = "2026-04-01T00:00:00.000Z";

let dataDir: string;

function baseConfig(dir: string) {
  return {
    host: "127.0.0.1",
    port: 0,
    logLevel: "warn" as const,
    awcpVersion: "awcp/v0.1",
    dataDir: dir,
    scannerSidecarUrl: "http://127.0.0.1:0",
    scannerPollIntervalMs: 30_000,
    auditLogRetentionDays: 30,
  };
}

function seedDecision(opts: {
  decision: "allow" | "block" | "route_to_review";
  createdAt: string;
  rulePackId?: string;
  hash?: string;
}): void {
  const id = randomUUID();
  const db = getDb();
  // @ts-ignore drizzle 0.38 enum default inference
  db.insert(policyDecisions)
    .values({
      id,
      actionId: randomUUID(),
      tenantId: TENANT,
      actorId: "actor-1",
      actorType: "agent",
      actorLabel: "test agent",
      proposedActionKind: "outbound.sms",
      proposedActionSummary: "test",
      evidenceSnapshot: "{}",
      decision: opts.decision,
      decisionReason: "test",
      shadowMode: false,
      rulePackId: opts.rulePackId ?? null,
      decisionHash: opts.hash ?? id,
      proposedAt: opts.createdAt,
      decidedAt: opts.createdAt,
      createdAt: opts.createdAt,
      updatedAt: opts.createdAt,
    })
    .run();
}

function seedFinding(opts: {
  severity: "critical" | "high" | "medium" | "low" | "info";
  createdAt: string;
  title?: string;
  status?: "open" | "resolved";
}): void {
  const id = randomUUID();
  const db = getDb();
  // @ts-ignore drizzle 0.38 enum default inference
  db.insert(scannerFindings)
    .values({
      id,
      tenantId: TENANT,
      originKind: "scanner_finding",
      originId: id,
      severity: opts.severity,
      title: opts.title ?? "test finding",
      description: "test",
      status: opts.status ?? "open",
      createdAt: opts.createdAt,
      updatedAt: opts.createdAt,
    })
    .run();
}

function seedTenant(label: string): void {
  // @ts-ignore drizzle 0.38 enum default inference
  getDb()
    .insert(tenants)
    .values({
      id: TENANT,
      name: label,
      vaultRoot: "<default>",
      shadowMode: true,
      createdAt: PERIOD_START,
      updatedAt: PERIOD_START,
    })
    .run();
}

describe("aggregateEvidenceReportData", () => {
  beforeEach(() => {
    resetDb();
    dataDir = mkdtempSync(join(tmpdir(), "awo-evid-"));
    initDb({ config: baseConfig(dataDir), migrations: migrate });
  });
  afterEach(() => {
    resetDb();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("counts decisions inside period and excludes outside", () => {
    seedDecision({ decision: "allow", createdAt: "2026-03-15T00:00:00.000Z" });
    seedDecision({ decision: "block", createdAt: "2026-03-20T00:00:00.000Z" });
    seedDecision({ decision: "block", createdAt: "2026-03-21T00:00:00.000Z" });
    seedDecision({
      decision: "route_to_review",
      createdAt: "2026-03-25T00:00:00.000Z",
    });
    // Boundary: exactly periodEnd is excluded (half-open).
    seedDecision({ decision: "allow", createdAt: PERIOD_END });
    // Outside period entirely.
    seedDecision({ decision: "allow", createdAt: "2026-04-15T00:00:00.000Z" });

    const data = aggregateEvidenceReportData({
      tenantId: TENANT,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      generatedAt: "2026-04-01T01:00:00Z",
    });

    expect(data.summary.totalDecisions).toBe(4);
    expect(data.summary.allowed).toBe(1);
    expect(data.summary.blocked).toBe(2);
    expect(data.summary.reviewed).toBe(1);
  });

  it("groups violations by rule pack and humanizes labels", () => {
    seedDecision({
      decision: "block",
      createdAt: "2026-03-10T00:00:00Z",
      rulePackId: "tcpa-real-estate",
    });
    seedDecision({
      decision: "block",
      createdAt: "2026-03-11T00:00:00Z",
      rulePackId: "tcpa-real-estate",
    });
    seedDecision({
      decision: "route_to_review",
      createdAt: "2026-03-12T00:00:00Z",
      rulePackId: "fair-housing",
    });
    // allow doesn't count as a violation
    seedDecision({
      decision: "allow",
      createdAt: "2026-03-13T00:00:00Z",
      rulePackId: "tcpa-real-estate",
    });
    // null rulePackId is filtered
    seedDecision({ decision: "block", createdAt: "2026-03-14T00:00:00Z" });

    const data = aggregateEvidenceReportData({
      tenantId: TENANT,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      generatedAt: PERIOD_END,
    });
    const tcpa = data.violations.find((v) => v.rulePackId === "tcpa-real-estate");
    const fh = data.violations.find((v) => v.rulePackId === "fair-housing");
    expect(tcpa?.count).toBe(2);
    expect(tcpa?.label).toBe("TCPA — Real Estate");
    expect(fh?.count).toBe(1);
    expect(fh?.label).toBe("Fair Housing");
  });

  it("aggregates findings by severity and emits highlights newest-first", () => {
    seedFinding({ severity: "critical", createdAt: "2026-03-05T00:00:00Z", title: "old crit" });
    seedFinding({ severity: "high", createdAt: "2026-03-20T00:00:00Z", title: "new high" });
    seedFinding({
      severity: "medium",
      createdAt: "2026-03-15T00:00:00Z",
      title: "med",
      status: "resolved",
    });
    // outside the period
    seedFinding({ severity: "low", createdAt: "2026-04-02T00:00:00Z" });

    const data = aggregateEvidenceReportData({
      tenantId: TENANT,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      generatedAt: PERIOD_END,
    });
    const counts = Object.fromEntries(
      data.findingsBySeverity.map((c) => [c.severity, c.count]),
    );
    expect(counts.critical).toBe(1);
    expect(counts.high).toBe(1);
    expect(counts.medium).toBe(1);
    expect(counts.low).toBeUndefined();
    expect(data.findingsHighlights[0]?.title).toBe("new high");
  });

  it("uses tenant label when present, omits it when absent", () => {
    seedTenant("Example Tenant");
    const labeled = aggregateEvidenceReportData({
      tenantId: TENANT,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      generatedAt: PERIOD_END,
    });
    expect(labeled.tenantLabel).toBe("Example Tenant");

    const otherTenant = "22222222-2222-2222-2222-222222222222";
    const unlabeled = aggregateEvidenceReportData({
      tenantId: otherTenant,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      generatedAt: PERIOD_END,
    });
    expect(unlabeled.tenantLabel).toBeUndefined();
  });

  it("derives reportId from tenant prefix and period yyyy-mm", () => {
    const data = aggregateEvidenceReportData({
      tenantId: TENANT,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      generatedAt: PERIOD_END,
    });
    expect(data.reportId).toBe(`er-${TENANT.slice(0, 8)}-2026-03`);
  });
});

describe("generateEvidenceReport", () => {
  beforeEach(() => {
    resetDb();
    dataDir = mkdtempSync(join(tmpdir(), "awo-evid-"));
    initDb({ config: baseConfig(dataDir), migrations: migrate });
  });
  afterEach(() => {
    resetDb();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("persists a row with PDF + summary JSON + engine name", async () => {
    seedTenant("Example Tenant");
    seedDecision({ decision: "allow", createdAt: "2026-03-10T00:00:00Z" });

    const engine = new FakePdfEngine();
    const result = await generateEvidenceReport({
      tenantId: TENANT,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      engine,
      now: () => "2026-04-01T01:00:00.000Z",
    });

    expect(result.engineName).toBe("fake");
    expect(result.pdfByteLength).toBeGreaterThan(100);
    expect(result.htmlSize).toBeGreaterThan(500);
    expect(result.summary.summary.totalDecisions).toBe(1);

    const row = getDb()
      .select()
      .from(evidenceReports)
      .where(eq(evidenceReports.id, result.id))
      .get();
    expect(row?.tenantId).toBe(TENANT);
    expect(row?.engineName).toBe("fake");
    expect(row?.status).toBe("complete");
    expect(row?.pdfBase64).toBeTruthy();
    const pdfBytes = Buffer.from(row?.pdfBase64 ?? "", "base64");
    expect(pdfBytes.subarray(0, 4).toString("ascii")).toBe("%PDF");

    const summary = JSON.parse(row?.summaryJson ?? "{}");
    expect(summary.tenantLabel).toBe("Example Tenant");
    expect(summary.reportId).toBe(`er-${TENANT.slice(0, 8)}-2026-03`);
  });

  it("updates an existing row instead of inserting a duplicate", async () => {
    const engine = new FakePdfEngine();
    seedDecision({ decision: "allow", createdAt: "2026-03-10T00:00:00Z" });

    const a = await generateEvidenceReport({
      tenantId: TENANT,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      engine,
      now: () => "2026-04-01T01:00:00.000Z",
    });

    seedDecision({ decision: "block", createdAt: "2026-03-15T00:00:00Z" });

    const b = await generateEvidenceReport({
      tenantId: TENANT,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      engine,
      now: () => "2026-04-01T02:00:00.000Z",
    });

    expect(a.id).toBe(b.id);
    const rows = getDb()
      .select()
      .from(evidenceReports)
      .where(eq(evidenceReports.tenantId, TENANT))
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0]?.updatedAt).toBe("2026-04-01T02:00:00.000Z");
    expect(b.summary.summary.blocked).toBe(1);
  });

  it("rejects inverted periods", async () => {
    const engine = new FakePdfEngine();
    await expect(
      generateEvidenceReport({
        tenantId: TENANT,
        periodStart: PERIOD_END,
        periodEnd: PERIOD_START,
        engine,
      }),
    ).rejects.toThrow(/must be before/);
  });

  it("works for a tenant with no decisions or findings", async () => {
    seedTenant("Empty Co");
    const engine = new FakePdfEngine();
    const result = await generateEvidenceReport({
      tenantId: TENANT,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      engine,
      now: () => "2026-04-01T01:00:00.000Z",
    });
    expect(result.summary.summary.totalDecisions).toBe(0);
    expect(result.summary.violations.length).toBe(0);
    expect(result.summary.findingsBySeverity.length).toBe(0);
    expect(result.pdfByteLength).toBeGreaterThan(100);
  });

  it("concurrent generate() calls: second call updates rather than throwing unique violation", async () => {
    // Codex M5: two concurrent cron ticks during a daemon restart both read
    // empty, both try to insert — the UNIQUE constraint on (tenant_id,
    // period_start, period_end) must not throw. The onConflictDoUpdate
    // path must handle the race.
    const engine = new FakePdfEngine();
    seedDecision({ decision: "allow", createdAt: "2026-03-10T00:00:00Z" });

    // Fire two generateEvidenceReport calls in parallel — both see an empty
    // table and both try to insert. With onConflictDoUpdate the second call
    // must receive a valid result, not a constraint error.
    const [a, b] = await Promise.all([
      generateEvidenceReport({
        tenantId: TENANT,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        engine,
        now: () => "2026-04-01T01:00:00.000Z",
      }),
      generateEvidenceReport({
        tenantId: TENANT,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        engine,
        now: () => "2026-04-01T01:00:00.000Z",
      }),
    ]);

    // Both calls must succeed without throwing
    expect(a.status).toBe("complete");
    expect(b.status).toBe("complete");

    // They must produce the same deterministic id
    expect(a.id).toBe(b.id);

    // Exactly one row in the DB (the other caller hit the conflict path)
    const rows = getDb()
      .select()
      .from(evidenceReports)
      .where(eq(evidenceReports.tenantId, TENANT))
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe(a.id);
  });
});
