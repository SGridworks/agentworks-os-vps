/**
 * Retrieval pipeline — hybrid BM25 + vector search + re-ranking.
 *
 * This module implements Stage 4 of the RAG pipeline: retrieval.
 *
 * Three retrieval signals are combined:
 *   1. BM25 — keyword-matched TF-IDF score (handles exact phrase queries)
 *   2. Vector similarity — cosine similarity in embedding space (handles semantic queries)
 *   3. Re-ranking — a cross-encoder scores each candidate against the query in context,
 *       pushing the most relevant chunks to the top (handles complex multi-aspect queries)
 *
 * Scoring formula:
 *   hybridScore = alpha * bm25Score_norm + (1 - alpha) * vectorScore
 *
 * alpha = 0.3 by default (30% BM25, 70% vector). This can be tuned per-query
 * or set globally via RAG_HYBRID_ALPHA.
 *
 * Re-ranking:
 *   We use a lightweight cross-encoder approach. If RAG_RERANKER_URL is set, we call
 *   a cross-encoder service (e.g. anywell/cross-encoder or a bespoke model). If not set,
 *   we fall back to a score-weighted combination of BM25 + vector.
 *
 * Token budget:
 *   At retrieval time we have no hard context limit — we fetch ANN_K candidates
 *   (default 20), re-rank them, and return the top K to the caller. The caller
 *   (generate stage in the agent adapter) applies the context window budget.
 */

import { createHash } from "node:crypto";
import type {
  RetrievalQuery,
  RetrievalResult,
  RetrievalResponse,
  Chunk,
  Embedding,
  VectorRecord,
} from "./types.js";
import type { IVectorStore, SearchFilters, AnnResult } from "./vector-store.js";
import { EmbedClient } from "./embed-client.js";

// ─── BM25 (in-process, no external dependency) ────────────────────────────────

/**
 * In-process BM25 implementation using a postings list.
 * No external search library needed — we compute BM25 scores for the
 * candidate chunks fetched from the vector store.
 *
 * We fetch ANN_K candidates from the vector store, then re-score them with BM25.
 * This is the "second-stage" BM25 refinement described in the RAG literature.
 */
export class Bm25Scorer {
  private readonly k1 = 1.5;
  private readonly b = 0.75;
  private readonly avgDocLen: number;

  constructor(
    private readonly documents: Array<{ id: string; tokens: string[]; docLen: number }>,
    private readonly corpusSize: number,
    private readonly docFreqs: Map<string, number>,
  ) {
    this.avgDocLen =
      documents.reduce((sum, d) => sum + d.docLen, 0) / (corpusSize || 1);
  }

  /**
   * Score a query against the pre-tokenised corpus.
   * Returns BM25 scores per document ID.
   */
  score(queryTokens: string[]): Map<string, number> {
    const scores = new Map<string, number>();

    for (const doc of this.documents) {
      let score = 0;
      for (const term of queryTokens) {
        if (!this.docFreqs.has(term)) continue;
        const tf = doc.tokens.filter((t) => t === term).length;
        const df = this.docFreqs.get(term)!;
        const idf = Math.log((this.corpusSize - df + 0.5) / (df + 0.5) + 1);
        const tfNorm = (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * (doc.docLen / this.avgDocLen)));
        score += idf * tfNorm;
      }
      scores.set(doc.id, score);
    }

    return scores;
  }

  /**
   * Normalise BM25 scores to [0, 1] using max-score normalisation.
   * Returns 0 for all docs if no term matches.
   */
  static normalise(scores: Map<string, number>): Map<string, number> {
    const max = Math.max(...Array.from(scores.values()), 0);
    if (max === 0) return scores;
    const out = new Map<string, number>();
    for (const [id, score] of Array.from(scores.entries())) {
      out.set(id, score / max);
    }
    return out;
  }

  /** Build a BM25 scorer from a list of chunks. */
  static fromChunks(chunks: Chunk[]): Bm25Scorer {
    const docs = chunks.map((c) => {
      const tokens = tokenise(c.body);
      return { id: c.id, tokens, docLen: tokens.length };
    });

    // Document frequencies
    const dfMap = new Map<string, number>();
    for (const doc of docs) {
      const seen = new Set<string>();
      for (const t of doc.tokens) {
        if (!seen.has(t)) {
          seen.add(t);
          dfMap.set(t, (dfMap.get(t) ?? 0) + 1);
        }
      }
    }

    return new Bm25Scorer(docs, docs.length, dfMap);
  }
}

