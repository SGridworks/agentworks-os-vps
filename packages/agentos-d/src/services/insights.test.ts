import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations/index.js";
import { recordInsight, listInsights } from "./insights.js";
import { EmbedClient, blobToVector } from "./embed-client.js";

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
      if (opts.fail) throw new Error("simulated");
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

describe("recordInsight", () => {
  it("inserts a row with embedding and matching FTS entry", async () => {
    const r = await recordInsight(
      sqlite,
      {
        tenantId: TENANT,
        frameType: "feedback",
        subject: "outbound-email",
        content: "No outbound email during build phase.",
        source: "user_correction",
        importance: 5,
      },
      { embedClient: fakeEmbedClient() },
    );
    expect(r.embeddingWritten).toBe(true);
    expect(r.embeddingModel).toBe("stub");

    const row = sqlite.prepare("SELECT * FROM insights WHERE id = ?").get(r.id) as {
      tenant_id: string;
      frame_type: string;
      subject: string;
      content: string;
      source: string;
      importance: number;
      validated: number;
      lifecycle: string;
      embedding: Buffer;
    };
    expect(row.tenant_id).toBe(TENANT);
    expect(row.frame_type).toBe("feedback");
    expect(row.subject).toBe("outbound-email");
    expect(row.source).toBe("user_correction");
    expect(row.importance).toBe(5);
    expect(row.validated).toBe(0);
    expect(row.lifecycle).toBe("active");

    const vec = blobToVector(row.embedding);
    expect(vec.length).toBe(4);

    const fts = sqlite
      .prepare("SELECT id, content FROM insights_fts WHERE tenant_id = ?")
      .all(TENANT) as { id: string; content: string }[];
    expect(fts).toHaveLength(1);
    expect(fts[0]!.id).toBe(r.id);
  });

  it("rejects empty content", async () => {
    await expect(
      recordInsight(
        sqlite,
        {
          tenantId: TENANT,
          frameType: "fact",
          content: "   ",
          source: "manual",
        },
        { embedClient: fakeEmbedClient() },
      ),
    ).rejects.toThrow(/empty/i);
  });

  it("rejects an invalid frame_type at the SQL level (CHECK constraint)", async () => {
    await expect(
      recordInsight(
        sqlite,
        {
          tenantId: TENANT,
          frameType: "not-a-real-frame" as never,
          content: "test",
          source: "manual",
        },
        { embedClient: fakeEmbedClient() },
      ),
    ).rejects.toThrow(/CHECK constraint/i);
  });

  it("persists the row even when embedding fails", async () => {
    const r = await recordInsight(
      sqlite,
      {
        tenantId: TENANT,
        frameType: "preference",
        content: "User prefers terse responses.",
        source: "agent_reflection",
      },
      { embedClient: fakeEmbedClient({ fail: true }) },
    );
    expect(r.embeddingWritten).toBe(false);
    const row = sqlite.prepare("SELECT embedding FROM insights WHERE id = ?").get(r.id) as {
      embedding: Buffer | null;
    };
    expect(row.embedding).toBeNull();
  });

  it("FTS5 MATCH finds the inserted insight", async () => {
    await recordInsight(
      sqlite,
      {
        tenantId: TENANT,
        frameType: "constraint",
        content: "Embedding model is BAAI bge-base-en-v1.5",
        source: "manual",
      },
      { embedClient: fakeEmbedClient() },
    );
    const hits = sqlite
      .prepare("SELECT id FROM insights_fts WHERE insights_fts MATCH ?")
      .all("embedding") as { id: string }[];
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe("listInsights", () => {
  beforeEach(async () => {
    const fixtures = [
      { frameType: "feedback" as const, subject: "email", content: "no email", source: "user_correction" as const, importance: 5 },
      { frameType: "preference" as const, subject: "voice", content: "terse responses", source: "agent_reflection" as const, importance: 3 },
      { frameType: "constraint" as const, content: "no torch in agentos-d", source: "manual" as const, importance: 4 },
      { frameType: "feedback" as const, subject: "voice", content: "no em-dashes", source: "user_correction" as const, importance: 2 },
    ];
    for (const f of fixtures) {
      await recordInsight(sqlite, { tenantId: TENANT, ...f }, { embedClient: fakeEmbedClient() });
    }
  });

  it("returns all active insights for the tenant", () => {
    const rows = listInsights(sqlite, { tenantId: TENANT });
    expect(rows).toHaveLength(4);
  });

  it("filters by frame_type", () => {
    const rows = listInsights(sqlite, { tenantId: TENANT, frameType: "feedback" });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.frameType === "feedback")).toBe(true);
  });

  it("filters by subject", () => {
    const rows = listInsights(sqlite, { tenantId: TENANT, subject: "voice" });
    expect(rows).toHaveLength(2);
    const frames = rows.map((r) => r.frameType).sort();
    expect(frames).toEqual(["feedback", "preference"]);
  });

  it("orders by importance desc, then created_at desc", () => {
    const rows = listInsights(sqlite, { tenantId: TENANT });
    expect(rows[0]!.importance).toBe(5);
    expect(rows[rows.length - 1]!.importance).toBe(2);
  });

  it("respects limit", () => {
    const rows = listInsights(sqlite, { tenantId: TENANT, limit: 2 });
    expect(rows).toHaveLength(2);
  });
});

describe("migration 0025", () => {
  it("is idempotent", () => {
    expect(() => migrate(sqlite)).not.toThrow();
    const n = sqlite
      .prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations WHERE hash = ?")
      .get("v25-insights") as { n: number };
    expect(n.n).toBe(1);
  });

  it("creates insights_fts virtual table", () => {
    const tbl = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='insights_fts'")
      .get();
    expect(tbl).toBeDefined();
  });
});
