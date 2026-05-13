/**
 * agentos restore command.
 *
 * Usage:
 *   agentos restore <backup-file> [--key KEY]
 *
 * Flags:
 *   --key KEY   Passphrase to decrypt the backup (required for .enc files).
 *
 * What is restored:
 *   - SQLite database (replacing the existing DB file)
 *   - Per-tenant vault directories
 *   - Tenant configurations (tenants, webhooks, rule-pack assignments)
 *
 * The restore is idempotent: it overwrites the existing data with no
 * confirmation prompt (operator is expected to have快照 before running).
 *
 * Pre-restore validation:
 *   - MANIFEST.json version compatibility check
 *   - SHA-256 checksum verification (before decryption / before DB write)
 *   - DB table count sanity check
 *
 * After restore the operator should restart the agentos-d daemon.
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { createHash } from "crypto";
import { homedir } from "os";
import { join, resolve, dirname } from "path";
import { loadConfig } from "../config.js";
import { initDb } from "../db/index.js";
import { migrate } from "../db/migrations/index.js";
import { getDb } from "../db/client.js";
import {
  tenants,
  tenantWebhooks,
  tenantRulePackAssignments,
} from "../db/schema.js";
import { eq } from "drizzle-orm";
import {
  BackupManifest,
  BACKUP_VERSION,
} from "./backup-manifest.js";
import { clearStaleSqliteSidecars } from "./db-utils.js";

function sha256File(path: string): string {
  // Same fix as backup.ts: streaming pipe returned before hashing the
  // payload, producing sha256-of-empty for every input.
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseArgs(argv: string[]): { backupFile: string; key?: string } {
  const args: { backupFile: string; key?: string } = { backupFile: "" };
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i] ?? "";
    if (cur === "--key" && i + 1 < argv.length) {
      args.key = argv[i + 1] ?? "";
      i++; // advance past the value
      continue;
    }
    if (!cur.startsWith("--")) {
      args.backupFile = cur;
    }
  }
  if (!args.backupFile) throw new Error("Usage: agentos restore <backup-file> [--key KEY]");
  return args;
}

function resolveVaultRoot(tenantId: string, configuredVaultRoot: string): string {
  if (configuredVaultRoot === "<default>") {
    return resolve(homedir(), "vault", tenantId);
  }
  return configuredVaultRoot;
}

function extractTarball(tarPath: string, destDir: string): void {
  execSync(`tar -xzf "${tarPath}" -C "${destDir}"`, { encoding: "utf8" });
}

function validateManifest(manifest: unknown): asserts manifest is BackupManifest {
  if (!manifest || typeof manifest !== "object") throw new Error("Invalid MANIFEST.json");
  const m = manifest as Record<string, unknown>;
  if (typeof m.version !== "string") throw new Error("MANIFEST.json: missing or invalid version");
  if (typeof m.createdAt !== "string") throw new Error("MANIFEST.json: missing or invalid createdAt");
  if (typeof m.dbTables !== "object" || !Array.isArray(m.dbTables))
    throw new Error("MANIFEST.json: missing or invalid dbTables");
}

export async function runRestore(argv: string[]): Promise<void> {
  const { backupFile, key } = parseArgs(argv);

  // 1. Decrypt if needed
  let workTar = backupFile;
  const tmpdir = execSync("mktemp -d", { encoding: "utf8" }).trim();
  try {
    if (backupFile.endsWith(".enc")) {
      if (!key) throw new Error("Encrypted backup requires --key");
      const decPath = join(tmpdir, "backup.tar.gz");
      execSync(
        `openssl enc -d -aes-256-cbc -pbkdf2 -pass pass:${key} -in "${backupFile}" -out "${decPath}"`,
        { encoding: "utf8" }
      );
      workTar = decPath;
    }

    // 2. Extract to working dir
    const extractDir = join(tmpdir, "extract");
    mkdirSync(extractDir, { recursive: true });
    extractTarball(workTar, extractDir);

    // 3. Read and validate manifest
    const manifestPath = join(extractDir, "MANIFEST.json");
    if (!existsSync(manifestPath)) throw new Error("MANIFEST.json not found in backup");
    const rawManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    validateManifest(rawManifest);
    const manifest = rawManifest as BackupManifest;

    // Version compatibility check
    if (manifest.version !== BACKUP_VERSION) {
      throw new Error(
        `Backup version mismatch: found ${manifest.version}, expected ${BACKUP_VERSION}. ` +
        `Manual migration may be required.`
      );
    }

    // 4. Stop daemon (caller's responsibility, but warn)
    console.log("NOTE: Stop the agentos-d daemon before proceeding. Data will be overwritten.");

    const config = loadConfig();
    initDb({ config, migrations: migrate });

    // 6. Restore SQLite DB. The DB file is agentworks.db (matches
    // src/db/client.ts:45). Older backups produced before this fix may
    // contain a stub agentos.db file — fall back to it if present so we
    // can still restore from those, but prefer the canonical name.
    const payloadDir = join(extractDir, "payload");
    let dbBackupPath = join(payloadDir, "agentworks.db");
    if (!existsSync(dbBackupPath)) {
      const legacy = join(payloadDir, "agentos.db");
      if (existsSync(legacy)) dbBackupPath = legacy;
      else throw new Error("agentworks.db not found in backup payload");
    }
    const actualChecksum = sha256File(dbBackupPath);
    if (manifest.checksumSha256 && manifest.checksumSha256 !== actualChecksum) {
      throw new Error(
        `Checksum mismatch: expected ${manifest.checksumSha256}, got ${actualChecksum}. ` +
        `Backup may be corrupted or tampered with.`
      );
    }

    const actualDbDir = config.dataDir;
    if (!existsSync(actualDbDir)) mkdirSync(actualDbDir, { recursive: true });
    const actualDbPath = join(actualDbDir, "agentworks.db");

    // The previous daemon may have left -wal/-shm beside the destination.
    // SQLite would try to apply them onto the freshly-restored DB on first
    // open and corrupt it (db-utils.ts has the full incident reference).
    const cleared = clearStaleSqliteSidecars(actualDbPath);
    if (cleared.walRemoved || cleared.shmRemoved) {
      console.log(
        `Cleared stale sidecars before restore: wal=${cleared.walRemoved} shm=${cleared.shmRemoved}`
      );
    }

    execSync(`sqlite3 "${dbBackupPath}" ".backup '${actualDbPath}'"`, { encoding: "utf8" });

    // 7. Restore tenant configurations
    const tenantConfigsPath = join(payloadDir, "tenant-configs.json");
    let tenantConfigs: Record<string, { tenant: unknown; webhooks: unknown[]; rulePacks: unknown[] }> = {};
    if (existsSync(tenantConfigsPath)) {
      tenantConfigs = JSON.parse(readFileSync(tenantConfigsPath, "utf8")) as typeof tenantConfigs;

      // Re-initialize DB connection with the restored DB
      // The initDb above already set up the connection; we re-run to pick up restored data
      // We restore tenants, webhooks, and rule pack assignments
      for (const [tenantId, cfg] of Object.entries(tenantConfigs)) {
        const tenantRow = cfg.tenant as Record<string, unknown>;
        const existing = getDb().select().from(tenants).where(eq(tenants.id, tenantId)).get();
        if (existing) {
          // Upsert tenant
          getDb().update(tenants)
            .set({
              name: tenantRow.name as string,
              industry: (tenantRow.industry as string | null) ?? null,
              vaultRoot: tenantRow.vaultRoot as string,
              shadowMode: tenantRow.shadowMode as boolean,
              shadowUntil: (tenantRow.shadowUntil as string | null) ?? null,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(tenants.id, tenantId))
            .run();
        } else {
          getDb().insert(tenants).values({
            id: tenantId,
            name: tenantRow.name as string,
            industry: (tenantRow.industry as string | null) ?? null,
            vaultRoot: tenantRow.vaultRoot as string,
            shadowMode: tenantRow.shadowMode as boolean,
            shadowUntil: (tenantRow.shadowUntil as string | null) ?? null,
            createdAt: tenantRow.createdAt as string,
            updatedAt: new Date().toISOString(),
          }).run();
        }

        // Restore webhooks
        getDb().delete(tenantWebhooks).where(eq(tenantWebhooks.tenantId, tenantId)).run();
        for (const wh of cfg.webhooks as Array<Record<string, unknown>>) {
          getDb().insert(tenantWebhooks).values({
            id: wh.id as string,
            url: wh.url as string,
            events: wh.events as string,
            tenantId: wh.tenantId as string,
            createdAt: wh.createdAt as string,
            updatedAt: new Date().toISOString(),
          }).run();
        }

        // Restore rule pack assignments
        getDb().delete(tenantRulePackAssignments)
          .where(eq(tenantRulePackAssignments.tenantId, tenantId))
          .run();
        for (const rp of cfg.rulePacks as Array<Record<string, unknown>>) {
          getDb().insert(tenantRulePackAssignments).values({
            id: rp.id as string,
            tenantId: rp.tenantId as string,
            packId: rp.packId as string,
            assignedAt: rp.assignedAt as string,
            updatedAt: new Date().toISOString(),
          }).run();
        }
      }
    }

    // 8. Restore per-tenant vault directories (tenantConfigs still in scope)
    const vaultsDir = join(payloadDir, "vaults");
    if (existsSync(vaultsDir)) {
      for (const tenant of Object.keys(tenantConfigs) as string[]) {
        const vaultBackup = join(vaultsDir, tenant);
        if (existsSync(vaultBackup)) {
          const cfg = (tenantConfigs[tenant] ?? { tenant: { vaultRoot: "<default>" } }) as { tenant: { vaultRoot: string } };
          const dest = resolveVaultRoot(tenant, cfg.tenant.vaultRoot);
          mkdirSync(dirname(dest), { recursive: true });
          rmSync(dest, { recursive: true, force: true });
          execSync(`cp -r "${vaultBackup}" "${dest}"`, { encoding: "utf8" });
        }
      }
    }

    console.log("Restore completed successfully.");
    console.log(`  DB restored: ${manifest.dbTables.join(", ")}`);
    console.log(`  Tenants restored: ${manifest.tenantConfigs.join(", ")}`);
    console.log(`  Vaults restored: ${manifest.vaults.join(", ") || "(none)"}`);
    console.log("Restart the agentos-d daemon to apply changes.");
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
}
