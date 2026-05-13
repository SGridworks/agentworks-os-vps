/**
 * Retrieval service — phase 1c of memory architecture.
 *
 * Hybrid search combining:
 *   - Dense (vector): cosine similarity over the embedding BLOB column.
 *     Computed in JS by scanning rows where embedding IS NOT NULL. For
 *     the v1 scale (low thousands of rows per tenant) this is fine and
 *     well under 100ms; swap to Chroma/Qdrant when scale demands.
 *   - Sparse (BM25): SQLite FTS5 MATCH against episodes_fts/insights_fts,
 *     ordered by built-in rank.
 *
 * Reciprocal Rank Fusion (k=60, configurable) merges the two ranked
 * lists. Pure-keyword queries (entity names, IDs, error codes) survive
 * via the sparse leg; pure-semantic queries survive via the dense leg.
 *
 * Results unify episodes and insights under a single `kind` discriminator
 * so callers can ask one question and get the most relevant memories
 * regardless of which table they live in.
 */

import type { Database } from "better-sqlite3";
import { EmbedClient, blobToVector } from "./embed-client.js";
import { RerankClient } from "./rerank-client.js";

export type RetrievalKind = "episode" | "insight";

export interface RetrievalHit {
  kind: RetrievalKind;
  id: string;
  tenantId: string;
  /** Body text used for ranking — episode.summary or insight.content. */
  text: string;
  /** Fused RRF score; higher is better. */
  score: number;
  /** Per-source ranks (1-based). Either may be undefined if the source missed. */
  denseRank: number | undefined;
  sparseRank: number | undefined;
  /** Cosine similarity from the dense leg (only set if matched). */
  denseSim: number | undefined;
  /** Cross-encoder rerank score (only set when the rerank pass ran). */
  rerankScore: number | undefined;
  /** Auxiliary metadata, kind-dependent. */
  meta: Record<string, unknown>;
}

export interface HybridSearchOptions {
  tenantId: string;
  query: string;
  /** Final k returned to caller. Default 20. */
  topK?: number | undefined;
  /** Per-leg cap before fusion. Default 50. */
  perLegLimit?: number | undefined;
  /** RRF k constant. Default 60 (per the standard from Cormack et al.). */
  rrfK?: number | undefined;
  /** Restrict result kinds. Default: both. */
  kinds?: RetrievalKind[] | undefined;
  /** Filter episodes/insights to lifecycle='active' only. Default true. */
  activeOnly?: boolean | undefined;
  /** Run cross-encoder reranker over the fused topK before returning.
   * Default is taken from RERANKER_MODE env: any value other than "stub"
   * (and other than missing) enables reranking. Pass false to force off
   * (e.g. tests). */
  rerank?: boolean | undefined;
  /** Optional rerank client; injected for tests. Default constructs one
   * from SCANNER_SIDECAR_URL. */
  rerankClient?: RerankClient | undefined;
}

interface DenseRow {
  kind: RetrievalKind;
  id: string;
  tenantId: string;
  text: string;
  embedding: Buffer;
  meta: Record<string, unknown>;
}

interface SparseHit {
  kind: RetrievalKind;
  id: string;
  rank: number;
}

function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

function norm(a: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * a[i]!;
  return Math.sqrt(sum);
}

function cosineSim(a: Float32Array, b: Float32Array): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

/**
 * Reciprocal Rank Fusion. Pure function — given two lists of (id, rank)
 * tuples (rank = 1-based), returns merged scores keyed by `kind:id`
 * compound key so episodes and insights with the same UUID can never
 * collide.
 */
export function rrf(
  dense: Array<{ kind: RetrievalKind; id: string; rank: number }>,
  sparse: Array<{ kind: RetrievalKind; id: string; rank: number }>,
  k: number = 60,
): Map<string, { score: number; denseRank?: number; sparseRank?: number }> {
  const merged = new Map<string, { score: number; denseRank?: number; sparseRank?: number }>();
  const compoundKey = (kind: RetrievalKind, id: string) => `${kind}:${id}`;

  for (const e of dense) {
    const ck = compoundKey(e.kind, e.id);
    const cur = merged.get(ck) ?? { score: 0 };
    cur.score += 1 / (k + e.rank);
    cur.denseRank = e.rank;
    merged.set(ck, cur);
  }
  for (const e of sparse) {
    const ck = compoundKey(e.kind, e.id);
    const cur = merged.get(ck) ?? { score: 0 };
    cur.score += 1 / (k + e.rank);
    cur.sparseRank = e.rank;
    merged.set(ck, cur);
  }
  return merged;
}

