import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  clearStaleSqliteSidecars,
  sqliteRowCount,
  assertBackupCapturedSourceData,
} from "./db-utils.js";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "awos-db-utils-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function createTestDb(path: string, tenantRows: number): void {
  const seed = Array.from({ length: tenantRows }, (_, i) =>
    `INSERT INTO tenants (id, name) VALUES ('t-${i}', 'Tenant ${i}');`
  ).join("\n");
  execSync(
    `sqlite3 "${path}" "CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT); ${seed}"`,
    { encoding: "utf8" }
  );
}

describe("clearStaleSqliteSidecars", () => {
  it("removes pre-existing -wal and -shm files", () => {
    const dbPath = join(workdir, "test.db");
    writeFileSync(`${dbPath}-wal`, "stale-wal");
    writeFileSync(`${dbPath}-shm`, "stale-shm");

    const result = clearStaleSqliteSidecars(dbPath);

    expect(result.walRemoved).toBe(true);
    expect(result.shmRemoved).toBe(true);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });

  it("is a no-op when no sidecars exist", () => {
    const dbPath = join(workdir, "test.db");
    const result = clearStaleSqliteSidecars(dbPath);
    expect(result.walRemoved).toBe(false);
    expect(result.shmRemoved).toBe(false);
  });

  it("removes only the sidecar that exists", () => {
    const dbPath = join(workdir, "test.db");
    writeFileSync(`${dbPath}-wal`, "stale-wal");

    const result = clearStaleSqliteSidecars(dbPath);

    expect(result.walRemoved).toBe(true);
    expect(result.shmRemoved).toBe(false);
  });
});

describe("sqliteRowCount", () => {
  it("returns the row count for a populated table", () => {
    const dbPath = join(workdir, "src.db");
    createTestDb(dbPath, 6);
    expect(sqliteRowCount(dbPath, "tenants")).toBe(6);
  });

  it("returns 0 for an empty table", () => {
    const dbPath = join(workdir, "src.db");
    createTestDb(dbPath, 0);
    expect(sqliteRowCount(dbPath, "tenants")).toBe(0);
  });
});

describe("assertBackupCapturedSourceData", () => {
  it("passes when source and snapshot row counts agree", () => {
    const src = join(workdir, "src.db");
    const bak = join(workdir, "bak.db");
    createTestDb(src, 3);
    createTestDb(bak, 3);
    expect(() => assertBackupCapturedSourceData(src, bak, "tenants")).not.toThrow();
  });

  it("throws when snapshot has fewer rows than source — the wiped-DB regression", () => {
    const src = join(workdir, "src.db");
    const bak = join(workdir, "bak.db");
    createTestDb(src, 6);
    createTestDb(bak, 0);
    expect(() => assertBackupCapturedSourceData(src, bak, "tenants")).toThrow(
      /source has 6.*snapshot captured 0/i
    );
  });

  it("passes when both source and snapshot are empty (fresh install)", () => {
    const src = join(workdir, "src.db");
    const bak = join(workdir, "bak.db");
    createTestDb(src, 0);
    createTestDb(bak, 0);
    expect(() => assertBackupCapturedSourceData(src, bak, "tenants")).not.toThrow();
  });
});
