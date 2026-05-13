/**
 * FileVaultStore — markdown files on disk under <root>/<tenantId>/<key>.md.
 *
 * Tenant isolation is enforced two ways:
 *   - The file path always starts with the tenant directory.
 *   - VaultKey schema rejects `..` and absolute paths, so a malicious
 *     key cannot escape the tenant subtree.
 *
 * `replace` writes to a temp file then renames over the target so a
 * partial write never lands on the read path. `append` adds a
 * timestamp-headed block. Parent directories are created lazily; missing
 * keys read as empty (existed = false).
 */

import { promises as fs } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createHash } from "node:crypto";
import {
  VaultKeySchema,
  type VaultKey,
  type VaultPage,
  type VaultReadResult,
  type VaultStore,
  type VaultWriteOptions,
  type VaultWriteResult,
} from "./types.js";

const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

interface Frontmatter {
  summary?: string;
  trigger?: string;
  detail_key?: string;
  authoringAgent?: string;
  lastUpdatedBy?: string;
  lastUpdatedAt?: string;
  lastUsedBy?: Array<{ agentId: string; usedAt: string }>;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Parse YAML frontmatter from a markdown body.
 * Returns { frontmatter, body } where frontmatter fields are extracted
 * and body is the content after the closing `---`.
 */
function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const fm: Frontmatter = {};
  if (!raw.startsWith("---")) {
    return { frontmatter: fm, body: raw };
  }
  const endIdx = raw.indexOf("\n---", 3);
  if (endIdx === -1) {
    return { frontmatter: fm, body: raw };
  }
  const yamlBlock = raw.slice(4, endIdx);
  const body = raw.slice(endIdx + 4); // skip "\n---"
  for (const line of yamlBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key === "summary") fm.summary = value;
    else if (key === "trigger") fm.trigger = value;
    else if (key === "detail_key") fm.detail_key = value;
    else if (key === "authoringAgent") fm.authoringAgent = value;
    else if (key === "lastUpdatedBy") fm.lastUpdatedBy = value;
    else if (key === "lastUpdatedAt") fm.lastUpdatedAt = value;
    else if (key === "lastUsedBy") {
      try {
        fm.lastUsedBy = JSON.parse(value);
      } catch {
        // If JSON parsing fails, skip this field
      }
    }
  }
  return { frontmatter: fm, body };
}

/**
 * Serialize frontmatter + body into a markdown string with YAML frontmatter block.
 */
function serializeFrontmatter(
  frontmatter: Frontmatter,
  body: string,
): string {
  const lines: string[] = ["---"];
  if (frontmatter.summary !== undefined) {
    lines.push(`summary: ${frontmatter.summary}`);
  }
  if (frontmatter.trigger !== undefined) {
    lines.push(`trigger: ${frontmatter.trigger}`);
  }
  if (frontmatter.detail_key !== undefined) {
    lines.push(`detail_key: ${frontmatter.detail_key}`);
  }
  if (frontmatter.authoringAgent !== undefined) {
    lines.push(`authoringAgent: ${frontmatter.authoringAgent}`);
  }
  if (frontmatter.lastUpdatedBy !== undefined) {
    lines.push(`lastUpdatedBy: ${frontmatter.lastUpdatedBy}`);
  }
  if (frontmatter.lastUpdatedAt !== undefined) {
    lines.push(`lastUpdatedAt: ${frontmatter.lastUpdatedAt}`);
  }
  if (frontmatter.lastUsedBy !== undefined) {
    lines.push(`lastUsedBy: ${JSON.stringify(frontmatter.lastUsedBy)}`);
  }
  if (
    frontmatter.summary === undefined &&
    frontmatter.trigger === undefined &&
    frontmatter.detail_key === undefined &&
    frontmatter.authoringAgent === undefined &&
    frontmatter.lastUpdatedBy === undefined &&
    frontmatter.lastUpdatedAt === undefined &&
    frontmatter.lastUsedBy === undefined
  ) {
    return body;
  }
  lines.push("---");
  return lines.join("\n") + "\n" + body;
}

