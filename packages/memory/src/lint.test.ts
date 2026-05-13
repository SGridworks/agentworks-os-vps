/**
 * Vault-lint tests.
 *
 *   - orphan_page: a page with no inbound wikilinks (and not whitelisted)
 *   - dead_link: an outbound wikilink whose target page does not exist
 *   - frontmatter_gap: required field missing or empty
 *   - empty_section: heading with no content beneath it
 *   - kebab_case_violation: filename slug not kebab-case
 *   - whitelist suppresses orphan + kebab checks for README.md / index.md
 *   - tenant isolation: lint(A) ignores B's pages
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintVault } from "./lint.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

let root: string;

function seed(rel: string, body: string): void {
  const abs = join(root, TENANT_A, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "awo-lint-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("lintVault", () => {
  it("flags orphan pages (no inbound wikilinks)", async () => {
    seed("alpha.md", `---\ntitle: alpha\ntype: note\n---\n\nlinks to [[beta]]\n`);
    seed("beta.md", `---\ntitle: beta\ntype: note\n---\n\nbody\n`);
    seed("orphan.md", `---\ntitle: orphan\ntype: note\n---\n\nbody\n`);

    const r = await lintVault(root, TENANT_A);
    const orphans = r.findings.filter((f) => f.kind === "orphan_page");
    const slugs = orphans.map((f) => f.path.replace(".md", ""));
    expect(slugs).toContain("orphan");
    expect(slugs).toContain("alpha"); // alpha has no inbound either
    expect(slugs).not.toContain("beta"); // beta is linked from alpha
  });

  it("flags dead wikilinks (target page missing)", async () => {
    seed(
      "page.md",
      `---\ntitle: page\ntype: note\n---\n\nrefs [[exists]] and [[missing]] and [[also-gone|alias]]\n`,
    );
    seed("exists.md", `---\ntitle: exists\ntype: note\n---\n\nbody\n`);

    const r = await lintVault(root, TENANT_A);
    const dead = r.findings
      .filter((f) => f.kind === "dead_link")
      .map((f) => f.message);
    expect(dead.some((m) => m.includes("[[missing]]"))).toBe(true);
    expect(dead.some((m) => m.includes("[[also-gone]]"))).toBe(true);
    expect(dead.some((m) => m.includes("[[exists]]"))).toBe(false);
  });

  it("flags missing frontmatter fields", async () => {
    seed("good.md", `---\ntitle: good\ntype: note\n---\n\nbody\n`);
    seed("bad.md", `---\ntitle: \n---\n\nbody\n`);
    seed("worse.md", `no frontmatter at all\n`);

    const r = await lintVault(root, TENANT_A);
    const gaps = r.findings.filter((f) => f.kind === "frontmatter_gap");
    expect(gaps.find((f) => f.path === "bad.md" && f.message.includes("title"))).toBeDefined();
    expect(gaps.find((f) => f.path === "bad.md" && f.message.includes("type"))).toBeDefined();
    expect(gaps.find((f) => f.path === "worse.md" && f.message.includes("title"))).toBeDefined();
    expect(gaps.find((f) => f.path === "good.md")).toBeUndefined();
  });

  it("flags empty sections (heading with no content)", async () => {
    seed(
      "page.md",
      `---\ntitle: page\ntype: note\n---\n\n## Has Content\nlorem\n\n## Empty\n\n## Another\nipsum\n`,
    );

    const r = await lintVault(root, TENANT_A);
    const empties = r.findings
      .filter((f) => f.kind === "empty_section")
      .map((f) => f.message);
    expect(empties.some((m) => m.includes("Empty"))).toBe(true);
    expect(empties.some((m) => m.includes("Has Content"))).toBe(false);
    expect(empties.some((m) => m.includes("Another"))).toBe(false);
  });

  it("flags kebab-case violations", async () => {
    seed("good-name.md", `---\ntitle: ok\ntype: note\n---\n\nbody\n`);
    seed("BadName.md", `---\ntitle: bad\ntype: note\n---\n\nbody\n`);
    seed("snake_case.md", `---\ntitle: snake\ntype: note\n---\n\nbody\n`);

    const r = await lintVault(root, TENANT_A);
    const violations = r.findings
      .filter((f) => f.kind === "kebab_case_violation")
      .map((f) => f.path);
    expect(violations).toContain("BadName.md");
    expect(violations).toContain("snake_case.md");
    expect(violations).not.toContain("good-name.md");
  });

  it("whitelist suppresses orphan + kebab checks for README.md and index.md", async () => {
    seed("README.md", `---\ntitle: readme\ntype: meta\n---\n\nentry\n`);
    seed("index.md", `---\ntitle: index\ntype: meta\n---\n\nentry\n`);

    const r = await lintVault(root, TENANT_A);
    const orphans = r.findings.filter((f) => f.kind === "orphan_page").map((f) => f.path);
    const kebab = r.findings.filter((f) => f.kind === "kebab_case_violation").map((f) => f.path);
    expect(orphans).not.toContain("README.md");
    expect(orphans).not.toContain("index.md");
    expect(kebab).not.toContain("README.md");
    expect(kebab).not.toContain("index.md");
  });

  it("tenant isolation — lint(A) does not see B's pages", async () => {
    seed("a-only.md", `---\ntitle: a\ntype: note\n---\n\nbody\n`);
    // Drop a file under tenant B with a deliberately-bad name; lint(A) must ignore it.
    const bDir = join(root, TENANT_B);
    mkdirSync(bDir, { recursive: true });
    writeFileSync(join(bDir, "BadInB.md"), `---\ntitle: b\ntype: note\n---\n\nbody\n`, "utf8");

    const ra = await lintVault(root, TENANT_A);
    expect(ra.pageCount).toBe(1);
    expect(ra.findings.find((f) => f.path.includes("BadInB"))).toBeUndefined();

    const rb = await lintVault(root, TENANT_B);
    expect(rb.pageCount).toBe(1);
    expect(rb.findings.find((f) => f.kind === "kebab_case_violation")).toBeDefined();
  });

  it("returns totals matching the findings array", async () => {
    seed("Bad_Name.md", `---\ntitle: bad\n---\n\n## Empty\n\n[[ghost]]\n`);

    const r = await lintVault(root, TENANT_A);
    let sum = 0;
    for (const k of Object.keys(r.totals) as Array<keyof typeof r.totals>) {
      sum += r.totals[k];
    }
    expect(sum).toBe(r.findings.length);
    expect(r.tenantId).toBe(TENANT_A);
    expect(r.ranAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("missing tenant directory returns zero pages without throwing", async () => {
    const r = await lintVault(root, "99999999-9999-9999-9999-999999999999");
    expect(r.pageCount).toBe(0);
    expect(r.findings).toEqual([]);
  });

  it("respects custom requiredFrontmatter list", async () => {
    seed("page.md", `---\ntitle: t\ntype: note\n---\n\nbody\n`);

    const r = await lintVault(root, TENANT_A, { requiredFrontmatter: ["title", "owner"] });
    const gaps = r.findings.filter((f) => f.kind === "frontmatter_gap");
    expect(gaps.find((f) => f.message.includes("owner"))).toBeDefined();
    expect(gaps.find((f) => f.message.includes("title"))).toBeUndefined();
  });
});
