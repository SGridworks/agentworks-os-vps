/**
 * Insights service — phase 1b of memory architecture.
 *
 * Stores atomic, frame-typed insights with embeddings. The recordInsight
 * function is provider-agnostic: it doesn't care whether the insight came
 * from an LLM extraction pass over an episode, an agent's self-reflection,
 * or a user posting a correction comment. The caller is responsible for
 * having already extracted/parsed the (frame_type, subject, content) tuple.
 *
 * Design parity with episodes.ts: same embedding round-trip semantics,
 * same NULL-on-embed-failure behaviour, same FTS5 mirror table written
 * inside one transaction.
 *
 * Future: a separate extractor module (Phase 1b follow-up) can consume
 * episodes.summary or feedback comments and call recordInsight per
 * extracted frame.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { EmbedClient, vectorToBlob } from "./embed-client.js";

export type FrameType =
  | "preference"
  | "fact"
  | "plan"
  | "constraint"
  | "feedback"
  | "error_pattern";

export type InsightSource =
  | "agent_reflection"
  | "user_correction"
  | "task_outcome"
  | "manual";

export interface RecordInsightInput {
  tenantId: string;
  /** Optional FK back to the episode that produced this insight. */
  episodeId?: string | undefined;
  frameType: FrameType;
  /** Optional entity the insight is about (person, project, system). */
  subject?: string | undefined;
  /** The insight itself. 1-3 sentences max in practice. */
  content: string;
  source: InsightSource;
  /** 1-5; defaults to 1 if not provided. */
  importance?: number | undefined;
  /** Whether the insight has been validated by a human reviewer. */
  validated?: boolean | undefined;
}

export interface RecordInsightResult {
  id: string;
  embeddingWritten: boolean;
  embeddingModel: string | undefined;
}

export interface RecordInsightDeps {
  embedClient: EmbedClient;
  now?: () => string;
}

export async function recordInsight(
  sqlite: Database,
  input: RecordInsightInput,
  deps: RecordInsightDeps,
): Promise<RecordInsightResult> {
  if (!input.content.trim()) {
    throw new Error("insight content must not be empty");
  }

  const id = randomUUID();
  const now = (deps.now ?? (() => new Date().toISOString()))();

  let embedding: Buffer | null = null;
  let embeddingModel: string | undefined;
  try {
    const r = await deps.embedClient.embedOne(input.content);
    embedding = vectorToBlob(r.vector);
    embeddingModel = r.model;
  } catch {
    // intentional: persist even if embedding fails. Sparse-only retrieval
    // for this row until backfill (Phase 1c).
  }

  const insertRow = sqlite.prepare(`
    INSERT INTO insights (
      id, tenant_id, episode_id,
      frame_type, subject, content,
      embedding, embedding_model,
      importance, source, validated, lifecycle,
      created_at
    ) VALUES (
      @id, @tenantId, @episodeId,
      @frameType, @subject, @content,
      @embedding, @embeddingModel,
      @importance, @source, @validated, 'active',
      @createdAt
    )
  `);

  const insertFts = sqlite.prepare(`
    INSERT INTO insights_fts (id, tenant_id, frame_type, content)
    VALUES (?, ?, ?, ?)
  `);

  const tx = sqlite.transaction(() => {
    insertRow.run({
      id,
      tenantId: input.tenantId,
      episodeId: input.episodeId ?? null,
      frameType: input.frameType,
      subject: input.subject ?? null,
      content: input.content,
      embedding,
      embeddingModel: embeddingModel ?? null,
      importance: input.importance ?? 1,
      source: input.source,
      validated: input.validated ? 1 : 0,
      createdAt: now,
    });
    insertFts.run(id, input.tenantId, input.frameType, input.content);
  });
  tx();

  return {
    id,
    embeddingWritten: embedding !== null,
    embeddingModel,
  };
}

export interface ListInsightsFilter {
  tenantId: string;
  frameType?: FrameType | undefined;
  subject?: string | undefined;
  episodeId?: string | undefined;
  lifecycle?: "active" | "archived" | "invalidated" | undefined;
  /** Cap rows returned. Default 100. */
  limit?: number | undefined;
}

export interface InsightSummary {
  id: string;
  frameType: FrameType;
  subject: string | null;
  content: string;
  source: InsightSource;
  importance: number;
  validated: boolean;
  episodeId: string | null;
  createdAt: string;
}

