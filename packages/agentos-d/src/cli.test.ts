/**
 * Backup / restore CLI integration tests.
 *
 * Runs the compiled CLI (dist/cli.js) as a subprocess.  The CLI uses the
 * working directory's default data dir (./data) and vault (./vault relative
 * to homedir), so tests must run from the package root and those paths must
 * exist.  Each test uses a unique tmp root and swaps VAULT_ROOT; AGENTOS_DATA_DIR
 * is intentionally left unset so the CLI uses its built-in default.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync, execFileSync } from "child_process";

describe("backup / restore CLI", () => {
  // Resolve to the agentos-d package root regardless of vitest's cwd.
  const PKG_ROOT = join(import.meta.dirname, "..");
  const CLI = join(PKG_ROOT, "dist", "cli.js");

  beforeEach(() => {
    // Ensure the data dir exists at the default location so the CLI can initialize
    mkdirSync(join(PKG_ROOT, "data"), { recursive: true });
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function runBackup(args: string[], extraEnv: Record<string, string> = {}): { exitCode: number; stdout: string; stderr: string } {
    const vaultRoot = mkdtempSync(join(tmpdir(), "awo-test-vault-"));
    // Seed the vault with minimal content so backup has something to package
    const vaultDataDir = join(vaultRoot, "data");
    mkdirSync(vaultDataDir, { recursive: true });
    writeFileSync(join(vaultDataDir, "manifest.json"), JSON.stringify({ version: "1.0", created: new Date().toISOString() }));
    const env = { ...process.env, VAULT_ROOT: vaultRoot, ...extraEnv };
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      stdout = execFileSync("node", [CLI, "backup", ...args], { cwd: PKG_ROOT, env, encoding: "utf8" });
    } catch (err: any) {
      stderr = err.stderr ?? "";
      stdout = err.stdout ?? "";
      exitCode = err.status ?? 1;
    }
    // Keep vaultRoot reference for cleanup
    (global as any).__testVaultRoot = vaultRoot;
    return { exitCode, stdout, stderr };
  }

  function runRestore(args: string[], extraEnv: Record<string, string> = {}): { exitCode: number; stdout: string; stderr: string } {
    const vaultRoot = mkdtempSync(join(tmpdir(), "awo-test-vault-"));
    const env = { ...process.env, VAULT_ROOT: vaultRoot, ...extraEnv };
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      stdout = execFileSync("node", [CLI, "restore", ...args], { cwd: PKG_ROOT, env, encoding: "utf8" });
    } catch (err: any) {
      stderr = err.stderr ?? "";
      stdout = err.stdout ?? "";
      exitCode = err.status ?? 1;
    }
    (global as any).__testVaultRoot = vaultRoot;
    return { exitCode, stdout, stderr };
  }

  afterEach(() => {
    const vaultRoot = (global as any).__testVaultRoot;
    if (vaultRoot) rmSync(vaultRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Backup
  // -------------------------------------------------------------------------

  it("backup --out creates a .tar.gz at the specified path", () => {
    const outFile = join(tmpdir(), `awo-backup-${Date.now()}.tar.gz`);
    const { exitCode, stdout } = runBackup(["--out", outFile]);

    expect(exitCode).toBe(0);
    expect(existsSync(outFile)).toBe(true);
    expect(stdout).toContain("Backup saved to");

    // Verify it's a valid tarball (payload/agentos.db is the DB file path inside the archive)
    const listing = execSync(`tar -tzf "${outFile}"`, { encoding: "utf8" });
    expect(listing).toContain("payload/");

    rmSync(outFile, { force: true });
  });

  it("backup --key encrypts to .enc and removes plain tarball", () => {
    const plainFile = join(tmpdir(), `awo-backup-key-${Date.now()}.tar.gz`);
    const encFile = `${plainFile}.enc`;

    // Plain backup succeeds
    const r1 = runBackup(["--out", plainFile]);
    expect(r1.exitCode).toBe(0);
    expect(existsSync(plainFile)).toBe(true);

    // Encrypted backup
    const r2 = runBackup(["--out", plainFile, "--key", "hunter2"]);
    expect(r2.exitCode).toBe(0);
    expect(existsSync(encFile)).toBe(true); // .enc file created
    expect(existsSync(plainFile)).toBe(false); // plain file removed

    // .enc is not a valid tar.gz
    let isValidTar = false;
    try {
      execSync(`tar -tzf "${encFile}"`);
      isValidTar = true;
    } catch {
      isValidTar = false;
    }
    expect(isValidTar).toBe(false);

    rmSync(encFile, { force: true });
  });

  // -------------------------------------------------------------------------
  // Restore
  // -------------------------------------------------------------------------

  it("restore of plain archive succeeds", () => {
    // Create a backup
    const outFile = join(tmpdir(), `awo-restore-src-${Date.now()}.tar.gz`);
    runBackup(["--out", outFile]);

    // Resolve where the CLI actually writes data: vitest.setup.ts forces
    // AGENTOS_DATA_DIR to a tmpdir to keep tests off the repo's data/ path.
    const dataDir = process.env.AGENTOS_DATA_DIR ?? join(PKG_ROOT, "data");

    // Wipe the data dir
    rmSync(dataDir, { recursive: true, force: true });

    const { exitCode, stdout, stderr } = runRestore([outFile]);
    expect(exitCode).toBe(0);
    expect((stdout + stderr).toLowerCase()).toContain("restore completed");

    // Data dir should be recreated
    expect(existsSync(dataDir)).toBe(true);

    rmSync(outFile, { force: true });
  });

  it("restore of .enc archive without key exits 1", () => {
    const plainFile = join(tmpdir(), `awo-restore-no-key-${Date.now()}.tar.gz`);
    const encFile = `${plainFile}.enc`;
    runBackup(["--out", plainFile, "--key", "secret123"]);

    rmSync(join(PKG_ROOT, "data"), { recursive: true, force: true });

    const { exitCode, stderr } = runRestore([encFile]);
    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toMatch(/key/i);

    rmSync(encFile, { force: true });
  });

  it("restore of .enc archive with correct key succeeds", () => {
    const plainFile = join(tmpdir(), `awo-restore-ok-key-${Date.now()}.tar.gz`);
    const encFile = `${plainFile}.enc`;
    runBackup(["--out", plainFile, "--key", "correct-key"]);

    rmSync(join(PKG_ROOT, "data"), { recursive: true, force: true });

    const { exitCode, stdout, stderr } = runRestore([encFile, "--key", "correct-key"]);
    expect(exitCode).toBe(0);
    expect((stdout + stderr).toLowerCase()).toContain("restore completed");

    rmSync(encFile, { force: true });
  });

  it("restore of .enc archive with wrong key exits 1", () => {
    const plainFile = join(tmpdir(), `awo-restore-wrong-key-${Date.now()}.tar.gz`);
    const encFile = `${plainFile}.enc`;
    runBackup(["--out", plainFile, "--key", "correct-key"]);

    rmSync(join(PKG_ROOT, "data"), { recursive: true, force: true });

    const { exitCode } = runRestore([encFile, "--key", "wrong-key"]);
    expect(exitCode).not.toBe(0);

    rmSync(encFile, { force: true });
  });

  // -------------------------------------------------------------------------
  // Error paths
  // -------------------------------------------------------------------------

  it("restore exits 1 when archive does not exist", () => {
    const { exitCode } = runRestore(["/nonexistent/path/backup.tar.gz"]);
    expect(exitCode).not.toBe(0);
  });

  it("restore exits 1 when archive is not a valid tarball", () => {
    const badFile = join(tmpdir(), `awo-bad-archive-${Date.now()}.tar.gz`);
    writeFileSync(badFile, "not a tarball at all");
    const { exitCode } = runRestore([badFile]);
    expect(exitCode).not.toBe(0);
    rmSync(badFile, { force: true });
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  it("two backups to different paths both succeed", () => {
    const out1 = join(tmpdir(), `awo-idempotent-1-${Date.now()}.tar.gz`);
    const out2 = join(tmpdir(), `awo-idempotent-2-${Date.now()}.tar.gz`);
    const r1 = runBackup(["--out", out1]);
    const r2 = runBackup(["--out", out2]);
    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);
    expect(existsSync(out1)).toBe(true);
    expect(existsSync(out2)).toBe(true);
    rmSync(out1, { force: true });
    rmSync(out2, { force: true });
  });
});
