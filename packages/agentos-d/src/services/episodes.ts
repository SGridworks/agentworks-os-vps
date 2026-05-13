/**
 * Episodes service — wraps the rendered SessionBrief with embedding +
 * persistence into the `episodes` table.
 *
 * Caller responsibility: build a Session (id/tenantId/openedAt/closedAt)
 * and the event list. This service is provider-agnostic; it doesn't care
 * how the session was tracked.
 *
 * recordEpisode(...) is a single transactional unit:
 *   1. renderSessionBrief → summary + importance (already extant in @memory)
 *   2. EmbedClient.embedOne(summary) → 768-dim vector
 *   3. INSERT into episodes (with embedding BLOB) + episodes_fts
 *
 * If the embed call fails we still write the episode row with a NULL
 * embedding so the work record is not lost — retrieval falls back to
 * sparse-only for that row until backfilled (Phase 1c handles backfill).
 */

import { randomUUID } from "node:crypto";
import { renderSessionBrief, type Session, type SessionEvent } from "@agentworks/memory";
import type { Database } from "better-sqlite3";
import { EmbedClient, vectorToBlob } from "./embed-client.js";

export interface RecordEpisodeInput {
  session: Session;
  events: SessionEvent[];
  /** Optional metadata that the SessionBrief shape doesn't carry. */
  agentId?: string;
  role?: string;
  taskType?: string;
  outcome?: "success" | "failure" | "blocked";
}

export interface RecordEpisodeResult {
  id: string;
  /** The rendered SessionBrief.summary that was stored. Useful for
   * downstream insight extraction without re-querying. */
  summary: string;
  embeddingWritten: boolean;
  embeddingModel: string | undefined;
  /** True when this call updated an existing episode for the session
   * rather than creating a new one. Set by upsertEpisodeBySession. */
  updated?: boolean;
}

export interface RecordEpisodeDeps {
  embedClient: EmbedClient;
  /** Override for tests; defaults to () => new Date().toISOString(). */
  now?: () => string;
}

export async function recordEpisode(
  sqlite: Database,
  input: RecordEpisodeInput,
  deps: RecordEpisodeDeps,
): Promise<RecordEpisodeResult> {
  const brief = renderSessionBrief(input.session, input.events);
  const id = randomUUID();
  const now = (deps.now ?? (() => new Date().toISOString()))();

  let embedding: Buffer | null = null;
  let embeddingModel: string | undefined;
  try {
    const r = await deps.embedClient.embedOne(brief.summary);
    embedding = vectorToBlob(r.vector);
    embeddingModel = r.model;
  } catch {
    // intentional: persist the episode even if embedding failed; retrieval
    // for this row will fall back to sparse until a backfill embeds it.
  }

  const insertRow = sqlite.prepare(`
    INSERT INTO episodes (
      id, tenant_id, agent_id, session_id,
      started_at, ended_at, duration_sec,
      role, task_type, outcome,
      summary, embedding, embedding_model,
      importance, lifecycle, created_at
    ) VALUES (
      @id, @tenantId, @agentId, @sessionId,
      @startedAt, @endedAt, @durationSec,
      @role, @taskType, @outcome,
      @summary, @embedding, @embeddingModel,
      @importance, 'active', @createdAt
    )
  `);

  const insertFts = sqlite.prepare(`
    INSERT INTO episodes_fts (id, tenant_id, summary)
    VALUES (?, ?, ?)
  `);

  const tx = sqlite.transaction(() => {
    insertRow.run({
      id,
      tenantId: brief.tenantId,
      agentId: input.agentId ?? null,
      sessionId: brief.sessionId,
      startedAt: input.session.openedAt,
      endedAt: brief.closedAt,
      durationSec: brief.durationSec,
      role: input.role ?? null,
      taskType: input.taskType ?? null,
      outcome: input.outcome ?? null,
      summary: brief.summary,
      embedding,
      embeddingModel: embeddingModel ?? null,
      importance: brief.importance,
      createdAt: now,
    });
    insertFts.run(id, brief.tenantId, brief.summary);
  });
  tx();

  return {
    id,
    summary: brief.summary,
    embeddingWritten: embedding !== null,
    embeddingModel,
  };
}

/**
 * Upsert an episode keyed by (tenant_id, session_id). When an episode for
 * the same session already exists, its event log is replaced with the
 * caller-provided merged set, the summary is re-rendered + re-embedded,
 * and started_at/ended_at are stretched to span the union. Otherwise
 * behaves exactly like recordEpisode.
 *
 * Caller is responsible for assembling the merged event list from all
 * runs in the session (see episode-from-run.ts). This function does not
 * read execution_run_events itself — it stays provider-agnostic.
 */
export async function upsertEpisodeBySession(
  sqlite: Database,
  input: RecordEpisodeInput,
  deps: RecordEpisodeDeps,
): Promise<RecordEpisodeResult> {
  const existing = sqlite
    .prepare(
      `SELECT id FROM episodes WHERE tenant_id = ? AND session_id = ? LIMIT 1`,
    )
    .get(input.session.tenantId, input.session.id) as { id: string } | undefined;

  if (!existing) {
    const r = await recordEpisode(sqlite, input, deps);
    return { ...r, updated: false };
  }

  const brief = renderSessionBrief(input.session, input.events);
  const now = (deps.now ?? (() => new Date().toISOString()))();

  let embedding: Buffer | null = null;
  let embeddingModel: string | undefined;
  try {
    const r = await deps.embedClient.embedOne(brief.summary);
    embedding = vectorToBlob(r.vector);
    embeddingModel = r.model;
  } catch {
    // Same fallback as recordEpisode — keep prior embedding rather than
    // wipe it. So we only update embedding if the new embed succeeded.
  }

  const updateRow = embedding
    ? sqlite.prepare(`
        UPDATE episodes
           SET ended_at = @endedAt,
               duration_sec = @durationSec,
               outcome = COALESCE(@outcome, outcome),
               summary = @summary,
               embedding = @embedding,
               embedding_model = @embeddingModel,
               importance = MAX(importance, @importance),
               updated_at = @updatedAt
         WHERE id = @id
      `)
    : sqlite.prepare(`
        UPDATE episodes
           SET ended_at = @endedAt,
               duration_sec = @durationSec,
               outcome = COALESCE(@outcome, outcome),
               summary = @summary,
               importance = MAX(importance, @importance),
               updated_at = @updatedAt
         WHERE id = @id
      `);

  const tx = sqlite.transaction(() => {
    const params: Record<string, unknown> = {
      id: existing.id,
      endedAt: brief.closedAt,
      durationSec: brief.durationSec,
      outcome: input.outcome ?? null,
      summary: brief.summary,
      importance: brief.importance,
      updatedAt: now,
    };
    if (embedding) {
      params.embedding = embedding;
      params.embeddingModel = embeddingModel ?? null;
    }
    updateRow.run(params);
    sqlite
      .prepare(`UPDATE episodes_fts SET summary = ? WHERE id = ?`)
      .run(brief.summary, existing.id);
  });
  tx();

  return {
    id: existing.id,
    summary: brief.summary,
    embeddingWritten: embedding !== null,
    embeddingModel,
    updated: true,
  };
}
