/**
 * Migration 0024: Episodes table — phase 1a of memory architecture.
 *
 *   episodes
 *     Persistent record of one closed agent session (or any work unit
 *     that has a beginning, middle, and end). Stores the LLM-generated
 *     summary, importance score, embedding of the summary, and metadata
 *     for retrieval (role, task_type, outcome).
 *
 *   episodes_fts
 *     SQLite FTS5 virtual table over `summary` for sparse (BM25) lookup.
 *     Combined with the embedding BLOB this enables hybrid retrieval
 *     (Phase 1c).
 *
 * The embedding column is BLOB (raw little-endian Float32). Vectors are
 * 768-dim by default (BAAI/bge-base-en-v1.5); the actual model that
 * produced a vector is recorded in `embedding_model` so we can detect
 * mismatches if the model is upgraded.
 *
 * Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, hash check guards rerun.
 */

import type { Database } from "better-sqlite3";

const HASH = "v24-episodes";

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
    .get(HASH);
  if (existing) return;

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      agent_id TEXT,
      session_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      duration_sec INTEGER NOT NULL,
      role TEXT,
      task_type TEXT,
      outcome TEXT,
      summary TEXT NOT NULL,
      embedding BLOB,
      embedding_model TEXT,
      importance INTEGER NOT NULL DEFAULT 1,
      lifecycle TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_episodes_tenant_role
      ON episodes(tenant_id, role);
    CREATE INDEX IF NOT EXISTS idx_episodes_session
      ON episodes(session_id);
    CREATE INDEX IF NOT EXISTS idx_episodes_started_at
      ON episodes(tenant_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_episodes_lifecycle
      ON episodes(tenant_id, lifecycle);
  `);

  // FTS5 virtual table for sparse retrieval. Content-less external-content
  // mode would save space but complicates triggers; for v1 we just write
  // summary into the FTS index alongside the row.
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
      id UNINDEXED,
      tenant_id UNINDEXED,
      summary,
      tokenize = 'porter unicode61'
    );
  `);

  sqlite.prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)").run(HASH);
}
