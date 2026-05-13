/**
 * Hot cache — a tenant-scoped ~500-word recent-context summary.
 *
 * The vault stores `wiki/hot.md` per tenant. Sessions read it at start to
 * get recent context without crawling the full wiki. This module is the
 * typed I/O layer: parse, render, read, write. The content synthesis (what
 * goes IN the cache) stays a job for the agent — substrate just gives a
 * structured store with stable parse/render so two agents read the same
 * shape.
 *
 * Format (canonical):
 *
 *   ---
 *   type: meta
 *   title: "Hot Cache"
 *   updated: 2026-04-28T01:23:45Z
 *   ---
 *
 *   # Recent Context
 *
 *   ## Last Updated
 *   YYYY-MM-DD. [what happened]
 *
 *   ## Key Recent Facts
 *   - fact 1
 *   - fact 2
 *
 *   ## Recent Changes
 *   - Created: [[Page]]
 *
 *   ## Active Threads
 *   - thread description
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

export const HOT_CACHE_KEY = "wiki/hot.md";
const MAX_WORDS = 500;

export interface HotCache {
  updated: string; // ISO datetime
  lastUpdatedNote: string;
  keyFacts: string[];
  recentChanges: string[];
  activeThreads: string[];
}

export function emptyHotCache(now: Date = new Date()): HotCache {
  return {
    updated: now.toISOString(),
    lastUpdatedNote: "",
    keyFacts: [],
    recentChanges: [],
    activeThreads: [],
  };
}

const PLACEHOLDER = "(none recorded yet)";

function bulletLines(section: string): string[] {
  const lines = section.split("\n").map((l) => l.trim());
  return lines
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim())
    .filter((l) => l.length > 0 && l !== PLACEHOLDER);
}

function extractSection(body: string, heading: string): string {
  // Split on '## ' headings then find the one matching `heading`. Avoids
  // multi-line/lookahead quirks that bit an earlier regex implementation.
  const parts = body.split(/^## /m);
  for (const part of parts) {
    const newlineIdx = part.indexOf("\n");
    if (newlineIdx < 0) continue;
    const head = part.slice(0, newlineIdx).trim();
    if (head === heading) {
      return part.slice(newlineIdx + 1).trim();
    }
  }
  return "";
}

export function parseHotCache(text: string): HotCache {
  // Strip frontmatter
  let updated = new Date().toISOString();
  let body = text;
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fm) {
    const fmBody = fm[1] ?? "";
    body = fm[2] ?? "";
    const updatedMatch = fmBody.match(/^updated:\s*(.+)$/m);
    if (updatedMatch?.[1]) updated = updatedMatch[1].trim();
  }

  const lastUpdatedNote = extractSection(body, "Last Updated");
  const keyFacts = bulletLines(extractSection(body, "Key Recent Facts"));
  const recentChanges = bulletLines(extractSection(body, "Recent Changes"));
  const activeThreads = bulletLines(extractSection(body, "Active Threads"));

  return { updated, lastUpdatedNote, keyFacts, recentChanges, activeThreads };
}

export function renderHotCache(cache: HotCache): string {
  const facts = cache.keyFacts.length
    ? cache.keyFacts.map((f) => `- ${f}`).join("\n")
    : `- ${PLACEHOLDER}`;
  const changes = cache.recentChanges.length
    ? cache.recentChanges.map((c) => `- ${c}`).join("\n")
    : `- ${PLACEHOLDER}`;
  const threads = cache.activeThreads.length
    ? cache.activeThreads.map((t) => `- ${t}`).join("\n")
    : `- ${PLACEHOLDER}`;

  return [
    "---",
    "type: meta",
    'title: "Hot Cache"',
    `updated: ${cache.updated}`,
    "---",
    "",
    "# Recent Context",
    "",
    "## Last Updated",
    cache.lastUpdatedNote || "(no note)",
    "",
    "## Key Recent Facts",
    facts,
    "",
    "## Recent Changes",
    changes,
    "",
    "## Active Threads",
    threads,
    "",
  ].join("\n");
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

export function isOverWordBudget(cache: HotCache): boolean {
  return wordCount(renderHotCache(cache)) > MAX_WORDS;
}

function hotCachePath(root: string, tenantId: string): string {
  return join(root, tenantId, HOT_CACHE_KEY);
}

/**
 * Read the hot cache for a tenant. Returns an empty cache if the file is
 * missing, so callers can always render against a stable shape.
 */
export async function readHotCache(
  root: string,
  tenantId: string,
): Promise<HotCache> {
  const path = hotCachePath(root, tenantId);
  try {
    const text = await fs.readFile(path, "utf8");
    return parseHotCache(text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyHotCache();
    }
    throw err;
  }
}

/**
 * Atomically write the hot cache. Stamps `updated` to now if the caller
 * didn't override it, so a stale timestamp doesn't slip through.
 */
export async function writeHotCache(
  root: string,
  tenantId: string,
  cache: HotCache,
): Promise<void> {
  const stamped: HotCache = { ...cache, updated: cache.updated || new Date().toISOString() };
  const text = renderHotCache(stamped);
  const path = hotCachePath(root, tenantId);
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, path);
}
