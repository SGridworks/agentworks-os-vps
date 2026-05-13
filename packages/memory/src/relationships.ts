/**
 * Typed frontmatter relationships for vault pages.
 *
 * Formalizes the `related:` YAML frontmatter that `save.ts` already emits
 * into a typed relationship graph. Agents can call `buildRelationshipGraph`
 * over a tenant's pages and then query: "what relates to X?", "who links to Y?",
 * "what decisions mention this concept?".
 *
 * No LLM — pure graph traversal over structured frontmatter.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

// Re-export types from extract.ts so callers get a single import point
export type { Entity, EntityType } from "./extract.js";

/** A directed relationship from one page to another. */
export interface Relationship {
  from: string;   // vault key of source page
  to: string;     // vault key of target page (normalized wikilink target)
  type: "related" | "mentions" | "references";
  /** Human-readable label for display */
  label: string;
}

/** Bidirectional relationship graph. Key = vault key, value = sorted deduped array. */
export type RelationshipGraph = Map<string, Relationship[]>;

/** All relationships in a tenant's vault. */
export interface GraphSummary {
  totalRelationships: number;
  totalPages: number;
  orphanPages: string[]; // pages with no incoming or outgoing relationships
  mostConnected: { key: string; degree: number }[];
}

/** Maximum depth for traversal operations. */
const MAX_DEPTH = 3;

/**
 * Parse `related:` YAML frontmatter from a vault page body.
 * Returns an array of normalized vault keys.
 */
export function parseRelatedFrontmatter(body: string): string[] {
  const lines = body.split("\n");
  let inRelated = false;
  const related: string[] = [];

  for (const line of lines) {
    if (line.trim() === "related:") {
      inRelated = true;
      continue;
    }
    if (inRelated) {
      // End of related block: blank line or non-indent line starts new field
      if (line === "" || (!line.startsWith("  ") && !line.startsWith("\t"))) {
        break;
      }
      // Indented list item: "  - [[key]]" or "  - key"
      const match = line.trim().match(/^-\s*(.+)/);
      if (!match || !match[1]) continue;
      const val = match[1].trim();
      // Strip wikilink brackets
      const normalized = val.replace(/^\[\[|\]\]$/g, "").trim();
      if (normalized) related.push(normalized);
    }
  }

  return related;
}

/**
 * Render `related:` YAML frontmatter from an array of vault keys.
 * Matches the format that `save.ts` renderNoteFrontmatter produces.
 */
export function renderRelatedFrontmatter(keys: string[]): string {
  if (keys.length === 0) return "";
  const lines = ["related:"];
  for (const key of keys) {
    lines.push(`  - ${key}`);
  }
  return lines.join("\n");
}

/**
 * Normalize a wikilink or mention to a vault key.
 * "[[projects/sgridworks]]" → "projects/sgridworks"
 * "@john" → "people/john"  (convention: @mentions map to people/ namespace)
 * "projects/sgridworks" → "projects/sgridworks"
 */
export function normalizeWikilink(raw: string): string {
  const stripped = raw.replace(/^\[\[|\]\]$/g, "").trim();
  if (stripped.startsWith("@")) {
    return `people/${stripped.slice(1)}`;
  }
  return stripped;
}

/**
 * Extract all wikilinks `[[...]]` from a vault page body.
 */
export function extractWikilinks(body: string): string[] {
  const re = /\[\[([^\]]+)\]\]/g;
  const links: string[] = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    if (!m[1]) continue;
    links.push(m[1]);
  }
  return links;
}

/**
 * Extract all @mentions from a vault page body.
 */
export function extractMentions(body: string): string[] {
  const re = /@([a-zA-Z0-9_\-./]+)/g;
  const mentions: string[] = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    if (!m[1]) continue;
    mentions.push(m[1]);
  }
  return mentions;
}

/**
 * Build a bidirectional relationship graph from a list of vault pages.
 *
 * For each page, parses `related:` frontmatter and wikilinks in body,
 * then creates Relationship entries both directions (from→to and to→from).
 *
 * @param pages — array of VaultPage objects for a tenant
 * @param resolveKey — maps a normalized wikilink to a vault key (for alias resolution)
 */
