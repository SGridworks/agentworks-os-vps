/**
 * Migration 0031: per-company issue identifier prefix + sequence.
 *
 * Issues had `identifier = NULL` in every row because the create handler
 * never assigned one. UI tables fell back to 8-char id slices, which made
 * cross-references like "see SGW-12" impossible.
 *
 * This migration:
 *   - Adds execution_companies.slug_prefix (e.g. "SGW", "BTM", "E2E").
 *     Derives from the company name: take initials of words OR first 3
 *     uppercase letters of the slug. Idempotent — only writes when NULL.
 *   - Adds execution_company_issue_seq table — atomic counter per company.
 *   - Backfills identifiers for every NULL-identifier issue in
 *     creation order, e.g. "SGW-1", "SGW-2".
 */

import type { Database } from "better-sqlite3";

const HASH = "v31-company-issue-prefix";

function deriveSlug(name: string, slug: string | null): string {
  const source = (name || slug || "").trim();
  if (!source) return "ISS";
  // Initials of words if multi-word and produces 2-4 letters.
  const words = source
    .split(/[\s_-]+/)
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ""))
    .filter((w) => w.length > 0);
  if (words.length >= 2) {
    const init = words.map((w) => w[0]!.toUpperCase()).join("").slice(0, 4);
    if (init.length >= 2) return init;
  }
  // Otherwise: first 3 chars of the source uppercased.
  const cleaned = source.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return (cleaned.slice(0, 3) || "ISS");
}

export function migrate(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  const existing = sqlite
    .prepare("SELECT 1 FROM __drizzle_migrations WHERE hash = ?")
    .get(HASH);
  if (existing) return;

  try {
    sqlite.exec(`ALTER TABLE execution_companies ADD COLUMN slug_prefix TEXT;`);
  } catch (err) {
    if (!/duplicate column name/i.test(String((err as Error).message ?? ""))) throw err;
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS execution_company_issue_seq (
      company_id TEXT PRIMARY KEY,
      next_seq INTEGER NOT NULL DEFAULT 1
    );
  `);

  // Assign prefixes. Resolve collisions by appending a digit.
  const companies = sqlite
    .prepare("SELECT id, name, slug FROM execution_companies WHERE slug_prefix IS NULL")
    .all() as Array<{ id: string; name: string; slug: string | null }>;

  const usedPrefixes = new Set(
    (sqlite
      .prepare("SELECT slug_prefix FROM execution_companies WHERE slug_prefix IS NOT NULL")
      .all() as Array<{ slug_prefix: string }>).map((r) => r.slug_prefix)
  );

  const setPrefix = sqlite.prepare(
    "UPDATE execution_companies SET slug_prefix = ? WHERE id = ?"
  );
  for (const c of companies) {
    let base = deriveSlug(c.name, c.slug);
    let pref = base;
    let i = 2;
    while (usedPrefixes.has(pref)) {
      pref = `${base}${i++}`;
    }
    usedPrefixes.add(pref);
    setPrefix.run(pref, c.id);
  }

  // Backfill identifiers for NULL-identifier issues, per company,
  // ordered by created_at so older issues get lower numbers.
  const allCompanies = sqlite
    .prepare("SELECT id, slug_prefix FROM execution_companies WHERE slug_prefix IS NOT NULL")
    .all() as Array<{ id: string; slug_prefix: string }>;

  const initSeq = sqlite.prepare(
    "INSERT OR IGNORE INTO execution_company_issue_seq (company_id, next_seq) VALUES (?, 1)"
  );
  const setSeq = sqlite.prepare(
    "UPDATE execution_company_issue_seq SET next_seq = ? WHERE company_id = ?"
  );
  const setIdentifier = sqlite.prepare(
    "UPDATE execution_issues SET identifier = ? WHERE id = ?"
  );

  for (const c of allCompanies) {
    initSeq.run(c.id);
    const issues = sqlite
      .prepare(
        "SELECT id FROM execution_issues WHERE company_id = ? AND identifier IS NULL ORDER BY created_at ASC"
      )
      .all(c.id) as Array<{ id: string }>;
    if (issues.length === 0) continue;
    let n = 1;
    for (const iss of issues) {
      setIdentifier.run(`${c.slug_prefix}-${n}`, iss.id);
      n++;
    }
    setSeq.run(n, c.id);
  }

  sqlite.prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)").run(HASH);
}
