/**
 * @agentworks/memory — vault contract types and the default file-backed store.
 *
 * The vault is tenant-isolated, append-friendly markdown storage used by
 * agentos-d's MCP memory.read / memory.write tools. v1 is file-backed so
 * customers can rsync, version-control, or sync via Obsidian. Future
 * implementations may use SQLite, S3, or a content-addressed store.
 *
 * Two contracts that all stores must honour:
 *
 *   1. Tenant isolation. Every read/write is scoped to a tenantId; one
 *      tenant must never observe another tenant's pages.
 *   2. Stable keys. A page key is a forward-slash path like
 *      "projects/sgridworks" — implementations map that to whatever
 *      backing storage they use, but the same key always returns the
 *      same logical page.
 */

export type {
  VaultKey,
  VaultPage,
  VaultReadResult,
  VaultWriteOptions,
  VaultWriteResult,
  VaultStore,
} from "./types.js";

export { UsageTracker } from "./usage-tracker.js";

export { VaultKeySchema, VaultWriteModeSchema } from "./types.js";
export { FileVaultStore, DiskFullError, MemoryKeyTooLargeError } from "./file-store.js";
export {
  OperatorMemoryStore,
  OperatorMemoryError,
  type OperatorMemoryEntry,
  type OperatorMemoryRead,
  type OperatorMemoryStoreOpts,
} from "./operator-memory.js";
export {
  loadManifest,
  saveManifest,
  setEntry,
  getEntry,
  removeEntry,
  isUnchanged,
  sha256OfContent,
  MANIFEST_FILENAME,
  type Manifest,
  type ManifestEntry,
} from "./manifest.js";
export {
  parseHotCache,
  renderHotCache,
  readHotCache,
  writeHotCache,
  emptyHotCache,
  isOverWordBudget,
  wordCount,
  HOT_CACHE_KEY,
  type HotCache,
} from "./hot-cache.js";
export {
  lintVault,
  type LintFinding,
  type LintReport,
  type LintOptions,
  type LintKind,
  type LintSeverity,
} from "./lint.js";
export {
  slugFromPath,
  slugFromUrl,
  renderSourceFrontmatter,
  planIngest,
  recordIngest,
  prependLogEntry,
  LOG_FILENAME,
  type IngestPlan,
  type IngestRecord,
  type SourceFrontmatter,
} from "./ingest.js";
export {
  noteFolder,
  renderNoteFrontmatter,
  saveNote,
  appendDecisionLogEntry,
  appendActionTrackerEntry,
  DECISION_LOG_FILENAME,
  ACTION_TRACKER_FILENAME,
  VAULT_LOG_FILENAME,
  type NoteType,
  type NoteSpec,
  type SaveResult,
  type DecisionLogEntry,
  type ActionTrackerEntry,
} from "./save.js";
export {
  SignalDetector,
  type Signal,
} from "./signal-detector.js";
export {
  type Entity,
  type EntityType,
  type Relationship,
  type RelationshipGraph,
  type GraphSummary,
  parseRelatedFrontmatter,
  renderRelatedFrontmatter,
  normalizeWikilink,
  buildRelationshipGraph,
  findNeighbors,
  findReferencers,
  traverseGraph,
  computeDegrees,
  mergeGraphs,
  summarizeGraph,
  buildTenantGraph,
  extractWikilinks,
} from "./relationships.js";
export { consolidateVault, type ConsolidateResult } from "./consolidate.js";

// ─── RAG ─────────────────────────────────────────────────────────────────────

export {
  // Types
  type Chunk,
  type ChunkMetadata,
  type ChunkContentType,
  type EmbedConfig,
  type VectorStoreConfig,
  type VectorRecord,
  type RetrievalQuery,
  type RetrievalResult,
  type RetrievalResponse,
  type RagIngestOptions,
  type RagIngestResult,
  type RagConfig,
  // Chunking
  chunkDocument,
  estimateTokens,
  // Embed client
  EmbedClient,
  EmbedError,
  // Vector store
  createVectorStore,
  type IVectorStore,
  ChromaStore,
  QdrantStore,
  // Retrieval
  HybridRetriever,
  Bm25Scorer,
  buildRetriever,
  // Pipeline
  runRagIngest,
  runBulkIngest,
  reIngestVaultPage,
  deleteVaultPageFromVectorStore,
  buildPipelineDeps,
  type BulkIngestOptions,
  type BulkIngestResult,
} from "./rag/index.js";
export {
  extractWikilinks as extractWikilinkObjects,
  extractMentions,
  extractUrls,
  extractDates,
  extractHashtags,
  extractQuoted,
  extractHeadings,
  extractPersonNames,
  extractTopics,
  stripMarkdown,
  extractAll,
  extractionStats,
  entitiesFromExtraction,
  type ExtractionResult,
  type ExtractionStats,
} from "./extract.js";
export {
  renderSessionBrief,
  type Session,
  type SessionBrief,
  type SessionEvent,
} from "./session-brief.js";
