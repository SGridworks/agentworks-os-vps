/**
 * RAG ingest pipeline — end-to-end document ingestion for AWOS memory.
 *
 * Implements the full 5-stage RAG pipeline for a single document:
 *   Stage 1: Chunk    — chunkDocument() from chunk.ts
 *   Stage 2: Embed   — embedClient.embed() from embed-client.ts
 *   Stage 3: Store   — vectorStore.upsert() from vector-store.ts
 *   Stage 4: Register — index BM25 corpus + update manifest (done in caller)
 *   Stage 5: Generate is handled by the agent adapter (not this module)
 *
 * This pipeline is called by the memory-server MCP tool whenever a vault page
 * is created or updated. It runs synchronously per document (one document per call).
 * For bulk re-ingestion (e.g. after a batch vault update), call this in a loop
 * or use runBulkIngest() which parallelises safely.
 *
 * Rollback: if upsert fails after chunks were embedded, the caller can pass
 * chunkIds from the result to mark those chunks as deleted in the vector store.
 *
 * Env vars (also see types.ts):
 *   RAG_INGEST_BATCH_SIZE   — max documents per bulk ingest batch (default: 10)
 *   RAG_PARALLEL_EMBEDS     — max concurrent embed API calls per batch (default: 3)
 */

import { createHash } from "node:crypto";
import type {
  Chunk,
  Embedding,
  VectorRecord,
  RagIngestOptions,
  RagIngestResult,
  RagConfig,
  RetrievalResult,
} from "./types.js";
import { chunkDocument } from "./chunk.js";
import { EmbedClient } from "./embed-client.js";
import { createVectorStore, type IVectorStore } from "./vector-store.js";
import {
  HybridRetriever,
  buildRetriever,
  Bm25Scorer,
  type RetrieverDeps,
} from "./retrieve.js";

// ─── Single-document ingest ───────────────────────────────────────────────────

/**
 * Run the full RAG ingest pipeline for one document.
 *
 * Usage:
 *   const result = await runRagIngest({
 *     tenantId: "tenant_abc",
 *     vaultKey: "projects/sgridworks/rag-fundamentals",
 *     content: vaultPage.body,  // raw markdown, no frontmatter
 *     metadata: { title: "RAG Fundamentals", tags: ["rag", "memory"] },
 *   });
 *   // result.chunksCreated === N chunks now searchable in vector store
 */
