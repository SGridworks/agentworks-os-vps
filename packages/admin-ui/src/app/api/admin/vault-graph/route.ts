/**
 * GET /api/admin/vault-graph
 *
 * Proxies the daemon's tenant-scoped memory graph. If no tenantId query
 * parameter is supplied, the first tenant from GET /api/tenants is used.
 */

export const dynamic = 'force-dynamic';

const AGENTOS_API_URL = process.env.AGENTOS_API_URL ?? 'http://127.0.0.1:7710';

interface TenantRow {
  id: string;
}

interface MemoryGraphNote {
  id: string;
  title: string;
  dir: string;
  kind: string;
  tags: string[];
  chars: number;
  edited: string;
  outgoing: number;
  backlinks: number;
}

interface MemoryGraphData {
  tenantId: string;
  notes: MemoryGraphNote[];
  edges: [string, string][];
  dirs: Array<{ dir: string; count: number; hue: number }>;
  generatedAt: string;
}

interface MemoryGraphResponse {
  ok: boolean;
  data?: MemoryGraphData;
  error?: string;
}

function isTenantRow(value: unknown): value is TenantRow {
  return typeof value === 'object' && value !== null && typeof (value as TenantRow).id === 'string';
}

async function resolveTenantId(req: Request): Promise<string | null> {
  const url = new URL(req.url);
  const explicit = url.searchParams.get('tenantId');
  if (explicit) return explicit;

  const tenantsRes = await fetch(`${AGENTOS_API_URL}/api/tenants`, { cache: 'no-store' });
  if (!tenantsRes.ok) {
    throw new Error(`tenant list failed: HTTP ${tenantsRes.status}`);
  }
  const tenants = await tenantsRes.json() as unknown;
  if (!Array.isArray(tenants)) return null;
  const first = tenants.find(isTenantRow);
  return first?.id ?? null;
}

export async function GET(req: Request): Promise<Response> {
  try {
    const tenantId = await resolveTenantId(req);
    if (!tenantId) {
      return Response.json({
        tenantId: null,
        nodes: [],
        edges: [],
        notes: [],
        stats: { nodeCount: 0, edgeCount: 0 },
        generatedAt: new Date().toISOString(),
      });
    }

    const graphRes = await fetch(
      `${AGENTOS_API_URL}/api/memory/graph?tenantId=${encodeURIComponent(tenantId)}`,
      { cache: 'no-store' },
    );
    if (!graphRes.ok) {
      throw new Error(`memory graph failed: HTTP ${graphRes.status}`);
    }
    const graph = await graphRes.json() as MemoryGraphResponse;
    if (!graph.ok || !graph.data) {
      throw new Error(graph.error ?? 'memory graph response missing data');
    }
    const data = graph.data;
    return Response.json({
      ...data,
      nodes: data.notes,
      stats: { nodeCount: data.notes.length, edgeCount: data.edges.length },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[vault-graph] failed:', message);
    return Response.json({ error: 'fetch_failed', message }, { status: 500 });
  }
}
