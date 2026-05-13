/**
 * episode-from-run — Hook that turns a completed execution_run into a
 * persisted episode. Called from the runtime-state PATCH path when an
 * agent reports lastRunStatus transitioning to a terminal state.
 *
 * This is the long-promised "session-end signal" wiring. Reads the run
 * row + its events from execution_runs/execution_run_events, builds the
 * Session/SessionEvent shape that recordEpisode() expects, and writes
 * one episode row.
 *
 * Idempotency: caller is responsible for deciding whether to call. We
 * additionally guard against double-write by checking if any episode
 * already exists for (tenant_id, session_id=runId).
 */

import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { Session, SessionEvent } from "@agentworks/memory";
import { upsertEpisodeBySession, type RecordEpisodeResult } from "./episodes.js";
import { recordInsight } from "./insights.js";
import type { EmbedClient } from "./embed-client.js";
import type { InsightExtractor } from "./insight-extractor.js";

const DEFAULT_IDLE_TIMEOUT_MIN = 30;

/**
 * Pick the episode_session_id to use for `runId` from this agent's
 * recent run history. If a prior run for the same agent ended within
 * the idle window, this run joins its session. Otherwise a new session
 * begins. Writes the choice back to execution_runs.episode_session_id.
 *
 * Pure-ish: queries + writes one column. No external IO.
 */
export function assignEpisodeSessionId(
  sqlite: Database,
  args: {
    runId: string;
    tenantId: string;
    agentId: string | null;
    runStartedAt: string;
    idleMinutes?: number;
  },
): string {
  const idleMs = (args.idleMinutes ?? readIdleMinutesFromEnv()) * 60_000;

  // Already assigned (idempotent re-PATCH)?
  const cur = sqlite
    .prepare("SELECT episode_session_id FROM execution_runs WHERE id = ?")
    .get(args.runId) as { episode_session_id: string | null } | undefined;
  if (cur?.episode_session_id) return cur.episode_session_id;

  // Find the most recent prior run for this agent in this tenant.
  let chosen: string | null = null;
  if (args.agentId) {
    const prior = sqlite
      .prepare(
        `SELECT episode_session_id, ended_at, started_at
           FROM execution_runs
          WHERE tenant_id = ? AND agent_id = ? AND id != ? AND episode_session_id IS NOT NULL
          ORDER BY COALESCE(ended_at, started_at) DESC
          LIMIT 1`,
      )
      .get(args.tenantId, args.agentId, args.runId) as
      | { episode_session_id: string; ended_at: string | null; started_at: string }
      | undefined;
    if (prior) {
      const priorEndedMs = Date.parse(prior.ended_at ?? prior.started_at);
      const thisStartedMs = Date.parse(args.runStartedAt);
      if (
        Number.isFinite(priorEndedMs) &&
        Number.isFinite(thisStartedMs) &&
        thisStartedMs - priorEndedMs <= idleMs
      ) {
        chosen = prior.episode_session_id;
      }
    }
  }

  const sessionId = chosen ?? randomUUID();
  sqlite
    .prepare("UPDATE execution_runs SET episode_session_id = ? WHERE id = ?")
    .run(sessionId, args.runId);
  return sessionId;
}

function readIdleMinutesFromEnv(): number {
  const raw = process.env.EPISODE_IDLE_TIMEOUT_MIN;
  if (!raw) return DEFAULT_IDLE_TIMEOUT_MIN;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_IDLE_TIMEOUT_MIN;
}

export type TerminalStatus = "completed" | "succeeded" | "failed" | "blocked";

// "succeeded" is the runtime-state vocab; "completed" is the run/outcome vocab.
// Treat both as success-terminal so the runtime-state PATCH path (which writes
// "succeeded") triggers episode creation.
const STATUS_TO_OUTCOME: Record<TerminalStatus, "success" | "failure" | "blocked"> = {
  completed: "success",
  succeeded: "success",
  failed: "failure",
  blocked: "blocked",
};

export interface MaybeRecordEpisodeArgs {
  /** Status before this PATCH (or null on first write). */
  prevStatus: string | null;
  /** Status after this PATCH. */
  nextStatus: string | null;
  /** Run ID that the runtime-state row points to. */
  lastRunId: string | null;
  agentId: string;
  embedClient: EmbedClient;
  /** Optional: if provided, extract insights from the episode summary
   * after a successful record and write them via recordInsight. */
  insightExtractor?: InsightExtractor;
}

export type MaybeRecordEpisodeResult =
  | { wrote: true; result: RecordEpisodeResult }
  | { wrote: false; reason: "no_transition" | "no_run_id" | "non_terminal" | "run_not_found" | "embed_skipped" };

const TERMINAL_STATUSES: ReadonlySet<TerminalStatus> = new Set([
  "completed",
  "succeeded",
  "failed",
  "blocked",
]);

