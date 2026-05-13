# Agentic Memory Recommendations for AgentWorks OS

**Date:** 2026-05-02
**Sources:** arXiv/GitHub research on persistent memory architectures, RAG patterns for agents, and existing vault analysis at `~/vault`

---

## Executive Summary

AgentWorks OS has an incipient memory architecture via `mcp_agentworks_memory_read`/`memory_write` and a vault at `~/vault`. The gap: no episode/chunk management, no vector retrieval, no importance weighting, no cross-session consolidation. This doc specifies what to add and where.

---

## Part I — Persistent Memory (SessionDB Layer)

### Current State
- `mcp_agentworks_memory_read(key)` / `memory_write(key)` — flat key-value with tenant isolation
- `mcp_agentworks_memory_hot(tenantId)` — rolling hot-cache summary (mirrors `vault/wiki/hot.md`)
- No episode boundaries, no vector embeddings, no importance scoring

### What the Research Says
The dominant pattern across production systems: **SQLite + FTS5 + embeddings + episodic chunking + knowledge-graph overlay**. Not a single system — a composite of patterns from agentmemory, memory-access, and Vektori.

### Recommendations

#### REC 1: Episode Chunking on Session Boundaries (High Priority)

**What:** Split each agent session into episodes. Store episodes with metadata: `session_id`, `started_at`, `ended_at`, `agent_role`, `task_type`, `outcome` (success/failure/blocked).

**Why:** Agents need to retrieve "how did we handle a similar task last time?" Without episode boundaries, retrieval returns raw conversation logs. With them, it returns task-level summaries.

**Schema sketch:**
```sql
CREATE TABLE episodes (
  id TEXT PRIMARY KEY,           -- UUID
  tenant_id TEXT NOT NULL,
  agent_id TEXT,
  session_id TEXT,               -- groups episodes by conversation thread
  started_at INTEGER,
  ended_at INTEGER,
  role TEXT,                     -- backend, frontend, compliance, etc.
  task_type TEXT,                -- bugfix, feature, refactor, etc.
  outcome TEXT,                  -- success, failure, blocked
  summary TEXT,                  -- LLM-generated 2-3 sentence summary
  embedding BLOB,                -- of the summary
  importance REAL DEFAULT 0.5,   -- 0-1, drives retrieval优先级
  lifecycle TEXT DEFAULT 'active' -- active|archived|invalidated
);

CREATE VIRTUAL TABLE episodes_fts USING fts5(summary);
CREATE INDEX idx_episodes_tenant_role ON episodes(tenant_id, role);
CREATE INDEX idx_episodes_session ON episodes(session_id);
```

**Implementation path:**
1. On session end: generate summary via LLM, compute embedding, write episode row
2. On retrieval: semantic search over `episodes_fts` + filter by `tenant_id` + `role`
3. Importance: initial default 0.5, adjust up if agent marks high-value, down via staleness decay

---

#### REC 2: Atomic Insights — Semantic Frame Decomposition (High Priority)

**What:** Extract structured "insights" from conversations: preferences, facts, plans, constraints. Each insight has a `frame_type` (from memory-access taxonomy: `preference`, `fact`, `plan`, `constraint`, `feedback`, `error_pattern`).

**Why:** Raw conversation is verbose for retrieval. Atomic insights are ~10x denser and frame-type enables targeted recall ("get me all constraints for this tenant").

**Schema sketch:**
```sql
CREATE TABLE insights (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  episode_id TEXT REFERENCES episodes(id),
  frame_type TEXT,               -- preference|fact|plan|constraint|feedback|error_pattern
  subject TEXT,                  -- the entity this insight is about
  content TEXT,                  -- the insight itself (1-3 sentences max)
  embedding BLOB,
  importance REAL DEFAULT 0.5,
  created_at INTEGER,
  source TEXT,                  -- 'agent_reflection'|'user_correction'|'task_outcome'
  validated BOOLEAN DEFAULT FALSE
);

CREATE VIRTUAL TABLE insights_fts USING fts5(content);
CREATE INDEX idx_insights_subject ON insights(subject);
CREATE INDEX idx_insights_frame ON insights(frame_type);
```

**Extraction trigger:** After each session, run a lightweight LLM extraction pass over the episode summary. Alternatively, extract inline when agent posts a `feedback` or `correction` comment.

---

#### REC 3: Three-Tier Memory Funnel (Medium Priority, Next Sprint)

**What:** Implement hot/warm/cold tier behavior within SessionDB:

| Tier | Content | Retention | Retrieval |
|------|---------|-----------|-----------|
| Hot  | Last 10 turns in-memory | Per-session | Immediate |
| Warm | Episodes + insights with `importance > 0.6` | 7 days | <50ms via SessionDB query |
| Cold | All episodes + insights | Until invalidated | Full scan, acceptable latency |

**Why:** Avoids inflating context with low-value memories. Agents fetch hot + warm on startup; cold only on explicit query.

