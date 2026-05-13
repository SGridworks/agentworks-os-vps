/**
 * Migration 0032: align execution_agent_task_sessions.status with the
 * runtime-state vocabulary (running | succeeded | failed | blocked).
 *
 * The route previously accepted only open|closed|failed which diverged
 * from the lastRunStatus enum used everywhere else. The route schema now
 * accepts both forms and transforms open→running, closed→succeeded.
 * This migration rewrites legacy rows so reads are consistent.
 */

import type { Database } from "better-sqlite3";

const HASH = "v32-task-session-status-align";

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

  sqlite
    .prepare("UPDATE execution_agent_task_sessions SET status = 'running' WHERE status = 'open'")
    .run();
  sqlite
    .prepare("UPDATE execution_agent_task_sessions SET status = 'succeeded' WHERE status = 'closed'")
    .run();

  sqlite.prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)").run(HASH);
}
