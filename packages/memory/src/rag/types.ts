/**
 * RAG types — shared contracts for the retrieval-augmented generation pipeline.
 *
 * Pipeline stages:
 *   1. chunk()      — split raw text into semantic chunks
 *   2. embed()      — convert chunks + query into vectors
 *   3. store()      — persist chunks + vectors to vector DB
 *   4. retrieve()   — hybrid BM25 + vector search + re-rank
 *   5. generate()   — pass retrieved chunks to LLM (happens in agent adapter)
 *
 * Two storage layers:
 *   - Vault (markdown files)      — source of truth, human-readable, versioned
 *   - Vector store (Qdrant/Chroma) — search index, updated on ingest
 */

import { z } from "zod";

// ─── Chunking ────────────────────────────────────────────────────────────────

/** A text chunk ready for embedding and storage. */
export interface Chunk {
  id: string;         // uuid — stable reference across re-ingests
  tenantId: string;
  vaultKey: string;   // which vault page this chunk came from
  body: string;       // raw text, no frontmatter
  tokenCount: number; // approximate token count (cl100k_base approx)
  byteOffset: number; // byte offset in original document (for re-ingest dedup)
  chunkIndex: number; // position in ordered sequence for this vaultKey
  totalChunks: number;
  metadata: ChunkMetadata;
}

/** Structured metadata attached to every chunk — used for filtering and citation. */
export interface ChunkMetadata {
  /** ISO-8601 when this chunk was first created. */
  createdAt: string;
  /** ISO-8601 on every re-ingest. */
  updatedAt: string;
  /** Content SHA-256 — detects staleness vs. re-ingest delta. */
  contentSha256: string;
  /** Vault page title (extracted from frontmatter). */
  title?: string;
  /** Vault page tags from frontmatter. */
  tags?: string[];
  /** Source file path or URL this vault page was ingested from. */
  sourcePath?: string;
  /** Section heading this chunk falls under (if detectable). */
  sectionHeading?: string;
  /** Content type hint for filtering. */
  contentType: ChunkContentType;
}

export type ChunkContentType =
  | "document"   // general markdown / doc
  | "code"       // source file
  | "transcript" // meeting/call recording
  | "web"        // scraped page
  | "spreadsheet"
  | "email"
  | "chat";

export const ChunkContentTypeSchema = z.enum([
  "document", "code", "transcript", "web", "spreadsheet", "email", "chat",
]);

// ─── Embeddings ──────────────────────────────────────────────────────────────

/** A dense vector embedding. Model-agnostic — any embedding dimension works. */
export type Embedding = number[];

/** Provider-agnostic embedding model config. */
export interface EmbedConfig {
  /** Model name, e.g. "text-embedding-3-small" or provider's model ID. */
  model: string;
  /** API base URL for OpenAI-compatible endpoint. */
  baseUrl: string;
  /** API key — read from RAG_EMBEDDING_API_KEY env if not provided. */
  apiKey?: string;
  /** Embedding dimension. If unset, inferred from first response. */
  dimension?: number;
  /** Hard timeout in ms. Default: 30_000. */
  timeoutMs?: number;
}

/** Default embed config — reads from environment variables. */
export const DEFAULT_EMBED_CONFIG: EmbedConfig = {
  model: process.env["RAG_EMBEDDING_MODEL"] ?? "text-embedding-3-small",
  baseUrl:
    process.env["RAG_EMBEDDING_BASE_URL"] ??
    "https://api.openai.com/v1",
  apiKey: process.env["RAG_EMBEDDING_API_KEY"],
  dimension: undefined, // inferred from first response
  timeoutMs: 30_000,
};

// ─── Vector storage ─────────────────────────────────────────────────────────

/** A chunk record as stored in the vector database. */
export interface VectorRecord {
  id: string;           // same as Chunk.id — UUID
  tenantId: string;
  vaultKey: string;     // which vault page this belongs to
  chunk: Chunk;         // denormalized so vector DB doesn't need to join
  vector: Embedding;    // dense embedding
  // BM25 fields (populated at index time, not stored in vector DB)
  bm25Score?: number;
}

/** Vector store configuration — supports Qdrant and Chroma. */
export interface VectorStoreConfig {
  provider: "qdrant" | "chroma";
  /** For Qdrant: full URL e.g. "http://localhost:6333"
   * For Chroma: data directory e.g. "./chroma_data" */
  url: string;
  /** Collection name. Default: "awosChunks". */
  collection?: string;
  /** API key for managed Qdrant Cloud. */
  apiKey?: string;
  /** How many vectors to return from ANN search before re-ranking. */
  annK?: number; // default 20
}

