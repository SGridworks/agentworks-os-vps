/**
 * Resolves the on-disk AGENTS.md path for an agent based on its name + role,
 * matching the same rules used by migrations 0027 (role-folder) and 0029
 * (name-alias). Used by:
 *   - migration 0027 (role match)
 *   - migration 0029 (name alias)
 *   - POST /api/agents (create-time backfill)
 *   - PATCH /api/agents/:id (when name/role changes and instructionsPath is unset)
 *
 * Returns the path RELATIVE to agentsRoot (e.g. "ceo/AGENTS.md") so callers
 * can validate it against the sandbox in routes/agent.ts.
 */

import fs from "node:fs";
import path from "node:path";

const NAME_ALIAS_TO_FOLDER: Record<string, string> = {
  backendengineer: "backend",
  frontendengineer: "frontend",
  pythonengineer: "python",
  devopsengineer: "devops",
  qaengineer: "qa",
  techlead: "techlead",
  processwatcher: "processwatcher",
  technicalwriter: "writer",
  complianceconsultant: "compliance",
  pm: "processwatcher",
  projectmanager: "processwatcher",
};

// Role values from POST /api/agents that don't have a same-named folder.
// The PM role conceptually maps to processwatcher (planning + progress oversight).
const ROLE_ALIAS_TO_FOLDER: Record<string, string> = {
  pm: "processwatcher",
  projectmanager: "processwatcher",
  engineer: "backend",
  writer: "writer",
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s_-]/g, "");
}

export function resolveDefaultInstructionsPath(
  name: string | null | undefined,
  role: string | null | undefined,
  agentsRoot: string
): string | null {
  if (role) {
    const rel = `${role}/AGENTS.md`;
    if (fs.existsSync(path.join(agentsRoot, rel))) return rel;
    const aliased = ROLE_ALIAS_TO_FOLDER[normalize(role)];
    if (aliased) {
      const aliasRel = `${aliased}/AGENTS.md`;
      if (fs.existsSync(path.join(agentsRoot, aliasRel))) return aliasRel;
    }
  }
  if (name) {
    const key = normalize(name);
    const folder = NAME_ALIAS_TO_FOLDER[key];
    if (folder) {
      const rel = `${folder}/AGENTS.md`;
      if (fs.existsSync(path.join(agentsRoot, rel))) return rel;
    }
  }
  return null;
}
