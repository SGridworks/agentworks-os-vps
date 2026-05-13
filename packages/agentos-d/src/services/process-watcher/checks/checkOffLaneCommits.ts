// packages/agentos-d/src/services/process-watcher/checks/checkOffLaneCommits.ts
// Consumes commit-scope.log and produces findings for OFF-LANE revert events.

import { readFile } from "fs/promises";
import type { CheckResult, Finding } from "../types.js";

export interface OffLaneInput {
  logPath: string;
  reportedCommits: Set<string>;
  /** Fallback issue ID to post to when no ticket identifier can be extracted from the commit message */
  standingIssueId: string;
  /**
   * Extract a ticket identifier (e.g. "AWO-123") from a commit message.
   * Returns null if none found — caller can use standingIssueId as fallback.
   */
  extractTicketFromCommit?: (commitHash: string) => Promise<string | null>;
}

interface RawLogEntry {
  timestamp: string;
  hash: string;
  role: string;
  files: string[];
}

function parseLine(
  line: string,
  prevEntry: RawLogEntry | null
): RawLogEntry | null {
  const offLane = line.match(
    /^\[(\d{2}:\d{2}:\d{2})\] OFF-LANE (\w+) role=(\w+):$/
  );
  if (offLane) {
    return {
      timestamp: offLane[1]!,
      hash: offLane[2]!,
      role: offLane[3]!,
      files: [],
    };
  }
  if (prevEntry && (line.startsWith(" ") || line.startsWith("\t"))) {
    const file = line.trim();
    if (file) prevEntry.files.push(file);
    return prevEntry;
  }
  // blank line → commit entry ends
  if (!line.trim() && prevEntry) return null; // null signals end-of-entry
  return null;
}

/** Extract AWO-NN ticket identifier from git commit subject line */
async function defaultExtractTicket(
  commitHash: string,
  cwd: string
): Promise<string | null> {
  try {
    const { execSync } = require("child_process");
    const subject = execSync(
      `git log -1 --format=%s ${commitHash}`,
      { cwd, encoding: "utf-8", timeout: 5000 }
    ).trim();
    const match = subject.match(/AWO-\d+/);
    return match ? match[0]! : null;
  } catch {
    return null;
  }
}

export async function checkOffLaneCommits(
  input: OffLaneInput
): Promise<CheckResult> {
  const { logPath, reportedCommits, standingIssueId, extractTicketFromCommit } = input;
  const findings: Finding[] = [];
  const errors: CheckResult["errors"] = [];

  // Resolve repo root once for git log calls
  const cwd = process.cwd();
  const resolveTicket = extractTicketFromCommit
    ? extractTicketFromCommit
    : (hash: string) => defaultExtractTicket(hash, cwd);

  let raw: string;
  try {
    raw = await readFile(logPath, "utf-8");
  } catch (e: unknown) {
    // ENOENT = log file doesn't exist yet (commit-scope daemon hasn't run).
    // This is an expected state — not an error.
    if (e instanceof Error && e.message.includes("ENOENT")) {
      return { findings, errors };
    }
    const msg = e instanceof Error ? e.message : String(e);
    errors.push({
      checkId: "off_lane_commits",
      message: `Cannot read log: ${msg}`,
    });
    return { findings, errors };
  }

  const entries: RawLogEntry[] = [];
  let current: RawLogEntry | null = null;

  for (const line of raw.split("\n")) {
    const parsed = parseLine(line, current);
    if (!parsed) {
      current = null;
      continue;
    }
    if (parsed === current) continue; // file line, already collected
    if (parsed) {
      current = parsed;
      entries.push(current);
    }
  }

  for (const entry of entries) {
    if (reportedCommits.has(entry.hash)) continue;

    // Try to resolve the ticket ID from the commit message
    let targetIssueId = standingIssueId;
    const ticketId = await resolveTicket(entry.hash);
    if (ticketId) {
      // We have a ticket ID but not its numeric ID — post to the standing issue
      // but annotate with the ticket identifier so Coordinator can route it
      targetIssueId = standingIssueId;
    }

    findings.push({
      checkId: "off_lane_commits",
      severity: "warn",
      targetIssueId,
      targetIdentifier: ticketId ?? `Commit ${entry.hash.slice(0, 7)} (${entry.role})`,
      explanation:
        `Commit \`${entry.hash}\` by ${entry.role} was reverted by commit-scope guard. ` +
        `Files: ${entry.files.join(", ") || "(none recorded)"}. ` +
        (ticketId ? `Ticket identified from commit message: ${ticketId}.` : "No ticket identifier found in commit subject."),
      suggestedAction:
        ticketId
          ? `Route to ${ticketId} assignee. Coordinator: revert off-lane files and open a subtask for the correct agent.`
          : "Identify the ticket for this commit, then follow the off-lane recovery protocol.",
      dedupKey: `off_lane_commits:${entry.hash}`,
    });
  }

  return { findings, errors };
}
