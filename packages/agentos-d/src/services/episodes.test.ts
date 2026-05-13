import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations/index.js";
import { recordEpisode } from "./episodes.js";
import { EmbedClient, blobToVector } from "./embed-client.js";
import type { Session, SessionEvent } from "@agentworks/memory";

const TENANT = "11111111-1111-1111-1111-111111111111";

let sqlite: Database.Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  migrate(sqlite);
});

afterEach(() => {
  sqlite.close();
});

function fakeEmbedClient(opts: { fail?: boolean; dim?: number; model?: string } = {}): EmbedClient {
  const dim = opts.dim ?? 4;
  return {
    async embedOne(_text: string) {
      if (opts.fail) throw new Error("simulated embed failure");
      return {
        vector: Float32Array.from(Array.from({ length: dim }, (_, i) => i / 10)),
        model: opts.model ?? "stub",
        dim,
      };
    },
    async embed() {
      return { vectors: [], model: "stub", dim };
    },
  } as unknown as EmbedClient;
}

function buildSession(): { session: Session; events: SessionEvent[] } {
  return {
    session: {
      id: "sess-1",
      tenantId: TENANT,
      openedAt: "2026-05-02T20:00:00.000Z",
      closedAt: "2026-05-02T20:30:00.000Z",
    },
    events: Array.from({ length: 6 }, (_, i) => ({
      at: `2026-05-02T20:0${i}:00.000Z`,
      type: i % 2 === 0 ? "vault_write" : "policy_evaluated",
      description: `event-${i}`,
    })),
  };
}

describe("recordEpisode", () => {
  it("inserts a row with embedding BLOB and matching FTS entry", async () => {
    const { session, events } = buildSession();
    const result = await recordEpisode(
      sqlite,
      { session, events, agentId: "agent-x", role: "backend", taskType: "bugfix", outcome: "success" },
      { embedClient: fakeEmbedClient(), now: () => "2026-05-02T20:30:01.000Z" },
    );

    expect(result.embeddingWritten).toBe(true);
    expect(result.embeddingModel).toBe("stub");

    const row = sqlite.prepare("SELECT * FROM episodes WHERE id = ?").get(result.id) as {
      tenant_id: string;
      session_id: string;
      summary: string;
      embedding: Buffer | null;
      embedding_model: string | null;
      role: string;
      outcome: string;
      duration_sec: number;
      importance: number;
      lifecycle: string;
      created_at: string;
    };
    expect(row.tenant_id).toBe(TENANT);
    expect(row.session_id).toBe("sess-1");
    expect(row.summary).toMatch(/Vault Write|Policy Evaluated/i);
    expect(row.role).toBe("backend");
    expect(row.outcome).toBe("success");
    expect(row.duration_sec).toBe(1800);
    expect(row.lifecycle).toBe("active");
    expect(row.created_at).toBe("2026-05-02T20:30:01.000Z");

    expect(row.embedding).toBeInstanceOf(Buffer);
    const vec = blobToVector(row.embedding!);
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(4);
    expect(row.embedding_model).toBe("stub");

    const fts = sqlite
      .prepare("SELECT id, summary FROM episodes_fts WHERE tenant_id = ?")
      .all(TENANT) as { id: string; summary: string }[];
    expect(fts).toHaveLength(1);
    expect(fts[0]!.id).toBe(result.id);
    expect(fts[0]!.summary).toBe(row.summary);
  });

  it("persists the row even when embedding fails (NULL embedding)", async () => {
    const { session, events } = buildSession();
    const result = await recordEpisode(
      sqlite,
      { session, events },
      { embedClient: fakeEmbedClient({ fail: true }) },
    );
    expect(result.embeddingWritten).toBe(false);
    expect(result.embeddingModel).toBeUndefined();

    const row = sqlite.prepare("SELECT embedding, embedding_model FROM episodes WHERE id = ?").get(
      result.id,
    ) as { embedding: Buffer | null; embedding_model: string | null };
    expect(row.embedding).toBeNull();
    expect(row.embedding_model).toBeNull();
  });

  it("FTS5 index is searchable with MATCH", async () => {
    const { session } = buildSession();
    const events: SessionEvent[] = [
      { at: "2026-05-02T20:00:00.000Z", type: "vault_write", description: "a" },
    ];
    await recordEpisode(
      sqlite,
      { session, events },
      { embedClient: fakeEmbedClient() },
    );

    const hits = sqlite
      .prepare("SELECT id FROM episodes_fts WHERE episodes_fts MATCH ?")
      .all("vault") as { id: string }[];
    expect(hits.length).toBeGreaterThan(0);
  });

  it("stores importance score from session-brief", async () => {
    const { session } = buildSession();
    // 50+ events → importance 5
    const manyEvents: SessionEvent[] = Array.from({ length: 50 }, (_, i) => ({
      at: `2026-05-02T20:00:${String(i).padStart(2, "0")}.000Z`,
      type: "vault_write",
      description: `evt-${i}`,
    }));
    const result = await recordEpisode(
      sqlite,
      { session, events: manyEvents },
      { embedClient: fakeEmbedClient() },
    );
    const row = sqlite.prepare("SELECT importance FROM episodes WHERE id = ?").get(result.id) as {
      importance: number;
    };
    expect(row.importance).toBeGreaterThanOrEqual(4);
  });
});

describe("migration 0024", () => {
  it("is idempotent", () => {
    // Already migrated by beforeEach; running again must not throw or duplicate.
    expect(() => migrate(sqlite)).not.toThrow();
    const migrationCount = sqlite
      .prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations WHERE hash = ?")
      .get("v24-episodes") as { n: number };
    expect(migrationCount.n).toBe(1);
  });

  it("creates episodes_fts virtual table", () => {
    const tbl = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='episodes_fts'",
      )
      .get();
    expect(tbl).toBeDefined();
  });

  it("re-running migrate after a fresh DB also works", () => {
    const fresh = new Database(":memory:");
    expect(() => migrate(fresh)).not.toThrow();
    expect(() => migrate(fresh)).not.toThrow();
    fresh.close();
  });
});

// Suppress console noise from unrelated consolidate logger if any
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});
