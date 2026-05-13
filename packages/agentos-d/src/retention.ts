/**
 * Audit log retention sweep.
 *
 * Deletes action_log rows older than the retention horizon. policy_decisions
 * are explicitly excluded — those rows are hash-chained for tamper-evidence
 * and the chain must not be broken. Compliance evidence reports aggregate
 * over policy_decisions counts, not action_log payloads.
 *
 * Wire-up: cli.ts schedules runAuditLogRetention every 24h after daemon boot.
 * For tests, call runAuditLogRetention(db, retentionDays) directly.
 */

import { lt } from "drizzle-orm";
import { actionLog } from "./db/schema.js";
import { getDb } from "./db/index.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionResult {
  deleted: number;
  cutoffIso: string;
  ranAt: string;
}

export function runAuditLogRetention(retentionDays: number): RetentionResult {
  const ranAt = new Date().toISOString();
  if (retentionDays <= 0) {
    return { deleted: 0, cutoffIso: "", ranAt };
  }

  const cutoffMs = Date.now() - retentionDays * ONE_DAY_MS;
  const cutoffIso = new Date(cutoffMs).toISOString();

  const db = getDb();
  const result = db.delete(actionLog).where(lt(actionLog.loggedAt, cutoffIso)).run();

  return {
    deleted: result.changes ?? 0,
    cutoffIso,
    ranAt,
  };
}

export function startAuditLogRetentionScheduler(retentionDays: number): NodeJS.Timeout | null {
  if (retentionDays <= 0) return null;

  // Run once at boot so tenants don't sit on a backlog after upgrading.
  const first = runAuditLogRetention(retentionDays);
  // eslint-disable-next-line no-console
  console.log(
    `[retention] initial sweep: deleted=${first.deleted} cutoff=${first.cutoffIso} (retention=${retentionDays}d)`,
  );

  return setInterval(() => {
    const result = runAuditLogRetention(retentionDays);
    // eslint-disable-next-line no-console
    console.log(
      `[retention] sweep: deleted=${result.deleted} cutoff=${result.cutoffIso}`,
    );
  }, ONE_DAY_MS);
}
