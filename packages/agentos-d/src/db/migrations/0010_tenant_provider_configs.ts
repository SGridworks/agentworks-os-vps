/**
 * Migration 0010 — tenant_provider_configs
 *
 * Per-tenant credential storage for third-party provider API keys and config.
 * Each (tenant_id, provider_name, config_key) tuple is unique.
 * config_value is encrypted at rest (AES-256-GCM via secureStorage).
 *
 * Forward-only, idempotent via __drizzle_migrations hash.
 */

import type { Database } from "better-sqlite3";

export function migrate(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  const existing = sqlite
    .prepare("SELECT 1 FROM __drizzle_migrations WHERE hash = ?")
    .get("v10-tenant-provider-configs");
  if (existing) return;

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS tenant_provider_configs (
      id              TEXT PRIMARY KEY,
      tenant_id       TEXT NOT NULL,
      provider_name   TEXT NOT NULL,
      config_key      TEXT NOT NULL,
      config_value    TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      UNIQUE(tenant_id, provider_name, config_key)
    );

    CREATE INDEX IF NOT EXISTS idx_tenant_provider_configs_tenant
    ON tenant_provider_configs(tenant_id);
  `);

  sqlite
    .prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)")
    .run("v10-tenant-provider-configs");
}
