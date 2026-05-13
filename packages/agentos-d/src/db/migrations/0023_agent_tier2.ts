/**
 * Migration 0023: Tier 2 agent surface — hierarchy, budget, runtime state,
 * config revisions, and task sessions.
 *
 *   execution_agents
 *     + reports_to              (FK to another agent — manager hierarchy)
 *     + budget_monthly_cents    (per-agent monthly cap, 0 = unlimited)
 *     + spent_monthly_cents     (rolling spend within current month)
 *     + budget_period_start     (ISO date when the rolling window started)
 *
 *   execution_agent_runtime_state (1:1 with agents)
 *     Live state reported by the agent runtime (adapter): current session,
 *     last run, accumulated token + cost counters, last error.
 *
 *   execution_agent_config_revisions (audit, append-only)
 *     A row for every PATCH /agents/:id mutation. Records who, when, what
 *     keys changed, and the before/after config JSON.
 *
 *   execution_agent_task_sessions
 *     Resumable LLM sessions keyed by task. Lets a long-running issue
 *     thread reuse the same provider session across heartbeats.
 *
 * Idempotent: ALTER TABLE ADD COLUMN is wrapped in try/catch on duplicate;
 * CREATE TABLE uses IF NOT EXISTS.
 */

import type { Database } from "better-sqlite3";

const HASH = "v23-agent-tier2";

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

  // Extend execution_agents
  const newCols: Array<[string, string]> = [
    ["reports_to", "TEXT"],
    ["budget_monthly_cents", "INTEGER NOT NULL DEFAULT 0"],
    ["spent_monthly_cents", "INTEGER NOT NULL DEFAULT 0"],
    ["budget_period_start", "TEXT"],
  ];
  for (const [name, type] of newCols) {
    try {
      sqlite.exec(`ALTER TABLE execution_agents ADD COLUMN ${name} ${type};`);
    } catch (err: any) {
      if (!/duplicate column name/i.test(String(err?.message ?? ""))) throw err;
    }
  }

  // Runtime state — 1:1 with agents
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS execution_agent_runtime_state (
      agent_id TEXT PRIMARY KEY REFERENCES execution_agents(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL,
      session_id TEXT,
      last_run_id TEXT,
      last_run_status TEXT,
      last_run_at TEXT,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_cents INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_error_at TEXT,
      updated_at TEXT NOT NULL
    );
  `);

  // Config revisions — append-only audit log
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS execution_agent_config_revisions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES execution_agents(id) ON DELETE CASCADE,
      actor_kind TEXT NOT NULL,
      actor_id TEXT,
      source TEXT,
      changed_keys_json TEXT NOT NULL,
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_exec_agent_revs_agent
      ON execution_agent_config_revisions(agent_id, created_at DESC);
  `);

  // Task sessions
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS execution_agent_task_sessions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES execution_agents(id) ON DELETE CASCADE,
      issue_id TEXT REFERENCES execution_issues(id) ON DELETE SET NULL,
      task_key TEXT NOT NULL,
      adapter_type TEXT,
      session_params_json TEXT,
      session_display_id TEXT,
      last_run_id TEXT,
      last_error TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, task_key)
    );
    CREATE INDEX IF NOT EXISTS idx_exec_agent_sessions_agent
      ON execution_agent_task_sessions(agent_id, updated_at DESC);
  `);

  sqlite.prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)").run(HASH);
}