function isTerminal(s: string | null): s is TerminalStatus {
  return s !== null && TERMINAL_STATUSES.has(s as TerminalStatus);
}

export async function maybeRecordEpisodeFromRun(
  sqlite: Database,
  args: MaybeRecordEpisodeArgs,
): Promise<MaybeRecordEpisodeResult> {
  // Detect transition: nextStatus is terminal AND it differs from prevStatus.
  // We allow nextStatus=prevStatus only if prev wasn't terminal — that way a
  // first-PATCH-with-terminal-status (no prior row) still writes.
  if (!isTerminal(args.nextStatus)) {
    return { wrote: false, reason: "non_terminal" };
  }
  if (isTerminal(args.prevStatus) && args.prevStatus === args.nextStatus) {
    return { wrote: false, reason: "no_transition" };
  }
  if (!args.lastRunId) {
    return { wrote: false, reason: "no_run_id" };
  }

  const run = sqlite
    .prepare(
      `SELECT id, tenant_id, agent_id, issue_id, summary, started_at, ended_at, created_at, updated_at
         FROM execution_runs WHERE id = ?`,
    )
    .get(args.lastRunId) as
    | {
        id: string;
        tenant_id: string;
        agent_id: string | null;
        issue_id: string | null;
        summary: string | null;
        started_at: string | null;
        ended_at: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (!run) {
    return { wrote: false, reason: "run_not_found" };
  }

  // Group this run into a session by idle-timeout heuristic. The first
  // call assigns; subsequent calls (re-PATCH same run) reuse.
  const episodeSessionId = assignEpisodeSessionId(sqlite, {
    runId: run.id,
    tenantId: run.tenant_id,
    agentId: run.agent_id,
    runStartedAt: run.started_at ?? run.created_at,
  });

  // Collect events from EVERY run that shares this session. This is what
  // turns a 5-run burst into one coherent episode summary.
  const sessionRunIds = sqlite
    .prepare(
      `SELECT id, started_at, ended_at, created_at
         FROM execution_runs
        WHERE tenant_id = ? AND episode_session_id = ?
        ORDER BY COALESCE(started_at, created_at) ASC`,
    )
    .all(run.tenant_id, episodeSessionId) as Array<{
    id: string;
    started_at: string | null;
    ended_at: string | null;
    created_at: string;
  }>;
  const runIds = sessionRunIds.map((r) => r.id);
  const placeholders = runIds.map(() => "?").join(",");
  const eventRows =
    runIds.length === 0
      ? []
      : (sqlite
          .prepare(
            `SELECT event_type, message, created_at
               FROM execution_run_events WHERE run_id IN (${placeholders})
              ORDER BY created_at ASC LIMIT 2000`,
          )
          .all(...runIds) as Array<{
          event_type: string;
          message: string | null;
          created_at: string;
        }>);

  const events: SessionEvent[] = eventRows.map((r) => ({
    at: r.created_at,
    type: r.event_type,
    description: r.message ?? "",
  }));

  // Span = earliest start to latest end across all runs in the session.
  const earliestStart = sessionRunIds[0]?.started_at ?? run.started_at ?? run.created_at;
  const lastRun = sessionRunIds[sessionRunIds.length - 1];
  const latestEnd =
    lastRun?.ended_at ??
    run.ended_at ??
    run.updated_at ??
    new Date().toISOString();
  const session: Session = {
    id: episodeSessionId,
    tenantId: run.tenant_id,
    openedAt: earliestStart,
    closedAt: latestEnd,
  };

  const result = await upsertEpisodeBySession(
    sqlite,
    {
      session,
      events,
      agentId: run.agent_id ?? args.agentId,
      outcome: STATUS_TO_OUTCOME[args.nextStatus],
    },
    { embedClient: args.embedClient },
  );

  // Best-effort insight extraction. Errors here must not poison the
  // episode write, so we swallow and log. If no extractor configured we
  // skip — the writer can call recordInsight directly later.
  if (args.insightExtractor) {
    try {
      const extracted = await args.insightExtractor.extract(result.summary, {
        tenantId: run.tenant_id,
        episodeId: result.id,
      });
      for (const ins of extracted) {
        await recordInsight(
          sqlite,
          {
            tenantId: run.tenant_id,
            episodeId: result.id,
            frameType: ins.frameType,
            subject: ins.subject ?? undefined,
            content: ins.content,
            source: ins.source,
            // Map confidence to importance bucket: 1..5
            importance: Math.max(1, Math.min(5, Math.round(ins.confidence * 5))),
            validated: false,
          },
          { embedClient: args.embedClient },
        );
      }
    } catch (err) {
      console.warn("[episode-from-run] insight extraction failed:", err);
    }
  }

  return { wrote: true, result };
}
