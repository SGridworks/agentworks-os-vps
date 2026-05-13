/**
 * SQLite client via better-sqlite3 + drizzle-orm.
 * Initialises the DB, runs migrations, exposes the typed instance.
 */

import Database, { type Database as DatabaseType } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { loadConfig, type Config } from "../config.js";

let _db: ReturnType<typeof drizzle> | null = null;
let _sqlite: Database.Database | null = null;

export function getDb(): ReturnType<typeof drizzle> {
  if (_db) return _db;
  throw new Error("DB not initialized — call initDb() first");
}

export function getSqlite(): Database.Database {
  if (_sqlite) return _sqlite;
  throw new Error("SQLite not initialized — call initDb() first");
}

export interface InitDbOptions {
  config?: Config;
  migrations?: typeof import("./migrations/index.js").migrate;
}

/**
 * Open (or create) the SQLite DB file and run migrations.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function initDb(
  opts: InitDbOptions = {}
): ReturnType<typeof drizzle> {
  if (_db) return _db;

  const config = opts.config ?? loadConfig();
  const dataDir = (opts.config ?? loadConfig()).dataDir ?? join(process.cwd(), "data");
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = join(dataDir, "agentworks.db");
  _sqlite = new Database(dbPath);
  _sqlite.pragma("journal_mode = WAL");
  _sqlite.pragma("foreign_keys = ON");

  _db = drizzle(_sqlite);

  // Run migrations if provided
  if (opts.migrations) {
    opts.migrations(_sqlite);
  }

  return _db;
}

/** Reset DB state — for testing only. */
export function resetDb(): void {
  _db = null;
  _sqlite?.close();
  _sqlite = null;
}
