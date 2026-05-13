/**
 * Migration 0029: backfill instructions_path by name alias for AWOS team
 * agents whose role is generic ("engineer", "researcher", etc.) but whose
 * NAME maps to a folder under <agentsRoot>.
 *
 * Examples: BackendEngineer -> backend, FrontendEngineer -> frontend,
 * TechLead -> techlead, ProcessWatcher -> processwatcher.
 *
 * Run after 0027 (role-folder match). Idempotent: only writes when the
 * existing value is NULL.
 */

import fs from "node:fs";
import path from "node:path";
import type { Database } from "better-sqlite3";

const HASH = "v29-agent-instructions-name-alias";

const NAME_TO_FOLDER: Record<string, string> = {
  backendengineer: "backend",
  frontendengineer: "frontend",
  pythonengineer: "python",
  devopsengineer: "devops",
  qaengineer: "qa",
  techlead: "techlead",
  processwatcher: "processwatcher",
  technicalwriter: "writer",
  complianceconsultant: "compliance",
};

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
      "SELECT id, name FROM execution_agents WHERE instructions_path IS NULL AND name IS NOT NULL"
    )
    .all() as Array<{ id: string; name: string }>;

  const update = sqlite.prepare(
    "UPDATE execution_agents SET instructions_path = ? WHERE id = ? AND instructions_path IS NULL"
  );

  for (const r of rows) {
    const key = r.name.toLowerCase().replace(/[\s_-]/g, "");
    const folder = NAME_TO_FOLDER[key];
    if (!folder) continue;
    const rel = `${folder}/AGENTS.md`;
    if (fs.existsSync(path.join(root, rel))) update.run(rel, r.id);
  }

  sqlite.prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)").run(HASH);
}