/**
 * Thrown when a vault write exceeds the per-key size limit.
 */
export class MemoryKeyTooLargeError extends Error {
  readonly code = "KEY_TOO_LARGE" as const;
  readonly limitBytes: number;
  readonly actualBytes: number;
  constructor(limitBytes: number, actualBytes: number) {
    super(
      `Vault key too large (${actualBytes} bytes). Limit is ${limitBytes} bytes. ` +
        `Suggestion: split into parts (e.g., key/part-01, key/part-02).`,
    );
    this.name = "MemoryKeyTooLargeError";
    this.limitBytes = limitBytes;
    this.actualBytes = actualBytes;
  }
}

/**
 * Thrown when a vault write hits ENOSPC. Carries the path the caller was
 * trying to land at so the operator can investigate which mount filled up.
 */
export class DiskFullError extends Error {
  readonly code = "ENOSPC" as const;
  readonly path: string;
  readonly bytes: number;
  constructor(path: string, bytes: number, cause?: unknown) {
    super(`Disk full while writing ${path} (${bytes} bytes)`);
    this.name = "DiskFullError";
    this.path = path;
    this.bytes = bytes;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch {
    // best effort — caller already has bigger problems
  }
}

function validateKey(key: VaultKey): VaultKey {
  return VaultKeySchema.parse(key);
}

export interface FileVaultStoreOpts {
  root: string;
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES =
  Number(process.env.MEMORY_KEY_MAX_BYTES) || 32_768;

export class FileVaultStore implements VaultStore {
  private readonly root: string;
  private readonly maxBytes: number;

  constructor(opts: FileVaultStoreOpts) {
    this.root = opts.root;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  /**
   * Snapshot the entire tenant vault to a timestamped backup directory.
   * Uses hard links where possible to avoid copying all data.
   * @returns snapshotId — timestamp-based directory name under .snapshots/{tenantId}/
   */
  async snapshot(tenantId: string): Promise<string> {
    if (!tenantId || tenantId.includes("/") || tenantId.includes("..")) {
      throw new Error(`Invalid tenantId: ${tenantId}`);
    }
    const snapshotId = new Date().toISOString().replace(/[:.]/g, "-");
    const snapDir = join(this.root, ".snapshots", tenantId, snapshotId);
    const tenantDir = this.tenantDir(tenantId);

    await fs.mkdir(snapDir, { recursive: true });

    const manifest: Record<string, string> = {};

    // Copy all .md files from tenant dir to snapshot dir
    let entries: Array<{ name: string; isFile: () => boolean }> = [];
    try {
      const raw = await fs.readdir(tenantDir, { withFileTypes: true });
      entries = raw.map((e) => ({ name: e.name, isFile: () => e.isFile() }));
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw e;
      // Empty vault — create empty manifest
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const src = join(tenantDir, entry.name);
      const dst = join(snapDir, entry.name);
      try {
        // Hard-link for efficiency; fall back to copy if cross-device
        await fs.link(src, dst);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "EXDEV") {
          // Cross-device — copy instead
          const content = await fs.readFile(src);
          await fs.writeFile(dst, content);
        } else {
          throw e;
        }
      }
      const raw = await fs.readFile(join(tenantDir, entry.name), "utf8");
      const { body } = parseFrontmatter(raw);
      manifest[entry.name] = sha256Hex(body);
    }

    // Write snapshot manifest
    await fs.writeFile(
      join(snapDir, "snapshot-manifest.json"),
      JSON.stringify({ snapshotId, createdAt: new Date().toISOString(), pages: manifest }, null, 2),
      "utf8",
    );

    return snapshotId;
  }

