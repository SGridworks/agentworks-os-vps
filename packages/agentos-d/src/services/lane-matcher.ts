/**
 * Lane Matcher Service
 *
 * Reads agent-lanes.json (agent-to-path routing config) and matches issue
 * descriptions against lane patterns to recommend an assignee.
 *
 * RFC 008 Section 3: Auto-assign router.
 *
 * Algorithm:
 * 1. Extract file paths from issue description (regex: packages/, docs/, etc.)
 * 2. Match paths against role allow patterns in agent-lanes.json
 * 3. Pick role with lowest open-todo count (tie-break: alphabetical)
 * 4. Return null if no match or ambiguous (lands in triage)
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LaneRole {
  agent_id_prefix: string;
  allow: string[]; // regex patterns
  description: string;
}

export interface LaneConfig {
  roles: Record<string, LaneRole>;
  _universal_allow?: string[];
  _comment?: string;
  _format?: string;
}

export interface LaneMatchResult {
  matched: boolean;
  ambiguous: boolean;
  role?: string;
  agentIdPrefix?: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Lane config cache
// ---------------------------------------------------------------------------

let _cachedConfig: LaneConfig | null = null;
let _configPath: string | null = null;

/**
 * Load and cache agent-lanes.json.
 * Respects AGENT_LANES_CONFIG_PATH env var (for tests).
 * Defaults to ~/.agentworks/scripts/agent-lanes.json.
 * @param explicitPath  Override path (tests should set AGENT_LANES_CONFIG_PATH instead)
 * @param inlineConfig  Pass config directly in test mode.
 */
export function loadLaneConfig(explicitPath?: string, inlineConfig?: LaneConfig): LaneConfig {
  if (inlineConfig) {
    // Cache it so that nested calls (e.g., matchLane calling loadLaneConfig internally)
    // also get the test config without doing file I/O
    _cachedConfig = inlineConfig;
    _configPath = "__inline_test__";
    return _cachedConfig;
  }

  const envPath = process.env.AGENT_LANES_CONFIG_PATH;
  const preferredPath = join(homedir(), ".agentworks/scripts/agent-lanes.json");
  const path = explicitPath ?? envPath ?? preferredPath;

  if (_cachedConfig && (_configPath === path || _configPath === "__inline_test__")) {
    return _cachedConfig;
  }

  if (!existsSync(path)) {
    throw new Error(`lane-matcher: agent-lanes.json not found at ${path}`);
  }

  const raw = readFileSync(path, "utf-8");
  _cachedConfig = JSON.parse(raw) as LaneConfig;
  _configPath = path;
  return _cachedConfig;
}

/** Reset the in-memory cache (useful for tests). */
export function clearLaneConfigCache(): void {
  _cachedConfig = null;
  _configPath = null;
}

// ---------------------------------------------------------------------------
// Path extraction
// ---------------------------------------------------------------------------

/**
 * Extract file-path tokens from a text body.
 * Matches: packages/, docs/, apps/, services/, scripts/, tests/,
 *          agents/, rule-packs/, or any absolute-looking path.
 */
export function extractFilePaths(text: string): string[] {
  const PATH_RE =
    /(?:^|[\s\(\[])((?:packages|docs|apps|services|scripts|tests|agents|rule-packs|\/(?:Users|home)\/[A-Za-z0-9_\-]+|\.\.\/)[a-zA-Z0-9_\-./]+)/gm;
  const results = new Set<string>();
  let match: RegExpExecArray | null;
  // Reset lastIndex since we're using /g flag
  PATH_RE.lastIndex = 0;
  while ((match = PATH_RE.exec(text)) !== null) {
    results.add(match[1]!);
  }
  return Array.from(results);
}

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

/**
 * Test whether a path matches any of the given allow patterns.
 * Returns true if the path matches ANY pattern.
 */
function pathMatchesAllow(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    // Strip leading ^ if present (anchored patterns are fine as-is)
    const re = new RegExp(pattern);
    return re.test(path);
  });
}

/**
 * Score a role based on how many of the extracted paths it matches.
 * Returns the count of matched paths.
 */
function scoreRole(role: LaneRole, paths: string[]): number {
  return paths.filter((p) => pathMatchesAllow(p, role.allow)).length;
}

// ---------------------------------------------------------------------------
// Lane matching
// ---------------------------------------------------------------------------

export interface LaneMatchInput {
  issueDescription: string;
  /** Optional: map of role -> current open-todo count */
  todoCounts?: Record<string, number>;
}

const DEFAULT_TODO_COUNTS: Record<string, number> = {};

/**
 * Match an issue description to a lane role.
 *
 * Returns LaneMatchResult:
 * - matched=true + role set: unambiguous best match found
 * - ambiguous=true: multiple roles tied for best score (route to triage)
 * - matched=false: no roles matched (route to triage)
 */
export function matchLane(input: LaneMatchInput): LaneMatchResult {
  const paths = extractFilePaths(input.issueDescription);

  if (paths.length === 0) {
    return {
      matched: false,
      ambiguous: false,
      reason: `No file paths extracted from description`,
    };
  }

  const config = loadLaneConfig();
  const { roles } = config;

  // Score each role by how many paths it matches
  const todoCounts = input.todoCounts ?? DEFAULT_TODO_COUNTS;
  const scored: Array<{ role: string; score: number; agentIdPrefix: string }> = [];

  for (const [roleName, role] of Object.entries(roles)) {
    const score = scoreRole(role, paths);
    if (score > 0) {
      scored.push({ role: roleName, score, agentIdPrefix: role.agent_id_prefix });
    }
  }

  if (scored.length === 0) {
    return {
      matched: false,
      ambiguous: false,
      reason: `No lane matched any of: ${paths.join(", ")}`,
    };
  }

  // Sort by score desc, then by todo count asc, then alphabetically for tie
  scored.sort((a, b) => {
    const todoA = todoCounts[a.role] ?? 0;
    const todoB = todoCounts[b.role] ?? 0;
    if (todoA !== todoB) return todoA - todoB;
    return a.role < b.role ? -1 : a.role > b.role ? 1 : 0;
  });

  const best = scored[0]!;
  const bestScore = best.score;

  // Check for ambiguity: any other role with the same score?
  const ties = scored.filter((s) => s.score === bestScore);
  if (ties.length > 1) {
    return {
      matched: false,
      ambiguous: true,
      reason: `Ambiguous: roles ${ties.map((t) => t.role).join(", ")} all scored ${bestScore} for: ${paths.join(", ")}`,
    };
  }

  return {
    matched: true,
    ambiguous: false,
    role: best.role,
    agentIdPrefix: best.agentIdPrefix,
    reason: `Matched ${best.role} (score=${best.score}) for: ${paths.join(", ")}`,
  };
}
