/**
 * Migration 0027: backfill instructions_path from on-disk agents/<role>/AGENTS.md.
 *
 * Agents imported from a legacy system kept only their adapter type and
 * source id — the link to their prompt file (AGENTS.md) was never set. The
 * Agents detail
 * page therefore showed dashes for every config field. We resolve the prompt
 * file by role: if `agents/<role>/AGENTS.md` exists relative to AWOS_AGENTS_ROOT,
 * we set `instructions_path = "<role>/AGENTS.md"`. Idempotent: only writes when
 * the existing value is NULL.
 *
 * AWOS_AGENTS_ROOT defaults to <repo>/agents (resolved from packages/agentos-d
 * via ../../agents). Override at startup if the layout differs.
 */

import fs from "node:fs";
import path from "node:path";
import type { Database } from "better-sqlite3";

const HASH = "v27-agent-instructions-backfill";

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

  const root =
    process.env.AWOS_AGENTS_ROOT ??
    path.resolve(process.cwd(), "..", "..", "agents");

  const rows = sqlite
    .prepare(
      "SELECT id, role FROM execution_agents WHERE instructions_path IS NULL AND role IS NOT NULL AND role != ''"
    )
    .all() as Array<{ id: string; role: string }>;

  const update = sqlite.prepare(
    "UPDATE execution_agents SET instructions_path = ? WHERE id = ? AND instructions_path IS NULL"
  );

  for (const r of rows) {
    const rel = `${r.role}/AGENTS.md`;
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) update.run(rel, r.id);
  }

  sqlite.prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)").run(HASH);
}
