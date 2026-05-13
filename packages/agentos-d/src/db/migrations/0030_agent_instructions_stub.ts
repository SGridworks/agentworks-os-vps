/**
 * Migration 0030: create empty AGENTS.md stubs for any AWOS agent that still
 * has NULL instructions_path after the role-folder match (0027) and the
 * name-alias match (0029).
 *
 * Without a stub file the user can't open the inline editor in admin-ui
 * because the instructions card refuses to render a textarea when no path
 * is set. We seed a one-line skeleton ("# <name>") so the editor opens, and
 * the user fills in the rest.
 *
 * Stubs go to <agentsRoot>/_imported/<agentId>.md. Idempotent.
 */

import fs from "node:fs";
import path from "node:path";
import type { Database } from "better-sqlite3";

const HASH = "v30-agent-instructions-stub";

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

  const importedDir = path.join(root, "_imported");
  fs.mkdirSync(importedDir, { recursive: true });

  const rows = sqlite
    .prepare("SELECT id, name, role FROM execution_agents WHERE instructions_path IS NULL")
    .all() as Array<{ id: string; name: string; role: string | null }>;

  const update = sqlite.prepare(
    "UPDATE execution_agents SET instructions_path = ? WHERE id = ? AND instructions_path IS NULL"
  );

  for (const r of rows) {
    const rel = path.posix.join("_imported", `${r.id}.md`);
    const dest = path.join(root, "_imported", `${r.id}.md`);
    if (!fs.existsSync(dest)) {
      const body = `# ${r.name}${r.role ? ` (${r.role})` : ""}\n\n_Add instructions here._\n`;
      fs.writeFileSync(dest, body, "utf8");
    }
    update.run(rel, r.id);
  }

  sqlite.prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)").run(HASH);
}
