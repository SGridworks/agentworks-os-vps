import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations/index.js";
import { consolidateEpisodes } from "./consolidation.js";
import { EmbedClient } from "./embed-client.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const AGENT_A = "22222222-2222-2222-2222-222222222222";
const AGENT_B = "33333333-3333-3333-3333-333333333333";

let sqlite: Database.Database;

function fakeEmbedClient(): EmbedClient {
  return {
    async embedOne() {
      return { vector: Float32Array.from([0.1, 0.2, 0.3, 0.4]), model: "stub", dim: 4 };
    },
    async embed() {
      return { vectors: [], model: "stub", dim: 4 };
    },
  } as unknown as EmbedClient;
}

function seedEpisode(opts: {
  id: string;
  agentId: string | null;
  startedAt: string;
  endedAt: string;
  summary: string;
  importance?: number;
  taskType?: string;
}) {
  sqlite
    .prepare(
      `INSERT INTO episodes
       (id, tenant_id, agent_id, session_id, started_at, ended_at, duration_sec,
        role, task_type, outcome, summary, embedding, embedding_model,
        importance, lifecycle, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, 600, NULL, ?, NULL, ?, NULL, NULL,
               ?, 'active', ?, ?)`,
    )
    .run(
      opts.id,
      TENANT,
      opts.agentId,
      opts.startedAt,
      opts.endedAt,
      opts.taskType ?? null,
      opts.summary,
      opts.importance ?? 1,
      opts.startedAt,
      opts.startedAt,
    );
  sqlite
    .prepare("INSERT INTO episodes_fts (id, tenant_id, summary) VALUES (?, ?, ?)")
    .run(opts.id, TENANT, opts.summary);
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  migrate(sqlite);
});

afterEach(() => {
  sqlite.close();
});

