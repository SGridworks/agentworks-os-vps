/**
 * Zero-LLM entity extraction from vault pages.
 *
 * Pure regex + statistics extraction for: wikilinks, @mentions, URLs,
 * dates, people, #hashtags, quoted concepts, and headings.
 * No embedding model, no LLM calls.
 *
 * Designed to power the signal detector and relationship graph builder.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** A typed entity referenced by a vault page. */
export interface Entity {
  type: EntityType;
  /** Raw wikilink or mention text, e.g. "[[projects/sgridworks]]" or "@john" */
  raw: string;
  /** Normalized key for lookup, e.g. "projects/sgridworks" or "people/john" */
  normalized: string;
}

export type EntityType =
  | "person"
  | "project"
  | "concept"
  | "decision"
  | "topic"
  | "url"
  | "date"
  | "custom";

// ─── Wikilink extraction ──────────────────────────────────────────────────────

/** Extract all `[[...]]` wikilinks from text. */
export function extractWikilinks(text: string): Array<{ raw: string; target: string }> {
  const re = /\[\[([^\]]+)\]\]/g;
  const results: Array<{ raw: string; target: string }> = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    results.push({ raw: m[0], target: (m[1] ?? "").trim() });
  }
  return results;
}

// ─── Mention extraction ──────────────────────────────────────────────────────

/** Extract all `@identifier` mentions from text. */
export function extractMentions(text: string): string[] {
  const re = /@([a-zA-Z0-9_\-./]{1,64})/g;
  const mentions: string[] = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!m[1]) continue;
    mentions.push(m[1]);
  }
  return mentions;
}

// ─── URL extraction ───────────────────────────────────────────────────────────

/** Extract all HTTP(S) URLs from text. */
export function extractUrls(text: string): string[] {
  const re = /https?:\/\/[^\s<>"\]]+/g;
  return text.match(re) ?? [];
}

// ─── Date extraction ─────────────────────────────────────────────────────────

/**
 * Extract ISO-8601 and common date patterns.
 * Returns ISO-normalized strings where possible.
 */
export function extractDates(text: string): string[] {
  const results: string[] = [];

  // ISO 8601: 2026-04-30 or 2026-04-30T09:00:00Z
  const isoRe = /\b(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;
  let m;
  while ((m = isoRe.exec(text)) !== null) {
    if (!m[1]) continue;
    results.push(m[1]); // just the date part
  }

  // US format: 04/30/2026 or 4/30/2026
  const usRe = /\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(\d{4})\b/g;
  while ((m = usRe.exec(text)) !== null) {
    const [, month, day, year] = m;
    if (!month || !day || !year) continue;
    if (month && day) results.push(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`);
  }

  // Written: April 30, 2026
  const writtenRe = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/gi;
  const MONTHS: Record<string, string> = {
    january: "01", february: "02", march: "03", april: "04",
    may: "05", june: "06", july: "07", august: "08",
    september: "09", october: "10", november: "11", december: "12",
  };
  while ((m = writtenRe.exec(text)) !== null) {
    if (!m[1]) continue;
    const month = MONTHS[m[1].toLowerCase()];
    const day = (m[2] ?? "").padStart(2, "0");
    results.push(`${m[3]}-${month}-${day}`);
  }

  return [...new Set(results)];
}

// ─── Hashtag extraction ───────────────────────────────────────────────────────

/** Extract `#hashtags` from text. Normalizes to lowercase. */
export function extractHashtags(text: string): string[] {
  const re = /#([a-zA-Z][a-zA-Z0-9_\-]{1,48})/g;
  const tags: string[] = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!m[1]) continue;
    tags.push(m[1].toLowerCase());
  }
  return [...new Set(tags)];
}

// ─── Quoted concept extraction ────────────────────────────────────────────────

/** Extract "quoted phrases" from text — common pattern for named concepts. */
export function extractQuoted(text: string): string[] {
  const re = /"([^"]{3,80})"/g;
  const quotes: string[] = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!m[1]) continue;
    quotes.push(m[1]);
  }
  return quotes;
}

// ─── Heading extraction ───────────────────────────────────────────────────────

/** Extract all markdown headings (## and ###) as potential section topics. */
export function extractHeadings(text: string): string[] {
  const re = /^#{2,3}\s+(.+)$/gm;
  const headings: string[] = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    headings.push((m[1] ?? "").trim());
  }
  return headings;
}

// ─── Person-like extraction ──────────────────────────────────────────────────

/**
 * Extract person-like tokens: "John Smith" (Two consecutive Titlecase words).
 * Naive but useful for surfacing names without NER.
 */
export function extractPersonNames(text: string): string[] {
  const re = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
  const names: string[] = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!m[1]) continue;
    names.push(m[1]);
  }
  return [...new Set(names)];
}

