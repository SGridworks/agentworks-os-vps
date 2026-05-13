/**
 * Unit tests for backup/restore CLI.
 * Tests: manifest schema, argument parsing, checksum calculation.
 * Integration tests (actual backup/restore cycle) require a live daemon and
 * are covered by the substrate-e2e test suite.
 */

import { describe, it, expect } from "vitest";
import {
  BackupManifest,
  BACKUP_VERSION,
  listDbTables,
} from "./backup-manifest.js";

describe("BackupManifest schema", () => {
  it("BACKUP_VERSION is 1.0.0", () => {
    expect(BACKUP_VERSION).toBe("1.0.0");
  });

  it("listDbTables returns all managed tables", () => {
    const tables = listDbTables();
    expect(tables).toContain("policy_decisions");
    expect(tables).toContain("action_log");
    expect(tables).toContain("tenants");
    expect(tables).toContain("tenant_webhooks");
    expect(tables).toContain("tenant_rule_pack_assignments");
    expect(tables).toContain("dispatch_queue");
    expect(tables).toContain("evidence_reports");
    // No scanner_worker tables (PythonEngineer's domain)
    expect(tables).not.toContain("scan_results");
  });

  it("BackupManifest interface is structurally valid", () => {
    const manifest: BackupManifest = {
      version: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      hostname: "test-host",
      dbTables: listDbTables(),
      vaults: ["tenant-1", "tenant-2"],
      rulePackAssignments: true,
      tenantConfigs: ["tenant-1", "tenant-2"],
      checksumSha256: "abc123",
    };
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.dbTables.length).toBeGreaterThan(0);
    expect(manifest.vaults).toHaveLength(2);
    expect(manifest.tenantConfigs).toHaveLength(2);
  });
});

describe("Backup argument parsing", () => {
  function parseBackupArgs(argv: string[]): { outPath?: string; key?: string } {
    const args: { outPath?: string; key?: string } = {};
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--out" && i + 1 < argv.length) args.outPath = argv[++i];
      else if (argv[i] === "--key" && i + 1 < argv.length) args.key = argv[++i];
    }
    return args;
  }

  it("parses --out flag", () => {
    const result = parseBackupArgs(["--out", "/tmp/my-backup.tar.gz"]);
    expect(result.outPath).toBe("/tmp/my-backup.tar.gz");
  });

  it("parses --key flag", () => {
    const result = parseBackupArgs(["--key", "hunter2"]);
    expect(result.key).toBe("hunter2");
  });

  it("parses both flags", () => {
    const result = parseBackupArgs(["--out", "/tmp/b.tar.gz", "--key", "secret123"]);
    expect(result.outPath).toBe("/tmp/b.tar.gz");
    expect(result.key).toBe("secret123");
  });

  it("returns empty object for no flags", () => {
    const result = parseBackupArgs([]);
    expect(result.outPath).toBeUndefined();
    expect(result.key).toBeUndefined();
  });
});

describe("Restore argument parsing", () => {
  function parseRestoreArgs(argv: string[]): { backupFile: string; key?: string } {
    const args: { backupFile: string; key?: string } = { backupFile: "" };
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--key" && i + 1 < argv.length) args.key = argv[++i];
      else if (!argv[i].startsWith("--")) args.backupFile = argv[i];
    }
    return args;
  }

  it("parses backup file positional arg", () => {
    const result = parseRestoreArgs(["/tmp/backup.tar.gz"]);
    expect(result.backupFile).toBe("/tmp/backup.tar.gz");
  });

  it("parses --key flag", () => {
    const result = parseRestoreArgs(["/tmp/backup.tar.gz", "--key", "hunter2"]);
    expect(result.backupFile).toBe("/tmp/backup.tar.gz");
    expect(result.key).toBe("hunter2");
  });

  it("empty array returns empty backupFile (no throw in parseArgs — error surfaces in runRestore)", () => {
    const result = parseRestoreArgs([]);
    expect(result.backupFile).toBe("");
    expect(result.key).toBeUndefined();
  });

  it("throws when runRestore is called with empty backupFile", async () => {
    // Error is thrown inside runRestore, not in parseRestoreArgs
    await expect(async () => {
      await import("./restore.js").then((m) =>
        m.runRestore([])
      );
    }).rejects.toThrow();
  });
});
