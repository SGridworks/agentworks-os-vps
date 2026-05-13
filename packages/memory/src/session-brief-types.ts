/**
 * Session Brief — structured summary written to the vault at session close.
 *
 * Importance 1-5 drives vault pruning: higher importance sessions are
 * retained longer during automated compaction.
 */

export interface SessionBrief {
  /** Session that was closed */
  sessionId: string;
  /** Tenant who owns this session */
  tenantId: string;
  /** ISO-8601 when session ended */
  closedAt: string;
  /** Duration in seconds */
  durationSec: number;
  /** One-line summary — generated from events */
  summary: string;
  /** Bullet points of notable events */
  events: SessionEvent[];
  /** Importance 1-5 for pruning decisions */
  importance: number;
}

export interface SessionEvent {
  /** ISO-8601 */
  at: string;
  /** e.g. "vault_write", "policy_evaluated", "agent_spawned" */
  type: string;
  /** Human-readable description */
  description: string;
}

/**
 * Minimal session shape required by renderSessionBrief.
 * The concrete Session type lives in the layer that owns session state
 * (e.g. agentos-d); this interface is the only contract packages/memory
 * depends on.
 */
export interface Session {
  id: string;
  tenantId: string;
  openedAt: string; // ISO-8601
  closedAt?: string; // ISO-8601 — present when closed
}
