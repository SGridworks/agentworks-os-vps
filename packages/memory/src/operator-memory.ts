/**
 * OperatorMemoryStore — read-only access to the operator's Claude Code
 * auto-memory directory (default ~/vault/memory/).
 *
 * Unlike FileVaultStore, this store is NOT tenant-scoped. The directory
 * holds the operator's own cross-project memory — preferences, feedback,
 * project status, references — and the same content is visible to any
 * AWOS tenant that asks for it.
 *
 * Read-only by design. AWOS agents must not write here; this is the
 * operator's source of truth and is owned by Claude Code.
 *
 * Each file is markdown with optional YAML frontmatter:
 *   ---
 *   name: …
 *   description: …
 *   type: user | feedback | project | reference
 *   ---
 *   <body>
 */

import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

const KEY_RE = /^[a-zA-Z0-9_\-./]+$/;

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export class OperatorMemoryError extends Error {
  readonly code: "INVALID_KEY" | "NOT_FOUND" | "OUTSIDE_ROOT";
  constructor(code: OperatorMemoryError["code"], message: string) {
    super(message);
    this.name = "OperatorMemoryError";
    this.code = code;
  }
}

export interface OperatorMemoryEntry {
  /** Filename without .md extension, e.g. "feedback-no-outbound-email-during-build". */
  key: string;
  /** Frontmatter `name`. */
  name?: string;
  /** Frontmatter `description` — used for relevance matching. */
  description?: string;
  /** Frontmatter `type` — user | feedback | project | reference. */
  type?: string;
  /** ISO-8601 mtime. */
  updatedAt: string;
  /** SHA-256 of full file body (frontmatter included). */
  sha256: string;
  bytes: number;
}

export interface OperatorMemoryRead extends OperatorMemoryEntry {
  /** Full file content including frontmatter. */
  raw: string;
  /** Body after the closing `---`, or full content if no frontmatter. */
  body: string;
  existed: boolean;
}

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  type?: string;
  body: string;
}

function parseFrontmatter(raw: string): ParsedFrontmatter {
  if (!raw.startsWith("---")) return { body: raw };
  const endIdx = raw.indexOf("\n---", 3);
  if (endIdx === -1) return { body: raw };
  const yaml = raw.slice(4, endIdx);
  const body = raw.slice(endIdx + 4).replace(/^\n/, "");
  const out: ParsedFrontmatter = { body };
  for (const line of yaml.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const k = line.slice(0, colonIdx).trim();
    const v = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (k === "name") out.name = v;
    else if (k === "description") out.description = v;
    else if (k === "type") out.type = v;
  }
  return out;
}

function validateKey(key: string): string {
  if (!KEY_RE.test(key)) {
    throw new OperatorMemoryError("INVALID_KEY", `key contains illegal chars: ${key}`);
  }
  if (key.startsWith("/") || key.includes("..") || key.includes("//")) {
    throw new OperatorMemoryError("INVALID_KEY", `key must not contain .. or leading /: ${key}`);
  }
  return key;
}

export interface OperatorMemoryStoreOpts {
  /** Defaults to $CLAUDE_CODE_MEMORY_ROOT or ~/vault/memory. */
  root?: string;
}

export class OperatorMemoryStore {
  private readonly root: string;

  constructor(opts: OperatorMemoryStoreOpts = {}) {
    const explicit = opts.root ?? process.env.CLAUDE_CODE_MEMORY_ROOT;
    this.root = resolve(explicit ?? join(homedir(), "vault", "memory"));
  }

  /**
   * List every .md file under the root with parsed frontmatter metadata.
   * Returns entries sorted by key. Hidden files (starting with .) are skipped.
   */
  async list(): Promise<OperatorMemoryEntry[]> {
    let names: string[] = [];
    try {
      names = await fs.readdir(this.root);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return [];
      throw e;
    }

    const entries: OperatorMemoryEntry[] = [];
    for (const name of names) {
      if (name.startsWith(".")) continue;
      if (!name.endsWith(".md")) continue;
      const path = join(this.root, name);
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(path);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;

      const raw = await fs.readFile(path, "utf8");
      const fm = parseFrontmatter(raw);
      entries.push({
        key: name.slice(0, -3),
        name: fm.name,
        description: fm.description,
        type: fm.type,
        updatedAt: stat.mtime.toISOString(),
        sha256: sha256Hex(raw),
        bytes: stat.size,
      });
    }

    entries.sort((a, b) => a.key.localeCompare(b.key));
    return entries;
  }

  /**
   * Read a single memory file by key (filename without .md). Throws on
   * invalid key or path-escape attempts. Returns existed=false with empty
   * body if the file does not exist (does not throw on missing).
   */
  async read(key: string): Promise<OperatorMemoryRead> {
    validateKey(key);
    const path = resolve(this.root, `${key}.md`);
    if (!path.startsWith(this.root + "/") && path !== this.root) {
      throw new OperatorMemoryError("OUTSIDE_ROOT", `resolved path escapes root: ${path}`);
    }

    try {
      const raw = await fs.readFile(path, "utf8");
      const stat = await fs.stat(path);
      const fm = parseFrontmatter(raw);
      return {
        key,
        name: fm.name,
        description: fm.description,
        type: fm.type,
        updatedAt: stat.mtime.toISOString(),
        sha256: sha256Hex(raw),
        bytes: raw.length,
        raw,
        body: fm.body,
        existed: true,
      };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return {
          key,
          updatedAt: new Date(0).toISOString(),
          sha256: sha256Hex(""),
          bytes: 0,
          raw: "",
          body: "",
          existed: false,
        };
      }
      throw e;
    }
  }
}
