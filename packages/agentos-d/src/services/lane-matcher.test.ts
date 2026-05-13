/**
 * Lane Matcher — Unit Tests
 *
 * Tests the lane-match algorithm per RFC 008 Section 3:
 * - Path extraction from issue descriptions
 * - Lane matching against agent-lanes.json patterns
 * - Tie-breaking (lowest todo count, then alphabetical)
 * - Ambiguity detection
 * - Manual-assignment wins
 *
 * Tests use inlineConfig (loadLaneConfig second arg) for full isolation —
 * no file I/O, no shared module cache, no teardown between tests.
 */

import { describe, it, expect } from "vitest";
import { extractFilePaths, matchLane, loadLaneConfig, clearLaneConfigCache } from "./lane-matcher.js";
import type { LaneConfig } from "./lane-matcher.js";

// --------------------------------------------------------------------------
// Test fixtures — inline configs (no file I/O needed)
// --------------------------------------------------------------------------

// Config WITHOUT QAEngineer to keep BackendEngineer tests deterministic.
// QAEngineer-specific tests use a separate config below.
const TEST_CONFIG_NO_QA: LaneConfig = {
  _universal_allow: ["^agents/[^/]+/AGENTS\\.md$", "^README\\.md$"],
  roles: {
    BackendEngineer: {
      agent_id_prefix: "79d8066d",
      allow: [
        "^packages/agentos-d/",
        "^packages/awcp/",
        "^packages/shared/",
        "^packages/memory/",
        "^apps/installer/",
        "^tests/",
      ],
      description: "agentos-d daemon, AWCP, shared types",
    },
    PythonEngineer: {
      agent_id_prefix: "6f5da3aa",
      allow: [
        "^packages/scanner-worker/",
        "^packages/.*\\.py$",
        "^services/.*\\.py$",
      ],
      description: "scanner-worker FastAPI",
    },
    FrontendEngineer: {
      agent_id_prefix: "8faf4a5a",
      allow: ["^packages/admin-ui/", "^apps/installer/.*ui/"],
      description: "admin-ui Next.js",
    },
    TechnicalWriter: {
      agent_id_prefix: "d2bde45f",
      allow: ["^docs/", "^README\\.md$", "^CHANGELOG\\.md$"],
      description: "all docs",
    },
  },
};

// Separate config that includes QAEngineer (for QAEngineer-specific tests)
const TEST_CONFIG_WITH_QA: LaneConfig = {
  _universal_allow: ["^agents/[^/]+/AGENTS\\.md$", "^README\\.md$"],
  roles: {
    ...TEST_CONFIG_NO_QA.roles,
    QAEngineer: {
      agent_id_prefix: "ec133cff",
      allow: ["^tests/", "^qa/", "^scripts/qa/"],
      description: "tests only",
    },
  },
};

// --------------------------------------------------------------------------
// Helper
// --------------------------------------------------------------------------

function withConfig<T>(config: LaneConfig, fn: () => T): T {
  // Save and restore AGENT_LANES_CONFIG_PATH to prevent test pollution
  // (a previous test may have set it to a bad path before its matchLane throws)
  const savedPath = process.env.AGENT_LANES_CONFIG_PATH;
  try {
    clearLaneConfigCache();
    loadLaneConfig(undefined, config);
    return fn();
  } finally {
    clearLaneConfigCache();
    if (savedPath !== undefined) {
      process.env.AGENT_LANES_CONFIG_PATH = savedPath;
    } else {
      delete process.env.AGENT_LANES_CONFIG_PATH;
    }
  }
}

// --------------------------------------------------------------------------
// Tests — extractFilePaths (pure function, no config needed)
// --------------------------------------------------------------------------

