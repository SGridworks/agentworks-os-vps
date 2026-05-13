import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDefaultInstructionsPath } from "./instructions-resolver.js";

let agentsRoot: string;

beforeEach(() => {
  agentsRoot = mkdtempSync(join(tmpdir(), "awo-resolver-"));
  for (const folder of ["backend", "qa", "processwatcher", "writer"]) {
    mkdirSync(join(agentsRoot, folder), { recursive: true });
    writeFileSync(join(agentsRoot, folder, "AGENTS.md"), "# stub\n");
  }
});

afterEach(() => {
  rmSync(agentsRoot, { recursive: true, force: true });
});

describe("resolveDefaultInstructionsPath", () => {
  it("matches role to same-named folder", () => {
    expect(resolveDefaultInstructionsPath(null, "qa", agentsRoot)).toBe("qa/AGENTS.md");
  });

  it("aliases pm role to processwatcher", () => {
    expect(resolveDefaultInstructionsPath(null, "pm", agentsRoot)).toBe(
      "processwatcher/AGENTS.md"
    );
  });

  it("aliases ProjectManager role variants", () => {
    expect(resolveDefaultInstructionsPath(null, "ProjectManager", agentsRoot)).toBe(
      "processwatcher/AGENTS.md"
    );
  });

  it("aliases generic engineer role to backend", () => {
    expect(resolveDefaultInstructionsPath(null, "engineer", agentsRoot)).toBe(
      "backend/AGENTS.md"
    );
  });

  it("falls through to name alias when role has no folder or alias", () => {
    expect(resolveDefaultInstructionsPath("BackendEngineer", "unknownRole", agentsRoot)).toBe(
      "backend/AGENTS.md"
    );
  });

  it("returns null when nothing matches", () => {
    expect(resolveDefaultInstructionsPath("Random", "weird", agentsRoot)).toBeNull();
  });
});
