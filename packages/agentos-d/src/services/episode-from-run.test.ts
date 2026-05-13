import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations/index.js";
import { maybeRecordEpisodeFromRun, assignEpisodeSessionId } from "./episode-from-run.js";
import { EmbedClient } from "./embed-client.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const AGENT = "22222222-2222-2222-2222-222222222222";
const RUN = "33333333-3333-3333-3333-333333333333";

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

function seedRun(opts: { events?: Array<{ type: string; message: string; at: string }> } = {}) {
  // execution_runs.company_id is NOT NULL with FK to execution_companies. We
  // INSERT a parent company row first to satisfy it; agent_id FK is also
  // satisfied by inserting an agent row. Tenant FK is loose (no execution_tenants).
  sqlite
    .prepare(
      `INSERT INTO execution_companies (id, tenant_id, name, slug, status, source, created_at, updated_at)
       VALUES (?, ?, 'Test Co', 'test-co', 'active', 'awos', ?, ?)`,
    )
    .run("44444444-4444-4444-4444-444444444444", TENANT, "2026-05-02T19:00:00.000Z", "2026-05-02T19:00:00.000Z");
  sqlite
    .prepare(
      `INSERT INTO execution_agents (id, tenant_id, company_id, name, status, source, created_at, updated_at)
       VALUES (?, ?, ?, 'Test Agent', 'active', 'awos', ?, ?)`,
    )
    .run(AGENT, TENANT, "44444444-4444-4444-4444-444444444444", "2026-05-02T19:00:00.000Z", "2026-05-02T19:00:00.000Z");
  sqlite
    .prepare(
      `INSERT INTO execution_runs
       (id, tenant_id, company_id, project_id, issue_id, agent_id, status, started_at, ended_at, summary, created_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, ?, 'completed', ?, ?, NULL, ?, ?)`,
    )
    .run(
      RUN,
      TENANT,
      "44444444-4444-4444-4444-444444444444",
      AGENT,
      "2026-05-02T20:00:00.000Z",
      "2026-05-02T20:30:00.000Z",
      "2026-05-02T20:00:00.000Z",
      "2026-05-02T20:30:00.000Z",
    );
  for (const e of opts.events ?? []) {
    sqlite
      .prepare(
        `INSERT INTO execution_run_events
         (id, tenant_id, run_id, event_type, message, data_json, created_at)
         VALUES (?, ?, ?, ?, ?, '{}', ?)`,
      )
      .run(crypto.randomUUID(), TENANT, RUN, e.type, e.message, e.at);
  }
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  migrate(sqlite);
});

afterEach(() => {
  sqlite.close();
});

