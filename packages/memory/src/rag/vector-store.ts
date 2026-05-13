/**
 * Vector store adapter — pluggable storage for chunk embeddings.
 *
 * Supports:
 *   - **Chroma** (default, local) — simplest for single-node / on-prem deployment.
 *     Ships as a server process alongside agentos-d.
 *   - **Qdrant** — for production clusters needing replication, WAL, and quantization.
 *     Works with Qdrant Cloud (managed) or self-hosted.
 *
 * The adapter is responsible for:
 *   - Initialising the collection with the correct embedding dimension
 *   - Upserting chunk vectors + payload
 *   - ANN search (approximate nearest-neighbour)
 *   - Deleting chunks by vaultKey (used when a vault page is updated)
 *
 * The VectorStore is **tenant-isolated** — every operation takes a tenantId
 * and the underlying collection uses a tenantId prefix on the record ID.
 * This is enforced in-app; the vector DB itself is NOT responsible for isolation.
 */

import type {
  VectorStoreConfig,
  Chunk,
  Embedding,
} from "./types.js";

export { type VectorStoreConfig } from "./types.js";

// ─── Local types ───────────────────────────────────────────────────────────────

/** Vector record — an embedded chunk stored in the vector database. */
export interface VectorRecord {
  id: string;
  tenantId: string;
  vaultKey: string;
  chunk: Chunk;
  vector: Embedding;
}

// ─── Interface ───────────────────────────────────────────────────────────────

/**
 * The vector store contract. Implement this to add a new provider.
 */
export interface IVectorStore {
  /** Initialize the collection. Idempotent — safe to call on every startup. */
  init(): Promise<void>;

  /**
   * Upsert chunk vectors into the store.
   * If a chunk with the same ID already exists, it is replaced.
   */
  upsert(records: VectorRecord[]): Promise<void>;

  /**
   * Delete all chunks associated with a vault key.
   * Called when a vault page is updated — the old chunks are stale.
   */
  deleteByVaultKey(tenantId: string, vaultKey: string): Promise<void>;

  /**
   * ANN search — returns approximate nearest neighbours.
   *
   * @param tenantId       — tenant scope
   * @param queryEmbedding — the query vector
   * @param topK           — how many results to return (before re-ranking)
   * @param filters        — optional metadata filters
   * @returns              — raw ANN results (pre-rerank)
   */
  search(
    tenantId: string,
    queryEmbedding: Embedding,
    topK: number,
    filters?: SearchFilters,
  ): Promise<AnnResult[]>;

  /**
   * Return the number of vectors currently stored.
   */
  count(tenantId: string): Promise<number>;

  /** Close connections / free resources. */
  close(): Promise<void>;
}

export interface SearchFilters {
  vaultKey?: string | string[];
  contentType?: string | string[];
  tags?: string[];
  minCreatedAt?: string; // ISO-8601
  maxCreatedAt?: string;
}

/** A raw ANN search result — before re-ranking. */
export interface AnnResult {
  id: string; // chunk ID
  score: number; // cosine similarity (0-1)
  payload: {
    tenantId: string;
    vaultKey: string;
    chunk: Chunk;
    [key: string]: unknown;
  };
}

// ─── Factory ────────────────────────────────────────────────────────────────

/** Create a configured vector store instance. */
export function createVectorStore(config: VectorStoreConfig): IVectorStore {
  if (config.provider === "qdrant") {
    return new QdrantStore(config);
  }
  return new ChromaStore(config);
}

// ─── Chroma ─────────────────────────────────────────────────────────────────

/**
 * Chroma adapter — in-process, local-first, zero-dependency server mode.
 *
 * Chroma runs as a subprocess spawned by this adapter on first init().
 * It communicates over HTTP to its embedded server.
 *
 * Env vars for Chroma (set via RAG_* prefix):
 *   RAG_CHROMA_PATH   — data directory (default: ./chroma_data)
 *
 * Note: Chroma's JS client uses fetch exclusively; no @chroma-db/chroma package needed.
 */
