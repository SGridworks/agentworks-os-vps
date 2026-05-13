/**
 * Vault ingest — deterministic substrate for the vault-ingest skill.
 *
 * The skill itself is mostly synthesis: read a source, decide which entities
 * and concepts matter, write summary text, choose targets. That stays an
 * agent's job. What the substrate provides is the mechanical scaffolding the
 * agent leans on every time:
 *
 *   - slug derivation from file path or URL
 *   - source-summary frontmatter rendering
 *   - log.md prepend (new entries at the top, atomic)
 *   - ingest-or-skip orchestration backed by .manifest.json hashes
 *
 * Run pattern:
 *
 *   const decision = await planIngest(root, tenantId, sourcePath, content);
 *   if (decision.action === "skip") return;
 *   // ... agent writes summary, entity, concept pages ...
 *   await recordIngest(root, tenantId, {
 *     sourcePath, contentHash: decision.contentHash,
 *     pagesCreated, pagesUpdated, summary: "Key insight in one sentence.",
 *   });
 */

import { promises as fs } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import {
  loadManifest,
  saveManifest,
  setEntry,
  isUnchanged,
  sha256OfContent,
} from "./manifest.js";

export const LOG_FILENAME = "log.md";

export interface IngestPlan {
  action: "ingest" | "skip";
  reason: string;
  contentHash: string;
  /** Suggested slug derived from sourcePath. */
  slug: string;
}

export interface IngestRecord {
  sourcePath: string;
  contentHash: string;
  pagesCreated: string[];
  pagesUpdated: string[];
  /** One-sentence summary written into log.md. */
  summary: string;
  /** Override for the title shown in log.md. Defaults to slug. */
  title?: string;
  /** Override for the date prefix on the log entry. Defaults to now (UTC date). */
  date?: string;
}

export interface SourceFrontmatter {
  title: string;
  tags?: string[];
  created?: string;
  updated?: string;
  /** Wikilink-formatted source paths, e.g. ["[[raw-sources/articles/foo.md]]"]. */
  sources?: string[];
  /** Free-form additional fields rendered as `key: value`. */
  extra?: Record<string, string>;
}

const SLUG_MAX = 80;

/**
 * Slug from a vault-relative path. Strips extension, lowercases, replaces
 * non-alphanumeric runs with hyphens, trims leading/trailing hyphens, caps
 * length. Two different paths can collide on slug — agents handle that
 * (date-suffix, parent-prefix); substrate just gives the canonical form.
 */
export function slugFromPath(path: string): string {
  const ext = extname(path);
  const stem = basename(path, ext);
  return slugify(stem);
}

/**
 * Slug from a URL — uses the last non-empty path segment, falling back to
 * the host if the path is empty. Query string and fragment are dropped.
 */
export function slugFromUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return slugify(url);
  }
  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);
  const tail = segments[segments.length - 1];
  if (tail) {
    const ext = extname(tail);
    return slugify(ext ? tail.slice(0, tail.length - ext.length) : tail);
  }
  return slugify(parsed.hostname);
}

function slugify(input: string): string {
  const lowered = input.toLowerCase();
  const hyphenated = lowered.replace(/[^a-z0-9]+/g, "-");
  const trimmed = hyphenated.replace(/^-+|-+$/g, "");
  return trimmed.slice(0, SLUG_MAX);
}

/**
 * Render a YAML frontmatter block for a source summary. Wraps title in
 * double quotes; lists serialize as inline arrays. Trailing newline so the
 * caller can concatenate body content directly.
 */
export function renderSourceFrontmatter(fm: SourceFrontmatter): string {
  const lines: string[] = ["---"];
  lines.push(`title: ${quoteYaml(fm.title)}`);
  if (fm.tags && fm.tags.length > 0) {
    lines.push(`tags: [${fm.tags.map((t) => quoteYaml(t)).join(", ")}]`);
  }
  if (fm.created) lines.push(`created: ${fm.created}`);
  if (fm.updated) lines.push(`updated: ${fm.updated}`);
  if (fm.sources && fm.sources.length > 0) {
    lines.push("sources:");
    for (const s of fm.sources) lines.push(`  - ${quoteYaml(s)}`);
  }
  if (fm.extra) {
    for (const [k, v] of Object.entries(fm.extra)) lines.push(`${k}: ${quoteYaml(v)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

function quoteYaml(value: string): string {
  if (/^[A-Za-z0-9_./[\]\-]+$/.test(value) && !value.startsWith("-")) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * Plan an ingest for the given source. Hashes the content, checks the
 * manifest, and returns either "skip" (already ingested unchanged) or
 * "ingest" with the hash and slug for the agent to use.
 */
export async function planIngest(
  root: string,
  tenantId: string,
  sourcePath: string,
  content: string | Buffer,
): Promise<IngestPlan> {
  const contentHash = sha256OfContent(content);
  const manifest = await loadManifest(root, tenantId);
  const slug = slugFromPath(sourcePath);
  if (isUnchanged(manifest, sourcePath, contentHash)) {
    return {
      action: "skip",
      reason: "Already ingested at this hash",
      contentHash,
      slug,
    };
  }
  return {
    action: "ingest",
    reason: "New source or content changed since last ingest",
    contentHash,
    slug,
  };
}

/**
 * Persist an ingest result: update the manifest entry, prepend a log entry.
 * Idempotent — re-running with the same hash overwrites the manifest entry
 * (kept for ingestedAt freshness) and appends another log entry.
 */
export async function recordIngest(
  root: string,
  tenantId: string,
  record: IngestRecord,
): Promise<void> {
  const manifest = await loadManifest(root, tenantId);
  const updated = setEntry(manifest, record.sourcePath, {
    hash: record.contentHash,
    pagesCreated: record.pagesCreated,
    pagesUpdated: record.pagesUpdated,
  });
  await saveManifest(root, tenantId, updated);
  await prependLogEntry(root, tenantId, record);
}

/**
 * Prepend an entry to log.md (new entries land at the top, per the
 * vault-ingest skill contract). Atomic: writes via tmp file + rename.
 */
export async function prependLogEntry(
  root: string,
  tenantId: string,
  record: IngestRecord,
): Promise<void> {
  const date = record.date ?? new Date().toISOString().slice(0, 10);
  const title = record.title ?? record.sourcePath;
  const lines: string[] = [];
  lines.push(`## [${date}] ingest | ${title}`);
  lines.push(`- Source: ${record.sourcePath}`);
  if (record.pagesCreated.length > 0) {
    lines.push(`- Pages created: ${record.pagesCreated.map(wikilink).join(", ")}`);
  }
  if (record.pagesUpdated.length > 0) {
    lines.push(`- Pages updated: ${record.pagesUpdated.map(wikilink).join(", ")}`);
  }
  lines.push(`- Key insight: ${record.summary}`);
  const block = `${lines.join("\n")}\n\n`;

  const path = join(root, tenantId, LOG_FILENAME);
  await fs.mkdir(dirname(path), { recursive: true });
  let existing = "";
  try {
    existing = await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const next = block + existing;
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, next, "utf8");
  await fs.rename(tmp, path);
}

function wikilink(target: string): string {
  return `[[${target}]]`;
}