function loadDenseRows(
  sqlite: Database,
  tenantId: string,
  kinds: RetrievalKind[],
  activeOnly: boolean,
): DenseRow[] {
  const out: DenseRow[] = [];
  const lifeFilter = activeOnly ? "AND lifecycle = 'active'" : "";

  if (kinds.includes("episode")) {
    const rows = sqlite
      .prepare(
        `SELECT id, tenant_id, summary, embedding, role, task_type, outcome, importance, started_at
           FROM episodes
          WHERE tenant_id = ? AND embedding IS NOT NULL ${lifeFilter}`,
      )
      .all(tenantId) as Array<{
      id: string;
      tenant_id: string;
      summary: string;
      embedding: Buffer;
      role: string | null;
      task_type: string | null;
      outcome: string | null;
      importance: number;
      started_at: string;
    }>;
    for (const r of rows) {
      out.push({
        kind: "episode",
        id: r.id,
        tenantId: r.tenant_id,
        text: r.summary,
        embedding: r.embedding,
        meta: {
          role: r.role,
          taskType: r.task_type,
          outcome: r.outcome,
          importance: r.importance,
          startedAt: r.started_at,
        },
      });
    }
  }

  if (kinds.includes("insight")) {
    const rows = sqlite
      .prepare(
        `SELECT id, tenant_id, content, embedding, frame_type, subject, importance, source, episode_id
           FROM insights
          WHERE tenant_id = ? AND embedding IS NOT NULL ${lifeFilter}`,
      )
      .all(tenantId) as Array<{
      id: string;
      tenant_id: string;
      content: string;
      embedding: Buffer;
      frame_type: string;
      subject: string | null;
      importance: number;
      source: string;
      episode_id: string | null;
    }>;
    for (const r of rows) {
      out.push({
        kind: "insight",
        id: r.id,
        tenantId: r.tenant_id,
        text: r.content,
        embedding: r.embedding,
        meta: {
          frameType: r.frame_type,
          subject: r.subject,
          importance: r.importance,
          source: r.source,
          episodeId: r.episode_id,
        },
      });
    }
  }

  return out;
}

function sparseHits(
  sqlite: Database,
  tenantId: string,
  query: string,
  kinds: RetrievalKind[],
  perLegLimit: number,
): SparseHit[] {
  // FTS5 MATCH parser is strict: anything that looks like an operator or
  // unbalanced quote will throw. Sanitize aggressively — we lose advanced
  // query syntax but gain robustness against arbitrary user input.
  const safe = query.replace(/[^a-zA-Z0-9 ]+/g, " ").trim();
  if (!safe) return [];

  const out: SparseHit[] = [];

  if (kinds.includes("episode")) {
    const rows = sqlite
      .prepare(
        `SELECT id FROM episodes_fts
          WHERE tenant_id = ? AND episodes_fts MATCH ?
          ORDER BY rank LIMIT ?`,
      )
      .all(tenantId, safe, perLegLimit) as Array<{ id: string }>;
    rows.forEach((r, i) => out.push({ kind: "episode", id: r.id, rank: i + 1 }));
  }

  if (kinds.includes("insight")) {
    const rows = sqlite
      .prepare(
        `SELECT id FROM insights_fts
          WHERE tenant_id = ? AND insights_fts MATCH ?
          ORDER BY rank LIMIT ?`,
      )
      .all(tenantId, safe, perLegLimit) as Array<{ id: string }>;
    rows.forEach((r, i) => out.push({ kind: "insight", id: r.id, rank: i + 1 }));
  }

  return out;
}

