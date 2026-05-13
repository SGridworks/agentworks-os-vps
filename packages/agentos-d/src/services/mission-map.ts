/**
 * Mission Map service — graph operations for the operator UX v2 map surface.
 *
 * Provides:
 * - getGraph(tenantId, root?, depth?) -> { nodes, edges }
 * - createNode(tenantId, kind, title, meta) -> Node
 * - createEdge(tenantId, fromNodeId, toNodeId, kind, meta) -> Edge
 *
 * Graph schema per mission-map-spec.md:
 *   nodes(id, tenant_id, kind, title, status, meta, created_at, updated_at, deleted_at)
 *   edges(id, tenant_id, from_node_id, to_node_id, kind, meta, created_at)
 *
 * Color rules are deterministic server-side per the spec palette.
 */

import { getDb } from "../db/index.js";
import { nodes, edges } from "../db/mission-map-schema.js";
import { eq, and, desc, sql } from "drizzle-orm";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type NodeKind = "company" | "project" | "issue" | "agent" | "run" | "evidence" | "memory";
export type EdgeKind = "owns" | "blocks" | "assigned" | "generated" | "references" | "depends" | "follows";
export type NodeStatus = "active" | "inactive" | "done" | "review" | "blocked" | "failed";

export interface NodeMeta {
  // company
  domain?: string;
  plan_tier?: string;
  seats?: number;
  billing_status?: string;
  
  // project
  slug?: string;
  visibility?: string;
  repo_url?: string;
  lead_agent_id?: string;
  
  // issue
  priority?: string;
  estimate?: number;
  assignee_agent_id?: string;
  tags?: string[];
  
  // agent
  role?: string;
  lane?: string;
  last_heartbeat?: string;
  budget_cents?: number;
  
  // run
  trigger?: string;
  exit_code?: number;
  cost_cents?: number;
  log_url?: string;
  artifact_urls?: string[];
  
  // evidence
  rule_pack_id?: string;
  severity?: "critical" | "block" | "high" | "medium" | "low" | "info";
  verdict?: string;
  scanner?: string;
  sha256?: string;
  
  // memory
  mime_type?: string;
  size_bytes?: number;
  vault_path?: string;
  indexed_at?: string;
}

export interface EdgeMeta {
  weight?: number;
  confidence?: number;
  scan_result_pointer?: string;
}

export interface Node {
  id: string;
  tenant_id: string;
  kind: NodeKind;
  title: string;
  status: NodeStatus | null;
  meta: NodeMeta;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  color: string; // server-computed per palette rules
}

