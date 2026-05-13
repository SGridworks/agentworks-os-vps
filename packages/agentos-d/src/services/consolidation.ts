/**
 * Consolidation pass — phase 1c follow-up.
 *
 * Periodic background job that summarises old episodes into longer-horizon
 * memory. Without it, the corpus grows linearly forever; retrieval gets
 * slower and noisier; the embedding model has to work harder to separate
 * a 4-month-old vault edit from yesterday's incident.
 *
 * Policy (MVP):
 *   - Look at episodes older than `minAgeDays` (default 14)
 *   - Group by (tenant_id, agent_id, ISO week)
 *   - Skip groups smaller than `minGroupSize` (default 3) — singletons
 *     are not worth the round-trip
 *   - For each surviving group:
 *       * Render a meta-summary that concatenates the source summaries
 *         in chronological order with timeline markers
 *       * Embed the new summary
 *       * Insert a new episode with role='consolidated',
 *         task_type='session_consolidation' carrying provenance for the
 *         sources in the summary itself
 *       * Transition every source episode to lifecycle='archived'
 *
 * Idempotent — sources move to 'archived' so a second run skips them.
 *
 * NOT WIRED to a cron yet — caller is whoever wants to run the pass
 * (operator command, daily cron, test). The function takes sqlite +
 * embedClient and returns counts; scheduling is a separate concern.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { EmbedClient, vectorToBlob } from "./embed-client.js";

export interface ConsolidationOptions {
  /** Episodes younger than this are left alone. Default 14. */
  minAgeDays?: number;
  /** Skip a (agent, week) bucket smaller than this. Default 3. */
  minGroupSize?: number;
  /** Override the clock for tests. */
  now?: () => Date;
  /** Restrict to one tenant; default = all tenants. */
  tenantId?: string;
}

export interface ConsolidationResult {
  /** Number of new consolidated episodes written. */
  consolidated: number;
  /** Number of source episodes archived. */
  archived: number;
  /** Number of buckets considered (including those skipped for size). */
  bucketsScanned: number;
}

interface SourceEpisode {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  started_at: string;
  ended_at: string;
  summary: string;
  importance: number;
}

function isoWeekKey(d: Date): string {
  // ISO 8601 week-of-year: thursday-of-the-week trick
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function buildMetaSummary(sources: SourceEpisode[], weekKey: string): string {
  const lines: string[] = [];
  lines.push(`# Consolidated memory: ${weekKey}`);
  lines.push("");
  lines.push(
    `Aggregated from ${sources.length} episode(s) between ` +
      `${sources[0]!.started_at} and ${sources[sources.length - 1]!.ended_at}.`,
  );
  lines.push("");
  lines.push("## Sources (chronological)");
  for (const s of sources) {
    const truncated = s.summary.length > 800 ? s.summary.slice(0, 800) + "..." : s.summary;
    lines.push(`- [${s.started_at}] (importance ${s.importance}) ${truncated}`);
  }
  return lines.join("\n");
}

export async function consolidateEpisodes(
  sqlite: Database,
  embedClient: EmbedClient,
  opts: ConsolidationOptions = {},
): Promise<ConsolidationResult> {
  const minAgeDays = opts.minAgeDays ?? 14;
  const minGroupSize = opts.minGroupSize ?? 3;
  const now = (opts.now ?? (() => new Date()))();
  const cutoffMs = now.getTime() - minAgeDays * 86_400_000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  const params: (string | number)[] = [cutoffIso];
  let tenantClause = "";
  if (opts.tenantId) {
    tenantClause = "AND tenant_id = ?";
    params.push(opts.tenantId);
  }

  const candidates = sqlite
    .prepare(
      `SELECT id, tenant_id, agent_id, started_at, ended_at, summary, importance
         FROM episodes
        WHERE lifecycle = 'active'
          AND task_type IS NOT 'session_consolidation'
          AND started_at < ?
          ${tenantClause}
        ORDER BY tenant_id, agent_id, started_at`,
    )
    .all(...params) as SourceEpisode[];

  const buckets = new Map<string, SourceEpisode[]>();
  for (const ep of candidates) {
    const week = isoWeekKey(new Date(ep.started_at));
    const key = `${ep.tenant_id}|${ep.agent_id ?? "_null_"}|${week}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(ep);
    else buckets.set(key, [ep]);
  }

  let consolidated = 0;
  let archived = 0;

  for (const [key, sources] of buckets) {
    if (sources.length < minGroupSize) continue;

    const tenantId = sources[0]!.tenant_id;
    const agentId = sources[0]!.agent_id;
    const weekKey = key.split("|").pop()!;

    const summary = buildMetaSummary(sources, weekKey);

    let embedding: Buffer | null = null;
    let embeddingModel: string | undefined;
    try {
      const r = await embedClient.embedOne(summary);
      embedding = vectorToBlob(r.vector);
      embeddingModel = r.model;
    } catch {
      // Same fallback as recordEpisode — write the row, leave retrieval
      // to recover via sparse FTS until backfill.
    }

    const newId = randomUUID();
    const startedAt = sources[0]!.started_at;
    const endedAt = sources[sources.length - 1]!.ended_at;
    const durationSec = Math.max(
      0,
      Math.floor((Date.parse(endedAt) - Date.parse(startedAt)) / 1000),
    );
    const importance = Math.min(
      5,
      Math.max(...sources.map((s) => s.importance), 1) + 1,
    );
    const createdAt = now.toISOString();

    const insertRow = sqlite.prepare(`
      INSERT INTO episodes (
        id, tenant_id, agent_id, session_id,
        started_at, ended_at, duration_sec,
        role, task_type, outcome,
        summary, embedding, embedding_model,
        importance, lifecycle, created_at, updated_at
      ) VALUES (
        @id, @tenantId, @agentId, NULL,
        @startedAt, @endedAt, @durationSec,
        'consolidated', 'session_consolidation', NULL,
        @summary, @embedding, @embeddingModel,
        @importance, 'active', @createdAt, @createdAt
      )
    `);
    const insertFts = sqlite.prepare(
      `INSERT INTO episodes_fts (id, tenant_id, summary) VALUES (?, ?, ?)`,
    );
    const archiveSrc = sqlite.prepare(
      `UPDATE episodes SET lifecycle = 'archived', updated_at = ? WHERE id = ?`,
    );
    const archiveSrcFts = sqlite.prepare(
      `DELETE FROM episodes_fts WHERE id = ?`,
    );

    const tx = sqlite.transaction(() => {
      insertRow.run({
        id: newId,
        tenantId,
        agentId,
        startedAt,
        endedAt,
        durationSec,
        summary,
        embedding,
        embeddingModel: embeddingModel ?? null,
        importance,
        createdAt,
      });
      insertFts.run(newId, tenantId, summary);
      for (const s of sources) {
        archiveSrc.run(createdAt, s.id);
        archiveSrcFts.run(s.id);
      }
    });
    tx();

    consolidated += 1;
    archived += sources.length;
  }

  return { consolidated, archived, bucketsScanned: buckets.size };
}
