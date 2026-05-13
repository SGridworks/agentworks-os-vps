/**
 * Migration 0034 — Mission Map tables — nodes and edges for operator UX v2
 *
 * Creates:
 * - mission_map_nodes — graph nodes (companies, projects, issues, agents, runs, evidence, memory)
 * - mission_map_edges — typed relationships between nodes
 *
 * Per mission-map-spec.md with indexes for tenant-scoped queries.
 */

import type { Database } from "better-sqlite3";

const HASH = "v34-mission-map";

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

  // Create mission_map_nodes table
  sqlite.exec(`
    CREATE TABLE mission_map_nodes (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('company','project','issue','agent','run','evidence','memory')),
      title TEXT NOT NULL,
      status TEXT,
      meta TEXT NOT NULL,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Create mission_map_edges table
  sqlite.exec(`
    CREATE TABLE mission_map_edges (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      from_node_id TEXT NOT NULL,
      to_node_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('owns','blocks','assigned','generated','references','depends','follows')),
      meta TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // Create indexes for tenant-scoped queries
  sqlite.exec(`CREATE INDEX idx_mission_map_nodes_tenant ON mission_map_nodes(tenant_id);`);
  sqlite.exec(`CREATE INDEX idx_mission_map_nodes_kind ON mission_map_nodes(kind);`);
  sqlite.exec(`CREATE INDEX idx_mission_map_nodes_status ON mission_map_nodes(status);`);
  sqlite.exec(`CREATE INDEX idx_mission_map_edges_tenant ON mission_map_edges(tenant_id);`);
  sqlite.exec(`CREATE INDEX idx_mission_map_edges_from ON mission_map_edges(from_node_id);`);
  sqlite.exec(`CREATE INDEX idx_mission_map_edges_to ON mission_map_edges(to_node_id);`);
  sqlite.exec(`CREATE INDEX idx_mission_map_edges_kind ON mission_map_edges(kind);`);

  // Create unique constraint to prevent duplicate edges
  sqlite.exec(`
    CREATE UNIQUE INDEX idx_mission_map_edges_unique 
    ON mission_map_edges(tenant_id, from_node_id, to_node_id, kind);
  `);

  sqlite.prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)").run(HASH);
}