export async function hybridSearch(
  sqlite: Database,
  embedClient: EmbedClient,
  opts: HybridSearchOptions,
): Promise<RetrievalHit[]> {
  const topK = opts.topK ?? 20;
  const perLegLimit = opts.perLegLimit ?? 50;
  const rrfK = opts.rrfK ?? 60;
  const kinds = opts.kinds ?? ["episode", "insight"];
  const activeOnly = opts.activeOnly ?? true;

  // ---- Dense leg ----
  let queryVec: Float32Array | null = null;
  try {
    const r = await embedClient.embedOne(opts.query);
    queryVec = r.vector;
  } catch {
    // Embed sidecar down — fall through with sparse only.
  }

  const dense: Array<{ kind: RetrievalKind; id: string; rank: number; sim: number; row: DenseRow }> = [];
  if (queryVec) {
    const rows = loadDenseRows(sqlite, opts.tenantId, kinds, activeOnly);
    const scored = rows
      .map((r) => ({
        row: r,
        sim: cosineSim(queryVec!, blobToVector(r.embedding)),
      }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, perLegLimit);
    scored.forEach((s, i) =>
      dense.push({ kind: s.row.kind, id: s.row.id, rank: i + 1, sim: s.sim, row: s.row }),
    );
  }

  // ---- Sparse leg ----
  const sparse = sparseHits(sqlite, opts.tenantId, opts.query, kinds, perLegLimit);

  // ---- Fuse ----
  const fused = rrf(dense, sparse, rrfK);

  // We need text + meta for every fused hit. Build lookup indexes:
  const denseByCk = new Map(dense.map((d) => [`${d.kind}:${d.id}`, d]));
  const sparseRowsNeeded = sparse.filter((s) => !denseByCk.has(`${s.kind}:${s.id}`));
  const sparseLookup = new Map<string, { text: string; meta: Record<string, unknown>; tenantId: string }>();
  if (sparseRowsNeeded.length > 0) {
    const epIds = sparseRowsNeeded.filter((r) => r.kind === "episode").map((r) => r.id);
    const insIds = sparseRowsNeeded.filter((r) => r.kind === "insight").map((r) => r.id);

    if (epIds.length > 0) {
      const placeholders = epIds.map(() => "?").join(",");
      const rows = sqlite
        .prepare(
          `SELECT id, tenant_id, summary, role, task_type, outcome, importance, started_at
             FROM episodes WHERE id IN (${placeholders})`,
        )
        .all(...epIds) as Array<{
        id: string;
        tenant_id: string;
        summary: string;
        role: string | null;
        task_type: string | null;
        outcome: string | null;
        importance: number;
        started_at: string;
      }>;
      for (const r of rows) {
        sparseLookup.set(`episode:${r.id}`, {
          tenantId: r.tenant_id,
          text: r.summary,
          meta: {
            role: r.role,
            taskType: r.task_type,
            outcome: r.outcome,
            importance: r.importance,
            startedAt: r.started_at,
          },
        });
      }
    }

    if (insIds.length > 0) {
      const placeholders = insIds.map(() => "?").join(",");
      const rows = sqlite
        .prepare(
          `SELECT id, tenant_id, content, frame_type, subject, importance, source, episode_id
             FROM insights WHERE id IN (${placeholders})`,
        )
        .all(...insIds) as Array<{
        id: string;
        tenant_id: string;
        content: string;
        frame_type: string;
        subject: string | null;
        importance: number;
        source: string;
        episode_id: string | null;
      }>;
      for (const r of rows) {
        sparseLookup.set(`insight:${r.id}`, {
          tenantId: r.tenant_id,
          text: r.content,
          meta: {
            frameType: r.frame_type,
            subject: r.subject,
            importance: r.importance,
            source: r.source,
            episodeId: r.episode_id,
          },
        });
      }
    }
  }

  const sorted = Array.from(fused.entries()).sort(([, a], [, b]) => b.score - a.score);
  const out: RetrievalHit[] = [];
  for (const [ck, scoreInfo] of sorted) {
    if (out.length >= topK) break;
    const [kind, id] = ck.split(":") as [RetrievalKind, string];
    const dRow = denseByCk.get(ck);
    if (dRow) {
      out.push({
        kind,
        id,
        tenantId: dRow.row.tenantId,
        text: dRow.row.text,
        score: scoreInfo.score,
        denseRank: scoreInfo.denseRank,
        sparseRank: scoreInfo.sparseRank,
        denseSim: dRow.sim,
        rerankScore: undefined,
        meta: dRow.row.meta,
      });
      continue;
    }
    const sLookup = sparseLookup.get(ck);
    if (sLookup) {
      out.push({
        kind,
        id,
        tenantId: sLookup.tenantId,
        text: sLookup.text,
        score: scoreInfo.score,
        denseRank: scoreInfo.denseRank,
        sparseRank: scoreInfo.sparseRank,
        denseSim: undefined,
        rerankScore: undefined,
        meta: sLookup.meta,
      });
    }
  }

  // ---- Cross-encoder rerank (optional) ----
  // Default-on unless RERANKER_MODE=stub or caller passes rerank=false.
  // Failures are swallowed — RRF order is a perfectly good fallback.
  const rerankEnabled =
    opts.rerank ?? (process.env.RERANKER_MODE ?? "real").toLowerCase() !== "stub";
  if (rerankEnabled && out.length > 1) {
    try {
      const client = opts.rerankClient ?? new RerankClient();
      const r = await client.rerank(opts.query, out.map((h) => h.text));
      if (r.scores.length === out.length && r.mode !== "stub") {
        for (let i = 0; i < out.length; i++) out[i]!.rerankScore = r.scores[i]!;
        out.sort((a, b) => (b.rerankScore ?? -Infinity) - (a.rerankScore ?? -Infinity));
      }
    } catch {
      // Sidecar down or model load failed — keep RRF order, no rerank scores.
    }
  }

  return out;
}