/** Env-var driven vector store config. */
export function vecConfigFromEnv(): VectorStoreConfig {
  const provider = process.env["RAG_VECTOR_STORE_PROVIDER"] as
    | "qdrant"
    | "chroma"
    | undefined;
  if (!provider) {
    // Default: Chroma local
    return {
      provider: "chroma",
      url: process.env["RAG_CHROMA_PATH"] ?? "./chroma_data",
      collection: "awosChunks",
    };
  }
  if (provider === "qdrant") {
    return {
      provider: "qdrant",
      url: process.env["RAG_QDRANT_URL"] ?? "http://localhost:6333",
      collection: process.env["RAG_QDRANT_COLLECTION"] ?? "awosChunks",
      apiKey: process.env["RAG_QDRANT_API_KEY"],
    };
  }
  return {
    provider: "chroma",
    url: process.env["RAG_CHROMA_PATH"] ?? "./chroma_data",
    collection: "awosChunks",
  };
}

// ─── Retrieval ───────────────────────────────────────────────────────────────

/**
 * A retrieval query — the input to the RAG retrieve stage.
 * The query text is embedded; chunks are fetched from the vector store;
 * then re-ranked before being returned.
 */
export interface RetrievalQuery {
  tenantId: string;
  /** Natural language query — e.g. "what is our refund policy for enterprise customers?" */
  query: string;
  /**
   * Maximum chunks to return after re-ranking.
   * Default: 5. Increase for complex multi-topic queries.
   */
  topK?: number;
  /**
   * Optional vault keys to restrict retrieval to.
   * Use when you know the relevant documents.
   */
  vaultKeyFilter?: string[];
  /**
   * Optional content-type filter.
   * Use to restrict to e.g. only "document" chunks.
   */
  contentTypeFilter?: ChunkContentType[];
  /**
   * Minimum relevance score threshold (0-1).
   * Chunks below this score are excluded from results.
   * Default: 0.0 (no filter — use topK to limit instead).
   */
  scoreThreshold?: number;
}

/**
 * A retrieval result — a chunk plus relevance metadata.
 * Ordered by relevance (best first).
 */
export interface RetrievalResult {
  chunk: Chunk;
  /** Hybrid score: BM25 * alpha + cosineSimilarity * (1-alpha). Range ~[0, 1]. */
  score: number;
  /** Cosine similarity of query embedding to chunk embedding. */
  vectorScore: number;
  /** BM25 TF-IDF score. */
  bm25Score: number;
  /** True if this chunk's vault page has been updated since last embed. */
  stale: boolean;
}

/**
 * Full retrieval response — includes results plus query metadata for auditing.
 */
export interface RetrievalResponse {
  results: RetrievalResult[];
  query: string;
  retrievedAt: string; // ISO-8601
  totalChunksSearched: number; // how many the ANN search fetched (before re-rank)
  hybridAlpha: number; // BM25 weight: alpha=1 = BM25 only, alpha=0 = vector only
  embedModel: string;
}

// ─── Ingest pipeline ─────────────────────────────────────────────────────────

/**
 * Options for a single-document RAG ingest.
 * Passed to runRagIngest().
 */
export interface RagIngestOptions {
  tenantId: string;
  /** Full vault key, e.g. "projects/sgridworks/rag-fundamentals". */
  vaultKey: string;
  /** Raw text content — the full document body (no frontmatter). */
  content: string;
  /** Frontmatter metadata for chunk metadata population. */
  metadata?: Partial<ChunkMetadata>;
  /** Override chunk size in tokens. Default: 400. */
  chunkSize?: number;
  /** Override chunk overlap in tokens. Default: 100. */
  chunkOverlap?: number;
  /** Skip embedding and storage — just chunk. Useful for testing. */
  dryRun?: boolean;
}

/**
 * Result of a full RAG ingest for one document.
 */
export interface RagIngestResult {
  vaultKey: string;
  chunksCreated: number;
  bytesIngested: number;
  tokensIngested: number;
  durationMs: number;
  errors: string[]; // non-fatal errors (e.g. one chunk failed to embed)
  chunkIds: string[]; // IDs of created chunks — use for rollback
}

// ─── Config ─────────────────────────────────────────────────────────────────

/** Master RAG configuration — read from env + constructor args. */
export interface RagConfig {
  embed: EmbedConfig;
  vector: VectorStoreConfig;
  /** BM25 weight in hybrid scoring. 0.0 = pure vector, 1.0 = pure BM25. Default: 0.3. */
  hybridAlpha: number;
  /** ANN search k before re-ranking. Default: 20. */
  annK: number;
  /** Default chunk size in tokens. Default: 400. */
  chunkSize: number;
  /** Default chunk overlap in tokens. Default: 100. */
  chunkOverlap: number;
  /** Embedding batch size. Default: 100. */
  embedBatchSize: number;
}

export const DEFAULT_RAG_CONFIG: Required<RagConfig> = {
  hybridAlpha: 0.3,
  annK: 20,
  chunkSize: 400,
  chunkOverlap: 100,
  embedBatchSize: 100,
  embed: DEFAULT_EMBED_CONFIG,
  vector: {
    provider: "chroma",
    collection: "awosChunks",
    url: "./chroma_data",
  },
};

/** Build a RagConfig from env + overrides. */
export function ragConfigFromEnv(overrides?: Partial<RagConfig>): RagConfig {
  return {
    ...DEFAULT_RAG_CONFIG,
    embed: { ...DEFAULT_EMBED_CONFIG },
    vector: vecConfigFromEnv(),
    ...overrides,
  };
}
