/**
 * agentos backup command.
 *
 * Usage:
 *   agentos backup [--out PATH] [--key KEY]
 *
 * Flags:
 *   --out PATH   Output tarball path. Default: agentworks-backup-{ISO-timestamp}.tar.gz
 *   --key KEY    Passphrase for AES-256-CBC encryption. Omit for unencrypted backup.
 *
 * What is included:
 *   - SQLite .backup of the agentos-d database (all tables)
 *   - Per-tenant vault directories (listed in tenants table)
 *   - Tenant configurations (tenants, tenant_webhooks, tenant_rule_pack_assignments)
 *   - MANIFEST.json with version, contents, and SHA-256 checksum
 *
 * The tarball is unencrypted unless --key is provided.
 * Encrypted backups are suffixed .enc and decrypted in-place during restore.
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { createHash } from "crypto";
import { homedir, hostname } from "os";
import { join, resolve } from "path";
import { loadConfig } from "../config.js";
import { initDb } from "../db/index.js";
import { migrate } from "../db/migrations/index.js";
import { getDb } from "../db/client.js";
import { tenants, tenantWebhooks, tenantRulePackAssignments } from "../db/schema.js";
import { eq } from "drizzle-orm";
import {
  BackupManifest,
  BACKUP_VERSION,
  listDbTables,
} from "./backup-manifest.js";
import { assertBackupCapturedSourceData } from "./db-utils.js";

function sha256File(path: string): string {
  // The earlier streaming form (createReadStream(path).pipe(hash))
  // returned the hash digest before the pipe had emitted any data,
  // producing the empty-input digest for every input. Read sync.
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseArgs(argv: string[]): { outPath?: string; key?: string } {
  const args: { outPath?: string; key?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i];
    if (cur === "--out" && i + 1 < argv.length) {
      const val = argv[i + 1];
      if (val !== undefined) args.outPath = val;
    } else if (cur === "--key" && i + 1 < argv.length) {
      const val = argv[i + 1];
      if (val !== undefined) args.key = val;
    }
  }
  return args;
}

function resolveVaultRoot(tenantId: string, configuredVaultRoot: string): string {
  // If vault_root is "<default>", use the conventional path
  if (configuredVaultRoot === "<default>") {
    return resolve(homedir(), "vault", tenantId);
  }
  return configuredVaultRoot;
}

export async function runBackup(argv: string[]): Promise<void> {
  const { outPath, key } = parseArgs(argv);

  initDb({ config: loadConfig(), migrations: migrate });

  // Collect tenant data
  const allTenants = getDb().select().from(tenants).all();
  const vaultTenantIds = allTenants
    .filter((t) => t.vaultRoot !== "<default>" && existsSync(resolveVaultRoot(t.id, t.vaultRoot)))
    .map((t) => t.id);

  // Create working directory
  const tmpdir = execSync("mktemp -d", { encoding: "utf8" }).trim();
  const payloadDir = join(tmpdir, "payload");
  mkdirSync(payloadDir, { recursive: true });

  try {
    // 1. SQLite backup — use .backup command for consistent state.
    // The DB file is agentworks.db (matches src/db/client.ts:45). The earlier
    // agentos.db filename here was a bug — sqlite3 .backup against a missing
    // path silently produced an empty payload.
    const config = loadConfig();
    const actualDbPath = join(config.dataDir, "agentworks.db");
    if (!existsSync(actualDbPath)) {
      throw new Error(`agentworks.db not found at ${actualDbPath}`);
    }
    const dbPath = join(payloadDir, "agentworks.db");
    execSync(`sqlite3 "${actualDbPath}" ".backup '${dbPath}'"`, { encoding: "utf8" });

    // Refuse to ship a backup that disagrees with the live DB. Without
    // this, .backup against a freshly-wiped DB produces a tarball of an
    // empty schema (~17KB) and reports success — see db-utils.ts.
    assertBackupCapturedSourceData(actualDbPath, dbPath, "tenants");

    // 2. Export tenant configs as JSON
    const tenantConfigs: Record<string, unknown> = {};
    for (const tenant of allTenants) {
      const webhooks = getDb()
        .select()
        .from(tenantWebhooks)
        .where(eq(tenantWebhooks.tenantId, tenant.id))
        .all();
      const rulePacks = getDb()
        .select()
        .from(tenantRulePackAssignments)
        .where(eq(tenantRulePackAssignments.tenantId, tenant.id))
        .all();
      tenantConfigs[tenant.id] = { tenant, webhooks, rulePacks };
    }
    writeFileSync(
      join(payloadDir, "tenant-configs.json"),
      JSON.stringify(tenantConfigs, null, 2),
      "utf8"
    );

    // 3. Copy per-tenant vault directories
    const vaultsDir = join(payloadDir, "vaults");
    mkdirSync(vaultsDir, { recursive: true });
    for (const tenant of allTenants) {
      const vaultPath = resolveVaultRoot(tenant.id, tenant.vaultRoot);
      if (existsSync(vaultPath)) {
        const dest = join(vaultsDir, tenant.id);
        execSync(`cp -r "${vaultPath}" "${dest}"`, { encoding: "utf8" });
      }
    }

    // 4. Write MANIFEST.json
    const checksum = sha256File(dbPath);
    const manifest: BackupManifest = {
      version: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      hostname: hostname(),
      dbTables: listDbTables(),
      vaults: vaultTenantIds,
      rulePackAssignments: true,
      tenantConfigs: allTenants.map((t) => t.id),
      checksumSha256: checksum,
    };
    writeFileSync(
      join(tmpdir, "MANIFEST.json"),
      JSON.stringify(manifest, null, 2),
      "utf8"
    );

    // 5. Create tarball (before encryption)
    const defaultOut = `agentworks-backup-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.tar.gz`;
    const tarPath = outPath ?? defaultOut;
    execSync(`tar -czf "${tarPath}" -C "${tmpdir}" .`, { encoding: "utf8" });

    // 6. Encrypt if key provided
    if (key) {
      const encPath = `${tarPath}.enc`;
      execSync(
        `openssl enc -aes-256-cbc -salt -pbkdf2 -pass pass:${key} -in "${tarPath}" -out "${encPath}"`,
        { encoding: "utf8" }
      );
      rmSync(tarPath);
      console.log(`Encrypted backup saved to ${encPath}`);
    } else {
      console.log(`Backup saved to ${tarPath}`);
    }

    console.log(`  version: ${BACKUP_VERSION}`);
    console.log(`  tables: ${manifest.dbTables.join(", ")}`);
    console.log(`  tenants: ${manifest.tenantConfigs.join(", ")}`);
    console.log(`  vaults: ${manifest.vaults.join(", ") || "(none)"}`);
    console.log(`  SHA-256: ${checksum}`);
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
}