export async function runRagIngest(
  opts: RagIngestOptions,
  deps: PipelineDeps,
): Promise<RagIngestResult> {
  const start = Date.now();
  const errors: string[] = [];
  const chunkIds: string[] = [];

  try {
    // ── Stage 1: Chunk ──────────────────────────────────────────────────────
    const chunks: Chunk[] = chunkDocument(
      opts.tenantId,
      opts.vaultKey,
      opts.content,
      {
        targetTokens: opts.chunkSize ?? 400,
        overlapTokens: opts.chunkOverlap ?? 100,
        contentType: opts.metadata?.contentType ?? "document",
      },
    );

    if (chunks.length === 0) {
      return {
        vaultKey: opts.vaultKey,
        chunksCreated: 0,
        bytesIngested: opts.content.length,
        tokensIngested: 0,
        durationMs: Date.now() - start,
        errors: [],
        chunkIds: [],
      };
    }

    // ── Stage 2: Embed ─────────────────────────────────────────────────────
    // If dryRun, skip embedding
    if (opts.dryRun) {
      return {
        vaultKey: opts.vaultKey,
        chunksCreated: chunks.length,
        bytesIngested: opts.content.length,
        tokensIngested: chunks.reduce((s, c) => s + c.tokenCount, 0),
        durationMs: Date.now() - start,
        errors: [],
        chunkIds: chunks.map((c) => c.id),
      };
    }

    // Upsert metadata onto each chunk
    const now = new Date().toISOString();
    const contentSha = sha256Hex(opts.content);
    for (const chunk of chunks) {
      chunk.metadata = {
        ...chunk.metadata,
        createdAt: now,
        updatedAt: now,
        contentSha256: contentSha,
        title: opts.metadata?.title,
        tags: opts.metadata?.tags,
        sourcePath: opts.metadata?.sourcePath,
        sectionHeading: opts.metadata?.sectionHeading,
        contentType: opts.metadata?.contentType ?? "document",
      };
    }

    // Embed in batches
    const embedBatchSize = 100;
    const allEmbeddings: Embedding[] = [];

    for (let i = 0; i < chunks.length; i += embedBatchSize) {
      const batch = chunks.slice(i, i + embedBatchSize);
      try {
        const { results } = await deps.embedClient.embed(batch.map((c) => c.body));
        for (const r of results) {
          allEmbeddings.push(r.embedding);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Embed batch ${i}-${i + batch.length} failed: ${msg}`);
        // Continue with remaining batches
      }
    }

    if (allEmbeddings.length < chunks.length) {
      // Some embeddings failed — proceed with what we have, track missing
      const failed = chunks.length - allEmbeddings.length;
      errors.push(`${failed}/${chunks.length} chunks failed to embed; they are not in the vector store`);
    }

    // ── Stage 3: Store ──────────────────────────────────────────────────────
    const records: VectorRecord[] = chunks
      .slice(0, allEmbeddings.length)
      .map((chunk, i) => ({
        id: chunk.id,
        tenantId: opts.tenantId,
        vaultKey: opts.vaultKey,
        chunk,
        vector: allEmbeddings[i],
      }));

    try {
      await deps.vectorStore.upsert(records);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Vector store upsert failed: ${msg}`);
    }

    const tokensIngested = chunks
      .slice(0, allEmbeddings.length)
      .reduce((s, c) => s + c.tokenCount, 0);

    return {
      vaultKey: opts.vaultKey,
      chunksCreated: allEmbeddings.length,
      bytesIngested: opts.content.length,
      tokensIngested,
      durationMs: Date.now() - start,
      errors,
      chunkIds: records.map((r) => r.id),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Ingest pipeline failed: ${msg}`);
    return {
      vaultKey: opts.vaultKey,
      chunksCreated: 0,
      bytesIngested: opts.content.length,
      tokensIngested: 0,
      durationMs: Date.now() - start,
      errors,
      chunkIds: [],
    };
  }
}

// ─── Bulk ingest ──────────────────────────────────────────────────────────────

export interface BulkIngestOptions {
  tenantId: string;
  documents: Array<{
    vaultKey: string;
    content: string;
    metadata?: RagIngestOptions["metadata"];
  }>;
  chunkSize?: number;
  chunkOverlap?: number;
  /** Max concurrent document ingests. Default: 3. */
  concurrency?: number;
}

export interface BulkIngestResult {
  totalDocuments: number;
  successfulDocuments: number;
  failedDocuments: number;
  totalChunksCreated: number;
  totalTokensIngested: number;
  totalDurationMs: number;
  perDocument: Array<{
    vaultKey: string;
    ok: boolean;
    result?: RagIngestResult;
    error?: string;
  }>;
}

/**
 * Run RAG ingest across multiple documents in parallel (bounded concurrency).
 *
 * Use this after:
 *   - A vault bulk sync (many pages updated at once)
 *   - A new tenant onboarding (seeding the vector store with existing vault)
 *
 * Note: BM25 index is rebuilt after all documents are ingested.
 * For very large corpora (>10k chunks), consider rebuilding the BM25 index
 * asynchronously after the bulk ingest completes.
 */
export async function runBulkIngest(
  opts: BulkIngestOptions,
  deps: PipelineDeps,
): Promise<BulkIngestResult> {
  const start = Date.now();
  const concurrency = opts.concurrency ?? 3;
  const perDocument: BulkIngestResult["perDocument"] = [];

  // Process in bounded parallel batches
  for (let i = 0; i < opts.documents.length; i += concurrency) {
    const batch = opts.documents.slice(i, i + concurrency);

    const results = await Promise.allSettled(
      batch.map((doc) =>
        runRagIngest(
          {
            tenantId: opts.tenantId,
            vaultKey: doc.vaultKey,
            content: doc.content,
            metadata: doc.metadata,
            chunkSize: opts.chunkSize,
            chunkOverlap: opts.chunkOverlap,
          },
          deps,
        ),
      ),
    );

    for (let j = 0; j < batch.length; j++) {
      const doc = batch[j];
      const result = results[j];

      if (result.status === "fulfilled") {
        perDocument.push({ vaultKey: doc.vaultKey, ok: true, result: result.value });
      } else {
        perDocument.push({
          vaultKey: doc.vaultKey,
          ok: false,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
  }

  const successful = perDocument.filter((r) => r.ok).length;
  const failed = perDocument.filter((r) => !r.ok).length;
  const totalChunks = perDocument.reduce(
    (s, r) => s + (r.result?.chunksCreated ?? 0),
    0,
  );
  const totalTokens = perDocument.reduce(
    (s, r) => s + (r.result?.tokensIngested ?? 0),
    0,
  );

  return {
    totalDocuments: opts.documents.length,
    successfulDocuments: successful,
    failedDocuments: failed,
    totalChunksCreated: totalChunks,
    totalTokensIngested: totalTokens,
    totalDurationMs: Date.now() - start,
    perDocument,
  };
}

// ─── BM25 index management ────────────────────────────────────────────────────

/**
 * Rebuild the BM25 index from all chunks currently in the vector store.
 *
 * Call this after:
 *   - Bulk ingest completes (to index newly added chunks)
 *   - A significant number of updates (to remove deleted chunk entries)
 *
 * Note: In production, the BM25 index should be maintained incrementally.
 * A full rebuild is acceptable for corpora < 50k chunks.
 *
 * @param allChunks  — all Chunk objects currently in the vector store
 *                     (fetch via vectorStore.search with very high topK,
 *                      or maintain the chunk list separately)
 */
export function rebuildBm25Index(allChunks: Chunk[]): Bm25Scorer {
  return Bm25Scorer.fromChunks(allChunks);
}

// ─── Re-ingest (update) ──────────────────────────────────────────────────────

/**
 * Re-ingest a vault page — deletes all existing chunks for that vaultKey
 * and ingests the new version.
 *
 * This is called when a vault page is updated (via memory.write or vault.save).
 * The pattern: delete old chunks → ingest new chunks.
 * This is simpler than an incremental update and guarantees consistency.
 */
export async function reIngestVaultPage(
  opts: RagIngestOptions,
  deps: PipelineDeps,
): Promise<RagIngestResult> {
  // Delete existing chunks for this vault key
  await deps.vectorStore.deleteByVaultKey(opts.tenantId, opts.vaultKey);
  // Re-ingest
  return runRagIngest(opts, deps);
}

// ─── Delete vault page from vector store ──────────────────────────────────────

/**
 * Remove all chunks for a vault page from the vector store.
 * Called when a vault page is deleted.
 */
export async function deleteVaultPageFromVectorStore(
  tenantId: string,
  vaultKey: string,
  vectorStore: IVectorStore,
): Promise<void> {
  await vectorStore.deleteByVaultKey(tenantId, vaultKey);
}

// ─── Full-text search (fallback when vector store is empty) ───────────────────

/**
 * Full-text search across chunk bodies using simple TF-IDF.
 * This is the fallback when the vector store has no chunks for a tenant.
 *
 * In production, this should be replaced with a proper full-text index
 * (e.g. SQLite FTS5, postgres tsvector) for performance at scale.
 */
export function fullTextSearch(
  query: string,
  chunks: Chunk[],
  topK = 5,
): RetrievalResult[] {
  const scorer = Bm25Scorer.fromChunks(chunks);
  const queryTokens = tokenise(query);
  const scores = scorer.score(queryTokens);
  const normalised = Bm25Scorer.normalise(scores);

  return Array.from(normalised.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id, score]) => {
      const chunk = chunks.find((c) => c.id === id)!;
      return {
        chunk,
        score,
        vectorScore: 0,
        bm25Score: score,
        stale: false,
      };
    });
}

// ─── Dependencies ─────────────────────────────────────────────────────────────

export interface PipelineDeps {
  embedClient: EmbedClient;
  vectorStore: IVectorStore;
}

/**
 * Build a fully configured PipelineDeps from environment variables.
 * Call once at startup.
 */
export async function buildPipelineDeps(config?: {
  embed?: Partial<import("./types.js").EmbedConfig>;
  vector?: Partial<import("./types.js").VectorStoreConfig>;
}): Promise<PipelineDeps> {
  const embedClient = new EmbedClient({
    model: config?.embed?.model ?? process.env["RAG_EMBEDDING_MODEL"] ?? "text-embedding-3-small",
    baseUrl: config?.embed?.baseUrl ?? process.env["RAG_EMBEDDING_BASE_URL"] ?? "https://api.openai.com/v1",
    apiKey: config?.embed?.apiKey ?? process.env["RAG_EMBEDDING_API_KEY"],
    timeoutMs: 30_000,
  });

  const vectorStore = createVectorStore({
    provider: (process.env["RAG_VECTOR_STORE_PROVIDER"] as "qdrant" | "chroma") ?? "chroma",
    url: process.env["RAG_QDRANT_URL"] ?? process.env["RAG_CHROMA_PATH"] ?? "./chroma_data",
    collection: process.env["RAG_QDRANT_COLLECTION"] ?? "awosChunks",
    apiKey: process.env["RAG_QDRANT_API_KEY"],
  });

  await vectorStore.init();

  return { embedClient, vectorStore };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}