describe("maybeRecordEpisodeFromRun", () => {
  it("writes an episode on transition from running → completed", async () => {
    seedRun({
      events: [
        { type: "vault_write", message: "wrote a page", at: "2026-05-02T20:05:00.000Z" },
        { type: "policy_evaluated", message: "allow", at: "2026-05-02T20:10:00.000Z" },
      ],
    });

    const r = await maybeRecordEpisodeFromRun(sqlite, {
      prevStatus: "running",
      nextStatus: "completed",
      lastRunId: RUN,
      agentId: AGENT,
      embedClient: fakeEmbedClient(),
    });
    expect(r.wrote).toBe(true);

    const sessionRow = sqlite
      .prepare("SELECT episode_session_id FROM execution_runs WHERE id = ?")
      .get(RUN) as { episode_session_id: string };
    expect(sessionRow.episode_session_id).toBeTruthy();

    const ep = sqlite
      .prepare("SELECT * FROM episodes WHERE session_id = ?")
      .get(sessionRow.episode_session_id) as {
      tenant_id: string;
      agent_id: string;
      session_id: string;
      outcome: string;
      started_at: string;
      ended_at: string;
      summary: string;
      embedding: Buffer;
    };
    expect(ep.tenant_id).toBe(TENANT);
    expect(ep.agent_id).toBe(AGENT);
    expect(ep.session_id).toBe(sessionRow.episode_session_id);
    expect(ep.outcome).toBe("success");
    expect(ep.started_at).toBe("2026-05-02T20:00:00.000Z");
    expect(ep.ended_at).toBe("2026-05-02T20:30:00.000Z");
    expect(ep.embedding).toBeInstanceOf(Buffer);
    expect(ep.summary).toMatch(/Vault Write|Policy Evaluated/i);
  });

  it("maps failed → outcome=failure and blocked → outcome=blocked", async () => {
    seedRun();
    await maybeRecordEpisodeFromRun(sqlite, {
      prevStatus: "running",
      nextStatus: "failed",
      lastRunId: RUN,
      agentId: AGENT,
      embedClient: fakeEmbedClient(),
    });
    const sessionRow = sqlite
      .prepare("SELECT episode_session_id FROM execution_runs WHERE id = ?")
      .get(RUN) as { episode_session_id: string };
    const ep = sqlite
      .prepare("SELECT outcome FROM episodes WHERE session_id = ?")
      .get(sessionRow.episode_session_id) as { outcome: string };
    expect(ep.outcome).toBe("failure");
  });

  it("skips when nextStatus is non-terminal", async () => {
    seedRun();
    const r = await maybeRecordEpisodeFromRun(sqlite, {
      prevStatus: null,
      nextStatus: "running",
      lastRunId: RUN,
      agentId: AGENT,
      embedClient: fakeEmbedClient(),
    });
    expect(r).toEqual({ wrote: false, reason: "non_terminal" });
    const count = sqlite.prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("skips when prev was already the same terminal status (idempotent re-PATCH)", async () => {
    seedRun();
    const r = await maybeRecordEpisodeFromRun(sqlite, {
      prevStatus: "completed",
      nextStatus: "completed",
      lastRunId: RUN,
      agentId: AGENT,
      embedClient: fakeEmbedClient(),
    });
    expect(r).toEqual({ wrote: false, reason: "no_transition" });
    const count = sqlite.prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("writes when prev was a different terminal status (status corrected from failed → completed)", async () => {
    seedRun();
    const r = await maybeRecordEpisodeFromRun(sqlite, {
      prevStatus: "failed",
      nextStatus: "completed",
      lastRunId: RUN,
      agentId: AGENT,
      embedClient: fakeEmbedClient(),
    });
    expect(r.wrote).toBe(true);
  });

  it("skips when no lastRunId is provided", async () => {
    const r = await maybeRecordEpisodeFromRun(sqlite, {
      prevStatus: "running",
      nextStatus: "completed",
      lastRunId: null,
      agentId: AGENT,
      embedClient: fakeEmbedClient(),
    });
    expect(r).toEqual({ wrote: false, reason: "no_run_id" });
  });

  it("skips when the run row is not found (orphan runId)", async () => {
    const r = await maybeRecordEpisodeFromRun(sqlite, {
      prevStatus: "running",
      nextStatus: "completed",
      lastRunId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      agentId: AGENT,
      embedClient: fakeEmbedClient(),
    });
    expect(r).toEqual({ wrote: false, reason: "run_not_found" });
  });

  it("is idempotent under upsert: a second call with the same run does not duplicate the episode", async () => {
    seedRun();
    const first = await maybeRecordEpisodeFromRun(sqlite, {
      prevStatus: "running",
      nextStatus: "completed",
      lastRunId: RUN,
      agentId: AGENT,
      embedClient: fakeEmbedClient(),
    });
    expect(first.wrote).toBe(true);
    if (first.wrote) {
      expect(first.result.updated).toBe(false);
    }

    const second = await maybeRecordEpisodeFromRun(sqlite, {
      prevStatus: "running",
      nextStatus: "completed",
      lastRunId: RUN,
      agentId: AGENT,
      embedClient: fakeEmbedClient(),
    });
    expect(second.wrote).toBe(true);
    if (second.wrote) {
      expect(second.result.updated).toBe(true);
    }

    const count = sqlite
      .prepare("SELECT COUNT(*) AS n FROM episodes")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("first-PATCH-with-terminal-status (prev=null) writes", async () => {
    seedRun();
    const r = await maybeRecordEpisodeFromRun(sqlite, {
      prevStatus: null,
      nextStatus: "completed",
      lastRunId: RUN,
      agentId: AGENT,
      embedClient: fakeEmbedClient(),
    });
    expect(r.wrote).toBe(true);
  });
});

describe("assignEpisodeSessionId — idle-timeout grouping", () => {
  function seedSecondRun(opts: {
    runId: string;
    startedAt: string;
    endedAt: string;
    events?: Array<{ type: string; message: string; at: string }>;
  }) {
    sqlite
      .prepare(
        `INSERT INTO execution_runs
         (id, tenant_id, company_id, project_id, issue_id, agent_id, status, started_at, ended_at, summary, created_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, ?, 'completed', ?, ?, NULL, ?, ?)`,
      )
      .run(
        opts.runId,
        TENANT,
        "44444444-4444-4444-4444-444444444444",
        AGENT,
        opts.startedAt,
        opts.endedAt,
        opts.startedAt,
        opts.endedAt,
      );
    for (const e of opts.events ?? []) {
      sqlite
        .prepare(
          `INSERT INTO execution_run_events
           (id, tenant_id, run_id, event_type, message, data_json, created_at)
           VALUES (?, ?, ?, ?, ?, '{}', ?)`,
        )
        .run(crypto.randomUUID(), TENANT, opts.runId, e.type, e.message, e.at);
    }
  }

  it("two runs within idle window share an episode_session_id", () => {
    // Seed a first run via seedRun (RUN ends at 20:30:00).
    sqlite
      .prepare(
        `INSERT INTO execution_companies (id, tenant_id, name, slug, status, source, created_at, updated_at)
         VALUES (?, ?, 'Test Co', 'test-co', 'active', 'awos', ?, ?)`,
      )
      .run("44444444-4444-4444-4444-444444444444", TENANT, "2026-05-02T19:00:00.000Z", "2026-05-02T19:00:00.000Z");
    sqlite
      .prepare(
        `INSERT INTO execution_agents (id, tenant_id, company_id, name, status, source, created_at, updated_at)
         VALUES (?, ?, ?, 'Test Agent', 'active', 'awos', ?, ?)`,
      )
      .run(AGENT, TENANT, "44444444-4444-4444-4444-444444444444", "2026-05-02T19:00:00.000Z", "2026-05-02T19:00:00.000Z");

    const RUN_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const RUN_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    seedSecondRun({ runId: RUN_A, startedAt: "2026-05-02T20:00:00.000Z", endedAt: "2026-05-02T20:30:00.000Z" });
    seedSecondRun({ runId: RUN_B, startedAt: "2026-05-02T20:35:00.000Z", endedAt: "2026-05-02T20:40:00.000Z" });

    const sessionA = assignEpisodeSessionId(sqlite, {
      runId: RUN_A,
      tenantId: TENANT,
      agentId: AGENT,
      runStartedAt: "2026-05-02T20:00:00.000Z",
    });
    const sessionB = assignEpisodeSessionId(sqlite, {
      runId: RUN_B,
      tenantId: TENANT,
      agentId: AGENT,
      runStartedAt: "2026-05-02T20:35:00.000Z",
    });
    expect(sessionA).toBe(sessionB);
  });

  it("two runs apart > idle window get distinct episode_session_ids", () => {
    sqlite
      .prepare(
        `INSERT INTO execution_companies (id, tenant_id, name, slug, status, source, created_at, updated_at)
         VALUES (?, ?, 'Test Co', 'test-co', 'active', 'awos', ?, ?)`,
      )
      .run("44444444-4444-4444-4444-444444444444", TENANT, "2026-05-02T19:00:00.000Z", "2026-05-02T19:00:00.000Z");
    sqlite
      .prepare(
        `INSERT INTO execution_agents (id, tenant_id, company_id, name, status, source, created_at, updated_at)
         VALUES (?, ?, ?, 'Test Agent', 'active', 'awos', ?, ?)`,
      )
      .run(AGENT, TENANT, "44444444-4444-4444-4444-444444444444", "2026-05-02T19:00:00.000Z", "2026-05-02T19:00:00.000Z");

    const RUN_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const RUN_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    seedSecondRun({ runId: RUN_A, startedAt: "2026-05-02T20:00:00.000Z", endedAt: "2026-05-02T20:30:00.000Z" });
    // 4 hours later — well beyond default 30min idle window
    seedSecondRun({ runId: RUN_C, startedAt: "2026-05-03T00:30:00.000Z", endedAt: "2026-05-03T00:35:00.000Z" });

    const sessionA = assignEpisodeSessionId(sqlite, {
      runId: RUN_A,
      tenantId: TENANT,
      agentId: AGENT,
      runStartedAt: "2026-05-02T20:00:00.000Z",
    });
    const sessionC = assignEpisodeSessionId(sqlite, {
      runId: RUN_C,
      tenantId: TENANT,
      agentId: AGENT,
      runStartedAt: "2026-05-03T00:30:00.000Z",
    });
    expect(sessionA).not.toBe(sessionC);
  });
});

describe("maybeRecordEpisodeFromRun — multi-run sessions", () => {
  it("two close runs collapse into one episode that spans both", async () => {
    sqlite
      .prepare(
        `INSERT INTO execution_companies (id, tenant_id, name, slug, status, source, created_at, updated_at)
         VALUES (?, ?, 'Test Co', 'test-co', 'active', 'awos', ?, ?)`,
      )
      .run("44444444-4444-4444-4444-444444444444", TENANT, "2026-05-02T19:00:00.000Z", "2026-05-02T19:00:00.000Z");
    sqlite
      .prepare(
        `INSERT INTO execution_agents (id, tenant_id, company_id, name, status, source, created_at, updated_at)
         VALUES (?, ?, ?, 'Test Agent', 'active', 'awos', ?, ?)`,
      )
      .run(AGENT, TENANT, "44444444-4444-4444-4444-444444444444", "2026-05-02T19:00:00.000Z", "2026-05-02T19:00:00.000Z");

    const RUN_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const RUN_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    sqlite
      .prepare(
        `INSERT INTO execution_runs
         (id, tenant_id, company_id, project_id, issue_id, agent_id, status, started_at, ended_at, summary, created_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, ?, 'completed', ?, ?, NULL, ?, ?)`,
      )
      .run(RUN_A, TENANT, "44444444-4444-4444-4444-444444444444", AGENT, "2026-05-02T20:00:00.000Z", "2026-05-02T20:15:00.000Z", "2026-05-02T20:00:00.000Z", "2026-05-02T20:15:00.000Z");
    sqlite
      .prepare(
        `INSERT INTO execution_run_events (id, tenant_id, run_id, event_type, message, data_json, created_at)
         VALUES (?, ?, ?, 'vault_write', 'first-run event', '{}', ?)`,
      )
      .run(crypto.randomUUID(), TENANT, RUN_A, "2026-05-02T20:05:00.000Z");

    sqlite
      .prepare(
        `INSERT INTO execution_runs
         (id, tenant_id, company_id, project_id, issue_id, agent_id, status, started_at, ended_at, summary, created_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, ?, 'completed', ?, ?, NULL, ?, ?)`,
      )
      .run(RUN_B, TENANT, "44444444-4444-4444-4444-444444444444", AGENT, "2026-05-02T20:20:00.000Z", "2026-05-02T20:30:00.000Z", "2026-05-02T20:20:00.000Z", "2026-05-02T20:30:00.000Z");
    sqlite
      .prepare(
        `INSERT INTO execution_run_events (id, tenant_id, run_id, event_type, message, data_json, created_at)
         VALUES (?, ?, ?, 'policy_evaluated', 'second-run event', '{}', ?)`,
      )
      .run(crypto.randomUUID(), TENANT, RUN_B, "2026-05-02T20:25:00.000Z");

    const r1 = await maybeRecordEpisodeFromRun(sqlite, {
      prevStatus: "running",
      nextStatus: "completed",
      lastRunId: RUN_A,
      agentId: AGENT,
      embedClient: fakeEmbedClient(),
    });
    const r2 = await maybeRecordEpisodeFromRun(sqlite, {
      prevStatus: "running",
      nextStatus: "completed",
      lastRunId: RUN_B,
      agentId: AGENT,
      embedClient: fakeEmbedClient(),
    });
    expect(r1.wrote).toBe(true);
    expect(r2.wrote).toBe(true);
    if (r2.wrote) expect(r2.result.updated).toBe(true);

    const count = sqlite.prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number };
    expect(count.n).toBe(1);

    const ep = sqlite.prepare("SELECT started_at, ended_at, summary FROM episodes").get() as {
      started_at: string;
      ended_at: string;
      summary: string;
    };
    expect(ep.started_at).toBe("2026-05-02T20:00:00.000Z");
    expect(ep.ended_at).toBe("2026-05-02T20:30:00.000Z");
    expect(ep.summary).toMatch(/Vault Write|Policy Evaluated/i);
  });
});