export function buildRelationshipGraph(
  pages: { key: string; body: string }[],
  resolveKey?: (normalized: string) => string | undefined,
): RelationshipGraph {
  const graph = new Map<string, Relationship[]>();

  // Index pages by key for fast lookup
  const pageIndex = new Map<string, string>();
  for (const page of pages) {
    pageIndex.set(page.key, page.body);
  }

  for (const page of pages) {
    const outgoing: Relationship[] = [];

    // From related: frontmatter
    const relatedKeys = parseRelatedFrontmatter(page.body);
    for (const rel of relatedKeys) {
      const target = resolveKey ? resolveKey(rel) ?? rel : rel;
      outgoing.push({
        from: page.key,
        to: target,
        type: "related",
        label: `related to ${target}`,
      });
    }

    // From wikilinks in body
    const wikilinks = extractWikilinks(page.body);
    for (const wl of wikilinks) {
      const target = resolveKey ? resolveKey(wl) ?? wl : wl;
      if (target === page.key) continue; // no self-loops
      outgoing.push({
        from: page.key,
        to: target,
        type: "references",
        label: `references ${target}`,
      });
    }

    // From @mentions in body
    const mentions = extractMentions(page.body);
    for (const m of mentions) {
      const target = normalizeWikilink(`@${m}`);
      outgoing.push({
        from: page.key,
        to: target,
        type: "mentions",
        label: `mentions @${m}`,
      });
    }

    if (outgoing.length > 0) {
      graph.set(page.key, outgoing);
    }
  }

  // Add bidirectional edges (incoming relationships)
  const incoming = new Map<string, Relationship[]>();
  for (const [from, rels] of graph) {
    for (const rel of rels) {
      const existing = incoming.get(rel.to) ?? [];
      existing.push({
        from: rel.to,
        to: from,
        type: rel.type,
        label: rel.label.replace("to ", "from "),
      });
      incoming.set(rel.to, existing);
    }
  }

  // Merge incoming into graph
  for (const [key, inRels] of incoming) {
    const existing = graph.get(key) ?? [];
    // Merge and dedupe by (from, to, type)
    const seen = new Set(existing.map((r) => `${r.from}:${r.to}:${r.type}`));
    for (const rel of inRels) {
      const sig = `${rel.from}:${rel.to}:${rel.type}`;
      if (!seen.has(sig)) {
        existing.push(rel);
        seen.add(sig);
      }
    }
    existing.sort((a, b) => a.from.localeCompare(b.from));
    graph.set(key, existing);
  }

  return graph;
}

/**
 * Find direct neighbors of a page (1-hop graph traversal).
 */
export function findNeighbors(graph: RelationshipGraph, key: string): Relationship[] {
  return graph.get(key) ?? [];
}

/**
 * Find all pages that link TO a given page (incoming relationships).
 */
export function findReferencers(graph: RelationshipGraph, key: string): Relationship[] {
  return graph.get(key)?.filter((r) => r.to === key && r.from !== key) ?? [];
}

/**
 * Traverse the relationship graph up to `depth` hops from `startKey`.
 * Returns all reachable keys with their distance.
 */
export function traverseGraph(
  graph: RelationshipGraph,
  startKey: string,
  depth = MAX_DEPTH,
): Map<string, number> {
  const visited = new Map<string, number>();
  const queue: Array<{ key: string; dist: number }> = [{ key: startKey, dist: 0 }];

  while (queue.length > 0) {
    const { key, dist } = queue.shift()!;
    if (dist > depth) break;
    if (visited.has(key) && visited.get(key)! <= dist) continue;
    visited.set(key, dist);

    const rels = graph.get(key) ?? [];
    for (const rel of rels) {
      if (!visited.has(rel.to) || visited.get(rel.to)! > dist + 1) {
        queue.push({ key: rel.to, dist: dist + 1 });
      }
    }
  }

  return visited;
}

/**
 * Compute degree (in + out edges) for every page in the graph.
 */
export function computeDegrees(graph: RelationshipGraph): Map<string, number> {
  const degrees = new Map<string, number>();

  for (const [key, rels] of graph) {
    degrees.set(key, (degrees.get(key) ?? 0) + rels.length);
    for (const rel of rels) {
      degrees.set(rel.to, (degrees.get(rel.to) ?? 0) + 1);
    }
  }

  return degrees;
}

/**
 * Merge two relationship graphs (union).
 */
export function mergeGraphs(a: RelationshipGraph, b: RelationshipGraph): RelationshipGraph {
  const result = new Map<string, Relationship[]>(a);

  for (const [key, rels] of b) {
    const existing = result.get(key) ?? [];
    const seen = new Set(existing.map((r) => `${r.from}:${r.to}:${r.type}`));
    for (const rel of rels) {
      const sig = `${rel.from}:${rel.to}:${rel.type}`;
      if (!seen.has(sig)) {
        existing.push(rel);
        seen.add(sig);
      }
    }
    result.set(key, existing);
  }

  return result;
}

/**
 * Get a summary of the relationship graph for a tenant.
 */
export function summarizeGraph(
  graph: RelationshipGraph,
): GraphSummary {
  const degrees = computeDegrees(graph);
  const allKeys = new Set<string>();
  for (const key of graph.keys()) {
    allKeys.add(key);
    for (const rel of graph.get(key) ?? []) {
      allKeys.add(rel.from);
      allKeys.add(rel.to);
    }
  }

  let totalRelationships = 0;
  for (const rels of graph.values()) {
    totalRelationships += rels.length;
  }

  const orphanPages = [...allKeys].filter(
    (k) => !graph.has(k) || (graph.get(k)?.length ?? 0) === 0,
  );

  const sorted = [...degrees.entries()].sort((a, b) => b[1] - a[1]);
  const mostConnected = sorted.slice(0, 10).map(([key, degree]) => ({ key, degree }));

  return {
    totalRelationships,
    totalPages: allKeys.size,
    orphanPages,
    mostConnected,
  };
}

/**
 * Load all vault pages for a tenant and build the relationship graph.
 * Convenience wrapper combining file listing + graph build.
 */
export async function buildTenantGraph(
  vaultRoot: string,
  tenantId: string,
): Promise<RelationshipGraph> {
  const tenantRoot = join(vaultRoot, tenantId);
  const keys = await fs.readdir(tenantRoot, { withFileTypes: true });

  const pages: { key: string; body: string }[] = [];
  for (const entry of keys) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const key = entry.name.replace(/\.md$/, "");
      const body = await fs.readFile(join(tenantRoot, entry.name), "utf8");
      pages.push({ key, body });
    }
  }

  return buildRelationshipGraph(pages);
}
