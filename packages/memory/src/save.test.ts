/**
 * Vault-save tests.
 *
 *   - noteFolder: type → folder mapping
 *   - renderNoteFrontmatter: each note type yields the right shape
 *   - saveNote: writes file at correct key, frontmatter + body, log prepend
 *   - appendDecisionLogEntry: structured block, header preserved
 *   - appendActionTrackerEntry: row appended, table header created
 *   - tenant isolation
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  noteFolder,
  renderNoteFrontmatter,
  saveNote,
  appendDecisionLogEntry,
  appendActionTrackerEntry,
  DECISION_LOG_FILENAME,
  ACTION_TRACKER_FILENAME,
  VAULT_LOG_FILENAME,
} from "./save.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "awo-save-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("noteFolder", () => {
  it("routes synthesis and concept to wiki/concepts", () => {
    expect(noteFolder("synthesis")).toBe("wiki/concepts");
    expect(noteFolder("concept")).toBe("wiki/concepts");
  });

  it("routes summary and session to wiki/summaries", () => {
    expect(noteFolder("summary")).toBe("wiki/summaries");
    expect(noteFolder("session")).toBe("wiki/summaries");
  });

  it("routes decision to wiki/decisions", () => {
    expect(noteFolder("decision")).toBe("wiki/decisions");
  });
});

describe("renderNoteFrontmatter", () => {
  it("emits title, type, created, updated for a basic note", () => {
    const fm = renderNoteFrontmatter({
      title: "Great Idea",
      type: "concept",
      body: "",
      date: "2026-04-28",
    });
    expect(fm).toContain('title: "Great Idea"');
    expect(fm).toContain("type: concept");
    expect(fm).toContain("created: 2026-04-28");
    expect(fm).toContain("updated: 2026-04-28");
  });

  it("decision adds decision_date and status fields", () => {
    const fm = renderNoteFrontmatter({
      title: "Pick Postgres",
      type: "decision",
      body: "",
      date: "2026-04-28",
    });
    expect(fm).toContain("decision_date: 2026-04-28");
    expect(fm).toContain("status: active");
  });

  it("decision honors explicit decisionDate and status overrides", () => {
    const fm = renderNoteFrontmatter({
      title: "Deprecate X",
      type: "decision",
      body: "",
      decisionDate: "2026-01-01",
      status: "superseded",
    });
    expect(fm).toContain("decision_date: 2026-01-01");
    expect(fm).toContain("status: superseded");
  });

  it("summary type emits empty sources list when none provided", () => {
    const fm = renderNoteFrontmatter({
      title: "Article Summary",
      type: "summary",
      body: "",
    });
    expect(fm).toContain("sources: []");
  });

  it("summary with explicit sources emits a bullet list", () => {
    const fm = renderNoteFrontmatter({
      title: "Article Summary",
      type: "summary",
      body: "",
      sources: ["[[raw-sources/articles/foo.md]]"],
    });
    expect(fm).toContain("sources:");
    expect(fm).toContain("[[raw-sources/articles/foo.md]]");
  });

  it("emits related: list when provided", () => {
    const fm = renderNoteFrontmatter({
      title: "X",
      type: "synthesis",
      body: "",
      related: ["[[Page A]]", "[[Page B]]"],
    });
    expect(fm).toContain("related:");
    expect(fm).toContain('- "[[Page A]]"');
    expect(fm).toContain('- "[[Page B]]"');
  });
});

describe("saveNote", () => {
  it("writes file at wiki/concepts/<slug>.md for synthesis", async () => {
    const r = await saveNote(root, TENANT_A, {
      title: "Big Idea",
      type: "synthesis",
      body: "The idea is X.",
    });
    expect(r.key).toBe("wiki/concepts/big-idea.md");
    expect(existsSync(r.absPath)).toBe(true);
    const text = readFileSync(r.absPath, "utf8");
    expect(text).toContain('title: "Big Idea"');
    expect(text).toContain("type: synthesis");
    expect(text).toContain("The idea is X.");
  });

  it("writes file at wiki/decisions/<slug>.md for decision", async () => {
    const r = await saveNote(root, TENANT_A, {
      title: "Pick Postgres",
      type: "decision",
      body: "Chose postgres for ACID.",
      date: "2026-04-28",
    });
    expect(r.key).toBe("wiki/decisions/pick-postgres.md");
    const text = readFileSync(r.absPath, "utf8");
    expect(text).toContain("decision_date: 2026-04-28");
    expect(text).toContain("status: active");
    expect(text).toContain("Chose postgres for ACID.");
  });

  it("uses an explicit slug override when provided", async () => {
    const r = await saveNote(root, TENANT_A, {
      title: "What is Z?",
      type: "concept",
      body: "Z is a thing.",
      slug: "z-explained",
    });
    expect(r.slug).toBe("z-explained");
    expect(r.key).toBe("wiki/concepts/z-explained.md");
  });

  it("prepends an entry to log.md after each save", async () => {
    await saveNote(root, TENANT_A, {
      title: "First",
      type: "concept",
      body: "a",
      date: "2026-04-01",
    });
    await saveNote(root, TENANT_A, {
      title: "Second",
      type: "concept",
      body: "b",
      date: "2026-04-02",
    });
    const log = readFileSync(join(root, TENANT_A, VAULT_LOG_FILENAME), "utf8");
    expect(log).toContain("## [2026-04-01] save | First");
    expect(log).toContain("## [2026-04-02] save | Second");
    expect(log.indexOf("Second")).toBeLessThan(log.indexOf("First"));
  });

  it("re-saving the same slug overwrites the file", async () => {
    await saveNote(root, TENANT_A, {
      title: "X",
      type: "concept",
      body: "first version",
    });
    await saveNote(root, TENANT_A, {
      title: "X",
      type: "concept",
      body: "second version",
    });
    const text = readFileSync(join(root, TENANT_A, "wiki/concepts/x.md"), "utf8");
    expect(text).toContain("second version");
    expect(text).not.toContain("first version");
  });
});

describe("appendDecisionLogEntry", () => {
  it("creates Decision-Log.md with header on first append", async () => {
    await appendDecisionLogEntry(root, TENANT_A, {
      title: "Pick Postgres",
      context: "We need ACID.",
      decision: "Use postgres.",
      rationale: "Most operationally familiar.",
      date: "2026-04-28",
    });
    const text = readFileSync(join(root, TENANT_A, DECISION_LOG_FILENAME), "utf8");
    expect(text).toContain("# Decision Log");
    expect(text).toContain("## [2026-04-28] Pick Postgres");
    expect(text).toContain("**Context:** We need ACID.");
    expect(text).toContain("**Decision:** Use postgres.");
    expect(text).toContain("**Rationale:** Most operationally familiar.");
  });

  it("appends new entries below previous ones", async () => {
    await appendDecisionLogEntry(root, TENANT_A, {
      title: "First",
      context: "x",
      decision: "y",
      rationale: "z",
      date: "2026-04-01",
    });
    await appendDecisionLogEntry(root, TENANT_A, {
      title: "Second",
      context: "x",
      decision: "y",
      rationale: "z",
      date: "2026-04-02",
    });
    const text = readFileSync(join(root, TENANT_A, DECISION_LOG_FILENAME), "utf8");
    expect(text.indexOf("First")).toBeLessThan(text.indexOf("Second"));
  });

  it("optional source field is included when set", async () => {
    await appendDecisionLogEntry(root, TENANT_A, {
      title: "Pick X",
      context: "c",
      decision: "d",
      rationale: "r",
      source: "[[wiki/concepts/x-tradeoffs]]",
    });
    const text = readFileSync(join(root, TENANT_A, DECISION_LOG_FILENAME), "utf8");
    expect(text).toContain("**Source:** [[wiki/concepts/x-tradeoffs]]");
  });
});

describe("appendActionTrackerEntry", () => {
  it("creates Action-Tracker.md with table header on first append", async () => {
    await appendActionTrackerEntry(root, TENANT_A, {
      action: "Email customer with install plan",
      owner: "operator",
      due: "2026-05-04",
    });
    const text = readFileSync(join(root, TENANT_A, ACTION_TRACKER_FILENAME), "utf8");
    expect(text).toContain("# Action Tracker");
    expect(text).toContain("| Action | Owner | Due | Source | Status |");
    expect(text).toContain("Email customer with install plan");
    expect(text).toContain("2026-05-04");
    expect(text).toContain("open");
  });

  it("appends a second row below the first", async () => {
    await appendActionTrackerEntry(root, TENANT_A, {
      action: "First action",
      owner: "alice",
    });
    await appendActionTrackerEntry(root, TENANT_A, {
      action: "Second action",
      owner: "bob",
      status: "in_progress",
    });
    const text = readFileSync(join(root, TENANT_A, ACTION_TRACKER_FILENAME), "utf8");
    expect(text).toContain("First action");
    expect(text).toContain("Second action");
    expect(text.indexOf("First action")).toBeLessThan(text.indexOf("Second action"));
    expect(text).toContain("in_progress");
  });

  it("escapes pipe characters in cell content", async () => {
    await appendActionTrackerEntry(root, TENANT_A, {
      action: "Run `cmd | grep foo`",
      owner: "x",
    });
    const text = readFileSync(join(root, TENANT_A, ACTION_TRACKER_FILENAME), "utf8");
    expect(text).toContain("`cmd \\| grep foo`");
  });
});

describe("tenant isolation", () => {
  it("save in tenant A doesn't reach tenant B", async () => {
    await saveNote(root, TENANT_A, {
      title: "secret",
      type: "concept",
      body: "tenant A only",
    });
    expect(existsSync(join(root, TENANT_B, "wiki/concepts/secret.md"))).toBe(false);
    expect(existsSync(join(root, TENANT_B, VAULT_LOG_FILENAME))).toBe(false);
  });

  it("decision-log writes are tenant-scoped", async () => {
    await appendDecisionLogEntry(root, TENANT_A, {
      title: "x",
      context: "c",
      decision: "d",
      rationale: "r",
    });
    expect(existsSync(join(root, TENANT_B, DECISION_LOG_FILENAME))).toBe(false);
  });
});
