/**
 * Migration 0021: hot-path indexes on execution_* tables.
 *
 * Adds indexes that 0020 missed for queries used by ProcessWatcher,
 * the admin BFF, and agent inbox-lite — all of which filter execution_issues
 * by company_id and look up most-recent comments per issue.
 */

import type { Database } from "better-sqlite3";

const HASH = "v21-execution-indexes";

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
    CREATE INDEX IF NOT EXISTS idx_exec_issues_company ON execution_issues(company_id);
    CREATE INDEX IF NOT EXISTS idx_exec_issues_company_status ON execution_issues(company_id, status);
    CREATE INDEX IF NOT EXISTS idx_exec_issue_comments_issue ON execution_issue_comments(issue_id);
    CREATE INDEX IF NOT EXISTS idx_exec_runs_company ON execution_runs(company_id);
  `);

  sqlite.prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)").run(HASH);
}
