/**
 * Signal detector — surfaces "you should know about X" signals from vault activity.
 *
 * Watches what pages are written and read, maintains a signal strength index,
 * and surfaces high-signal pages that are new since the agent last polled.
 *
 * Pattern from gbrain signal-detector skill; adapted for flat-file vault.
 *
 * Signal strength model:
 *   - First write: 1.0
 *   - Subsequent write: +0.5
 *   - Read/reference: +0.3
 *   - Decay: strength *= 0.5 ** daysSinceLastUpdate (minimum 0.01)
 *   - Threshold for visibility: 1.0
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

/** A signal — a vault page with computed relevance strength. */
export interface Signal {
  /** Vault key of the page this signal is about. */
  page: string;
  /** Human-readable reason for the signal. */
  reason: string;
  /** Computed strength (decayed, updated on each event). */
  strength: number;
  /** ISO-8601 UTC timestamp of last event. */
  updatedAt: string;
  /** Total number of write+read events. */
  eventCount: number;
}

/** Persisted signals index. Stored at tenant root as .signals.json. */
interface SignalsIndex {
  signals: Record<string, Signal>;
  lastChecked: string; // ISO-8601
}

const SIGNALS_FILENAME = ".signals.json";

function isOlderThanDays(isoDate: string, days: number): boolean {
  const updated = new Date(isoDate).getTime();
  const now = Date.now();
  const msPerDay = 1000 * 60 * 60 * 24;
  return (now - updated) / msPerDay > days;
}

function daysSince(isoDate: string): number {
  const updated = new Date(isoDate).getTime();
  const now = Date.now();
  const msPerDay = 1000 * 60 * 60 * 24;
  return (now - updated) / msPerDay;
}

/** Load .signals.json, creating a default if missing. */
async function loadIndex(tenantRoot: string): Promise<SignalsIndex> {
  const path = join(tenantRoot, SIGNALS_FILENAME);
  try {
    const raw = await fs.readFile(path, "utf8");
    return JSON.parse(raw) as SignalsIndex;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Default lastChecked to epoch 0 so any new signal is visible on first getSignals().
      // Agent must call markChecked() to advance lastChecked to "now" after consuming.
      return { signals: {}, lastChecked: "1970-01-01T00:00:00.000Z" };
    }
    throw err;
  }
}

/** Atomically save .signals.json via tmp+rename. */
async function saveIndex(tenantRoot: string, idx: SignalsIndex): Promise<void> {
  const path = join(tenantRoot, SIGNALS_FILENAME);
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(idx, null, 2), "utf8");
  await fs.rename(tmp, path);
}

/** Read the signals index from disk (bypasses in-memory cache). */
async function readIndex(tenantRoot: string): Promise<SignalsIndex> {
  const path = join(tenantRoot, SIGNALS_FILENAME);
  const raw = await fs.readFile(path, "utf8");
  return JSON.parse(raw) as SignalsIndex;
}

/** Compute decayed strength for a signal. */
function decayed(signal: Signal): number {
  const d = daysSince(signal.updatedAt);
  if (d < 1) return signal.strength;
  const decayed = signal.strength * Math.pow(0.5, d);
  return Math.max(0.01, decayed);
}

export class SignalDetector {
  private root: string;
  private tenantId: string;
  private tenantRoot: string;
  private idx!: SignalsIndex;
  private dirty = false;

  /**
   * @param root — vault root (tenant shards live at {root}/{tenantId}/)
   * @param tenantId — tenant identifier
   */
  constructor(root: string, tenantId: string) {
    this.root = root;
    this.tenantId = tenantId;
    this.tenantRoot = join(root, tenantId);
  }

  /** Lazily load the index. Called before any read/write operation. */
  private async ensure(): Promise<SignalsIndex> {
    if (!this.idx) {
      await fs.mkdir(this.tenantRoot, { recursive: true });
      this.idx = await loadIndex(this.tenantRoot);
    }
    return this.idx;
  }