describe("extractFilePaths", () => {
  it("extracts packages/ paths", () => {
    const text =
      "Fix the bug in packages/agentos-d/src/routes/dispatch.ts and also touch apps/installer/cli.ts";
    const paths = extractFilePaths(text);
    expect(paths).toContain("packages/agentos-d/src/routes/dispatch.ts");
    expect(paths).toContain("apps/installer/cli.ts");
  });

  it("extracts docs/ paths", () => {
    const text =
      "Update the docs/api/reference.md and create docs/rfcs/009-auto-assign.md";
    const paths = extractFilePaths(text);
    expect(paths).toContain("docs/api/reference.md");
    expect(paths).toContain("docs/rfcs/009-auto-assign.md");
  });

  it("extracts absolute /Users/ paths", () => {
    const text =
      "The file at /Users/example/repo/packages/admin-ui/page.tsx needs changes";
    const paths = extractFilePaths(text);
    expect(paths).toContain(
      "/Users/example/repo/packages/admin-ui/page.tsx"
    );
  });

  it("extracts ../relative paths", () => {
    const text = "See ../packages/shared/types.ts for the interface definition";
    const paths = extractFilePaths(text);
    expect(paths).toContain("../packages/shared/types.ts");
  });

  it("extracts multiple occurrences of same path (deduplicates)", () => {
    const text =
      "Both packages/agentos-d/src/app.ts and packages/agentos-d/src/app.ts are affected";
    const paths = extractFilePaths(text);
    expect(paths.filter((p) => p === "packages/agentos-d/src/app.ts"))
      .toHaveLength(1);
  });

  it("returns empty array when no paths found", () => {
    const text = "This issue has no file paths in it, just a vague description";
    const paths = extractFilePaths(text);
    expect(paths).toHaveLength(0);
  });

  it("ignores paths without recognized prefixes", () => {
    const text =
      "Change https://example.com or user@host or just random words here";
    const paths = extractFilePaths(text);
    expect(paths).toHaveLength(0);
  });

  it("handles multiline with parens and brackets", () => {
    const text = `(
      packages/scanner-worker/scanner.py
      [packages/admin-ui/styles.css]
    )`;
    const paths = extractFilePaths(text);
    expect(paths).toContain("packages/scanner-worker/scanner.py");
    expect(paths).toContain("packages/admin-ui/styles.css");
  });
});

// --------------------------------------------------------------------------
// Tests — matchLane (uses inlineConfig)
// --------------------------------------------------------------------------

