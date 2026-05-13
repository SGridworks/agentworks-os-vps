/**
 * GET /api/admin/vault-graph
 *
 * Walks the operator tenant's vault subtree and returns a graph of pages
 * and their [[wikilinks]] for rendering in the Graph view.
 *
 * Resolution strategy: a wikilink `[[X]]` resolves to the first .md file
 * whose stem (basename without .md) equals X (case-insensitive). If no
 * match, the link is dropped.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const dynamic = 'force-dynamic';

const VAULT_ROOT = process.env.VAULT_ROOT;
const TENANT_ID = process.env.AGENTOS_TENANT_ID;

const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const SKIP_DIRS = new Set(['.git', '.obsidian', 'node_modules', 'legacy-tenants']);

interface VaultNode {
  id: string; // relative path
  title: string; // stem
  dir: string; // parent dir (relative)
}

interface VaultEdge {
  source: string;
  target: string;
}

function walkMarkdown(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile() && name.endsWith('.md')) {
        out.push(full);
      }
    }
  }
  return out;
}

function stem(path: string): string {
  const base = path.split('/').pop()!;
  return base.replace(/\.md$/i, '');
}

export async function GET(): Promise<Response> {
  // Default install runs the admin-ui container with no vault mount
  // and no tenant pinned, so the documented Memory Vault Viewer should
  // degrade gracefully (200, empty graph) rather than return 500. Operators
  // who want a populated graph wire VAULT_ROOT + AGENTOS_TENANT_ID via
  // docker-compose.yml.
  if (!VAULT_ROOT || !TENANT_ID) {
    return Response.json({
      tenantId: null,
      tenantRoot: null,
      nodes: [],
      edges: [],
      stats: { nodeCount: 0, edgeCount: 0, unresolvedWikilinks: 0 },
      notice:
        'Memory Vault Viewer is unwired in the default v0.1.9 docker-compose install. ' +
        'To enable: bind-mount the vault path into admin-ui and set VAULT_ROOT + AGENTOS_TENANT_ID. ' +
        'See docs/install-runbook.md.',
    });
  }
  try {
    const tenantRoot = join(VAULT_ROOT, TENANT_ID);
    const files = walkMarkdown(tenantRoot);

    // Build index: lowercased stem → relative path (first match wins)
    const stemIndex = new Map<string, string>();
    const nodes: VaultNode[] = [];
    for (const abs of files) {
      const rel = relative(tenantRoot, abs);
      const s = stem(abs);
      const lower = s.toLowerCase();
      if (!stemIndex.has(lower)) stemIndex.set(lower, rel);
      nodes.push({
        id: rel,
        title: s,
        dir: rel.split('/').slice(0, -1).join('/') || '/',
      });
    }

    // Parse wikilinks
    const edgeSet = new Set<string>(); // dedup as "src→tgt"
    const edges: VaultEdge[] = [];
    for (const abs of files) {
      const rel = relative(tenantRoot, abs);
      let body = '';
      try {
        body = readFileSync(abs, 'utf-8');
      } catch {
        continue;
      }
      WIKILINK_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = WIKILINK_RE.exec(body)) !== null) {
        const target = match[1].trim();
        const targetStem = target.split('/').pop()!.toLowerCase();
        const targetRel = stemIndex.get(targetStem);
        if (!targetRel || targetRel === rel) continue;
        const key = `${rel}→${targetRel}`;
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        edges.push({ source: rel, target: targetRel });
      }
    }

    return Response.json({
      tenantId: TENANT_ID,
      tenantRoot,
      nodes,
      edges,
      stats: {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        unresolvedWikilinks: 0, // not tracked
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[vault-graph] failed:', message);
    return Response.json({ error: 'fetch_failed', message }, { status: 500 });
  }
}
