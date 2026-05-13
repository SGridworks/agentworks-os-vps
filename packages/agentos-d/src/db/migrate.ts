/**
 * Standalone migration runner.
 * Run with: node --import tsx src/db/migrate.ts
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { loadConfig } from "../config.js";
import { migrate } from "./migrations/index.js";

const config = loadConfig();
const dataDir = config.dataDir ?? "./data";
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
  console.log(`[migrate] created data directory: ${dataDir}`);
}

const dbPath = `${dataDir}/agentworks.db`;
console.log(`[migrate] opening ${dbPath}`);

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

migrate(sqlite);

const tables = sqlite
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all();
console.log("[migrate] tables:", tables.map((t: any) => t.name));

const applied = sqlite
  .prepare("SELECT hash FROM __drizzle_migrations")
  .all();
console.log("[migrate] migrations applied:", applied.map((m: any) => m.hash));

sqlite.close();
console.log("[migrate] done");
