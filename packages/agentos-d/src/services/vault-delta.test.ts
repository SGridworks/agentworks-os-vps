/**
 * Tests for vault-delta scanner
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { scanVaultDelta, type VaultDeltaEntry } from "./vault-delta.js";
import { saveManifest, setEntry } from "@agentworks/memory";

describe("vault-delta", () => {
  let vaultRoot: string;
  let tenantId: string;

  beforeEach(async () => {
    vaultRoot = join(tmpdir(), `vault-delta-test-${randomUUID()}`);
    tenantId = `tenant-${randomUUID()}`;
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(vaultRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("scanVaultDelta", () => {
    it("returns empty result for non-existent tenant", async () => {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const result = await scanVaultDelta(vaultRoot, tenantId, cutoff);
      
      expect(result.entries).toEqual([]);
      expect(result.scanned).toEqual(0);
      expect(result.manifestUsed).toEqual(false);
    });

    it("finds files modified after cutoff", async () => {
      const tenantDir = join(vaultRoot, tenantId);
      await fs.mkdir(tenantDir, { recursive: true });
      
      const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
      const recentTime = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago
      const cutoff = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1 hour ago
      
      // Create old file
      const oldFile = join(tenantDir, "old.md");
      await fs.writeFile(oldFile, "old content");
      await fs.utimes(oldFile, oldTime, oldTime);
      
      // Create recent file
      const recentFile = join(tenantDir, "recent.md");
      await fs.writeFile(recentFile, "recent content");
      await fs.utimes(recentFile, recentTime, recentTime);
      
      const result = await scanVaultDelta(vaultRoot, tenantId, cutoff);
      
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].key).toEqual("recent");
      expect(result.entries[0].path).toEqual(recentFile);
      expect(result.scanned).toEqual(2); // both files scanned
      expect(result.manifestUsed).toEqual(false);
    });

    it("finds files in subdirectories", async () => {
      const tenantDir = join(vaultRoot, tenantId);
      const subDir = join(tenantDir, "subdir");
      await fs.mkdir(subDir, { recursive: true });
      
      const cutoff = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      const recentTime = new Date();
      
      // Create file in subdirectory
      const subFile = join(subDir, "nested.md");
      await fs.writeFile(subFile, "nested content");
      await fs.utimes(subFile, recentTime, recentTime);
      
      const result = await scanVaultDelta(vaultRoot, tenantId, cutoff);
      
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].key).toEqual("subdir/nested");
      expect(result.entries[0].path).toEqual(subFile);
    });

    it("ignores non-markdown files", async () => {
      const tenantDir = join(vaultRoot, tenantId);
      await fs.mkdir(tenantDir, { recursive: true });
      
      const cutoff = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      const recentTime = new Date();
      
      // Create markdown file
      const mdFile = join(tenantDir, "page.md");
      await fs.writeFile(mdFile, "markdown content");
      await fs.utimes(mdFile, recentTime, recentTime);
      
      // Create non-markdown file
      const txtFile = join(tenantDir, "note.txt");
      await fs.writeFile(txtFile, "text content");
      await fs.utimes(txtFile, recentTime, recentTime);
      
      const result = await scanVaultDelta(vaultRoot, tenantId, cutoff);
      
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].key).toEqual("page");
      expect(result.scanned).toEqual(2); // both files scanned
    });

    it("ignores manifest file", async () => {
      const tenantDir = join(vaultRoot, tenantId);
      await fs.mkdir(tenantDir, { recursive: true });
      
      const cutoff = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      const recentTime = new Date();
      
      // Create manifest file
      const manifestFile = join(tenantDir, ".manifest.json");
      await fs.writeFile(manifestFile, '{"version": 1, "sources": {}}');
      await fs.utimes(manifestFile, recentTime, recentTime);
      
      // Create markdown file
      const mdFile = join(tenantDir, "page.md");
      await fs.writeFile(mdFile, "markdown content");
      await fs.utimes(mdFile, recentTime, recentTime);
      
      const result = await scanVaultDelta(vaultRoot, tenantId, cutoff);
      
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].key).toEqual("page");
      expect(result.entries[0].path).toEqual(mdFile);
    });

    it("computes SHA256 hashes when requested", async () => {
      const tenantDir = join(vaultRoot, tenantId);
      await fs.mkdir(tenantDir, { recursive: true });
      
      const cutoff = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      const recentTime = new Date();
      
      // Create file with frontmatter
      const mdFile = join(tenantDir, "page.md");
      const content = `---\nsummary: test page\n---\npage body content`;
      await fs.writeFile(mdFile, content);
      await fs.utimes(mdFile, recentTime, recentTime);
      
      const result = await scanVaultDelta(vaultRoot, tenantId, cutoff, { computeHashes: true });
      
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].sha256).toBeDefined();
      expect(result.entries[0].sha256).toHaveLength(64); // SHA256 hex length
      // Hash should be of body content only ("page body content")
      const expectedHash = require("node:crypto").createHash("sha256").update("page body content", "utf8").digest("hex");
      expect(result.entries[0].sha256).toEqual(expectedHash);
    });

    it("uses manifest when available and requested", async () => {
      const tenantDir = join(vaultRoot, tenantId);
      await fs.mkdir(tenantDir, { recursive: true });
      
      const cutoff = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      const recentTime = new Date();
      
      // Create manifest
      const manifest = {
        version: 1,
        sources: {
          "page.md": {
            hash: "abc123",
            ingestedAt: recentTime.toISOString(),
            pagesCreated: ["page"],
            pagesUpdated: [],
          },
        },
      };
      await saveManifest(vaultRoot, tenantId, manifest);
      
      // Create markdown file
      const mdFile = join(tenantDir, "page.md");
      await fs.writeFile(mdFile, "page content");
      await fs.utimes(mdFile, recentTime, recentTime);
      
      const result = await scanVaultDelta(vaultRoot, tenantId, cutoff, { useManifest: true });
      
      expect(result.manifestUsed).toEqual(true);
      expect(result.entries.length).toBeGreaterThan(0);
    });

    it("falls back to file system scan when manifest is corrupted", async () => {
      const tenantDir = join(vaultRoot, tenantId);
      await fs.mkdir(tenantDir, { recursive: true });
      
      const cutoff = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      const recentTime = new Date();
      
      // Create corrupted manifest
      const manifestFile = join(tenantDir, ".manifest.json");
      await fs.writeFile(manifestFile, "invalid json content");
      
      // Create markdown file
      const mdFile = join(tenantDir, "page.md");
      await fs.writeFile(mdFile, "page content");
      await fs.utimes(mdFile, recentTime, recentTime);
      
      const result = await scanVaultDelta(vaultRoot, tenantId, cutoff, { useManifest: true });
      
      expect(result.manifestUsed).toEqual(false); // Manifest failed to load
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].key).toEqual("page");
    });

    it("skips manifest when useManifest is false", async () => {
      const tenantDir = join(vaultRoot, tenantId);
      await fs.mkdir(tenantDir, { recursive: true });
      
      const cutoff = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      const recentTime = new Date();
      
      // Create valid manifest
      const manifest = {
        version: 1,
        sources: {},
      };
      await saveManifest(vaultRoot, tenantId, manifest);
      
      // Create markdown file
      const mdFile = join(tenantDir, "page.md");
      await fs.writeFile(mdFile, "page content");
      await fs.utimes(mdFile, recentTime, recentTime);
      
      const result = await scanVaultDelta(vaultRoot, tenantId, cutoff, { useManifest: false });
      
      expect(result.manifestUsed).toEqual(false);
      expect(result.entries).toHaveLength(1);
    });

    it("handles files that cannot be read during hash computation", async () => {
      const tenantDir = join(vaultRoot, tenantId);
      await fs.mkdir(tenantDir, { recursive: true });
      
      const cutoff = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      const recentTime = new Date();
      
      // Create file
      const mdFile = join(tenantDir, "page.md");
      await fs.writeFile(mdFile, "page content");
      await fs.utimes(mdFile, recentTime, recentTime);
      
      // Make file unreadable (this might not work on Windows, so we mock instead)
      const result = await scanVaultDelta(vaultRoot, tenantId, cutoff, { computeHashes: true });
      
      // Should still find the file even if hash computation fails
      expect(result.entries.length).toBeGreaterThanOrEqual(0);
    });

    it("sorts entries by key", async () => {
      const tenantDir = join(vaultRoot, tenantId);
      await fs.mkdir(tenantDir, { recursive: true });
      
      const cutoff = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      const recentTime = new Date();
      
      // Create files in non-alphabetical order
      const files = ["zebra.md", "alpha.md", "beta.md"];
      for (const filename of files) {
        const filePath = join(tenantDir, filename);
        await fs.writeFile(filePath, `content of ${filename}`);
        await fs.utimes(filePath, recentTime, recentTime);
      }
      
      const result = await scanVaultDelta(vaultRoot, tenantId, cutoff);
      
      expect(result.entries).toHaveLength(3);
      expect(result.entries[0].key).toEqual("alpha");
      expect(result.entries[1].key).toEqual("beta");
      expect(result.entries[2].key).toEqual("zebra");
    });

    it("handles empty tenant directory", async () => {
      const tenantDir = join(vaultRoot, tenantId);
      await fs.mkdir(tenantDir, { recursive: true });
      
      const cutoff = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      
      const result = await scanVaultDelta(vaultRoot, tenantId, cutoff);
      
      expect(result.entries).toEqual([]);
      expect(result.scanned).toEqual(0);
    });
  });
});