import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations/index.js";
import { hybridSearch, rrf, type RetrievalKind } from "./retrieval.js";
import { recordEpisode } from "./episodes.js";
import { recordInsight } from "./insights.js";
import { EmbedClient, vectorToBlob } from "./embed-client.js";
import { RerankClient } from "./rerank-client.js";
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

/** Embed client that maps each text to a known vector via an inject map. */
function injectEmbedClient(map: Record<string, number[]>, dim = 4): EmbedClient {
  return {
    async embedOne(text: string) {
      const v = map[text];
      if (!v) throw new Error(`no injected vector for text: ${text}`);
      if (v.length !== dim) throw new Error(`injected vector wrong dim: ${v.length} != ${dim}`);
      return { vector: Float32Array.from(v), model: "inject", dim };
    },
    async embed() {
      return { vectors: [], model: "inject", dim };
    },
  } as unknown as EmbedClient;
}

function failingEmbedClient(): EmbedClient {
  return {
    async embedOne() {
      throw new Error("simulated embed failure");
    },
    async embed() {
      return { vectors: [], model: "stub", dim: 0 };
    },
  } as unknown as EmbedClient;
}

function buildSession(id: string): { session: Session; events: SessionEvent[] } {
  return {
    session: {
      id,
      tenantId: TENANT,
      openedAt: "2026-05-02T20:00:00.000Z",
      closedAt: "2026-05-02T20:30:00.000Z",
    },
    events: [
      { at: "2026-05-02T20:00:00.000Z", type: "vault_write", description: "x" },
    ],
  };
}

describe("rrf (pure)", () => {
  it("scores higher for items appearing in both legs", () => {
    const dense = [
      { kind: "episode" as RetrievalKind, id: "a", rank: 1 },
      { kind: "episode" as RetrievalKind, id: "b", rank: 2 },
    ];
    const sparse = [
      { kind: "episode" as RetrievalKind, id: "a", rank: 1 },
      { kind: "episode" as RetrievalKind, id: "c", rank: 2 },
    ];
    const merged = rrf(dense, sparse);
    const scoreA = merged.get("episode:a")!.score;
    const scoreB = merged.get("episode:b")!.score;
    const scoreC = merged.get("episode:c")!.score;
    expect(scoreA).toBeGreaterThan(scoreB);
    expect(scoreA).toBeGreaterThan(scoreC);
  });

  it("disambiguates same id across different kinds", () => {
    const dense = [{ kind: "episode" as RetrievalKind, id: "x", rank: 1 }];
    const sparse = [{ kind: "insight" as RetrievalKind, id: "x", rank: 1 }];
    const merged = rrf(dense, sparse);
    expect(merged.size).toBe(2);
    expect(merged.has("episode:x")).toBe(true);
    expect(merged.has("insight:x")).toBe(true);
  });

  it("k constant matters: smaller k = bigger spread between ranks", () => {
    const dense = [
      { kind: "episode" as RetrievalKind, id: "a", rank: 1 },
      { kind: "episode" as RetrievalKind, id: "b", rank: 100 },
    ];
    const tightK = rrf(dense, [], 0); // k=0 makes 1/(0+1) vs 1/(0+100) — big spread
    const loosK = rrf(dense, [], 1000);
    const tightSpread = tightK.get("episode:a")!.score / tightK.get("episode:b")!.score;
    const loosSpread = loosK.get("episode:a")!.score / loosK.get("episode:b")!.score;
    expect(tightSpread).toBeGreaterThan(loosSpread);
  });
});

