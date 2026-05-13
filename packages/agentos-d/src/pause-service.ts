/**
 * Substrate pause/resume service.
 *
 * All three substrate operations — dispatch, policy.check, and cron ticks —
 * consult isPaused() before proceeding. While paused they return 503 with
 * reason="substrate_paused".
 */

import { getDb } from "./db/client.js";
import { daemonPausedState } from "./db/schema.js";
import { eq } from "drizzle-orm";

/** Returns true if the substrate is currently paused. */
export function isPaused(): boolean {
  const row = getDb()
    .select()
    .from(daemonPausedState)
    .where(eq(daemonPausedState.id, 1))
    .get();
  return row?.paused ?? false;
}

/** Pause the substrate. Idempotent — pausing an already-paused substrate is a no-op. */
export function pause(by: string, reason: string): void {
  getDb()
    .update(daemonPausedState)
    .set({
      paused: true,
      pausedAt: new Date().toISOString(),
      pausedBy: by,
      reason,
    })
    .where(eq(daemonPausedState.id, 1))
    .run();
}

/** Resume the substrate. Idempotent — resuming a running substrate is a no-op. */
export function resume(): void {
  getDb()
    .update(daemonPausedState)
    .set({
      paused: false,
      pausedAt: null,
      pausedBy: null,
      reason: null,
    })
    .where(eq(daemonPausedState.id, 1))
    .run();
}