export interface Edge {
  id: string;
  tenant_id: string;
  from_node_id: string;
  to_node_id: string;
  kind: EdgeKind;
  meta: EdgeMeta;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Color Palette (deterministic, server-side)
// ---------------------------------------------------------------------------
const PALETTE = {
  company:   { default: "#0ea5e9",  hover: "#0284c7" },
  project:   { default: "#10b981",  hover: "#059669" },
  issue:     { default: "#f59e0b",  hover: "#d97706" },
  agent:     { default: "#8b5cf6",  hover: "#7c3aed" },
  run:       { default: "#6b7280",  hover: "#4b5563" },
  evidence:  { default: "#ef4444",  hover: "#dc2626" },
  memory:    { default: "#06b6d4",  hover: "#0891b2" }
} as const;

function computeNodeColor(node: {
  kind: NodeKind;
  status: NodeStatus | null;
  deleted_at: string | null;
  meta: NodeMeta;
}): string {
  if (node.deleted_at) return "#d1d5db"; // gray-300
  
  if (node.kind === "issue") {
    switch (node.status) {
      case "done":  return "#10b981"; // green-500
      case "review":return "#8b5cf6"; // purple-500
      case "blocked":return "#ef4444"; // red-500: danger; red-900 is reserved for severe evidence
    }
  }
  
  if (node.kind === "run" && node.status === "failed") return "#ef4444"; // red-500
  
  if (node.kind === "evidence" && (node.meta.severity === "critical" || node.meta.severity === "block")) return "#991b1b"; // red-900
  
  return PALETTE[node.kind].default;
}

// ---------------------------------------------------------------------------
// Graph Queries
// ---------------------------------------------------------------------------

export interface GetGraphOptions {
  tenantId: string;
  root?: string; // node id to use as root
  depth?: number; // max depth (default: 3, max: 5)
}

/**
 * Get graph nodes and edges for a tenant.
 * If root is provided, returns the subgraph rooted at that node up to depth.
 * Otherwise returns all nodes/edges for the tenant (capped at 1000 nodes).
 */
export function getGraph(opts: GetGraphOptions): { nodes: Node[]; edges: Edge[] } {
  const db = getDb();
  const { tenantId, root, depth = 3 } = opts;
  const maxDepth = Math.min(depth, 5);
  
  if (root) {
    // Get subgraph rooted at the specified node
    return getSubgraph(db, tenantId, root, maxDepth);
  } else {
    // Get all nodes/edges for the tenant (with reasonable limits)
    return getFullGraph(db, tenantId);
  }
}

function getFullGraph(db: ReturnType<typeof getDb>, tenantId: string): { nodes: Node[]; edges: Edge[] } {
  // Get nodes with limit to prevent memory issues
  const nodeRows = db
    .select()
    .from(nodes)
    .where(eq(nodes.tenant_id, tenantId))
    .limit(1000)
    .all();
  
  if (nodeRows.length === 0) {
    return { nodes: [], edges: [] };
  }
  
  const nodeIds = nodeRows.map(n => n.id);
  
  // Get edges that connect these nodes
  const edgeRows = db
    .select()
    .from(edges)
    .where(and(
      eq(edges.tenant_id, tenantId),
      sql`${edges.from_node_id} IN ${nodeIds}`,
      sql`${edges.to_node_id} IN ${nodeIds}`
    ))
    .limit(2000)
    .all();
  
  const nodeMap = new Map(nodeRows.map(n => [n.id, n]));
  
  return {
    nodes: nodeRows.map(n => ({
      id: n.id,
      tenant_id: n.tenant_id,
      kind: n.kind as NodeKind,
      title: n.title,
      status: n.status as NodeStatus | null,
      meta: JSON.parse(n.meta as string) as NodeMeta,
      created_at: n.created_at,
      updated_at: n.updated_at,
      deleted_at: n.deleted_at,
      color: computeNodeColor({
        kind: n.kind as NodeKind,
        status: n.status as NodeStatus | null,
        deleted_at: n.deleted_at,
        meta: JSON.parse(n.meta as string) as NodeMeta
      })
    })),
    edges: edgeRows.map(e => ({
      id: e.id,
      tenant_id: e.tenant_id,
      from_node_id: e.from_node_id,
      to_node_id: e.to_node_id,
      kind: e.kind as EdgeKind,
      meta: JSON.parse(e.meta as string) as EdgeMeta,
      created_at: e.created_at
    }))
  };
}

function getSubgraph(db: ReturnType<typeof getDb>, tenantId: string, rootId: string, maxDepth: number): { nodes: Node[]; edges: Edge[] } {
  // For now, implement a simple 1-hop neighborhood
  // TODO: implement proper BFS traversal with depth limiting
  
  const rootNode = db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, rootId), eq(nodes.tenant_id, tenantId)))
    .get();
  
  if (!rootNode) {
    return { nodes: [], edges: [] };
  }
  
  // Get direct edges from/to the root node
  const edgeRows = db
    .select()
    .from(edges)
    .where(and(
      eq(edges.tenant_id, tenantId),
      sql`${edges.from_node_id} = ${rootId} OR ${edges.to_node_id} = ${rootId}`
    ))
    .all();
  
  const connectedNodeIds = new Set<string>();
  connectedNodeIds.add(rootId);
  
  for (const edge of edgeRows) {
    connectedNodeIds.add(edge.from_node_id);
    connectedNodeIds.add(edge.to_node_id);
  }
  
  // Get all connected nodes
  const nodeRows = db
    .select()
    .from(nodes)
    .where(and(
      eq(nodes.tenant_id, tenantId),
      sql`${nodes.id} IN ${Array.from(connectedNodeIds)}`
    ))
    .all();
  
  return {
    nodes: nodeRows.map(n => ({
      id: n.id,
      tenant_id: n.tenant_id,
      kind: n.kind as NodeKind,
      title: n.title,
      status: n.status as NodeStatus | null,
      meta: JSON.parse(n.meta as string) as NodeMeta,
      created_at: n.created_at,
      updated_at: n.updated_at,
      deleted_at: n.deleted_at,
      color: computeNodeColor({
        kind: n.kind as NodeKind,
        status: n.status as NodeStatus | null,
        deleted_at: n.deleted_at,
        meta: JSON.parse(n.meta as string) as NodeMeta
      })
    })),
    edges: edgeRows.map(e => ({
      id: e.id,
      tenant_id: e.tenant_id,
      from_node_id: e.from_node_id,
      to_node_id: e.to_node_id,
      kind: e.kind as EdgeKind,
      meta: JSON.parse(e.meta as string) as EdgeMeta,
      created_at: e.created_at
    }))
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface CreateNodeInput {
  tenantId: string;
  kind: NodeKind;
  title: string;
  status?: NodeStatus;
  meta?: NodeMeta;
}

export function createNode(input: CreateNodeInput): Node {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  
  const meta = input.meta || {};
  const status = input.status || "active";
  
  const nodeRow = {
    id,
    tenant_id: input.tenantId,
    kind: input.kind,
    title: input.title,
    status,
    meta: JSON.stringify(meta),
    created_at: now,
    updated_at: now,
    deleted_at: null
  };
  
  db.insert(nodes).values(nodeRow).run();
  
  return {
    id,
    tenant_id: input.tenantId,
    kind: input.kind,
    title: input.title,
    status,
    meta,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    color: computeNodeColor({ kind: input.kind, status, deleted_at: null, meta })
  };
}

export interface CreateEdgeInput {
  tenantId: string;
  fromNodeId: string;
  toNodeId: string;
  kind: EdgeKind;
  meta?: EdgeMeta;
}

export function createEdge(input: CreateEdgeInput): Edge {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  
  const meta = input.meta || {};
  
  // Verify both nodes exist and belong to the tenant
  const fromNode = db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, input.fromNodeId), eq(nodes.tenant_id, input.tenantId)))
    .get();
    
  const toNode = db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, input.toNodeId), eq(nodes.tenant_id, input.tenantId)))
    .get();
  
  if (!fromNode || !toNode) {
    throw new Error("One or both nodes not found or do not belong to tenant");
  }
  
  const edgeRow = {
    id,
    tenant_id: input.tenantId,
    from_node_id: input.fromNodeId,
    to_node_id: input.toNodeId,
    kind: input.kind,
    meta: JSON.stringify(meta),
    created_at: now
  };
  
  db.insert(edges).values(edgeRow).run();
  
  return {
    id,
    tenant_id: input.tenantId,
    from_node_id: input.fromNodeId,
    to_node_id: input.toNodeId,
    kind: input.kind,
    meta,
    created_at: now
  };
}