  /**
   * Record a vault write to a page. Call after a successful vault write.
   * @param key — vault key of the written page
   * @param reason — optional human-readable reason override
   */
  async recordWrite(key: string, reason?: string): Promise<void> {
    const idx = await this.ensure();
    const existing = idx.signals[key];
    const now = new Date().toISOString();

    if (!existing) {
      idx.signals[key] = {
        page: key,
        reason: reason ?? `written: new page`,
        strength: 1.0,
        updatedAt: now,
        eventCount: 1,
      };
    } else {
      idx.signals[key] = {
        ...existing,
        strength: existing.strength + 0.5,
        updatedAt: now,
        eventCount: existing.eventCount + 1,
        reason: reason ?? `written: updated ${existing.eventCount + 1} times`,
      };
    }

    this.dirty = true;
    await this.saveIfDirty();
  }

  /**
   * Record a vault read / reference of a page. Call when an agent reads a page.
   * @param key — vault key of the read page
   */
  async recordRead(key: string): Promise<void> {
    const idx = await this.ensure();
    const existing = idx.signals[key];
    const now = new Date().toISOString();

    if (!existing) {
      idx.signals[key] = {
        page: key,
        reason: "referenced by agent",
        strength: 0.3,
        updatedAt: now,
        eventCount: 1,
      };
    } else {
      idx.signals[key] = {
        ...existing,
        strength: existing.strength + 0.3,
        updatedAt: now,
        eventCount: existing.eventCount + 1,
        reason: "referenced by agent",
      };
    }

    this.dirty = true;
    await this.saveIfDirty();
  }

  /**
   * Get signals that are new or stronger since the last call to markChecked().
   * Applies decay to all signals before filtering.
   *
   * @param limit — maximum number of signals to return (default 10)
   */
  async getSignals(limit = 10): Promise<Signal[]> {
    const idx = await this.ensure();
    const lastChecked = new Date(idx.lastChecked).getTime();
    const now = Date.now();

    const results: Signal[] = [];

    for (const signal of Object.values(idx.signals)) {
      // Apply decay
      const d = daysSince(signal.updatedAt);
      const currentStrength = d < 1 ? signal.strength : signal.strength * Math.pow(0.5, d);

      // Skip if below visibility threshold
      if (currentStrength < 1.0) continue;

      // Skip if not updated since lastChecked
      const updatedAt = new Date(signal.updatedAt).getTime();
      if (updatedAt <= lastChecked) continue;

      results.push({ ...signal, strength: currentStrength });
    }

    return results
      .sort((a, b) => b.strength - a.strength)
      .slice(0, limit);
  }

  /**
   * Mark the current time as "last checked" — subsequent getSignals() calls
   * will only return signals updated after this point.
   */
  async markChecked(): Promise<void> {
    const idx = await this.ensure();
    idx.lastChecked = new Date().toISOString();
    this.dirty = true;
    await this.saveIfDirty();
  }

  /**
   * Get the last-checked timestamp.
   */
  async lastChecked(): Promise<string> {
    const idx = await this.ensure();
    return idx.lastChecked;
  }

  /**
   * Remove signals with strength below threshold.
   * Reads fresh state from disk to capture any external modifications.
   * @param threshold — minimum strength to keep (default 1.0)
   */
  async prune(threshold = 1.0): Promise<number> {
    // Re-read from disk to get any externally-written changes
    this.idx = await readIndex(this.tenantRoot);
    this.dirty = false;
    const before = Object.keys(this.idx.signals).length;

    for (const [key, signal] of Object.entries(this.idx.signals)) {
      const d = daysSince(signal.updatedAt);
      const current = d < 1 ? signal.strength : signal.strength * Math.pow(0.5, d);
      if (current < threshold) {
        delete this.idx.signals[key];
      }
    }

    const after = Object.keys(this.idx.signals).length;
    this.dirty = true;
    await this.saveIfDirty();
    return before - after;
  }

  /**
   * Force-persist any dirty state to disk.
   */
  async flush(): Promise<void> {
    if (this.dirty) {
      await this.saveIfDirty();
    }
  }

  private async saveIfDirty(): Promise<void> {
    if (this.dirty && this.idx) {
      await saveIndex(this.tenantRoot, this.idx);
      this.dirty = false;
    }
  }
}