describe("hybridSearch — keyword leg only (semantic miss)", () => {
  it("FTS catches a literal token even when no embedding contributes", async () => {
    // Inject vectors that are far apart, so the dense leg ranks the
    // unrelated row higher. The sparse FTS leg should still surface
    // the row whose summary contains the literal term.
    const queryText = "tcpa";
    const matchSummary = "Email reviewed under tcpa rules";
    const otherSummary = "Routine vault page write happened";

    const inject = injectEmbedClient(
      {
        [queryText]: [1, 0, 0, 0],
        [matchSummary]: [0, 0, 0, 1], // far from query
        [otherSummary]: [0.99, 0.01, 0, 0], // close to query (dense red herring)
      },
      4,
    );

    // Manually craft episodes with the injected vectors for their summaries
    const sBoth = buildSession("s-match");
    const sNoise = buildSession("s-noise");

    // Stub renderSessionBrief by pre-crafting summaries via direct SQL
    sqlite
      .prepare(
        `INSERT INTO episodes (id, tenant_id, started_at, ended_at, duration_sec,
                               summary, embedding, embedding_model, importance, lifecycle, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'inject', 1, 'active', ?)`,
      )
      .run(
        "ep-match",
        TENANT,
        sBoth.session.openedAt,
        sBoth.session.closedAt!,
        1800,
        matchSummary,
        vectorToBlob(Float32Array.from([0, 0, 0, 1])),
        "2026-05-02T20:30:01.000Z",
      );
    sqlite
      .prepare(
        `INSERT INTO episodes (id, tenant_id, started_at, ended_at, duration_sec,
                               summary, embedding, embedding_model, importance, lifecycle, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'inject', 1, 'active', ?)`,
      )
      .run(
        "ep-noise",
        TENANT,
        sNoise.session.openedAt,
        sNoise.session.closedAt!,
        1800,
        otherSummary,
        vectorToBlob(Float32Array.from([0.99, 0.01, 0, 0])),
        "2026-05-02T20:30:02.000Z",
      );
    sqlite.prepare("INSERT INTO episodes_fts (id, tenant_id, summary) VALUES (?, ?, ?)").run("ep-match", TENANT, matchSummary);
    sqlite.prepare("INSERT INTO episodes_fts (id, tenant_id, summary) VALUES (?, ?, ?)").run("ep-noise", TENANT, otherSummary);

    const hits = await hybridSearch(sqlite, inject, { tenantId: TENANT, query: queryText, topK: 5 });

    // ep-match should surface (sparse hit on "tcpa"), even though dense
    // ranks ep-noise higher.
    const matchHit = hits.find((h) => h.id === "ep-match");
    expect(matchHit).toBeDefined();
    expect(matchHit!.sparseRank).toBe(1);
  });
});

describe("hybridSearch — semantic leg only (sparse miss)", () => {
  it("dense surfaces a row even when no FTS token overlap", async () => {
    const inject = injectEmbedClient(
      {
        "compliance gateway": [1, 0, 0, 0],
        "regulatory perimeter overseer": [0.95, 0.05, 0, 0], // semantically near
        "completely unrelated bagel recipe": [0, 0, 1, 0],
      },
      4,
    );

    sqlite
      .prepare(
        `INSERT INTO episodes (id, tenant_id, started_at, ended_at, duration_sec,
                               summary, embedding, embedding_model, importance, lifecycle, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'inject', 1, 'active', ?)`,
      )
      .run(
        "ep-near",
        TENANT,
        "2026-05-02T20:00:00.000Z",
        "2026-05-02T20:30:00.000Z",
        1800,
        "regulatory perimeter overseer",
        vectorToBlob(Float32Array.from([0.95, 0.05, 0, 0])),
        "2026-05-02T20:30:01.000Z",
      );
    sqlite
      .prepare(
        `INSERT INTO episodes (id, tenant_id, started_at, ended_at, duration_sec,
                               summary, embedding, embedding_model, importance, lifecycle, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'inject', 1, 'active', ?)`,
      )
      .run(
        "ep-far",
        TENANT,
        "2026-05-02T20:00:00.000Z",
        "2026-05-02T20:30:00.000Z",
        1800,
        "completely unrelated bagel recipe",
        vectorToBlob(Float32Array.from([0, 0, 1, 0])),
        "2026-05-02T20:30:02.000Z",
      );
    sqlite.prepare("INSERT INTO episodes_fts (id, tenant_id, summary) VALUES (?, ?, ?)").run("ep-near", TENANT, "regulatory perimeter overseer");
    sqlite.prepare("INSERT INTO episodes_fts (id, tenant_id, summary) VALUES (?, ?, ?)").run("ep-far", TENANT, "completely unrelated bagel recipe");

    const hits = await hybridSearch(sqlite, inject, {
      tenantId: TENANT,
      query: "compliance gateway",
      topK: 5,
    });

    const near = hits.find((h) => h.id === "ep-near");
    const far = hits.find((h) => h.id === "ep-far");
    expect(near).toBeDefined();
    expect(near!.score).toBeGreaterThan(far?.score ?? 0);
    expect(near!.denseRank).toBe(1); // closer cosine
    // No FTS token overlap with query "compliance gateway" — sparse miss
    expect(near!.sparseRank).toBeUndefined();
  });
});

