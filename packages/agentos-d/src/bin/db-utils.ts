/**
 * SQLite filesystem helpers used by backup and restore. Two specific
 * gotchas that have caused data loss are encoded here:
 *
 * 1. Stale WAL/SHM sidecars from a previous daemon process must be
 *    cleared before a fresh DB file is dropped into place. Otherwise
 *    SQLite will try to apply the old WAL onto the new DB on first
 *    open and produce "database disk image is malformed" — exactly
 *    the failure observed during the 2026-05-03 night recovery.
 *
 * 2. `.backup` happily snapshots an already-wiped DB and reports
 *    success. The 21:54 rolling tarball that night was 17KB because
 *    the daemon had wiped its DB right before the backup ran. Compare
 *    row counts between source and snapshot to catch this class of
 *    silent failure.
 */

import { execSync } from "child_process";
import { existsSync, rmSync } from "fs";

export function clearStaleSqliteSidecars(dbPath: string): {
  walRemoved: boolean;
  shmRemoved: boolean;
} {
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  const walRemoved = existsSync(walPath);
  const shmRemoved = existsSync(shmPath);
  if (walRemoved) rmSync(walPath, { force: true });
  if (shmRemoved) rmSync(shmPath, { force: true });
  return { walRemoved, shmRemoved };
}

export function sqliteRowCount(dbPath: string, table: string): number {
  const out = execSync(
    `sqlite3 "${dbPath}" "SELECT COUNT(*) FROM ${table};"`,
    { encoding: "utf8" }
  ).trim();
  const n = parseInt(out, 10);
  if (Number.isNaN(n)) {
    throw new Error(`sqliteRowCount: unparseable output for ${dbPath}/${table}: ${out}`);
  }
  return n;
}

export function assertBackupCapturedSourceData(
  srcDbPath: string,
  backupDbPath: string,
  table: string = "tenants"
): void {
  const srcCount = sqliteRowCount(srcDbPath, table);
  const bakCount = sqliteRowCount(backupDbPath, table);
  if (srcCount !== bakCount) {
    throw new Error(
      `Backup integrity check failed: source has ${srcCount} rows in ${table}, ` +
        `snapshot captured ${bakCount}. Source DB may be mid-wipe or otherwise ` +
        `inconsistent — refusing to ship a backup that disagrees with the live DB.`
    );
  }
}