/** Cheap, non-vector listing for browsing. Vector + RRF retrieval is Phase 1c. */
export function listInsights(
  sqlite: Database,
  filter: ListInsightsFilter,
): InsightSummary[] {
  const clauses: string[] = ["tenant_id = ?"];
  const params: (string | number)[] = [filter.tenantId];

  if (filter.frameType) {
    clauses.push("frame_type = ?");
    params.push(filter.frameType);
  }
  if (filter.subject) {
    clauses.push("subject = ?");
    params.push(filter.subject);
  }
  if (filter.episodeId) {
    clauses.push("episode_id = ?");
    params.push(filter.episodeId);
  }
  clauses.push("lifecycle = ?");
  params.push(filter.lifecycle ?? "active");

  const limit = Math.max(1, Math.min(filter.limit ?? 100, 1000));
  params.push(limit);

  const rows = sqlite
    .prepare(
      `SELECT id, frame_type, subject, content, source, importance,
              validated, episode_id, created_at
         FROM insights
        WHERE ${clauses.join(" AND ")}
        ORDER BY importance DESC, created_at DESC
        LIMIT ?`,
    )
    .all(...params) as Array<{
    id: string;
    frame_type: FrameType;
    subject: string | null;
    content: string;
    source: InsightSource;
    importance: number;
    validated: number;
    episode_id: string | null;
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    frameType: r.frame_type,
    subject: r.subject,
    content: r.content,
    source: r.source,
    importance: r.importance,
    validated: r.validated === 1,
    episodeId: r.episode_id,
    createdAt: r.created_at,
  }));
}

export interface UpdateInsightInput {
  content?: string | undefined;
  validated?: boolean | undefined;
  importance?: number | undefined;
  subject?: string | null | undefined;
}

/**
 * Apply a partial update to an insight. Re-mirrors the FTS row when content
 * changes so search stays consistent. Returns the updated InsightSummary.
 * Throws if the insight doesn't exist.
 */
export function updateInsight(
  sqlite: Database,
  tenantId: string,
  id: string,
  input: UpdateInsightInput,
): InsightSummary {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (input.content !== undefined) {
    if (!input.content.trim()) throw new Error("insight content must not be empty");
    sets.push("content = ?");
    params.push(input.content);
  }
  if (input.validated !== undefined) {
    sets.push("validated = ?");
    params.push(input.validated ? 1 : 0);
  }
  if (input.importance !== undefined) {
    sets.push("importance = ?");
    params.push(input.importance);
  }
  if (input.subject !== undefined) {
    sets.push("subject = ?");
    params.push(input.subject);
  }

  if (sets.length === 0) {
    // Nothing to change — return current row
    const rows = listInsights(sqlite, { tenantId, lifecycle: "active", limit: 1000 });
    const found = rows.find((r) => r.id === id);
    if (!found) throw new Error("insight not found");
    return found;
  }

  const tx = sqlite.transaction(() => {
    const result = sqlite
      .prepare(`UPDATE insights SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`)
      .run(...params, id, tenantId);
    if (result.changes === 0) throw new Error("insight not found");
    if (input.content !== undefined) {
      sqlite
        .prepare(`UPDATE insights_fts SET content = ? WHERE id = ?`)
        .run(input.content, id);
    }
  });
  tx();

  const row = sqlite
    .prepare(
      `SELECT id, frame_type, subject, content, source, importance,
              validated, episode_id, created_at
         FROM insights WHERE id = ? AND tenant_id = ?`,
    )
    .get(id, tenantId) as {
    id: string;
    frame_type: FrameType;
    subject: string | null;
    content: string;
    source: InsightSource;
    importance: number;
    validated: number;
    episode_id: string | null;
    created_at: string;
  };

  return {
    id: row.id,
    frameType: row.frame_type,
    subject: row.subject,
    content: row.content,
    source: row.source,
    importance: row.importance,
    validated: row.validated === 1,
    episodeId: row.episode_id,
    createdAt: row.created_at,
  };
}

/** Soft-delete an insight by transitioning lifecycle to "archived". */
export function archiveInsight(sqlite: Database, tenantId: string, id: string): void {
  const result = sqlite
    .prepare(`UPDATE insights SET lifecycle = 'archived' WHERE id = ? AND tenant_id = ? AND lifecycle = 'active'`)
    .run(id, tenantId);
  if (result.changes === 0) throw new Error("insight not found or already archived");
}
