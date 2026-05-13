/**
 * Evidence-report cron — runs periodically and, on the first tick of each
 * calendar month for each tenant, generates the prior-month evidence
 * report.
 *
 * Designed for testability: `tickOnce()` is the unit of work, `start()` /
 * `stop()` only manage the setInterval timer. `now` is injectable so a
 * test can drive the clock forward without touching the system clock.
 */

import type { PdfEngine } from "@agentworks/pdf";
import { eq, and } from "drizzle-orm";
import pino from "pino";
import { getDb } from "../db/index.js";
import { tenants, evidenceReports } from "../db/schema.js";
import { generateEvidenceReport } from "./evidence-report.js";
import { isPaused } from "../pause-service.js";

const logger = pino({ name: "evidence-report-cron" });

export interface CronOptions {
  engine: PdfEngine;
  /** Wall-clock injectable for tests. Default Date.now-backed. */
  now?: () => Date;
  /** Tick frequency. Default 1 hour. */
  intervalMs?: number;
  /** Override tenant lookup for tests. */
  listTenants?: () => string[];
}

export interface TickResult {
  /** Tenant IDs the cron generated reports for this tick. */
  generated: string[];
  /** Tenant IDs that already had a current-period report (no work needed). */
  skipped: string[];
  /** Tenant IDs that errored. */
  errored: Array<{ tenantId: string; reason: string }>;
}

export class EvidenceReportCron {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: CronOptions) {
    if (!opts.engine) throw new Error("EvidenceReportCron: engine required");
  }

  start(): void {
    if (this.timer) return;
    const intervalMs = this.opts.intervalMs ?? 60 * 60 * 1000;
    this.timer = setInterval(() => {
      this.tickOnce().catch((err) => {
        logger.error({ err }, "evidence-report cron tick failed");
      });
    }, intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tickOnce(): Promise<TickResult> {
    if (isPaused()) {
      return { generated: [], skipped: [], errored: [] };
    }
    const now = (this.opts.now ?? (() => new Date()))();
    const { periodStart, periodEnd } = priorMonthBounds(now);
    const tenantIds = this.opts.listTenants
      ? this.opts.listTenants()
      : listAllTenantIds();

    const result: TickResult = { generated: [], skipped: [], errored: [] };

    for (const tenantId of tenantIds) {
      try {
        if (alreadyGenerated(tenantId, periodStart, periodEnd)) {
          result.skipped.push(tenantId);
          continue;
        }
        await generateEvidenceReport({
          tenantId,
          periodStart,
          periodEnd,
          engine: this.opts.engine,
          now: () => now.toISOString(),
        });
        result.generated.push(tenantId);
      } catch (err) {
        result.errored.push({
          tenantId,
          reason: err instanceof Error ? err.message : String(err),
        });
        logger.error(
          { err, tenantId, periodStart, periodEnd },
          "evidence-report generation failed",
        );
      }
    }

    return result;
  }
}

export function priorMonthBounds(now: Date): {
  periodStart: string;
  periodEnd: string;
} {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
  return {
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
  };
}

function listAllTenantIds(): string[] {
  return getDb()
    .select({ id: tenants.id })
    .from(tenants)
    .all()
    .map((r) => r.id);
}

function alreadyGenerated(
  tenantId: string,
  periodStart: string,
  periodEnd: string,
): boolean {
  const row = getDb()
    .select({ id: evidenceReports.id })
    .from(evidenceReports)
    .where(
      and(
        eq(evidenceReports.tenantId, tenantId),
        eq(evidenceReports.periodStart, periodStart),
        eq(evidenceReports.periodEnd, periodEnd),
      ),
    )
    .get();
  return Boolean(row);
}