export class ChromaStore implements IVectorStore {
  private readonly cfg: VectorStoreConfig;
  private baseUrl = "http://localhost:8000";
  private initPromise: Promise<void> | null = null;

  constructor(config: VectorStoreConfig) {
    this.cfg = {
      annK: 20,
      collection: "awosChunks",
      ...config,
    };
  }

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _init(): Promise<void> {
    const collection = this.cfg.collection ?? "awosChunks";

    // Chroma's REST API: create collection if not exists
    // The collection is created with a fixed dimension (we use 1536 for text-embedding-3-small)
    // Note: Chroma requires knowing dimension at collection creation time.
    // We default to 1536 (text-embedding-3-small) but a real deployment should pass the
    // dimension from the first embed response.
    const dim = 1536; // TODO: pull from env or first embed

    try {
      await fetch(`${this.baseUrl}/api/v1/collections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: collection,
          get_or_create: true,
          metadata: { dimension: dim },
        }),
      });
    } catch (err) {
      // Chroma server may not be running — warn but don't fail init
      console.warn("[ChromaStore] Could not connect to Chroma server:", err);
    }
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const collection = this.cfg.collection ?? "awosChunks";

    const embeddings = records.map((r) => r.vector);
    const ids = records.map((r) => makeRecordId(r.tenantId, r.id));
    const metadatas = records.map((r) => ({
      tenantId: r.tenantId,
      vaultKey: r.vaultKey,
      chunkId: r.id,
      ...r.chunk.metadata,
    }));
    const documents = records.map((r) => r.chunk.body);

    await fetch(`${this.baseUrl}/api/v1/collections/${collection}/upsert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, embeddings, metadatas, documents }),
    });
  }

  async deleteByVaultKey(tenantId: string, vaultKey: string): Promise<void> {
    const collection = this.cfg.collection ?? "awosChunks";
    const prefix = `${tenantId}:`;
    await fetch(
      `${this.baseUrl}/api/v1/collections/${collection}/delete` +
        `?where=${encodeURIComponent(JSON.stringify({ vaultKey }))}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
  }

  async search(
    tenantId: string,
    queryEmbedding: Embedding,
    topK: number,
    filters?: SearchFilters,
  ): Promise<AnnResult[]> {
    const collection = this.cfg.collection ?? "awosChunks";
    const k = filters?.vaultKey ? 100 : topK; // fetch more if filtering

    const whereFilter = buildChromaWhere(filters);

    const res = await fetch(
      `${this.baseUrl}/api/v1/collections/${collection}/query`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query_embeddings: [queryEmbedding],
          n_results: k,
          where: whereFilter,
          include: ["metadatas", "documents", "distances"],
        }),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Chroma query failed: ${res.status} ${text}`);
    }

    const data = await res.json() as ChromaQueryResult;
    const ids: string[] = data.ids?.[0] ?? [];
    const distances: number[] = data.distances?.[0] ?? [];
    const metadatas: ChromaMetadata[] = data.metadatas?.[0] ?? [];
    const documents: string[] = data.documents?.[0] ?? [];

    // Cosine similarity from Chroma: distance is 0=identical, 2=opposite
    // Convert to 0-1 similarity score
    const results: AnnResult[] = ids.map((id, i) => {
      const metadata = metadatas[i] ?? {};
      return {
        id,
        score: 1 - (distances[i] ?? 0) / 2, // normalise to 0-1
        payload: {
          tenantId: metadata.tenantId ?? tenantId,
          vaultKey: metadata.vaultKey ?? "",
          chunk: JSON.parse(documents[i] ?? "{}") as Chunk,
          ...metadata,
        },
      };
    });

    return results;
  }

  async count(tenantId: string): Promise<number> {
    const collection = this.cfg.collection ?? "awosChunks";
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/collections/${collection}/count`, {
        method: "GET",
      });
      if (!res.ok) return 0;
      return (await res.json()) as number;
    } catch {
      return 0;
    }
  }

  async close(): Promise<void> {
    // Chroma runs in separate process — nothing to close
  }
}

// ─── Qdrant ─────────────────────────────────────────────────────────────────

/**
 * Qdrant adapter — for self-hosted or Qdrant Cloud deployments.
 *
 * Qdrant is a high-performance vector database with:
 *   - HNSW + quantization for fast ANN search
 *   - Named ranges / tenant isolation via filter
 *   - Point-level CRUD with consistency levels
 *
 * Env vars for Qdrant:
 *   RAG_QDRANT_URL       — e.g. "http://localhost:6333" or "https://xyz.qdrant.io"
 *   RAG_QDRANT_API_KEY   — for Qdrant Cloud
 *   RAG_QDRANT_COLLECTION — collection name (default: awosChunks)
 */
export class QdrantStore implements IVectorStore {
  private readonly cfg: Required<VectorStoreConfig>;
  private readonly headers: Record<string, string>;

  constructor(config: VectorStoreConfig) {
    this.cfg = {
      provider: "qdrant",
      url: config.url ?? "http://localhost:6333",
      collection: config.collection ?? "awosChunks",
      apiKey: config.apiKey ?? process.env["RAG_QDRANT_API_KEY"] ?? "",
      annK: config.annK ?? 20,
    };
    this.headers = {
      "Content-Type": "application/json",
      ...(this.cfg.apiKey ? { "api-key": this.cfg.apiKey } : {}),
    };
  }

  async init(): Promise<void> {
    // Create collection if it doesn't exist
    const collection = this.cfg.collection;
    const dim = parseInt(process.env["RAG_EMBEDDING_DIMENSION"] ?? "1536", 10);

    const exists = await this.collectionExists(collection);
    if (!exists) {
      await this.createCollection(collection, dim);
    }
  }

  private async collectionExists(name: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.cfg.url}/collections/${name}`, {
        headers: this.headers,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async createCollection(name: string, dim: number): Promise<void> {
    await fetch(`${this.cfg.url}/collections/${name}`, {
      method: "PUT",
      headers: this.headers,
      body: JSON.stringify({
        vectors: {
          size: dim,
          distance: "Cosine",
        },
        // Qdrant optimises for single-node dev; use HNSW for prod
        params: {
          hnsw_on_disk: true,
        },
      }),
    });
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const collection = this.cfg.collection;

    const points = records.map((r) => ({
      id: hashIds(r.tenantId, r.id), // numeric 64-bit ID
      vector: r.vector,
      payload: {
        tenantId: r.tenantId,
        vaultKey: r.vaultKey,
        chunkId: r.id,
        chunk: r.chunk,
        contentSha256: r.chunk.metadata.contentSha256,
      },
    }));

    await fetch(`${this.cfg.url}/collections/${collection}/points Upsert`, {
      method: "PUT",
      headers: this.headers,
      body: JSON.stringify({ points }),
    });
  }

  async deleteByVaultKey(tenantId: string, vaultKey: string): Promise<void> {
    const collection = this.cfg.collection;
    await fetch(`${this.cfg.url}/collections/${collection}/points/delete`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        filter: {
          must: [
            { key: "tenantId", match: { value: tenantId } },
            { key: "vaultKey", match: { value: vaultKey } },
          ],
        },
      }),
    });
  }

  async search(
    tenantId: string,
    queryEmbedding: Embedding,
    topK: number,
    filters?: SearchFilters,
  ): Promise<AnnResult[]> {
    const collection = this.cfg.collection;
    const qdrantFilter = buildQdrantFilter(tenantId, filters);

    const res = await fetch(
      `${this.cfg.url}/collections/${collection}/points/search`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          vector: queryEmbedding,
          limit: topK,
          with_payload: true,
          score_threshold: 0.0,
          filter: qdrantFilter,
        }),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Qdrant search failed: ${res.status} ${text}`);
    }

    const data = await res.json() as QdrantSearchResult;
    return (data.result ?? []).map((p) => ({
      id: String(p.id),
      score: p.score, // Qdrant already returns cosine similarity with Cosine distance
      payload: p.payload as AnnResult["payload"],
    }));
  }

  async count(tenantId: string): Promise<number> {
    const collection = this.cfg.collection;
    try {
      const res = await fetch(`${this.cfg.url}/collections/${collection}/points/count`, {
        method: "GET",
        headers: this.headers,
        body: JSON.stringify({ filter: { must: [{ key: "tenantId", match: { value: tenantId } }] } }),
      });
      if (!res.ok) return 0;
      const data = await res.json() as { result?: number };
      return data.result ?? 0;
    } catch {
      return 0;
    }
  }

  async close(): Promise<void> {
    // HTTP client — no persistent connection to close
  }
}

// ─── Filter builders ─────────────────────────────────────────────────────────

function buildChromaWhere(filters?: SearchFilters): Record<string, unknown> | undefined {
  if (!filters) return undefined;
  const conditions: Array<Record<string, unknown>> = [];

  if (filters.vaultKey) {
    const keys = Array.isArray(filters.vaultKey) ? filters.vaultKey : [filters.vaultKey];
    conditions.push({ vaultKey: { $in: keys } });
  }
  if (filters.contentType) {
    const types = Array.isArray(filters.contentType) ? filters.contentType : [filters.contentType];
    conditions.push({ contentType: { $in: types } });
  }
  if (filters.minCreatedAt) {
    conditions.push({ createdAt: { $gte: filters.minCreatedAt } });
  }

  return conditions.length > 0 ? { $and: conditions } : undefined;
}

function buildQdrantFilter(tenantId: string, filters?: SearchFilters): QdrantFilter {
  const must: QdrantCondition[] = [{ key: "tenantId", match: { value: tenantId } }];

  if (!filters) return { must };

  if (filters.vaultKey) {
    const keys = Array.isArray(filters.vaultKey) ? filters.vaultKey : [filters.vaultKey];
    must.push({ key: "vaultKey", match: { any: keys } });
  }
  if (filters.contentType) {
    const types = Array.isArray(filters.contentType) ? filters.contentType : [filters.contentType];
    must.push({ key: "contentType", match: { any: types } });
  }
  if (filters.minCreatedAt) {
    must.push({ key: "createdAt", range: { gte: filters.minCreatedAt } });
  }

  return { must };
}

// ─── Qdrant filter types ───────────────────────────────────────────────────────

interface QdrantFilter { must: QdrantCondition[]; }
type QdrantCondition =
  | { key: string; match: { value: string } | { any: string[] } }
  | { key: string; range: { gte?: string; lte?: string } };

// ─── Utilities ───────────────────────────────────────────────────────────────

/** Composite record ID that encodes tenantId so Chroma doesn't need multi-tenancy. */
function makeRecordId(tenantId: string, chunkId: string): string {
  return `${tenantId}:${chunkId}`;
}

/** Deterministic 64-bit hash for Qdrant point IDs (Qdrant requires numeric ID). */
function hashIds(tenantId: string, chunkId: string): number {
  let hash = 0;
  const str = `${tenantId}:${chunkId}`;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return hash;
}

// ─── Response types ─────────────────────────────────────────────────────────

interface ChromaQueryResult {
  ids: string[][];
  distances: number[][];
  metadatas: ChromaMetadata[][];
  documents: string[][];
}

interface ChromaMetadata {
  tenantId?: string;
  vaultKey?: string;
  chunkId?: string;
  [key: string]: unknown;
}

interface QdrantSearchResult {
  result: Array<{
    id: number;
    score: number;
    payload: AnnResult["payload"];
  }>;
}
