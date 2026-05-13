/**
 * Vault lint — mechanical health checks over a tenant's vault.
 *
 * Ports the deterministic subset of the vault-lint skill into a
 * typed module: orphan pages, dead wikilinks, frontmatter gaps, empty
 * sections, kebab-case filename violations. Semantic checks (stale claims,
 * missing cross-references, writing-style violations) stay an agent's job
 * — substrate provides the structure; agents do the synthesis.
 *
 * Run pattern:
 *
 *   const report = await lintVault(vaultRoot, tenantId, {
 *     requiredFrontmatter: ["title", "type"],
 *   });
 *   for (const f of report.findings) console.log(f.path, f.kind, f.message);
 */

import { promises as fs } from "node:fs";
import { join, relative, basename } from "node:path";

export type LintKind =
  | "orphan_page"
  | "dead_link"
  | "frontmatter_gap"
  | "empty_section"
  | "kebab_case_violation";

export type LintSeverity = "warn" | "info";

export interface LintFinding {
  kind: LintKind;
  severity: LintSeverity;
  path: string; // vault-relative
  message: string;
}

export interface LintReport {
  tenantId: string;
  ranAt: string;
  pageCount: number;
  findings: LintFinding[];
  totals: Record<LintKind, number>;
}

export interface LintOptions {
  /** Frontmatter fields a page must declare. Default: title, type. */
  requiredFrontmatter?: string[];
  /** Skip kebab-case checks for these basenames (e.g. README.md, index.md). */
  filenameWhitelist?: string[];
}

interface PageSnapshot {
  /** Absolute filesystem path. */
  absPath: string;
  /** Vault-relative path (relative to <root>/<tenantId>). */
  relPath: string;
  /** Filename without extension — used as wikilink target. */
  slug: string;
  /** Parsed frontmatter (top-level keys only). */
  frontmatter: Record<string, string>;
  /** Outbound wikilinks (the [[Target]] strings, unresolved). */
  outboundLinks: string[];
  /** Has a `## Heading` with no non-empty content under it. */
  emptySections: string[];
}

interface VaultSnapshot {
  pages: PageSnapshot[];
  /** slug → page paths that contain at least one wikilink to that slug. */
  inboundIndex: Map<string, string[]>;
}

const DEFAULT_REQUIRED_FRONTMATTER = ["title", "type"];
const DEFAULT_WHITELIST = ["README.md", "index.md", "log.md"];

// Walk a directory recursively, returning all .md files.
// Follows symbolic links (so the prod tenant's `wiki -> ../wiki` resolves
// the shared Obsidian wiki content). Cycle-safe via realpath dedup.
async function findMarkdownFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  async function walk(dir: string): Promise<void> {
    let real: string;
    try {
      real = await fs.realpath(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (seen.has(real)) return;
    seen.add(real);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // skip .manifest.json, .git, etc.
      const p = join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const st = await fs.stat(p);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue; // broken symlink
        }
      }
      if (isDir) await walk(p);
      else if (isFile && entry.name.endsWith(".md")) out.push(p);
    }
  }
  await walk(root);
  return out;
}

function parseFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fm) return { frontmatter: {}, body: text };
  const frontmatter: Record<string, string> = {};
  for (const line of (fm[1] ?? "").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (m && m[1]) frontmatter[m[1]] = (m[2] ?? "").trim();
  }
  return { frontmatter, body: fm[2] ?? "" };
}