describe("consolidateEpisodes", () => {
  it("collapses 5 old same-week episodes for one agent into one consolidated episode", async () => {
    // 5 episodes in week 2026-W10 (Mar 2-8), well past 14-day cutoff if now=2026-05-15
    for (let i = 0; i < 5; i++) {
      seedEpisode({
        id: `ep-${i}`,
        agentId: AGENT_A,
        startedAt: `2026-03-0${i + 2}T10:00:00.000Z`,
        endedAt: `2026-03-0${i + 2}T10:30:00.000Z`,
        summary: `episode ${i} did some vault writes and policy decisions`,
        importance: 2,
      });
    }

    const r = await consolidateEpisodes(sqlite, fakeEmbedClient(), {
      now: () => new Date("2026-05-15T00:00:00.000Z"),
      minAgeDays: 14,
      minGroupSize: 3,
    });

    expect(r.consolidated).toBe(1);
    expect(r.archived).toBe(5);

    const active = sqlite
      .prepare(
        "SELECT id, role, task_type, summary, importance FROM episodes WHERE lifecycle = 'active'",
      )
      .all() as Array<{ id: string; role: string | null; task_type: string | null; summary: string; importance: number }>;
    expect(active).toHaveLength(1);
    expect(active[0]!.role).toBe("consolidated");
    expect(active[0]!.task_type).toBe("session_consolidation");
    expect(active[0]!.summary).toContain("Consolidated memory");
    // Importance bumps one above source max (2 → 3)
    expect(active[0]!.importance).toBe(3);

    const archived = sqlite
      .prepare("SELECT COUNT(*) AS n FROM episodes WHERE lifecycle = 'archived'")
      .get() as { n: number };
    expect(archived.n).toBe(5);

    // Source rows should be removed from FTS so retrieval doesn't surface
    // them; the consolidated row should replace them.
    const ftsCount = sqlite
      .prepare("SELECT COUNT(*) AS n FROM episodes_fts")
      .get() as { n: number };
    expect(ftsCount.n).toBe(1);
  });

  it("skips singleton buckets and small groups below minGroupSize", async () => {
    seedEpisode({
      id: "lonely",
      agentId: AGENT_A,
      startedAt: "2026-03-02T10:00:00.000Z",
      endedAt: "2026-03-02T10:30:00.000Z",
      summary: "the only episode in its week",
    });
    // Two more, below default minGroupSize=3 — should also be skipped
    seedEpisode({
      id: "pair-1",
      agentId: AGENT_B,
      startedAt: "2026-03-15T10:00:00.000Z",
      endedAt: "2026-03-15T10:30:00.000Z",
      summary: "episode pair-1",
    });
    seedEpisode({
      id: "pair-2",
      agentId: AGENT_B,
      startedAt: "2026-03-15T11:00:00.000Z",
      endedAt: "2026-03-15T11:30:00.000Z",
      summary: "episode pair-2",
    });

    const r = await consolidateEpisodes(sqlite, fakeEmbedClient(), {
      now: () => new Date("2026-05-15T00:00:00.000Z"),
      minAgeDays: 14,
      minGroupSize: 3,
    });
    expect(r.consolidated).toBe(0);
    expect(r.archived).toBe(0);
    expect(r.bucketsScanned).toBe(2);

    const active = sqlite
      .prepare("SELECT COUNT(*) AS n FROM episodes WHERE lifecycle = 'active'")
      .get() as { n: number };
    expect(active.n).toBe(3);
  });

  it("respects minAgeDays — recent episodes stay untouched", async () => {
    for (let i = 0; i < 5; i++) {
      seedEpisode({
        id: `recent-${i}`,
        agentId: AGENT_A,
        startedAt: `2026-05-1${i}T10:00:00.000Z`,
        endedAt: `2026-05-1${i}T10:30:00.000Z`,
        summary: `recent episode ${i}`,
      });
    }

    const r = await consolidateEpisodes(sqlite, fakeEmbedClient(), {
      now: () => new Date("2026-05-15T00:00:00.000Z"),
      minAgeDays: 14,
      minGroupSize: 3,
    });
    expect(r.consolidated).toBe(0);
    expect(r.archived).toBe(0);
  });

  it("groups by agent — different agents in the same week are independent buckets", async () => {
    for (let i = 0; i < 3; i++) {
      seedEpisode({
        id: `a-${i}`,
        agentId: AGENT_A,
        startedAt: `2026-03-0${i + 2}T10:00:00.000Z`,
        endedAt: `2026-03-0${i + 2}T10:30:00.000Z`,
        summary: `agent-A episode ${i}`,
      });
      seedEpisode({
        id: `b-${i}`,
        agentId: AGENT_B,
        startedAt: `2026-03-0${i + 2}T15:00:00.000Z`,
        endedAt: `2026-03-0${i + 2}T15:30:00.000Z`,
        summary: `agent-B episode ${i}`,
      });
    }

    const r = await consolidateEpisodes(sqlite, fakeEmbedClient(), {
      now: () => new Date("2026-05-15T00:00:00.000Z"),
      minAgeDays: 14,
      minGroupSize: 3,
    });
    expect(r.consolidated).toBe(2);
    expect(r.archived).toBe(6);
  });

  it("is idempotent: a second pass over the same DB does nothing", async () => {
    for (let i = 0; i < 5; i++) {
      seedEpisode({
        id: `ep-${i}`,
        agentId: AGENT_A,
        startedAt: `2026-03-0${i + 2}T10:00:00.000Z`,
        endedAt: `2026-03-0${i + 2}T10:30:00.000Z`,
        summary: `episode ${i}`,
      });
    }

    const r1 = await consolidateEpisodes(sqlite, fakeEmbedClient(), {
      now: () => new Date("2026-05-15T00:00:00.000Z"),
    });
    expect(r1.consolidated).toBe(1);

    const r2 = await consolidateEpisodes(sqlite, fakeEmbedClient(), {
      now: () => new Date("2026-05-15T00:00:00.000Z"),
    });
    expect(r2.consolidated).toBe(0);
    expect(r2.archived).toBe(0);
  });

  it("does not re-consolidate already-consolidated episodes", async () => {
    // Insert 3 source episodes + 1 already-consolidated meta episode in same week
    for (let i = 0; i < 3; i++) {
      seedEpisode({
        id: `src-${i}`,
        agentId: AGENT_A,
        startedAt: `2026-03-0${i + 2}T10:00:00.000Z`,
        endedAt: `2026-03-0${i + 2}T10:30:00.000Z`,
        summary: `source ${i}`,
        taskType: null as unknown as undefined,
      });
    }
    seedEpisode({
      id: "meta",
      agentId: AGENT_A,
      startedAt: "2026-03-02T09:00:00.000Z",
      endedAt: "2026-03-04T11:00:00.000Z",
      summary: "prior consolidation",
      taskType: "session_consolidation",
    });

    const r = await consolidateEpisodes(sqlite, fakeEmbedClient(), {
      now: () => new Date("2026-05-15T00:00:00.000Z"),
    });
    // 3 sources collapse — the prior meta is excluded by task_type filter
    expect(r.consolidated).toBe(1);
    expect(r.archived).toBe(3);

    const stillActiveMeta = sqlite
      .prepare("SELECT lifecycle FROM episodes WHERE id = ?")
      .get("meta") as { lifecycle: string };
    expect(stillActiveMeta.lifecycle).toBe("active");
  });

  it("respects tenantId filter when provided", async () => {
    const OTHER_TENANT = "99999999-9999-9999-9999-999999999999";
    for (let i = 0; i < 3; i++) {
      seedEpisode({
        id: `t1-${i}`,
        agentId: AGENT_A,
        startedAt: `2026-03-0${i + 2}T10:00:00.000Z`,
        endedAt: `2026-03-0${i + 2}T10:30:00.000Z`,
        summary: `t1 ${i}`,
      });
    }
    // Insert into other tenant directly
    for (let i = 0; i < 3; i++) {
      sqlite
        .prepare(
          `INSERT INTO episodes
           (id, tenant_id, agent_id, session_id, started_at, ended_at, duration_sec,
            role, task_type, outcome, summary, embedding, embedding_model,
            importance, lifecycle, created_at, updated_at)
           VALUES (?, ?, ?, NULL, ?, ?, 600, NULL, NULL, NULL, ?, NULL, NULL,
                   1, 'active', ?, ?)`,
        )
        .run(`t2-${i}`, OTHER_TENANT, AGENT_A, `2026-03-0${i + 2}T10:00:00.000Z`, `2026-03-0${i + 2}T10:30:00.000Z`, `t2 ${i}`, `2026-03-0${i + 2}T10:00:00.000Z`, `2026-03-0${i + 2}T10:00:00.000Z`);
      sqlite
        .prepare("INSERT INTO episodes_fts (id, tenant_id, summary) VALUES (?, ?, ?)")
        .run(`t2-${i}`, OTHER_TENANT, `t2 ${i}`);
    }

    const r = await consolidateEpisodes(sqlite, fakeEmbedClient(), {
      now: () => new Date("2026-05-15T00:00:00.000Z"),
      tenantId: TENANT,
    });
    expect(r.consolidated).toBe(1);
    expect(r.archived).toBe(3);

    const otherStillActive = sqlite
      .prepare("SELECT COUNT(*) AS n FROM episodes WHERE tenant_id = ? AND lifecycle = 'active'")
      .get(OTHER_TENANT) as { n: number };
    expect(otherStillActive.n).toBe(3);
  });
});
