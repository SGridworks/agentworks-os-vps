export type { Session, SessionBrief, SessionEvent } from "./session-brief-types.js";
import type { Session, SessionBrief, SessionEvent } from "./session-brief-types.js";

/**
 * Importance score based on event count.
 * More events = higher importance (more worth remembering).
 * Caps at 5.
 */
function computeImportance(eventCount: number, durationSec: number): number {
  let score = 1;
  if (eventCount >= 50) score = 5;
  else if (eventCount >= 20) score = 4;
  else if (eventCount >= 10) score = 3;
  else if (eventCount >= 5) score = 2;

  // Long-running sessions get a bump (more opportunity for meaningful work)
  if (durationSec > 3600 && score < 5) score += 1;

  return score;
}

/**
 * Generate a one-line summary from the event list.
 * Groups events by type and counts them.
 *
 * Examples:
 *   "Wrote 3 vault pages, evaluated 5 policies, spawned 2 agents"
 *   "No significant activity"
 */
function generateSummary(events: SessionEvent[]): string {
  if (events.length === 0) return "No significant activity";

  const counts: Record<string, number> = {};
  for (const evt of events) {
    counts[evt.type] = (counts[evt.type] ?? 0) + 1;
  }

  const parts: string[] = [];
  for (const [type, count] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) {
    // Humanise the type name: vault_write → "vault page writes"
    const label = type
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    parts.push(`${count} ${label}`);
  }

  return parts.join(", ");
}

/**
 * Render a SessionBrief for a closed session.
 *
 * @param session - the Session (must have a closedAt timestamp)
 * @param events  - list of notable events that occurred during the session
 */
export function renderSessionBrief(
  session: Session,
  events: SessionEvent[] = [],
): SessionBrief {
  if (!session.closedAt) {
    throw new Error("Cannot render SessionBrief for an open session — closedAt is required");
  }

  const openedAtMs = new Date(session.openedAt).getTime();
  const closedAtMs = new Date(session.closedAt).getTime();
  const durationSec = Math.round((closedAtMs - openedAtMs) / 1000);

  return {
    sessionId: session.id,
    tenantId: session.tenantId,
    closedAt: session.closedAt,
    durationSec,
    summary: generateSummary(events),
    events,
    importance: computeImportance(events.length, durationSec),
  };
}
