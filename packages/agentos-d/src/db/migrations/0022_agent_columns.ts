/**
 * Migration 0022: agent operability columns + wakeup audit log.
 *
 * Promotes structured fields from `execution_agents.config_json` JSON into
 * top-level columns:
 *   - adapter_type            (e.g. "claude_local")
 *   - model                   (e.g. "claude-opus-4-7")
 *   - instructions_path       (path to the agent's AGENTS.md)
 *   - capabilities            (free-text)
 *   - heartbeat_interval_sec  (runtime_config.heartbeat.intervalSec)
 *   - wake_on_demand          (runtime_config.heartbeat.wakeOnDemand, 0/1)
 *   - last_heartbeat_at       (stamped whenever the agent calls AWOS)
 *   - pause_reason / paused_at (richer pause semantics than just status)
 *
 * Backfills each new column from existing config_json on rows already
 * present (idempotent — only writes NULLs).
 *
 * Also creates execution_agent_wakeups, a forward-only audit log of every
 * POST /agents/:id/wakeup call. Used by Mission Control to show a wakeup
 * timeline and by ProcessWatcher to detect pile-ups.
 */

import type { Database } from "better-sqlite3";

const HASH = "v22-agent-columns";

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

  // Add columns to execution_agents. SQLite allows ALTER TABLE ADD COLUMN
  // but errors if the column already exists, so wrap each in a try/catch
  // so the migration is safe if a previous attempt partially applied.
  const newCols: Array<[string, string]> = [
    ["adapter_type", "TEXT"],
    ["model", "TEXT"],
    ["instructions_path", "TEXT"],
    ["capabilities", "TEXT"],
    ["heartbeat_interval_sec", "INTEGER"],
    ["wake_on_demand", "INTEGER"],
    ["last_heartbeat_at", "TEXT"],
    ["pause_reason", "TEXT"],
    ["paused_at", "TEXT"],
  ];
  for (const [name, type] of newCols) {
    try {
      sqlite.exec(`ALTER TABLE execution_agents ADD COLUMN ${name} ${type};`);
    } catch (err: any) {
      if (!/duplicate column name/i.test(String(err?.message ?? ""))) throw err;
    }
  }

  // Backfill from config_json. We pull every agent and project the JSON
  // shape the import script wrote (config.adapterType / config.model /
  // config.capabilities / config.runtimeConfig.heartbeat).
  const rows = sqlite
    .prepare(
      "SELECT id, config_json FROM execution_agents WHERE adapter_type IS NULL OR model IS NULL OR capabilities IS NULL OR heartbeat_interval_sec IS NULL"
    )
    .all() as Array<{ id: string; config_json: string | null }>;

  const update = sqlite.prepare(`
    UPDATE execution_agents SET
      adapter_type = COALESCE(adapter_type, @adapterType),
      model = COALESCE(model, @model),
      instructions_path = COALESCE(instructions_path, @instructionsPath),
      capabilities = COALESCE(capabilities, @capabilities),
      heartbeat_interval_sec = COALESCE(heartbeat_interval_sec, @heartbeatIntervalSec),
      wake_on_demand = COALESCE(wake_on_demand, @wakeOnDemand)
    WHERE id = @id
  `);

  for (const r of rows) {
    let cfg: any = {};
    try {
      cfg = r.config_json ? JSON.parse(r.config_json) : {};
    } catch {
      cfg = {};
    }
    const adapterCfg = cfg.adapterConfig ?? {};
    const runtimeCfg = cfg.runtimeConfig ?? {};
    const heartbeat = runtimeCfg.heartbeat ?? {};
    update.run({
      id: r.id,
      adapterType: cfg.adapterType ?? null,
      model: adapterCfg.model ?? cfg.model ?? null,
      instructionsPath: cfg.instructionsPath ?? null,
      capabilities: cfg.capabilities ?? null,
      heartbeatIntervalSec:
        typeof heartbeat.intervalSec === "number" ? heartbeat.intervalSec : null,
      wakeOnDemand: heartbeat.wakeOnDemand === true ? 1 : heartbeat.wakeOnDemand === false ? 0 : null,
    });
  }

  // Wakeup audit log
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS execution_agent_wakeups (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES execution_agents(id) ON DELETE CASCADE,
      source TEXT,
      trigger_detail TEXT,
      reason TEXT,
      payload_json TEXT,
      idempotency_key TEXT,
      coalesced_count INTEGER NOT NULL DEFAULT 1,
      dispatch_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_exec_agent_wakeups_agent
      ON execution_agent_wakeups(agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_exec_agent_wakeups_idem
      ON execution_agent_wakeups(agent_id, idempotency_key);
  `);

  sqlite.prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)").run(HASH);
}
