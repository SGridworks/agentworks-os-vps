/**
 * Auto-Assign Service: picks a specific agent for a lane-matched role.
 *
 * Given a role name returned by lane-matcher.ts (e.g. "BackendEngineer"),
 * this service:
 * 1. Resolves the role's agent_id_prefix from agent-lanes.json
 * 2. Finds all agents in the company whose ID starts with that prefix
 * 3. Counts their current todo + in_progress issues
 * 4. Returns the least-loaded agent (tie-break: alphabetical by agent name)
 *
 * Integration: called by routes/issues.ts after lane-matching returns a role.
 * If the role returns null/unassignable, routes/issues.ts returns triage=true.
 */

import { loadLaneConfig } from "./lane-matcher.js";
import type { LaneConfig } from "./lane-matcher.js";
import { getSqlite } from "../db/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentIssueCounts {
  agentId: string;
  agentName: string;
  todo: number;
  inProgress: number;
  total: number;
}

export interface AutoAssignResult {
  /** Agent ID of the selected assignee, or null if no assignable agent found */
  assigneeAgentId: string | null;
  /** Human-readable reason for the assignment decision */
  reason: string;
  /** Which lane role was matched */
  role: string | null;
  /** True if the issue should go to triage (no clear winner, or no agents) */
  triage: boolean;
  /** All candidate agents with their load (for debugging/triage UI) */
  candidates: AgentIssueCounts[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ExecutionAgent {
  id: string;
  name: string;
  role: string | null;
}

interface ExecutionIssue {
  id: string;
  assigneeAgentId: string | null;
  status: string;
}

/** List all agents in a company. */
async function listCompanyAgents(
  companyId: string,
  _signal?: AbortSignal,
): Promise<ExecutionAgent[]> {
  const rows = getSqlite()
    .prepare("SELECT id, name, role FROM execution_agents WHERE company_id = ? AND status = 'active'")
    .all(companyId) as Array<{ id: string; name: string; role: string | null }>;
  return rows;
}

/** List all non-done issues for a company (paginated; fetches first 500). */
async function listCompanyIssues(
  companyId: string,
  _signal?: AbortSignal,
): Promise<ExecutionIssue[]> {
  const rows = getSqlite()
    .prepare("SELECT id, assignee_agent_id, status FROM execution_issues WHERE company_id = ?")
    .all(companyId) as Array<{ id: string; assignee_agent_id: string | null; status: string }>;
  return rows.map((row) => ({
    id: row.id,
    assigneeAgentId: row.assignee_agent_id,
    status: row.status,
  }));
}

/**
 * Count open (todo + in_progress) issues per agent from a flat list.
 * Ignores issues with no assignee.
 */
function countOpenIssuesPerAgent(issues: ExecutionIssue[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const issue of issues) {
    if (issue.assigneeAgentId && issue.status !== "done" && issue.status !== "cancelled" && issue.status !== "blocked") {
      counts[issue.assigneeAgentId] = (counts[issue.assigneeAgentId] ?? 0) + 1;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Auto-assign an issue to the least-loaded agent matching the given role.
 *
 * @param role          Role name from lane-matcher (e.g. "BackendEngineer")
 * @param companyId     Execution company ID
 * @param config        Optional LaneConfig override (defaults to loading from file)
 * @param signal        AbortSignal for cancellation
 */
export async function autoAssignAgent(
  role: string,
  companyId: string,
  config?: LaneConfig,
  signal?: AbortSignal,
): Promise<AutoAssignResult> {
  const laneConfig = config ?? loadLaneConfig();

  // 1. Resolve agent_id_prefix for the given role
  const roleEntry = laneConfig.roles[role];
  if (!roleEntry) {
    return {
      assigneeAgentId: null,
      reason: `Role "${role}" not found in agent-lanes.json`,
      role,
      triage: true,
      candidates: [],
    };
  }

  const { agent_id_prefix: prefix } = roleEntry;

  // 2. Fetch agents in company + issues in parallel
  const [agents, issues] = await Promise.all([
    listCompanyAgents(companyId, signal).catch((err) => {
      console.error(`[auto-assign] failed to list agents: ${err}`);
      return [] as ExecutionAgent[];
    }),
    listCompanyIssues(companyId, signal).catch((err) => {
      console.error(`[auto-assign] failed to list issues: ${err}`);
      return [] as ExecutionIssue[];
    }),
  ]);

  // 3. Filter agents whose ID starts with the prefix or whose role matches.
  const matchingAgents = agents.filter(
    (a) => a.id.startsWith(prefix) || normalizeRole(a.role) === normalizeRole(role),
  );

  if (matchingAgents.length === 0) {
    return {
      assigneeAgentId: null,
      reason: `No agents found with ID prefix ${prefix} for role "${role}"`,
      role,
      triage: true,
      candidates: [],
    };
  }

  // 4. Count open issues per agent
  const openCounts = countOpenIssuesPerAgent(issues);

  // 5. Build candidate list with load info
  const candidates: AgentIssueCounts[] = matchingAgents.map((a) => {
    const open = openCounts[a.id] ?? 0;
    return {
      agentId: a.id,
      agentName: a.name ?? a.id,
      todo: 0, // per-agent breakdown not needed for selection; total is sufficient
      inProgress: 0,
      total: open,
    };
  });

  // 6. Sort by total asc, then alphabetically for tie-break
  candidates.sort((a, b) => {
    if (a.total !== b.total) return a.total - b.total;
    return a.agentName.localeCompare(b.agentName);
  });

  const winner = candidates[0]!;

  return {
    assigneeAgentId: winner.agentId,
    reason: `Assigned to ${winner.agentName} (${winner.total} open issues; role=${role})`,
    role,
    triage: false,
    candidates,
  };
}

function normalizeRole(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
