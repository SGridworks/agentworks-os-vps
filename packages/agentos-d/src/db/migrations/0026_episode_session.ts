/**
 * Migration 0026: episode_session_id on execution_runs.
 *
 * Phase 1c follow-up — episode boundary fix.
 *
 * Before: one execution_run = one episode. A burst of five quick agent
 * invocations produced five fragmented episodes that retrieval had to
 * stitch back together. The corpus drowned in noise.
 *
 * After: runs are grouped into "sessions" by an idle-timeout heuristic.
 * If a new run starts within EPISODE_IDLE_TIMEOUT_MIN minutes of the same
 * agent's previous run end, both runs share an episode_session_id; their
 * events are merged into one episode that grows over time. The grouping
 * happens in the episode-from-run hook, not in the daemon — runs always
 * record cleanly even if the hook is off.
 *
 * Idempotent: ALTER TABLE wrapped in try/catch on duplicate column, hash
 * check guards rerun.
 */

import type { Database } from "better-sqlite3";

const HASH = "v26-episode-session";

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

  try {
    sqlite.exec(`ALTER TABLE execution_runs ADD COLUMN episode_session_id TEXT;`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) throw err;
  }

  // episodes was write-once before. Now that runs can append into an
  // existing episode, an audit field for the last update is useful.
  try {
    sqlite.exec(`ALTER TABLE episodes ADD COLUMN updated_at TEXT;`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) throw err;
  }

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_exec_runs_episode_session
      ON execution_runs(tenant_id, agent_id, episode_session_id);
    CREATE INDEX IF NOT EXISTS idx_exec_runs_agent_started
      ON execution_runs(tenant_id, agent_id, started_at DESC);
  `);

  sqlite.prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)").run(HASH);
}