// ─── Simple tokenizer ─────────────────────────────────────────────────────────

/** Split text into lowercase word tokens for BM25. */
function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

// ─── Cross-encoder reranker ───────────────────────────────────────────────────

/**
 * Re-ranker using a cross-encoder model via HTTP.
 *
 * If RAG_RERANKER_URL is set, we POST query+document pairs and get
 * relevance scores back. This is significantly more accurate than
 * score fusion alone but requires a running reranker service.
 *
 * Fallback: if no reranker is configured, we use a simple weighted
 * combination of the BM25 and vector scores.
 */
export class CrossEncoderReranker {
  constructor(private readonly rerankerUrl: string | undefined) {}

  /**
   * Re-rank a list of candidates.
   * Returns candidate IDs with their re-ranked scores, sorted descending.
   */
  async rerank(
    query: string,
    candidates: Array<{ id: string; chunkBody: string; vectorScore: number; bm25Score: number }>,
  ): Promise<Map<string, number>> {
    if (!this.rerankerUrl || candidates.length === 0) {
      // Fallback: weighted average of vector + BM25
      const scores = new Map<string, number>();
      for (const c of candidates) {
        scores.set(c.id, 0.6 * c.vectorScore + 0.4 * c.bm25Score);
      }
      return scores;
    }

    // Call cross-encoder service
    const res = await fetch(this.rerankerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        documents: candidates.map((c) => c.chunkBody),
      }),
    });

    if (!res.ok) {
      console.warn(`[Reranker] failed ${res.status}, falling back to score fusion`);
      const scores = new Map<string, number>();
      for (const c of candidates) {
        scores.set(c.id, 0.6 * c.vectorScore + 0.4 * c.bm25Score);
      }
      return scores;
    }

    const data = (await res.json()) as { scores: number[] };
    const reranked = new Map<string, number>();
    for (let i = 0; i < candidates.length; i++) {
      reranked.set(candidates[i].id, data.scores[i] ?? 0);
    }
    return reranked;
  }
}

// ─── Main retriever ───────────────────────────────────────────────────────────

export interface RetrieverDeps {
  vectorStore: IVectorStore;
  embedClient: EmbedClient;
  bm25Indexer?: Bm25Scorer; // built on first ingest; optional on retrieval
  reranker?: CrossEncoderReranker;
}

export class HybridRetriever {
  private readonly alpha: number;
  private readonly annK: number;
  private readonly deps: RetrieverDeps;

  constructor(
    deps: RetrieverDeps,
    alpha = 0.3,
    annK = 20,
  ) {
    this.alpha = alpha;
    this.annK = annK;
    this.deps = deps;
  }

