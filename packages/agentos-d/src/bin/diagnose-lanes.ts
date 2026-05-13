/**
 * diagnose-lanes — lane assignment diagnostic tool.
 *
 * Usage:
 *   npx tsx src/bin/diagnose-lanes.ts --days 30 --company-id UUID
 *   npx tsx src/bin/diagnose-lanes.ts --days 30 --company-id UUID --format=json
 *
 * Reads lane_assignments from the local SQLite DB and prints a human-readable
 * (or JSON) report of:
 *   - Per-role: assignment count, triage rate, ambiguous rate, resolution breakdown
 *   - Roles with zero assignments in the window (potential pattern gaps)
 *   - Top "triage" descriptions that might indicate missing lane patterns
 */

import { loadConfig } from "../config.js";
import { initDb } from "../db/index.js";
import { migrate } from "../db/migrations/index.js";
import { getDb } from "../db/client.js";
import { laneAssignments } from "../db/schema.js";
import { eq, sql, and, gte } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RoleStats {
  role: string;
  total: number;
  triage: number;
  triageRate: number;
  ambiguous: number;
  ambiguousRate: number;
  completed: number;
  closed: number;
  escalated: number;
  unresolved: number;
}

interface Report {
  generatedAt: string;
  windowDays: number;
  companyId: string;
  totalAssignments: number;
  byRole: RoleStats[];
  zeroAssignmentRoles: string[];
  triageDescriptions: { description: string; count: number }[];
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  days: number;
  companyId: string;
  format: "text" | "json";
} {
  const args = {
    days: 30,
    companyId: "",
    format: "text" as "text" | "json",
  };
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i];
    if (cur === "--days" && i + 1 < argv.length) args.days = parseInt(argv[++i]!, 10);
    else if (cur === "--company-id" && i + 1 < argv.length) args.companyId = argv[++i]!;
    else if (cur === "--format" && i + 1 < argv.length) args.format = argv[++i]! as "text" | "json";
  }
  if (!args.companyId) {
    console.error("ERROR: --company-id is required");
    process.exit(1);
  }
  if (isNaN(args.days) || args.days < 1) {
    console.error("ERROR: --days must be a positive integer");
    process.exit(1);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Core query
// ---------------------------------------------------------------------------

function buildReport(rows: any[], allRoles: string[], days: number, companyId: string): Report {
  // Group by role
  const byRoleMap = new Map<string, RoleStats>();

  for (const row of rows) {
    const role = row.matched_role ?? "(none)";
    if (!byRoleMap.has(role)) {
      byRoleMap.set(role, {
        role,
        total: 0,
        triage: 0,
        triageRate: 0,
        ambiguous: 0,
        ambiguousRate: 0,
        completed: 0,
        closed: 0,
        escalated: 0,
        unresolved: 0,
      });
    }
    const s = byRoleMap.get(role)!;
    s.total++;
    if (row.triage) s.triage++;
    if (row.ambiguous) s.ambiguous++;
    if (row.resolution === "completed") s.completed++;
    else if (row.resolution === "closed") s.closed++;
    else if (row.resolution === "escalated") s.escalated++;
    else s.unresolved++;
  }

  // Compute rates
  for (const s of byRoleMap.values()) {
    s.triageRate = s.total > 0 ? s.triage / s.total : 0;
    s.ambiguousRate = s.total > 0 ? s.ambiguous / s.total : 0;
  }

  // Roles with zero assignments
  const assignedRoles = new Set(byRoleMap.keys());
  const zeroAssignmentRoles = allRoles.filter(
    (r) => !assignedRoles.has(r) && r !== "(none)",
  );

  // Triage descriptions (top 10)
  const triageDescCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.triage) {
      const key = row.lane_match_reason.slice(0, 120);
      triageDescCounts.set(key, (triageDescCounts.get(key) ?? 0) + 1);
    }
  }
  const triageDescriptions = Array.from(triageDescCounts.entries())
    .map(([description, count]) => ({ description, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    companyId,
    totalAssignments: rows.length,
    byRole: Array.from(byRoleMap.values()).sort((a, b) => b.total - a.total),
    zeroAssignmentRoles,
    triageDescriptions,
  };
}

// ---------------------------------------------------------------------------
// Text renderer
// ---------------------------------------------------------------------------

function renderText(report: Report): string {
  const lines: string[] = [];
  const divider = "─".repeat(72);

  lines.push(`Lane Assignment Diagnostic Report`);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Window: last ${report.windowDays} days`);
  lines.push(`Company: ${report.companyId}`);
  lines.push(`Total assignments: ${report.totalAssignments}`);
  lines.push("");

  if (report.byRole.length === 0) {
    lines.push("No lane assignments in this window.");
  } else {
    lines.push(divider);
    lines.push("PER-ROLE BREAKDOWN");
    lines.push(divider);
    lines.push(
      [
        "Role".padEnd(22),
        "Total",
        "Tri%",
        "Amb%",
        "Done",
        "Close",
        "Esc",
        "Open",
      ].join("  "),
    );
    lines.push("".padEnd(72, "─"));

    for (const s of report.byRole) {
      const triPct = (s.triageRate * 100).toFixed(0);
      const ambPct = (s.ambiguousRate * 100).toFixed(0);
      lines.push(
        [
          s.role.padEnd(22),
          String(s.total).padStart(5),
          (triPct + "%").padStart(5),
          (ambPct + "%").padStart(5),
          String(s.completed).padStart(5),
          String(s.closed).padStart(6),
          String(s.escalated).padStart(4),
          String(s.unresolved).padStart(5),
        ].join("  "),
      );
    }
  }

  if (report.zeroAssignmentRoles.length > 0) {
    lines.push("");
    lines.push(divider);
    lines.push("ROLES WITH ZERO ASSIGNMENTS (possible pattern gaps)");
    lines.push(divider);
    for (const role of report.zeroAssignmentRoles) {
      lines.push(`  - ${role}`);
    }
  }

  if (report.triageDescriptions.length > 0) {
    lines.push("");
    lines.push(divider);
    lines.push("TOP TRIAGE REASONS (may indicate missing lane patterns)");
    lines.push(divider);
    for (const { description, count } of report.triageDescriptions) {
      lines.push(`  [${count}] ${description}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const config = loadConfig();
  initDb({ config, migrations: migrate });
  const db = getDb();

  const cutoffDays = args.days;
  const cutoffUnix = Math.floor(Date.now() / 1000) - cutoffDays * 24 * 60 * 60;

  // All known roles from lane config
  const laneConfigPath = process.env.AGENT_LANES_CONFIG_PATH
    ?? join(process.env.HOME ?? "", ".agentworks/scripts/agent-lanes.json");
  let allRoles: string[] = [];
  try {
    const content = await import("node:fs").then((fs) =>
      fs.promises.readFile(laneConfigPath, "utf8"),
    );
    const parsed = JSON.parse(content);
    allRoles = Object.keys(parsed.roles ?? {});
  } catch {
    // Not fatal — continue without zero-assignment role list
  }

  const rows = db
    .select({
      matchedRole: laneAssignments.matchedRole,
      triage: laneAssignments.triage,
      ambiguous: laneAssignments.ambiguous,
      resolution: laneAssignments.resolution,
      laneMatchReason: laneAssignments.laneMatchReason,
    })
    .from(laneAssignments)
    .where(
      and(
        eq(laneAssignments.tenantId, args.companyId),
        gte(sql`unixepoch(${laneAssignments.createdAt})`, cutoffUnix),
      ),
    )
    .all();

  const report = buildReport(rows, allRoles, cutoffDays, args.companyId);

  if (args.format === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderText(report));
  }
}

import { join } from "node:path";

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