  /**
   * Restore the tenant vault from a previously created snapshot.
   * WARNING: this overwrites all current vault content for the tenant.
   * @param tenantId — tenant to restore
   * @param snapshotId — snapshot ID returned by snapshot()
   */
  async restore(tenantId: string, snapshotId: string): Promise<void> {
    if (!tenantId || tenantId.includes("/") || tenantId.includes("..")) {
      throw new Error(`Invalid tenantId: ${tenantId}`);
    }
    if (!snapshotId || snapshotId.includes("..")) {
      throw new Error(`Invalid snapshotId: ${snapshotId}`);
    }
    const snapDir = join(this.root, ".snapshots", tenantId, snapshotId);
    const tenantDir = this.tenantDir(tenantId);

    // Verify snapshot exists
    const manifestPath = join(snapDir, "snapshot-manifest.json");
    let manifest: { pages: Record<string, string> };
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      manifest = JSON.parse(raw);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new Error(`Snapshot not found: ${snapshotId} for tenant ${tenantId}`);
      }
      throw e;
    }

    // Remove all current vault files
    let currentEntries: Array<{ name: string; isFile: () => boolean }> = [];
    try {
      const raw = await fs.readdir(tenantDir, { withFileTypes: true });
      currentEntries = raw.map((e) => ({ name: e.name, isFile: () => e.isFile() }));
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw e;
    }
    for (const entry of currentEntries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      await fs.unlink(join(tenantDir, entry.name));
    }

