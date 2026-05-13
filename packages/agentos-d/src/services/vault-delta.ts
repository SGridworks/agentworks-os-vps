/**
 * Vault edit delta query — scans <VAULT_ROOT>/<tenantId> for files modified
 * after a cutoff time, reading .manifest.json first when present.
 *
 * Used by morning-brief and other features that need to know what changed
 * in the vault since a given timestamp.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { loadManifest, MANIFEST_FILENAME } from "@agentworks/memory";

export interface VaultDeltaEntry {
  /** Vault key (without .md extension) */
  key: string;
  /** Absolute file path */
  path: string;
  /** File modification time as ISO string */
  modifiedAt: string;
  /** File size in bytes */
  sizeBytes: number;
  /** SHA256 of file content (body only, excluding frontmatter) */
  sha256?: string;
}

export interface VaultDeltaResult {
  /** Entries modified after the cutoff */
  entries: VaultDeltaEntry[];
  /** Total files scanned */
  scanned: number;
  /** Whether manifest was read and used */
  manifestUsed: boolean;
}

/**
 * Scan vault for files modified after cutoff, optionally using manifest for efficiency.
 * 
 * @param vaultRoot - Root vault directory (VAULT_ROOT env var)
 * @param tenantId - Tenant identifier
 * @param cutoff - ISO timestamp; only files modified after this are returned
 * @param opts.options - Scanning options
 * @returns Promise resolving to delta scan result
 */
export async function scanVaultDelta(
  vaultRoot: string,
  tenantId: string,
  cutoff: string,
  opts: {
    /** Whether to read manifest.json for efficiency (default: true) */
    useManifest?: boolean;
    /** Whether to compute SHA256 hashes (default: false) */
    computeHashes?: boolean;
  } = {},
): Promise<VaultDeltaResult> {
  const { useManifest = true, computeHashes = false } = opts;
  const tenantDir = join(vaultRoot, tenantId);
  
  let entries: VaultDeltaEntry[] = [];
  let scanned = 0;
  let manifestUsed = false;

  try {
    // Check if manifest exists before trying to use it
    const manifestPath = join(vaultRoot, tenantId, MANIFEST_FILENAME);
    let manifestExists = false;
    if (useManifest) {
      try {
        await fs.access(manifestPath);
        manifestExists = true;
      } catch {
        manifestExists = false;
      }
    }

    // Try to read manifest if it exists
    let manifest;
    if (useManifest && manifestExists) {
      try {
        manifest = await loadManifest(vaultRoot, tenantId);
        manifestUsed = true;
      } catch {
        // Manifest exists but is corrupted, fall back to file system scan
        manifestUsed = false;
      }
    }

    // Read all files in tenant directory recursively
    const files = await walkDirectory(tenantDir);
    scanned = files.length;

    const cutoffTime = new Date(cutoff);

    for (const file of files) {
      // Skip manifest and other non-markdown files
      if (file.name === MANIFEST_FILENAME || !file.name.endsWith(".md")) {
        continue;
      }

      const filePath = file.path;
      const stats = file.stats;
      
      // Check if file was modified after cutoff
      const modifiedTime = new Date(stats.mtime);
      if (modifiedTime <= cutoffTime) {
        continue;
      }

      // Extract vault key from path
      const relativePath = file.relativePath;
      const key = relativePath.replace(/\.md$/, "").replace(/\\/g, "/");

      const entry: VaultDeltaEntry = {
        key,
        path: filePath,
        modifiedAt: modifiedTime.toISOString(),
        sizeBytes: stats.size,
      };

      // Compute hash if requested
      if (computeHashes) {
        try {
          const content = await fs.readFile(filePath, "utf8");
          // Parse frontmatter to get just the body for hashing
          const bodyStart = content.indexOf("\n---\n");
          const body = bodyStart !== -1 ? content.slice(bodyStart + 5) : content;
          const { createHash } = await import("node:crypto");
          entry.sha256 = createHash("sha256").update(body, "utf8").digest("hex");
        } catch {
          // If we can't read/hash the file, skip it
          continue;
        }
      }

      entries.push(entry);
    }

  } catch (error) {
    // If tenant directory doesn't exist, return empty result
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw error;
    }
  }

  return {
    entries: entries.sort((a, b) => a.key.localeCompare(b.key)),
    scanned,
    manifestUsed,
  };
}

interface WalkedFile {
  name: string;
  path: string;
  relativePath: string;
  stats: import("node:fs").Stats;
}

/**
 * Walk directory recursively and return all files with stats
 */
async function walkDirectory(dir: string): Promise<WalkedFile[]> {
  const files: WalkedFile[] = [];
  
  async function walk(currentPath: string, currentRelative: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = join(currentPath, entry.name);
      const entryRelative = currentRelative ? `${currentRelative}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await walk(entryPath, entryRelative);
      } else if (entry.isFile()) {
        try {
          const stats = await fs.stat(entryPath);
          files.push({
            name: entry.name,
            path: entryPath,
            relativePath: entryRelative,
            stats,
          });
        } catch {
          // Skip files we can't stat
        }
      }
    }
  }

  await walk(dir, "");
  return files;
}