// ─── TF-based topic extraction ───────────────────────────────────────────────

/**
 * Extract top topics from a page using Term Frequency.
 * Strips markdown, stopwords, then ranks by frequency.
 * Returns top N terms (default 5).
 *
 * No embeddings — pure bag-of-words TF.
 */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "is", "are", "was", "were",
  "be", "been", "being", "have", "has", "had", "do", "does", "did",
  "will", "would", "could", "should", "may", "might", "must", "shall",
  "can", "need", "to", "of", "in", "for", "on", "with", "at", "by",
  "from", "as", "into", "through", "during", "before", "after",
  "above", "below", "between", "under", "over", "this", "that", "these",
  "those", "it", "its", "they", "them", "their", "we", "our", "you",
  "your", "he", "she", "him", "her", "his", "i", "my", "me", "what",
  "which", "who", "whom", "when", "where", "why", "how", "not", "no",
  "nor", "so", "too", "very", "just", "also", "now", "here", "there",
  "then", "than", "only", "own", "same", "say", "see", "know", "get",
  "make", "go", "goes", "went", "gone", "come", "came", "take", "took",
]);

/**
 * Strip markdown syntax from text for clean TF analysis.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\[\[([^\]]+)\]\]/g, "$1")   // wikilinks → text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links → text
    .replace(/[#*_~`>]/g, " ")             // markdown symbols
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Extract top N topics by term frequency.
 */
export function extractTopics(text: string, topN = 5): Array<{ term: string; count: number }> {
  const cleaned = stripMarkdown(text);
  const words = cleaned.split(/\s+/).filter(
    (w) => w.length > 3 && !STOPWORDS.has(w) && /^[a-z]+$/.test(w),
  );

  const freq = new Map<string, number>();
  for (const word of words) {
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([term, count]) => ({ term, count }));
}

// ─── Unified extraction ───────────────────────────────────────────────────────

export interface ExtractionResult {
  wikilinks: Array<{ raw: string; target: string }>;
  mentions: string[];
  urls: string[];
  dates: string[];
  hashtags: string[];
  quoted: string[];
  headings: string[];
  personNames: string[];
  topics: Array<{ term: string; count: number }>;
}

/**
 * Run all extractors and return a consolidated result.
 */
export function extractAll(text: string): ExtractionResult {
  return {
    wikilinks: extractWikilinks(text),
    mentions: extractMentions(text),
    urls: extractUrls(text),
    dates: extractDates(text),
    hashtags: extractHashtags(text),
    quoted: extractQuoted(text),
    headings: extractHeadings(text),
    personNames: extractPersonNames(text),
    topics: extractTopics(text),
  };
}

/**
 * Summary statistics for an extraction result.
 */
export interface ExtractionStats {
  totalEntities: number;
  byType: Record<string, number>;
}

export function extractionStats(result: ExtractionResult): ExtractionStats {
  const byType: Record<string, number> = {
    wikilink: result.wikilinks.length,
    mention: result.mentions.length,
    url: result.urls.length,
    date: result.dates.length,
    hashtag: result.hashtags.length,
    quoted: result.quoted.length,
    heading: result.headings.length,
    personName: result.personNames.length,
    topic: result.topics.length,
  };

  return {
    totalEntities: Object.values(byType).reduce((a, b) => a + b, 0),
    byType,
  };
}

/**
 * Convert an extraction result into typed Entity objects
 * for use in the relationship graph.
 */
export function entitiesFromExtraction(result: ExtractionResult): Entity[] {
  const entities: Entity[] = [];

  for (const { target } of result.wikilinks) {
    entities.push({ type: "concept", raw: `[[${target}]]`, normalized: target });
  }

  for (const m of result.mentions) {
    entities.push({ type: "person", raw: `@${m}`, normalized: `people/${m}` });
  }

  for (const url of result.urls) {
    entities.push({ type: "url", raw: url, normalized: url });
  }

  for (const date of result.dates) {
    entities.push({ type: "date", raw: date, normalized: date });
  }

  for (const tag of result.hashtags) {
    entities.push({ type: "topic", raw: `#${tag}`, normalized: `topics/${tag}` });
  }

  for (const q of result.quoted) {
    entities.push({ type: "concept", raw: `"${q}"`, normalized: q.toLowerCase().replace(/\s+/g, "-") });
  }

  for (const name of result.personNames) {
    const normalized = name.toLowerCase().replace(/\s+/g, "-");
    entities.push({ type: "person", raw: name, normalized: `people/${normalized}` });
  }

  for (const { term } of result.topics) {
    entities.push({ type: "topic", raw: `#${term}`, normalized: `topics/${term}` });
  }

  return entities;
}
