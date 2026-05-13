/**
 * Vault save — deterministic substrate for the vault-save skill.
 *
 * The skill itself is mostly synthesis: scan the conversation, decide what's
 * worth keeping, pick the right note type, write declarative prose. That stays
 * an agent's job. Substrate provides the mechanical pieces:
 *
 *   - note-type → folder routing
 *   - per-type frontmatter rendering (decision adds decision_date/status, ...)
 *   - kebab-case filename derivation
 *   - vault-relative key for the file vault store
 *   - log.md prepend (newest at top), Decision-Log.md / Action-Tracker.md
 *     append helpers
 *
 * The agent constructs a NoteSpec, calls saveNote, and gets back the key for
 * follow-up writes. The append helpers are independent so quick-log entries
 * (no full wiki page) can land directly.
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { slugFromPath } from "./ingest.js";

export type NoteType = "synthesis" | "concept" | "summary" | "decision" | "session";

export const DECISION_LOG_FILENAME = "Decision-Log.md";
export const ACTION_TRACKER_FILENAME = "Action-Tracker.md";
export const VAULT_LOG_FILENAME = "log.md";

const ACTION_TRACKER_HEADER = `| Action | Owner | Due | Source | Status |\n| --- | --- | --- | --- | --- |\n`;

export interface NoteSpec {
  /** Human-facing title; also drives the default filename slug. */
  title: string;
  type: NoteType;
  /** Markdown body. Caller writes prose; substrate writes frontmatter + body. */
  body: string;
  tags?: string[];
  /** Wiki pages this note references — emitted as `related:` frontmatter. */
  related?: string[];
  /** For type=summary, source markdown wikilinks ("[[raw-sources/...]]"). */
  sources?: string[];
  /** For type=decision, ISO date the decision was made. Defaults to today. */
  decisionDate?: string;
  /** For type=decision, lifecycle: active, superseded, retired. Default: active. */
  status?: "active" | "superseded" | "retired";
  /** Override for the kebab-case filename slug. Defaults to slugFromPath(title). */
  slug?: string;
  /** Override for the created/updated date. Defaults to today (UTC). */
  date?: string;
}

export interface SaveResult {
  /** Vault-relative key, e.g. "wiki/concepts/great-idea.md". */
  key: string;
  /** Absolute filesystem path written. */
  absPath: string;
  /** Final slug used. */
  slug: string;
}

export interface DecisionLogEntry {
  title: string;
  context: string;
  decision: string;
  rationale: string;
  source?: string;
  date?: string;
}

export interface ActionTrackerEntry {
  action: string;
  owner: string;
  due?: string;
  source?: string;
  status?: "open" | "in_progress" | "done" | "blocked";
}

export function noteFolder(type: NoteType): string {
  switch (type) {
    case "synthesis":
    case "concept":
      return "wiki/concepts";
    case "summary":
    case "session":
      return "wiki/summaries";
    case "decision":
      return "wiki/decisions";
  }
}

