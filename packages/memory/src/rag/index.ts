/**
 * RAG package — retrieval-augmented generation for AgentWorks OS memory.
 *
 * Usage:
 *
 *   import {
 *     runRagIngest,
 *     buildPipelineDeps,
 *     HybridRetriever,
 *     chunkDocument,
 *   } from "@agentworks/memory/rag";
 *
 *   // Build dependencies once at startup
 *   const deps = await buildPipelineDeps();
 *
 *   // Ingest a vault page when it is created or updated
 *   const result = await runRagIngest({
 *     tenantId: "tenant_abc",
 *     vaultKey: "projects/myproject/overview",
 *     content: page.body, // raw markdown without frontmatter
 *     metadata: { title: page.title, tags: ["project"] },
 *   }, deps);
 *
 *   // Retrieve relevant chunks for a query
 *   const retriever = new HybridRetriever({ vectorStore: deps.vectorStore, embedClient: deps.embedClient });
 *   const response = await retriever.retrieve({
 *     tenantId: "tenant_abc",
 *     query: "what is the refund policy for enterprise customers?",
 *     topK: 5,
 *   });
 *   // response.results[0].chunk.body === most relevant chunk
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type {
  Chunk,
  ChunkMetadata,
  ChunkContentType,
  Embedding,
  EmbedConfig,
  VectorStoreConfig,
  VectorRecord,
  RetrievalQuery,
  RetrievalResult,
  RetrievalResponse,
  RagIngestOptions,
  RagIngestResult,
  RagConfig,
} from "./types.js";

export {
  DEFAULT_EMBED_CONFIG,
  DEFAULT_RAG_CONFIG,
  ragConfigFromEnv,
  vecConfigFromEnv,
  ChunkContentTypeSchema,
} from "./types.js";

// ─── Chunking ────────────────────────────────────────────────────────────────

export { chunkDocument, estimateTokens, type ChunkOptions } from "./chunk.js";

// ─── Embedding ──────────────────────────────────────────────────────────────

export { EmbedClient, EmbedError, type EmbedResult, type EmbedResults } from "./embed-client.js";

// ─── Vector store ───────────────────────────────────────────────────────────

export {
  createVectorStore,
  type IVectorStore,
  type SearchFilters,
  type AnnResult,
} from "./vector-store.js";

export { ChromaStore, QdrantStore } from "./vector-store.js";

// ─── Retrieval ───────────────────────────────────────────────────────────────

export {
  HybridRetriever,
  Bm25Scorer,
  CrossEncoderReranker,
  buildRetriever,
  type RetrieverDeps,
} from "./retrieve.js";

// ─── Pipeline ───────────────────────────────────────────────────────────────

export {
  runRagIngest,
  runBulkIngest,
  reIngestVaultPage,
  deleteVaultPageFromVectorStore,
  rebuildBm25Index,
  fullTextSearch,
  buildPipelineDeps,
  type PipelineDeps,
  type BulkIngestOptions,
  type BulkIngestResult,
} from "./pipeline.js";