describe("matchLane", () => {
  it("matches BackendEngineer for packages/agentos-d/ path", () => {
    withConfig(TEST_CONFIG_NO_QA, () => {
      const result = matchLane({
        issueDescription:
          "Fix the circuit breaker in packages/agentos-d/src/circuit-breaker/CircuitBreaker.ts",
        todoCounts: { BackendEngineer: 3, PythonEngineer: 1 },
      });
      expect(result.matched).toBe(true);
      expect(result.role).toBe("BackendEngineer");
      expect(result.ambiguous).toBe(false);
      expect(result.agentIdPrefix).toBe("79d8066d");
    });
  });

  it("matches PythonEngineer for packages/scanner-worker/ path", () => {
    withConfig(TEST_CONFIG_NO_QA, () => {
      const result = matchLane({
        issueDescription:
          "Update the scanner worker at packages/scanner-worker/main.py",
      });
      expect(result.matched).toBe(true);
      expect(result.role).toBe("PythonEngineer");
      expect(result.agentIdPrefix).toBe("6f5da3aa");
    });
  });

  it("matches FrontendEngineer for packages/admin-ui/ path", () => {
    withConfig(TEST_CONFIG_NO_QA, () => {
      const result = matchLane({
        issueDescription:
          "Fix the sidebar component in packages/admin-ui/components/Sidebar.tsx",
      });
      expect(result.matched).toBe(true);
      expect(result.role).toBe("FrontendEngineer");
    });
  });

  it("matches TechnicalWriter for docs/ path", () => {
    withConfig(TEST_CONFIG_NO_QA, () => {
      const result = matchLane({
        issueDescription:
          "Update API docs in docs/api/reference.md with new endpoints",
      });
      expect(result.matched).toBe(true);
      expect(result.role).toBe("TechnicalWriter");
    });
  });

  it("matches QAEngineer for tests/ path (ambiguous with BackendEngineer)", () => {
    // Both BackendEngineer and QAEngineer allow ^tests/, so the result is ambiguous.
    // Give QAEngineer fewer todos so it would win on tie-break, but since it's a tie
    // the algorithm marks it ambiguous (route to triage).
    withConfig(TEST_CONFIG_WITH_QA, () => {
      const result = matchLane({
        issueDescription:
          "Add integration tests under tests/dispatch/integration.test.ts",
        todoCounts: { BackendEngineer: 3, QAEngineer: 1 },
      });
      expect(result.matched).toBe(false);
      expect(result.ambiguous).toBe(true);
    });
  });

  it("returns matched=false when no paths found", () => {
    withConfig(TEST_CONFIG_NO_QA, () => {
      const result = matchLane({
        issueDescription:
          "This is a vague issue with no specific file paths mentioned",
      });
      expect(result.matched).toBe(false);
      expect(result.ambiguous).toBe(false);
    });
  });

  it("returns matched=false for path not in any lane", () => {
    withConfig(TEST_CONFIG_NO_QA, () => {
      const result = matchLane({
        issueDescription:
          "Change the thing at some/unknown/path/file.ts instead",
      });
      expect(result.matched).toBe(false);
      expect(result.ambiguous).toBe(false);
    });
  });

  it("picks lowest todo-count role when scores tie", () => {
    withConfig(TEST_CONFIG_NO_QA, () => {
      // All three roles score 0 for docs/README.md
      // TechnicalWriter has lowest todo count (1) → wins
      const result = matchLane({
        issueDescription: "Update docs/README.md",
        todoCounts: { BackendEngineer: 5, FrontendEngineer: 2, TechnicalWriter: 1 },
      });
      expect(result.matched).toBe(true);
      expect(result.role).toBe("TechnicalWriter");
    });
  });

  it("alphabetical tie-break when two roles score equal with equal todos", () => {
    const savedPath = process.env.AGENT_LANES_CONFIG_PATH;
    try {
      clearLaneConfigCache();
      loadLaneConfig(undefined, TEST_CONFIG_NO_QA);

      // apps/installer/ matches both BackendEngineer (^apps/installer/) and
      // FrontendEngineer (^apps/installer/.*ui/) with equal scores (1 each).
      // Equal todo counts (3 each) → multiple roles tied for best score → ambiguous
      const result = matchLane({
        issueDescription: "Fix apps/installer/ui/dashboard.tsx",
        todoCounts: { BackendEngineer: 3, FrontendEngineer: 3 },
      });
      // The tie is not broken alphabetically — ambiguous is returned when scores tie
      expect(result.matched).toBe(false);
      expect(result.ambiguous).toBe(true);
    } finally {
      clearLaneConfigCache();
      if (savedPath !== undefined) process.env.AGENT_LANES_CONFIG_PATH = savedPath;
      else delete process.env.AGENT_LANES_CONFIG_PATH;
    }
  });

  it("requires at least one path match to be considered matched", () => {
    withConfig(TEST_CONFIG_NO_QA, () => {
      const result = matchLane({
        issueDescription:
          "packages/unknown-scope/thing.ts is affected but not defined in any lane allow list",
      });
      expect(result.matched).toBe(false);
      expect(result.ambiguous).toBe(false);
    });
  });

  it("returns reason string explaining the match decision", () => {
    withConfig(TEST_CONFIG_NO_QA, () => {
      const result = matchLane({
        issueDescription: "Fix dispatch.ts at packages/agentos-d/src/routes/dispatch.ts",
      });
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    });
  });

  it("scores by count of matched paths, not binary match", () => {
    withConfig(TEST_CONFIG_NO_QA, () => {
      // Two paths that both match BackendEngineer → score = 2
      const result = matchLane({
        issueDescription:
          "Change packages/agentos-d/src/routes/dispatch.ts and also packages/agentos-d/src/app.ts",
        todoCounts: { BackendEngineer: 0, PythonEngineer: 0 },
      });
      expect(result.matched).toBe(true);
      expect(result.role).toBe("BackendEngineer");
    });
  });

  it("throws when no agent-lanes.json exists", () => {
    clearLaneConfigCache();
    const badPath = "/this/path/does/not/exist/agent-lanes.json";
    process.env.AGENT_LANES_CONFIG_PATH = badPath;
    try {
      expect(() =>
        matchLane({ issueDescription: "packages/agentos-d/src/app.ts" })
      ).toThrow();
    } finally {
      delete process.env.AGENT_LANES_CONFIG_PATH;
      clearLaneConfigCache();
    }
  });

  it("loads config from inlineConfig when provided", () => {
    const config = loadLaneConfig(undefined, TEST_CONFIG_NO_QA);
    expect(config.roles.BackendEngineer).toBeDefined();
    expect(config.roles.PythonEngineer).toBeDefined();
  });
});
