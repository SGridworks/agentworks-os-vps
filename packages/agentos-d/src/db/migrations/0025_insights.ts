/**
 * Migration 0025: Insights table — phase 1b of memory architecture.
 *
 *   insights
 *     Atomic, frame-typed extracted facts from episodes or feedback
 *     comments. Each insight is one short sentence with a frame_type
 *     (preference, fact, plan, constraint, feedback, error_pattern)
 *     and an optional subject (the entity it's about). ~10x denser
 *     than raw conversation.
 *
 *   insights_fts
 *     SQLite FTS5 over `content` for sparse retrieval.
 *
 * The episode_id FK is nullable because insights can be extracted from
 * sources other than session episodes (e.g., a feedback comment posted
 * directly).
 *
 * Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, hash check guards rerun.
 */

import type { Database } from "better-sqlite3";

const HASH = "v25-insights";

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
    CREATE TABLE IF NOT EXISTS insights (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
      frame_type TEXT NOT NULL,
      subject TEXT,
      content TEXT NOT NULL,
      embedding BLOB,
      embedding_model TEXT,
      importance INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL,
      validated INTEGER NOT NULL DEFAULT 0,
      lifecycle TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      CHECK (frame_type IN ('preference','fact','plan','constraint','feedback','error_pattern')),
      CHECK (source IN ('agent_reflection','user_correction','task_outcome','manual')),
      CHECK (lifecycle IN ('active','archived','invalidated'))
    );
    CREATE INDEX IF NOT EXISTS idx_insights_tenant_frame
      ON insights(tenant_id, frame_type);
    CREATE INDEX IF NOT EXISTS idx_insights_subject
      ON insights(subject);
    CREATE INDEX IF NOT EXISTS idx_insights_episode
      ON insights(episode_id);
    CREATE INDEX IF NOT EXISTS idx_insights_lifecycle
      ON insights(tenant_id, lifecycle);
  `);

  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS insights_fts USING fts5(
      id UNINDEXED,
      tenant_id UNINDEXED,
      frame_type UNINDEXED,
      content,
      tokenize = 'porter unicode61'
    );
  `);

  sqlite.prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)").run(HASH);
}