describe("hybridSearch — sparse-only fallback when embed fails", () => {
  it("returns FTS hits even when the embed sidecar is down", async () => {
    sqlite
      .prepare(
        `INSERT INTO episodes (id, tenant_id, started_at, ended_at, duration_sec,
                               summary, embedding, embedding_model, importance, lifecycle, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 1, 'active', ?)`,
      )
      .run("ep-1", TENANT, "2026-05-02T20:00:00.000Z", "2026-05-02T20:30:00.000Z", 1800, "vault write happened", "2026-05-02T20:30:01.000Z");
    sqlite.prepare("INSERT INTO episodes_fts (id, tenant_id, summary) VALUES (?, ?, ?)").run("ep-1", TENANT, "vault write happened");

    const hits = await hybridSearch(sqlite, failingEmbedClient(), {
      tenantId: TENANT,
      query: "vault",
      topK: 5,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe("ep-1");
    expect(hits[0]!.denseRank).toBeUndefined();
    expect(hits[0]!.sparseRank).toBe(1);
  });
});

describe("hybridSearch — kind filter", () => {
  it("respects kinds=['insight'] (excludes episodes)", async () => {
    const inject = injectEmbedClient({
      "voice rule": [1, 0, 0, 0],
    }, 4);

    await recordEpisode(
      sqlite,
      buildSession("s-1"),
      { embedClient: { async embedOne() { return { vector: Float32Array.from([0.99, 0, 0, 0]), model: "inject", dim: 4 }; }, async embed() { return { vectors: [], model: "inject", dim: 4 }; } } as unknown as EmbedClient },
    );
    await recordInsight(
      sqlite,
      { tenantId: TENANT, frameType: "feedback", content: "voice rule", source: "manual" },
      { embedClient: { async embedOne() { return { vector: Float32Array.from([0.95, 0, 0, 0]), model: "inject", dim: 4 }; }, async embed() { return { vectors: [], model: "inject", dim: 4 }; } } as unknown as EmbedClient },
    );

    const hits = await hybridSearch(sqlite, inject, {
      tenantId: TENANT,
      query: "voice rule",
      kinds: ["insight"],
      topK: 10,
    });
    expect(hits.every((h) => h.kind === "insight")).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe("hybridSearch — query sanitization", () => {
  it("does not throw on punctuation or FTS operator characters", async () => {
    const hits = await hybridSearch(sqlite, failingEmbedClient(), {
      tenantId: TENANT,
      query: 'foo "bar" AND (baz OR qux)*',
    });
    expect(hits).toEqual([]);
  });

  it("returns empty for whitespace-only query when embed also fails", async () => {
    const hits = await hybridSearch(sqlite, failingEmbedClient(), {
      tenantId: TENANT,
      query: "   ",
    });
    expect(hits).toEqual([]);
  });
});

describe("hybridSearch — cross-encoder rerank", () => {
  function fakeRerankClient(scores: Record<string, number>, mode = "real"): RerankClient {
    return {
      async rerank(_query: string, candidates: string[]) {
        return {
          scores: candidates.map((c) => scores[c] ?? 0),
          model: "fake-cross-encoder",
          mode,
        };
      },
    } as unknown as RerankClient;
  }

  function seedTwoFtsEpisodes(): void {
    for (const [id, summary] of [
      ["ep-low", "the user prefers terse responses with no trailing summaries"],
      ["ep-high", "user terse style guideline"],
    ] as const) {
      sqlite
        .prepare(
          `INSERT INTO episodes (id, tenant_id, started_at, ended_at, duration_sec,
                                 summary, embedding, embedding_model, importance, lifecycle, created_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 1, 'active', ?)`,
        )
        .run(
          id,
          TENANT,
          "2026-05-02T20:00:00.000Z",
          "2026-05-02T20:30:00.000Z",
          1800,
          summary,
          "2026-05-02T20:30:01.000Z",
        );
      sqlite
        .prepare("INSERT INTO episodes_fts (id, tenant_id, summary) VALUES (?, ?, ?)")
        .run(id, TENANT, summary);
    }
  }

  it("reorders fused hits by rerank score and attaches rerankScore", async () => {
    seedTwoFtsEpisodes();

    const client = fakeRerankClient({
      "the user prefers terse responses with no trailing summaries": 0.2,
      "user terse style guideline": 0.95,
    });

    const hits = await hybridSearch(sqlite, failingEmbedClient(), {
      tenantId: TENANT,
      query: "user terse",
      topK: 5,
      rerank: true,
      rerankClient: client,
    });

    expect(hits).toHaveLength(2);
    expect(hits[0]!.id).toBe("ep-high");
    expect(hits[1]!.id).toBe("ep-low");
    expect(hits[0]!.rerankScore).toBe(0.95);
    expect(hits[1]!.rerankScore).toBe(0.2);
  });

  it("ignores rerank scores when client returns mode=stub (preserves RRF order)", async () => {
    seedTwoFtsEpisodes();

    // Stub client: scores would invert order, but mode=stub means we ignore.
    const client = fakeRerankClient(
      {
        "the user prefers terse responses with no trailing summaries": 0.99,
        "user terse style guideline": 0.0,
      },
      "stub",
    );

    const hits = await hybridSearch(sqlite, failingEmbedClient(), {
      tenantId: TENANT,
      query: "user terse",
      topK: 5,
      rerank: true,
      rerankClient: client,
    });

    expect(hits).toHaveLength(2);
    for (const h of hits) {
      expect(h.rerankScore).toBeUndefined();
    }
  });

  it("falls back to RRF order when rerank client throws", async () => {
    seedTwoFtsEpisodes();

    const failing: RerankClient = {
      async rerank() {
        throw new Error("simulated sidecar down");
      },
    } as unknown as RerankClient;

    const hits = await hybridSearch(sqlite, failingEmbedClient(), {
      tenantId: TENANT,
      query: "user terse",
      topK: 5,
      rerank: true,
      rerankClient: failing,
    });

    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.rerankScore).toBeUndefined();
    }
  });

  it("rerank=false skips the rerank pass entirely", async () => {
    seedTwoFtsEpisodes();

    let called = false;
    const client: RerankClient = {
      async rerank() {
        called = true;
        return { scores: [0, 0], model: "x", mode: "real" };
      },
    } as unknown as RerankClient;

    await hybridSearch(sqlite, failingEmbedClient(), {
      tenantId: TENANT,
      query: "user terse",
      topK: 5,
      rerank: false,
      rerankClient: client,
    });

    expect(called).toBe(false);
  });
});

describe("hybridSearch — topK + perLegLimit", () => {
  it("returns at most topK results", async () => {
    for (let i = 0; i < 30; i++) {
      sqlite
        .prepare(
          `INSERT INTO episodes (id, tenant_id, started_at, ended_at, duration_sec,
                                 summary, embedding, embedding_model, importance, lifecycle, created_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 1, 'active', ?)`,
        )
        .run(`ep-${i}`, TENANT, "2026-05-02T20:00:00.000Z", "2026-05-02T20:30:00.000Z", 1800, `widget ${i}`, "2026-05-02T20:30:01.000Z");
      sqlite.prepare("INSERT INTO episodes_fts (id, tenant_id, summary) VALUES (?, ?, ?)").run(`ep-${i}`, TENANT, `widget ${i}`);
    }
    const hits = await hybridSearch(sqlite, failingEmbedClient(), {
      tenantId: TENANT,
      query: "widget",
      topK: 5,
    });
    expect(hits).toHaveLength(5);
  });
});