    // Restore files from snapshot
    for (const [filename] of Object.entries(manifest.pages)) {
      const src = join(snapDir, filename);
      const dst = join(tenantDir, filename);
      try {
        await fs.link(src, dst);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "EXDEV") {
          const content = await fs.readFile(src);
          await fs.writeFile(dst, content);
        } else {
          throw e;
        }
      }
    }
  }

  private tenantDir(tenantId: string): string {
    if (!tenantId || tenantId.includes("/") || tenantId.includes("..")) {
      throw new Error(`Invalid tenantId: ${tenantId}`);
    }
    return join(this.root, tenantId);
  }

  private pathFor(tenantId: string, key: VaultKey): string {
    if (!tenantId || tenantId.includes("/") || tenantId.includes("..")) {
      throw new Error(`Invalid tenantId: ${tenantId}`);
    }
    const validKey = validateKey(key);
    const filePath = join(this.root, tenantId, `${validKey}.md`);
    const tenantRoot = join(this.root, tenantId);
    const rel = relative(tenantRoot, filePath);
    if (rel.startsWith("..") || rel.startsWith("/")) {
      throw new Error(`Key escapes tenant subtree: ${key}`);
    }
    return filePath;
  }

  async list(tenantId: string): Promise<string[]> {
    const dir = this.tenantDir(tenantId);
    try {
      // Manual walk so symlinked directories (e.g. tenant's `wiki -> ../wiki`
      // and `memory -> ../memory`) are traversed. Node's
      // fs.readdir({ recursive: true }) does NOT descend into symlinks, which
      // hid shared wiki + operator memory from the graph route.
      const keys: string[] = [];
      const seen = new Set<string>(); // realpath dedup — cycle-safe
      const walk = async (current: string): Promise<void> => {
        const real = await fs.realpath(current).catch(() => current);
        if (seen.has(real)) return;
        seen.add(real);
        let entries: import("node:fs").Dirent[];
        try {
          entries = await fs.readdir(current, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = join(current, entry.name);
          let isDir = entry.isDirectory();
          let isFile = entry.isFile();
          if (entry.isSymbolicLink()) {
            try {
              const st = await fs.stat(full);
              isDir = st.isDirectory();
              isFile = st.isFile();
            } catch {
              continue;
            }
          }
          if (isDir) {
            await walk(full);
          } else if (isFile && entry.name.endsWith(".md")) {
            const rel = relative(dir, full);
            if (rel.startsWith("..") || rel.startsWith("/")) continue;
            const key = rel.replace(/\\/g, "/").replace(/\.md$/, "");
            keys.push(key);
          }
        }
      };
      await walk(dir);
      return keys.sort();
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return [];
      throw e;
    }
  }

  async read(tenantId: string, key: VaultKey): Promise<VaultReadResult> {
    const filePath = this.pathFor(tenantId, key);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const stats = await fs.stat(filePath);
      const { frontmatter, body } = parseFrontmatter(raw);
      return {
        tenantId,
        key,
        body,
        updatedAt: stats.mtime.toISOString(),
        sha256: sha256Hex(body),
        existed: true,
        summary: frontmatter.summary,
        trigger: frontmatter.trigger,
        detail_key: frontmatter.detail_key,
        authoringAgent: frontmatter.authoringAgent,
        lastUpdatedBy: frontmatter.lastUpdatedBy,
        lastUpdatedAt: frontmatter.lastUpdatedAt,
        lastUsedBy: frontmatter.lastUsedBy,
      };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return {
          tenantId,
          key,
          body: "",
          updatedAt: new Date(0).toISOString(),
          sha256: EMPTY_SHA256,
          existed: false,
        };
      }
      throw e;
    }
  }

  async write(
    tenantId: string,
    key: VaultKey,
    body: string,
    opts: VaultWriteOptions = {},
  ): Promise<VaultWriteResult> {
    const filePath = this.pathFor(tenantId, key);
    const mode = opts.mode ?? "replace";
    const bodyBytes = Buffer.byteLength(body, "utf8");

    if (bodyBytes > this.maxBytes) {
      throw new MemoryKeyTooLargeError(this.maxBytes, bodyBytes);
    }

    await fs.mkdir(dirname(filePath), { recursive: true });

    if (mode === "append") {
      const ts = new Date().toISOString();
      const block = `\n\n## ${ts}\n${body}\n`;
      try {
        await fs.appendFile(filePath, block, "utf8");
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOSPC") {
          throw new DiskFullError(
            filePath,
            Buffer.byteLength(block, "utf8"),
            err,
          );
        }
        throw e;
      }
    } else {
      // Merge frontmatter: preserve existing, update with opts
      let existingFm: Frontmatter = {};
      let existingBody = body;
      try {
        const raw = await fs.readFile(filePath, "utf8");
        const { frontmatter, body: existing } = parseFrontmatter(raw);
        existingFm = {
          ...(frontmatter.summary !== undefined && { summary: frontmatter.summary }),
          ...(frontmatter.trigger !== undefined && { trigger: frontmatter.trigger }),
          ...(frontmatter.detail_key !== undefined && { detail_key: frontmatter.detail_key }),
          ...(frontmatter.authoringAgent !== undefined && { authoringAgent: frontmatter.authoringAgent }),
          ...(frontmatter.lastUpdatedBy !== undefined && { lastUpdatedBy: frontmatter.lastUpdatedBy }),
          ...(frontmatter.lastUpdatedAt !== undefined && { lastUpdatedAt: frontmatter.lastUpdatedAt }),
          ...(frontmatter.lastUsedBy !== undefined && { lastUsedBy: frontmatter.lastUsedBy }),
        };
        existingBody = existing;
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw e;
        // File doesn't exist yet — nothing to preserve
      }

      // Handle lazy detail: write detail file and set detail_key
      let detail_key = existingFm.detail_key;
      if (opts.detail_body !== undefined) {
        detail_key = `detail-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const detailDir = join(this.root, tenantId, ".details");
        await fs.mkdir(detailDir, { recursive: true });
        const detailPath = join(detailDir, detail_key);
        await fs.writeFile(detailPath, opts.detail_body, "utf8");
      }

      // Build frontmatter — new opts override, undefined opts falls back to existing
      const fm: Frontmatter = {
        ...(existingFm.summary !== undefined && { summary: existingFm.summary }),
        ...(existingFm.trigger !== undefined && { trigger: existingFm.trigger }),
        ...(existingFm.detail_key !== undefined && { detail_key: existingFm.detail_key }),
        ...(existingFm.authoringAgent !== undefined && { authoringAgent: existingFm.authoringAgent }),
        ...(existingFm.lastUpdatedBy !== undefined && { lastUpdatedBy: existingFm.lastUpdatedBy }),
        ...(existingFm.lastUpdatedAt !== undefined && { lastUpdatedAt: existingFm.lastUpdatedAt }),
        ...(existingFm.lastUsedBy !== undefined && { lastUsedBy: existingFm.lastUsedBy }),
        ...(opts.summary !== undefined && { summary: opts.summary }),
        ...(opts.trigger !== undefined && { trigger: opts.trigger }),
        ...(detail_key !== undefined && { detail_key }),
        ...(opts.lastUsedBy !== undefined && { lastUsedBy: opts.lastUsedBy }),
      };
      const finalBody = serializeFrontmatter(fm, body);
      const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      try {
        await fs.writeFile(tempPath, finalBody, "utf8");
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        // Disk-full rescue: clean up the partial tmp before surfacing.
        await safeUnlink(tempPath);
        if (err.code === "ENOSPC") {
          throw new DiskFullError(
            filePath,
            Buffer.byteLength(finalBody, "utf8"),
            err,
          );
        }
        throw e;
      }
      try {
        await fs.rename(tempPath, filePath);
      } catch (e) {
        await safeUnlink(tempPath);
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOSPC") {
          throw new DiskFullError(
            filePath,
            Buffer.byteLength(finalBody, "utf8"),
            err,
          );
        }
        throw e;
      }
    }

    const raw = await fs.readFile(filePath, "utf8");
    const { body: contentBody, frontmatter: _fm } = parseFrontmatter(raw);
    const stats = await fs.stat(filePath);
    return {
      tenantId,
      key,
      bytesWritten: bodyBytes,
      updatedAt: stats.mtime.toISOString(),
      sha256: sha256Hex(contentBody),
    };
  }

  /**
   * Read lazy-loaded detail content by its key.
   * @param tenantId — tenant isolation enforced
   * @param detailKey — the detail_key from the vault page
   * @throws if detail file not found
   */
  async readDetail(tenantId: string, detailKey: string): Promise<string> {
    if (!tenantId || tenantId.includes("/") || tenantId.includes("..")) {
      throw new Error(`Invalid tenantId: ${tenantId}`);
    }
    // Sanitize detailKey — only allow safe characters
    if (!/^[a-zA-Z0-9_-]+$/.test(detailKey)) {
      throw new Error(`Invalid detailKey: ${detailKey}`);
    }
    const detailPath = join(this.root, tenantId, ".details", detailKey);
    // Enforce tenant isolation
    const rel = relative(join(this.root, tenantId), detailPath);
    if (rel.startsWith("..") || rel.startsWith("/")) {
      throw new Error(`detailKey escapes tenant subtree: ${detailKey}`);
    }
    try {
      return await fs.readFile(detailPath, "utf8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new Error(`Detail not found: ${detailKey}`);
      }
      throw e;
    }
  }

  /**
   * Delete a vault page and its associated detail file if present.
   */
  async delete(tenantId: string, key: VaultKey): Promise<void> {
    const filePath = this.pathFor(tenantId, key);
    // Read to check for detail_key
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const { frontmatter } = parseFrontmatter(raw);
      if (frontmatter.detail_key) {
        try {
          await fs.unlink(join(this.root, tenantId, ".details", frontmatter.detail_key));
        } catch {
          // best effort
        }
      }
    } catch {
      // ignore
    }
    try {
      await fs.unlink(filePath);
    } catch {
      // best effort
    }
  }
}

export function pageFromResult(r: VaultReadResult): VaultPage {
  const { existed: _existed, ...rest } = r;
  return rest;
}
