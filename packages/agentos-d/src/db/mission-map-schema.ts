/**
 * Mission Map database schema — nodes and edges for the operator UX v2 map surface.
 *
 * Tables:
 * - nodes — graph nodes (companies, projects, issues, agents, runs, evidence, memory)
 * - edges — typed relationships between nodes
 *
 * Per mission-map-spec.md with deterministic color rules computed server-side.
 */

import { sqliteTable, text } from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// nodes
// ---------------------------------------------------------------------------
export const nodes = sqliteTable("mission_map_nodes", {
  id: text("id").primaryKey(), // UUID
  tenant_id: text("tenant_id").notNull(), // UUID
  
  // Node identity
  kind: text("kind", {
    enum: ["company", "project", "issue", "agent", "run", "evidence", "memory"]
  }).notNull(),
  title: text("title").notNull(),
  
  // Status (kind-specific enum values)
  status: text("status"), // company: active|inactive, issue: todo|in_progress|review|done|blocked, etc.
  
  // Kind-specific metadata (JSON blob)
  meta: text("meta").notNull(), // JSON string per NodeMeta shape
  
  // Soft delete support
  deleted_at: text("deleted_at"), // ISO datetime
  
  // Timestamps
  created_at: text("created_at").notNull(), // ISO datetime
  updated_at: text("updated_at").notNull(), // ISO datetime
});

// ---------------------------------------------------------------------------
// edges
// ---------------------------------------------------------------------------
export const edges = sqliteTable("mission_map_edges", {
  id: text("id").primaryKey(), // UUID
  tenant_id: text("tenant_id").notNull(), // UUID
  
  // Node references
  from_node_id: text("from_node_id").notNull(), // FK to nodes.id
  to_node_id: text("to_node_id").notNull(), // FK to nodes.id
  
  // Edge kind (typed relationship semantics)
  kind: text("kind", {
    enum: ["owns", "blocks", "assigned", "generated", "references", "depends", "follows"]
  }).notNull(),
  
  // Edge metadata (weight, confidence, etc.)
  meta: text("meta").notNull(), // JSON string per EdgeMeta shape
  
  // Timestamps
  created_at: text("created_at").notNull(), // ISO datetime
});

// ---------------------------------------------------------------------------
// TypeScript types
// ---------------------------------------------------------------------------
export type NodeRow = typeof nodes.$inferSelect;
export type NewNodeRow = typeof nodes.$inferInsert;
export type EdgeRow = typeof edges.$inferSelect;
export type NewEdgeRow = typeof edges.$inferInsert;