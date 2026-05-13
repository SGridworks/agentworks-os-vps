import { describe, it, expect } from "vitest";
import { extractFilePaths, matchLane, loadLaneConfig, clearLaneConfigCache } from "./lane-matcher.js";
import type { LaneConfig } from "./lane-matcher.js";

const TEST_CONFIG_NO_QA: LaneConfig = {
  _universal_allow: ["^agents/[^/]+/AGENTS\\.md$", "^README\\.md$"],
  roles: {
    BackendEngineer: {
      agent_id_prefix: "79d8066d",
      allow: ["^packages/agentos-d/", "^packages/awcp/", "^packages/shared/", "^packages/memory/", "^apps/installer/", "^tests/"],
      description: "agentos-d daemon, AWCP, shared types",
    },
    PythonEngineer: {
      agent_id_prefix: "6f5da3aa",
      allow: ["^packages/scanner-worker/", "^packages/.*\\.py$", "^services/.*\\.py$"],
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

describe("DEBUG alphabetical", () => {
  it("alphabetical", () => {
    const savedPath = process.env.AGENT_LANES_CONFIG_PATH;
    try {
      clearLaneConfigCache();
      loadLaneConfig(undefined, TEST_CONFIG_NO_QA);
      
      const result = matchLane({
        issueDescription: "Update docs/README.md",
        todoCounts: { BackendEngineer: 3, PythonEngineer: 3 },
      });
      console.log("RESULT:", JSON.stringify(result));
      expect(result.matched).toBe(true);
      // docs/README.md matches TechnicalWriter (^docs/ pattern, score=1).
      // BackendEngineer and PythonEngineer score 0 for this path.
      expect(result.role).toBe("TechnicalWriter");
    } finally {
      clearLaneConfigCache();
      if (savedPath !== undefined) process.env.AGENT_LANES_CONFIG_PATH = savedPath;
      else delete process.env.AGENT_LANES_CONFIG_PATH;
    }
  });
});

describe("DEBUG alphabetical 2", () => {
  it("debug", () => {
    const savedPath = process.env.AGENT_LANES_CONFIG_PATH;
    try {
      clearLaneConfigCache();
      loadLaneConfig(undefined, TEST_CONFIG_NO_QA);
      
      const result = matchLane({
        issueDescription: "Fix apps/installer/ui/dashboard.tsx",
        todoCounts: { BackendEngineer: 3, FrontendEngineer: 3 },
      });
      console.log("RESULT:", JSON.stringify(result));
    } finally {
      clearLaneConfigCache();
      if (savedPath !== undefined) process.env.AGENT_LANES_CONFIG_PATH = savedPath;
      else delete process.env.AGENT_LANES_CONFIG_PATH;
    }
  });
});