  /**
   * Retrieve the most relevant chunks for a query.
   *
   * Pipeline:
   *   1. Embed query
   *   2. ANN search in vector store (fetch ANN_K candidates)
   *   3. Compute BM25 scores for all candidates (in-process)
   *   4. Fuse BM25 + vector into hybrid scores
   *   5. Re-rank using cross-encoder (if configured)
   *   6. Return top K results with full chunk objects
   */
  async retrieve(query: RetrievalQuery): Promise<RetrievalResponse> {
    const topK = query.topK ?? 5;
    const scoreThreshold = query.scoreThreshold ?? 0.0;

    // Step 1: embed query
    const embedStart = Date.now();
    const { embedding } = await this.deps.embedClient.embedOne(query.query);

    // Step 2: ANN search
    const searchFilters: SearchFilters | undefined = query.vaultKeyFilter
      ? { vaultKey: query.vaultKeyFilter }
      : query.contentTypeFilter
        ? { contentType: query.contentTypeFilter }
        : undefined;

    const annResults = await this.deps.vectorStore.search(
      query.tenantId,
      embedding,
      this.annK,
      searchFilters,
    );

    if (annResults.length === 0) {
      return {
        results: [],
        query: query.query,
        retrievedAt: new Date().toISOString(),
        totalChunksSearched: 0,
        hybridAlpha: this.alpha,
        embedModel: this.deps.embedClient.getDimension()?.toString() ?? "unknown",
      };
    }

    // Step 3: build candidate map
    const candidates = annResults.map((r) => ({
      annResult: r,
      chunk: r.payload.chunk as Chunk,
      vectorScore: r.score,
      bm25Score: 0,
    }));

    // Step 4: BM25 scores (in-process)
    if (this.deps.bm25Indexer) {
      const queryTokens = tokenise(query.query);
      const bm25Scores = this.deps.bm25Indexer.score(queryTokens);
      const normalisedBm25 = Bm25Scorer.normalise(bm25Scores);
      for (const c of candidates) {
        c.bm25Score = normalisedBm25.get(c.chunk.id) ?? 0;
      }
    }

    // Step 5: hybrid fusion
    const hybridScores = new Map<string, number>();
    for (const c of candidates) {
      hybridScores.set(
        c.chunk.id,
        this.alpha * c.bm25Score + (1 - this.alpha) * c.vectorScore,
      );
    }

    // Step 6: re-ranking
    let finalScores = hybridScores;
    if (this.deps.reranker) {
      finalScores = await this.deps.reranker.rerank(
        query.query,
        candidates.map((c) => ({
          id: c.chunk.id,
          chunkBody: c.chunk.body,
          vectorScore: c.vectorScore,
          bm25Score: c.bm25Score,
        })),
      );
    }

    // Step 7: assemble results sorted by final score
    const results: RetrievalResult[] = candidates
      .map((c) => ({
        chunk: c.chunk,
        score: finalScores.get(c.chunk.id) ?? 0,
        vectorScore: c.vectorScore,
        bm25Score: c.bm25Score,
        stale: isStale(c.chunk),
      }))
      .filter((r) => r.score >= scoreThreshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return {
      results,
      query: query.query,
      retrievedAt: new Date().toISOString(),
      totalChunksSearched: annResults.length,
      hybridAlpha: this.alpha,
      embedModel: this.deps.embedClient.getDimension()?.toString() ?? "unknown",
    };
  }
}

// ─── Staleness detection ─────────────────────────────────────────────────────

/**
 * Returns true if a chunk's content SHA doesn't match the vault page's
 * current SHA — meaning the vault page has been updated since this chunk
 * was embedded and stored.
 *
 * In a full implementation, the vector store payload would store contentSha256
 * and the vault store would provide a "current SHA" check. For now, we check
 * the metadata timestamp — a chunk older than 7 days is considered potentially stale.
 */
function isStale(chunk: Chunk): boolean {
  try {
    const updated = new Date(chunk.metadata.updatedAt);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    return updated < sevenDaysAgo;
  } catch {
    return false;
  }
}

// ─── Convenience ─────────────────────────────────────────────────────────────

/**
 * Build a HybridRetriever from env-configured dependencies.
 * Call this once at startup and reuse the retriever instance.
 */
export async function buildRetriever(
  embedClient: EmbedClient,
  vectorStore: IVectorStore,
): Promise<HybridRetriever> {
  const alpha = parseFloat(process.env["RAG_HYBRID_ALPHA"] ?? "0.3");
  const annK = parseInt(process.env["RAG_ANN_K"] ?? "20", 10);
  const rerankerUrl = process.env["RAG_RERANKER_URL"];

  const reranker = rerankerUrl ? new CrossEncoderReranker(rerankerUrl) : undefined;

  // Initialise vector store
  await vectorStore.init();

  return new HybridRetriever(
    { vectorStore, embedClient, reranker },
    alpha,
    annK,
  );
}
