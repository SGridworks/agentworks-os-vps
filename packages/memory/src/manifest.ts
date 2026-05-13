/**
 * Tenant-scoped ingest manifest — the delta tracker for vault-ingest.
 *
 * Each tenant's vault carries a `.manifest.json` at its root recording every
 * source file that's been ingested, the sha256 of its content at ingest time,
 * and which wiki pages were created / updated. Re-running ingest on an
 * unchanged source hits the manifest, sees the matching hash, and skips.
 *
 * Manifest shape (v1):
 *
 *   {
 *     "version": 1,
 *     "sources": {
 *       "raw-sources/articles/foo.md": {
 *         "hash": "abc...",
 *         "ingestedAt": "2026-04-28T...",
 *         "pagesCreated": ["wiki/summaries/foo.md"],
 *         "pagesUpdated": ["index.md"]
 *       }
 *     }
 *   }
 *
 * Atomic write: writes to <path>.tmp then renames over <path> so a partial
 * write never lands on the read path.
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

export const MANIFEST_FILENAME = ".manifest.json";
const MANIFEST_VERSION = 1;

export interface ManifestEntry {
  hash: string;
  ingestedAt: string;
  pagesCreated: string[];
  pagesUpdated: string[];
}

export interface Manifest {
  version: number;
  sources: Record<string, ManifestEntry>;
}

function emptyManifest(): Manifest {
  return { version: MANIFEST_VERSION, sources: {} };
}

function manifestPath(root: string, tenantId: string): string {
  return join(root, tenantId, MANIFEST_FILENAME);
}

export function sha256OfContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Load the manifest for a tenant. Returns an empty manifest if the file
 * doesn't exist; throws if the file exists but is unparseable (operator
 * needs to know about corruption rather than silently rebuild).
 */
export async function loadManifest(
  root: string,
  tenantId: string,
): Promise<Manifest> {
  const path = manifestPath(root, tenantId);
  try {
    const raw = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Manifest;
    // Tolerant of older shapes — coerce missing fields.
    return {
      version: parsed.version ?? MANIFEST_VERSION,
      sources: parsed.sources ?? {},
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyManifest();
    throw err;
  }
}

export function getEntry(
  manifest: Manifest,
  sourcePath: string,
): ManifestEntry | null {
  return manifest.sources[sourcePath] ?? null;
}

/**
 * Pure update: returns a new manifest with the entry merged in. The caller
 * persists via saveManifest. ingestedAt defaults to now.
 */
export function setEntry(
  manifest: Manifest,
  sourcePath: string,
  entry: Omit<ManifestEntry, "ingestedAt"> & { ingestedAt?: string },
): Manifest {
  return {
    ...manifest,
    sources: {
      ...manifest.sources,
      [sourcePath]: {
        hash: entry.hash,
        ingestedAt: entry.ingestedAt ?? new Date().toISOString(),
        pagesCreated: entry.pagesCreated,
        pagesUpdated: entry.pagesUpdated,
      },
    },
  };
}

export function removeEntry(manifest: Manifest, sourcePath: string): Manifest {
  if (!(sourcePath in manifest.sources)) return manifest;
  const next = { ...manifest.sources };
  delete next[sourcePath];
  return { ...manifest, sources: next };
}

/**
 * Has the source content changed since the last ingest? Returns true (changed)
 * if the source isn't tracked or the stored hash doesn't match the new hash.
 */
export function isUnchanged(
  manifest: Manifest,
  sourcePath: string,
  contentHash: string,
): boolean {
  const entry = getEntry(manifest, sourcePath);
  return entry !== null && entry.hash === contentHash;
}

/**
 * Persist the manifest atomically. Writes to <path>.tmp then renames over
 * <path>; an interrupted write never leaves a partial manifest in place.
 */
export async function saveManifest(
  root: string,
  tenantId: string,
  manifest: Manifest,
): Promise<void> {
  const path = manifestPath(root, tenantId);
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, path);
}