export function renderNoteFrontmatter(spec: NoteSpec): string {
  const today = spec.date ?? new Date().toISOString().slice(0, 10);
  const lines: string[] = ["---"];
  lines.push(`title: ${quoteYaml(spec.title)}`);
  lines.push(`type: ${spec.type}`);
  if (spec.tags && spec.tags.length > 0) {
    lines.push(`tags: [${spec.tags.map(quoteYaml).join(", ")}]`);
  }
  lines.push(`created: ${today}`);
  lines.push(`updated: ${today}`);
  if (spec.sources && spec.sources.length > 0) {
    lines.push("sources:");
    for (const s of spec.sources) lines.push(`  - ${quoteYaml(s)}`);
  } else if (spec.type === "summary") {
    lines.push("sources: []");
  }
  if (spec.related && spec.related.length > 0) {
    lines.push("related:");
    for (const r of spec.related) lines.push(`  - ${quoteYaml(r)}`);
  }
  if (spec.type === "decision") {
    lines.push(`decision_date: ${spec.decisionDate ?? today}`);
    lines.push(`status: ${spec.status ?? "active"}`);
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
 * Persist a note into the tenant's vault. Writes the file atomically via
 * tmp+rename, prepends a log.md entry. Returns the key so callers can chain
 * follow-up writes (index.md, hot.md, related-page edits).
 *
 * Re-saving the same slug overwrites the file. Re-save is idempotent — the
 * agent decides whether to call it; substrate doesn't deduplicate by content.
 */
export async function saveNote(
  root: string,
  tenantId: string,
  spec: NoteSpec,
): Promise<SaveResult> {
  const slug = spec.slug ?? slugFromPath(spec.title);
  const folder = noteFolder(spec.type);
  const key = `${folder}/${slug}.md`;
  const absPath = join(root, tenantId, key);

  const body = spec.body.endsWith("\n") ? spec.body : `${spec.body}\n`;
  const text = `${renderNoteFrontmatter({ ...spec, slug })}${body}`;

  await atomicWrite(absPath, text);
  const logEntry: SaveLogEntry = {
    title: spec.title,
    type: spec.type,
    location: key,
  };
  if (spec.date) logEntry.date = spec.date;
  await prependSaveLogEntry(root, tenantId, logEntry);

  return { key, absPath, slug };
}

interface SaveLogEntry {
  title: string;
  type: NoteType;
  location: string;
  date?: string;
}

async function prependSaveLogEntry(
  root: string,
  tenantId: string,
  entry: SaveLogEntry,
): Promise<void> {
  const date = entry.date ?? new Date().toISOString().slice(0, 10);
  const block = [
    `## [${date}] save | ${entry.title}`,
    `- Type: ${entry.type}`,
    `- Location: ${entry.location}`,
    "",
    "",
  ].join("\n");

  const path = join(root, tenantId, VAULT_LOG_FILENAME);
  await fs.mkdir(dirname(path), { recursive: true });
  let existing = "";
  try {
    existing = await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await atomicWriteText(path, block + existing);
}

export async function appendDecisionLogEntry(
  root: string,
  tenantId: string,
  entry: DecisionLogEntry,
): Promise<void> {
  const date = entry.date ?? new Date().toISOString().slice(0, 10);
  const block = [
    `## [${date}] ${entry.title}`,
    "",
    `**Context:** ${entry.context}`,
    `**Decision:** ${entry.decision}`,
    `**Rationale:** ${entry.rationale}`,
    entry.source ? `**Source:** ${entry.source}` : null,
    "",
    "",
  ]
    .filter((l): l is string => l !== null)
    .join("\n");

  const path = join(root, tenantId, DECISION_LOG_FILENAME);
  await fs.mkdir(dirname(path), { recursive: true });
  let existing = "";
  try {
    existing = await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    existing = "# Decision Log\n\n";
  }
  if (existing === "") existing = "# Decision Log\n\n";
  await atomicWriteText(path, `${existing}${block}`);
}

export async function appendActionTrackerEntry(
  root: string,
  tenantId: string,
  entry: ActionTrackerEntry,
): Promise<void> {
  const path = join(root, tenantId, ACTION_TRACKER_FILENAME);
  await fs.mkdir(dirname(path), { recursive: true });
  let existing: string;
  try {
    existing = await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    existing = `# Action Tracker\n\n${ACTION_TRACKER_HEADER}`;
  }
  if (!existing.includes("| Action |")) {
    existing = existing
      ? `${existing.replace(/\n+$/, "")}\n\n${ACTION_TRACKER_HEADER}`
      : `# Action Tracker\n\n${ACTION_TRACKER_HEADER}`;
  }
  const row = `| ${escapeCell(entry.action)} | ${escapeCell(entry.owner)} | ${escapeCell(entry.due ?? "")} | ${escapeCell(entry.source ?? "")} | ${escapeCell(entry.status ?? "open")} |\n`;
  const next = existing.endsWith("\n") ? existing + row : `${existing}\n${row}`;
  await atomicWriteText(path, next);
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

async function atomicWrite(absPath: string, content: string): Promise<void> {
  await fs.mkdir(dirname(absPath), { recursive: true });
  await atomicWriteText(absPath, content);
}

async function atomicWriteText(absPath: string, content: string): Promise<void> {
  const tmp = `${absPath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, absPath);
}