function stripCodeBlocks(body: string): string {
  // Drop fenced ```...``` blocks and inline `code` spans before extracting
  // wikilinks. Doc/template files commonly contain example wikilinks like
  // [[page-name]] or [[project-slug]] inside fences; those aren't real links
  // and shouldn't surface as dead-link warnings.
  return body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`[^`\n]*`/g, "");
}

function extractWikilinks(body: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]\n]+)\]\]/g;
  let m: RegExpExecArray | null;
  const stripped = stripCodeBlocks(body);
  while ((m = re.exec(stripped)) !== null) {
    if (!m[1]) continue;
    // Stripping any "|alias" — wikilinks can be [[Target|alias]]
    const target = m[1].split("|")[0]?.trim() ?? "";
    if (target) out.push(target);
  }
  return out;
}

function findEmptyHeadings(body: string): string[] {
  const lines = body.split("\n");
  const headings: { idx: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]?.match(/^(#{1,6})\s+(.+)$/);
    if (m && m[2]) headings.push({ idx: i, text: m[2].trim() });
  }
  const empties: string[] = [];
  for (let h = 0; h < headings.length; h++) {
    const start = headings[h]!.idx + 1;
    const end = h + 1 < headings.length ? headings[h + 1]!.idx : lines.length;
    const between = lines.slice(start, end).filter((l) => l.trim().length > 0);
    if (between.length === 0) empties.push(headings[h]!.text);
  }
  return empties;
}

async function snapshotVault(root: string, tenantId: string): Promise<VaultSnapshot> {
  const tenantRoot = join(root, tenantId);
  const files = await findMarkdownFiles(tenantRoot);
  const pages: PageSnapshot[] = [];

  for (const absPath of files) {
    const relPath = relative(tenantRoot, absPath);
    const text = await fs.readFile(absPath, "utf8");
    const { frontmatter, body } = parseFrontmatter(text);
    pages.push({
      absPath,
      relPath,
      slug: basename(absPath, ".md"),
      frontmatter,
      outboundLinks: extractWikilinks(body),
      emptySections: findEmptyHeadings(body),
    });
  }

  // inboundIndex: which pages link to each slug
  const inboundIndex = new Map<string, string[]>();
  for (const page of pages) {
    for (const link of page.outboundLinks) {
      const list = inboundIndex.get(link) ?? [];
      list.push(page.relPath);
      inboundIndex.set(link, list);
    }
  }

  return { pages, inboundIndex };
}

function isKebabCase(name: string): boolean {
  // basename without extension; allow lowercase letters, digits, hyphens.
  // No uppercase, no underscores, no spaces, no leading/trailing/double hyphens.
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}

function newTotals(): Record<LintKind, number> {
  return {
    orphan_page: 0,
    dead_link: 0,
    frontmatter_gap: 0,
    empty_section: 0,
    kebab_case_violation: 0,
  };
}

export async function lintVault(
  root: string,
  tenantId: string,
  opts: LintOptions = {},
): Promise<LintReport> {
  const required = opts.requiredFrontmatter ?? DEFAULT_REQUIRED_FRONTMATTER;
  const whitelist = new Set(opts.filenameWhitelist ?? DEFAULT_WHITELIST);
  const snapshot = await snapshotVault(root, tenantId);
  const findings: LintFinding[] = [];
  const totals = newTotals();
  const pageSlugs = new Set(snapshot.pages.map((p) => p.slug));
  // Path-style targets: each page is reachable both by its bare slug
  // ([[profile]]) and by any unambiguous tail of its relPath
  // ([[me/profile]] or [[wiki/me/profile]]). Strip the .md extension and
  // normalize to forward slashes so wikilinks authored with either separator
  // resolve.
  const pagePaths = new Set<string>();
  for (const p of snapshot.pages) {
    const rel = p.relPath.replace(/\\/g, "/").replace(/\.md$/i, "");
    pagePaths.add(rel);
  }
  function resolves(link: string): boolean {
    if (pageSlugs.has(link)) return true;
    const norm = link.replace(/\\/g, "/").replace(/\.md$/i, "");
    if (pagePaths.has(norm)) return true;
    // Match in either direction:
    //   [[me/profile]] → wiki/me/profile.md (page path ends with link)
    //   [[<tenantId>/me/profile]] or [[wiki/me/profile]] → me/profile.md
    //     (link ends with page path — strips a prefix the author included)
    for (const path of pagePaths) {
      if (path === norm) return true;
      if (path.endsWith("/" + norm)) return true;
      if (norm.endsWith("/" + path)) return true;
    }
    return false;
  }

  for (const page of snapshot.pages) {
    // Orphan: no inbound wikilinks
    const inbound = snapshot.inboundIndex.get(page.slug) ?? [];
    if (inbound.length === 0 && !whitelist.has(basename(page.relPath))) {
      findings.push({
        kind: "orphan_page",
        severity: "info",
        path: page.relPath,
        message: `No inbound wikilinks point to [[${page.slug}]]`,
      });
      totals.orphan_page++;
    }

    // Dead links: outbound wikilinks that don't resolve to a page
    for (const link of page.outboundLinks) {
      if (!resolves(link)) {
        findings.push({
          kind: "dead_link",
          severity: "warn",
          path: page.relPath,
          message: `Wikilink [[${link}]] does not resolve to a vault page`,
        });
        totals.dead_link++;
      }
    }

    // Frontmatter gaps
    for (const field of required) {
      if (!page.frontmatter[field] || page.frontmatter[field] === "") {
        findings.push({
          kind: "frontmatter_gap",
          severity: "warn",
          path: page.relPath,
          message: `Missing required frontmatter field: ${field}`,
        });
        totals.frontmatter_gap++;
      }
    }

    // Empty sections
    for (const heading of page.emptySections) {
      findings.push({
        kind: "empty_section",
        severity: "info",
        path: page.relPath,
        message: `Heading '## ${heading}' has no content below it`,
      });
      totals.empty_section++;
    }

    // kebab-case filename
    const fname = basename(page.relPath);
    if (!whitelist.has(fname) && !isKebabCase(page.slug)) {
      findings.push({
        kind: "kebab_case_violation",
        severity: "warn",
        path: page.relPath,
        message: `Filename '${fname}' is not kebab-case`,
      });
      totals.kebab_case_violation++;
    }
  }

  return {
    tenantId,
    ranAt: new Date().toISOString(),
    pageCount: snapshot.pages.length,
    findings,
    totals,
  };
}