**Implementation:** Add `tier` column to episodes/insights with TTL-based demotion job. Warm items accessed less than once per 7 days → cold.

---

#### REC 4: Knowledge Graph Overlay on Episodes (Lower Priority)

**What:** Add `subject`, `predicate`, `object` triples extracted from episodes (following Vektori's L0 fact layer pattern). Enables graph traversal queries like "show me all errors related to database migrations for tenant X."

**Schema sketch:**
```sql
CREATE TABLE kg_triples (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  episode_id TEXT REFERENCES episodes(id),
  subject TEXT,
  predicate TEXT,
  object TEXT,
  created_at INTEGER
);

CREATE INDEX idx_kg_subject ON kg_triples(subject);
CREATE INDEX idx_kg_tenant ON kg_triples(tenant_id);
```

**Note:** This is a Phase 2 item. Phase 1 (REC 1-3) should ship first.

---

## Part II — RAG Layer (Vector + Full-Text Retrieval)

### Current State
No vector retrieval. `memory_read` is key-based lookup only. No semantic search.

### What the Research Says
Production agent RAG = **hybrid dense+sparse retrieval** (vector similarity + BM25 keyword) fused via Reciprocal Rank Fusion (RRF). Chunking on action boundaries, not fixed token windows.

### Recommendations

#### REC 5: Embedding Pipeline + Chroma (Dev) / Qdrant (Prod) (High Priority)

**What:** Add an embedding pipeline. SessionDB stores embeddings (BLOB column already in REC 1-2 schemas). Vector index via:
- **Dev/local:** Chroma (in-process, zero ops)
- **Prod:** Qdrant (hybrid filter+vector, real-time, multi-tenant namespaces)

**Embedding model:** `BAAI/bge-base-en-v1.5` (768-dim, best average on MTEB benchmark). Fallback: `thenlper/gte-small` (384-dim, 4x faster, lower quality).

**Index strategy:**
```python
# Per-tenant collection isolation
collection_name = f"awos_{tenant_id}"

# Chroma (dev)
client = chromadb.PersistentClient(path=f"~/.awos/vectorstore/{tenant_id}")
collection = client.get_or_create_collection(
    name=collection_name,
    metadata={"tenant": tenant_id}
)

# Qdrant (prod) — use tenant_id as collection name or namespace
client = QdrantClient(url=os.environ["QDRANT_URL"], api_key=os.environ["QDRANT_API_KEY"])
```

---

#### REC 6: Hybrid Retrieval with RRF Fusion (High Priority, Next Sprint)

**What:** Combine vector similarity + BM25 keyword search via Reciprocal Rank Fusion. This prevents the classic failure mode where pure vector search misses exact matches (entity names, IDs, error codes) and pure keyword search misses semantic similarity.

**Fusion formula:** `RRF(d) = 1 / (k + rank)` where k=60. Sum scores across dense and sparse retrievers.

**Implementation sketch:**
```python
def hybrid_retrieve(query: str, tenant_id: str, k: int = 20) -> list[dict]:
    # Dense: vector similarity top-k
    query_vec = embed_model.encode(query)
    dense_results = vector_store.query(
        vector=query_vec,
        filter={"tenant": tenant_id},
        top_k=k
    )

    # Sparse: BM25 over episodes_fts
    sparse_results = sessiondb.execute(
        "SELECT id, summary FROM episodes_fts WHERE episodes_fts MATCH ?",
        [query]
    ).fetchall()

    # RRF fusion
    fused = {}
    for rank, row in enumerate(dense_results):
        fused[row["id"]] = fused.get(row["id"], 0) + 1 / (60 + rank)
    for rank, (row_id, _) in enumerate(sparse_results):
        fused[row_id] = fused.get(row_id, 0) + 1 / (60 + rank)

    return sorted(fused, key=fused.get, reverse=True)[:k]
```

---

#### REC 7: Asymmetric Semantic Chunking (Medium Priority)

**What:** Chunk strategy should split on agent action boundaries, not fixed token windows:
- Tool call definitions: 128-256 tokens (precise, no truncation)
- Conversation turns: 256-512 tokens (preserve context)
- Knowledge base docs: 512-1024 tokens (balance precision vs recall)

**Separator priority:** `\n\n<Action>\n\n` > `\n\n<ToolCall>\n\n` > `\n\n<Result>\n\n` > `\n\n<User>\n\n` > `. ` (sentence boundary)

**In practice for AgentWorks:** Most agent output is structured (code, YAML, JSON). Use structural separators: ``` for code blocks, `---` for section dividers, `\n\n` for paragraphs.

---

## Part III — Obsidian / Vault Layer

### Current State
`~/vault` is already well-architected with `wiki/hot.md` (episodic hot cache), `wiki/agents/` (agent registry), `wiki/projects/` (project pages), `Action-Tracker.md`, and `CRITICAL_FACTS.md`. The `mcp_agentworks_memory_*` MCP tools mirror the vault structure.

### What the Research Says
The vault is already ahead of most implementations. The gaps: Dataview querying is not exercised, mobile capture is absent, and the `memory/` directory (Claude Code auto-memory, 64 files) is opaque to AgentWorks.

### Recommendations

#### REC 8: Wire Dataview-Style Queries to AgentWorks MCP (High Priority)

**What:** The vault has Dataview queries in YAML frontmatter. Wire these as first-class query patterns in AgentWorks:

| Obsidian Pattern | AgentWorks MCP Equivalent |
|-----------------|--------------------------|
| `wiki/hot.md` rolling summary | `mcp_agentworks_memory_hot(tenantId)` — already done |
| Dataview: pages by tag/date | `mcp_agentworks_memory_read(key="query:type=X")` with filtering |
| `memory/MEMORY.md` index | `mcp_agentworks_list_resources` → agentic query interface |
| `wiki/[[wikilinks]]` backlinks | `memory_write` records `sources: [key]` in frontmatter equivalent |
| Daily `YYYY-MM-DD.md` | `memory_write(key="daily/{{date}}")` at session end |

**Gap to close:** The `memory/` directory (64 files, Claude Code auto-memory) should be accessible via `mcp_agentworks_memory_read` with a `type=claude-code-memory` discriminator, or imported into SessionDB episodes/insights.

---

#### REC 9: Session-End Daily Note Capture (Medium Priority)

**What:** At the end of each agent heartbeat run, write a daily note to `memory_write(key="daily/YYYY-MM-DD")` capturing:
- What was worked on (1-3 sentences)
- Decisions made
- Blockers encountered
- Next actions

**Why:** Provides an episodic trace that predates the SessionDB episode. Retroactive import of existing vault daily notes into SessionDB should be a one-time migration job.

---

#### REC 10: Action-Tracker as Structured Agent Memory (Low Priority, Already Partially Done)

**What:** `Action-Tracker.md` already exists as a structured markdown table. The AgentWorks equivalent: sync it to `memory_write(key="action-tracker")` as a structured JSON blob, parsed on session restore.

**Format:**
```json
{
  "actions": [
    {"id": "...", "content": "...", "owner": "...", "deadline": "...", "status": "open|done|blocked", "source": "issue_url"}
  ],
  "last_synced": 1743552000
}
```

---

## Part IV — Integration Points for AgentWorks Architecture

### Where These Recommendations Live in the Codebase

| Recommendation | File/Area | Priority |
|---------------|-----------|----------|
| Episode schema | `packages/shared/db/migrations/` | High |
| Insight schema + extraction | `packages/agentos-d/memory/` or `packages/shared/` | High |
| Embedding pipeline | `packages/shared/embeddings.py` (new) | High |
| Hybrid retrieval | `packages/shared/retrieval.py` (new) | High, Next Sprint |
| Chroma/Qdrant integration | `packages/shared/vectorstore.py` (new) | High |
| Three-tier demotion job | `packages/shared/consolidation.py` (new) | Medium |
| Dataview query interface | MCP server memory tool definitions | Medium |
| Daily note capture | Heartbeat run end hook | Medium |
| KG triples extraction | Phase 2 — depends on REC 1-3 | Lower |

### No Honcho — Note for Implementors

Honcho was evaluated in research (3.2k stars, production memory library). It is **not** being adopted. The architecture above uses:
- SessionDB (SQLite) as the primary store — no external memory service required
- Chroma (local dev) / Qdrant (prod) for vector retrieval — separate from SessionDB
- MCP tools already in place — extend, don't replace

---

## Summary: Top 5 Changes by Effort

| # | Change | Effort | Impact | Phase |
|---|--------|--------|--------|-------|
| 1 | Add `episodes` table with embedding column + session-end summary generation | Medium | High | Phase 1 |
| 2 | Add `insights` table with `frame_type` + inline extraction on feedback/corrections | Low-Medium | High | Phase 1 |
| 3 | Add embedding pipeline (BAAI/bge-base-en-v1.5) + Chroma dev integration | Medium | High | Phase 1 |
| 4 | Implement hybrid retrieval (dense+sparse RRF) on top of episodes_fts | Medium | High | Next Sprint |
| 5 | Wire vault `memory/` import + Dataview-style queries to MCP tools | Low | Medium | Next Sprint |

---

## References

- **agentmemory** (rohitg00/agentmemory, 2.1k stars) — episode chunking + confidence scores + SQLite
- **memory-access** (emmahyde/memory-access) — atomic insights + semantic frames + MCP
- **Vektori** (vektori-ai/vektori) — three-layer fact/episode/sentence graph
- **A-MEM** (frabatx/agentic-memory-system) — self-organizing memory with reflection
- **vstash** (2026) — local-first hybrid retrieval with adaptive RRF fusion
- **BAAI/bge-base-en-v1.5** — recommended embedding model (MTEB benchmark leader)
