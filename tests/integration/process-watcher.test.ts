// tests/integration/process-watcher.test.ts
// Integration tests for the ProcessWatcher heartbeat orchestrator.
// Mocks the AWOS API client to test the full runHeartbeat() flow,
// including per-check logic, dedup, comment posting, and daily digest.

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProcessWatcher } from "../../packages/agentos-d/src/services/process-watcher/processWatcher.js";
import type { ProcessWatcherConfig, DedupState } from "../../packages/agentos-d/src/services/process-watcher/types.js";
import type { AwosApiClient } from "../../packages/agentos-d/src/services/process-watcher/awosApiClient.js";

// ------------------------------------------------------------------------------------------------------------------------------------------
// Isolated dedup state per test — each test gets its own temp files so findings are
// never deduped against state from other tests in the same run.
// ------------------------------------------------------------------------------------------------------------------------------------------
let _testCounter = 0;

beforeEach(async () => {
  // Use a fresh path per test to guarantee isolation. Using a shared dir with a
  // per-test filename is simpler and faster than creating a new temp dir each time.
  const id = ++_testCounter;
  process.env.PW_DEDUP_STATE_PATH = join(tmpdir(), `pw-test-dedup-${id}.json`);
  process.env.PW_REPORTED_COMMITS_PATH = join(tmpdir(), `pw-test-reported-${id}.json`);
});

afterAll(async () => {
  // Clean up any stray files that weren't collected (tests that didn't run to completion)
  for (let i = 1; i <= _testCounter; i++) {
    const dedup = join(tmpdir(), `pw-test-dedup-${i}.json`);
    const reported = join(tmpdir(), `pw-test-reported-${i}.json`);
    await rm(dedup, { force: true }).catch(() => {});
    await rm(reported, { force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Helper: build a minimal config
// ---------------------------------------------------------------------------
function makeConfig(overrides: Partial<ProcessWatcherConfig> = {}): ProcessWatcherConfig {
  const freshDedupState: DedupState = {
    seenFindings: {},
    lastRunAt: new Date(0).toISOString(),
    resolvedIssueIds: {},
  };
  return {
    staleInProgressThresholdMin: 45,
    prematureDoneWindowSec: 60,
    queueDepthWatermark: 8,
    failedRunThresholdHrs: 2,
    blockedStuckThresholdHrs: 24,
    commitScopeLogPath: "/nonexistent/commit-scope.log",
    awosApiUrl: "http://127.0.0.1:3100",
    awosApiKey: "test-key",
    companyId: "test-company",
    criticalMentionTarget: "ceo",
    standingIssueId: "standing-issue-001",
    heartbeatIntervalMin: 30,
    digestTargetIssueId: "digest-issue-001",
    agentosApiUrl: "http://127.0.0.1:3000",
    agentosApiKey: "test-key",
    _dedupState: freshDedupState,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// MockAwosApiClient
// ---------------------------------------------------------------------------
// Mirrors the real AwosApiClient interface but records calls and returns
// fixture data. Injected via the ProcessWatcher constructor.

interface MockAgent {
  id: string;
  name: string;
}

interface MockIssue {
  id: string;
  identifier: string;
  status: string;
  updatedAt: string;
  completedAt: string | null;
  assigneeAgentId: string | null;
  executionRunId: string | null;
  latestCommentAt: string | null;
}

interface MockComment {
  id: string;
  createdAt: string;
  body: string;
}

function createMockClient() {
  const agents: MockAgent[] = [];
  const issueMap = new Map<string, MockIssue>();
  const commentsByIssue = new Map<string, MockComment[]>();
  const postedComments: Array<{ issueId: string; body: string }> = [];

  const client: AwosApiClient = {
    getIssues: vi.fn((_companyId: string, statuses: string[]) =>
      Promise.resolve(Array.from(issueMap.values()).filter((i) => statuses.includes(i.status)))
    ),
    getAgents: vi.fn(() => Promise.resolve([...agents])),
    getLastComment: vi.fn((issueId: string) =>
      Promise.resolve(
        (commentsByIssue.get(issueId) ?? [])
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null
      )
    ),
    postComment: vi.fn((issueId: string, body: string) => {
      postedComments.push({ issueId, body });
      return Promise.resolve(true);
    }),
  } as unknown as AwosApiClient;

  function addIssue(
    overrides: Partial<MockIssue> & { id: string; identifier: string; status: string }
  ) {
    const issue: MockIssue = {
      id: "default-id",
      identifier: "AWO-999",
      status: "todo",
      updatedAt: new Date().toISOString(),
      completedAt: null,
      assigneeAgentId: null,
      executionRunId: null,
      latestCommentAt: null,
      ...overrides,
    };
    issueMap.set(issue.id, issue);
    return issue;
  }

  function addAgent(id: string, name: string) {
    agents.push({ id, name });
  }

  function addComment(issueId: string, body: string, createdAt?: string) {
    const comments = commentsByIssue.get(issueId) ?? [];
    comments.push({
      id: `comment-${comments.length + 1}`,
      body,
      createdAt: createdAt ?? new Date().toISOString(),
    });
    commentsByIssue.set(issueId, comments);
  }

  function reset() {
    agents.length = 0;
    issueMap.clear();
    commentsByIssue.clear();
    postedComments.length = 0;
  }

  return { client, addIssue, addAgent, addComment, postedComments, reset };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProcessWatcher runHeartbeat", () => {
  let mock: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mock = createMockClient();
  });

  it("runs all seven checks even when some return empty results", async () => {
    const watcher = new ProcessWatcher(makeConfig(), mock.client);
    const result = await watcher.runHeartbeat();
    expect(result.errors).toHaveLength(0);
    expect(result.newFindings).toHaveLength(0);
  });

  it("flags stale in_progress issue (check 1)", async () => {
    mock.addAgent("agent-1", "BackendEngineer");
    mock.addIssue({
      id: "issue-stale",
      identifier: "AWO-100",
      status: "in_progress",
      assigneeAgentId: "agent-1",
      updatedAt: new Date(Date.now() - 50 * 60 * 1000).toISOString(), // 50 min ago
    });

    const watcher = new ProcessWatcher(makeConfig(), mock.client);
    const result = await watcher.runHeartbeat();

    expect(result.newFindings.some((f) => f.checkId === "stale_in_progress")).toBe(true);
    const stale = result.newFindings.find((f) => f.checkId === "stale_in_progress");
    expect(stale!.targetIssueId).toBe("issue-stale");
    expect(stale!.severity).toBe("warn");

    // Comment should have been posted to the offending ticket
    const posted = mock.postedComments.find((c) => c.issueId === "issue-stale");
    expect(posted).toBeDefined();
    expect(posted!.body).toContain("[ProcessWatcher]");
    expect(posted!.body).toContain("stale_in_progress");
  });

  it("flags premature done with auto-commit evidence (check 2 + 4)", async () => {
    mock.addAgent("agent-1", "BackendEngineer");
    const completedAt = new Date(Date.now() - 30 * 1000).toISOString(); // 30s ago
    mock.addIssue({
      id: "issue-done",
      identifier: "AWO-148",
      status: "done",
      completedAt,
      updatedAt: completedAt,
      assigneeAgentId: "agent-1",
      executionRunId: "run-148",
    });
    // No close-comment hygiene — triggers premature_done (critical due to auto-commit evidence).
    // hasAutoCommit must be injected so the test controls its return value.
    // _commitsSince is injected to prevent the test identifier colliding with real git history.
    // globalThis.fetch must be mocked so resolve-lane-assignment doesn't silently fail.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 200 })
    );
    const watcher = new ProcessWatcher(makeConfig({
      _hasAutoCommit: async (_id, _runId) => true,
      _commitsSince: async () => [],
    }), mock.client);
    const result = await watcher.runHeartbeat();
    fetchSpy.mockRestore();

    // Should trigger premature_done
    const premature = result.newFindings.find((f) => f.checkId === "premature_done");
    expect(premature).toBeDefined();
    expect(premature!.severity).toBe("critical"); // has auto-commit evidence
    expect(premature!.targetIdentifier).toBe("AWO-148");
  });

  it("does NOT flag done issue with hygiene comment", async () => {
    mock.addAgent("agent-1", "BackendEngineer");
    const completedAt = new Date(Date.now() - 30 * 1000).toISOString();
    const commentAt = new Date(Date.now() - 10 * 1000).toISOString();
    mock.addIssue({
      id: "issue-done-clean",
      identifier: "AWO-NO-HYGIENE-FLAG",
      status: "done",
      completedAt,
      updatedAt: completedAt,
      assigneeAgentId: "agent-1",
      executionRunId: null, // no run ID → auto_commit_close_mismatch check also skips this
    });
    // Hygiene comment posted AFTER completion.
    // Must include "/" per lastCommentHygiene: body.includes("/") && (pnpm || test || ...)
    mock.addComment("issue-done-clean", "Done. /test run — all pass.", commentAt);

    // Inject _commitsSince to prevent test identifier from colliding with real git history.
    // Also mock globalThis.fetch so resolve-lane-assignment doesn't emit errors.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 200 })
    );
    const watcher = new ProcessWatcher(makeConfig({
      _commitsSince: async () => [],
    }), mock.client);
    const result = await watcher.runHeartbeat();
    fetchSpy.mockRestore();

    expect(result.newFindings.filter((f) => f.checkId === "premature_done")).toHaveLength(0);
  });

  it("flags queue depth overflow (check 5)", async () => {
    mock.addAgent("agent-1", "BackendEngineer");
    mock.addAgent("agent-2", "FrontendEngineer");
    // BackendEngineer has 10 todos (over watermark of 8)
    for (let i = 0; i < 10; i++) {
      mock.addIssue({
        id: `todo-be-${i}`,
        identifier: `AWO-BE-${i}`,
        status: "todo",
        assigneeAgentId: "agent-1",
      });
    }
    // FrontendEngineer has 3 todos (within watermark)
    for (let i = 0; i < 3; i++) {
      mock.addIssue({
        id: `todo-fe-${i}`,
        identifier: `AWO-FE-${i}`,
        status: "todo",
        assigneeAgentId: "agent-2",
      });
    }

    const watcher = new ProcessWatcher(makeConfig(), mock.client);
    const result = await watcher.runHeartbeat();

    const queueFinding = result.newFindings.find((f) => f.checkId === "queue_depth");
    expect(queueFinding).toBeDefined();
    expect(queueFinding!.severity).toBe("info");
    expect(queueFinding!.agentId).toBe("agent-1");
    expect(queueFinding!.targetIssueId).toBeNull(); // queue depth findings are agent-level
  });

  it("flags blocked ticket stuck too long (check 7)", async () => {
    mock.addAgent("agent-1", "BackendEngineer");
    const updatedAt = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(); // 30h ago
    mock.addIssue({
      id: "issue-blocked",
      identifier: "AWO-200",
      status: "blocked",
      updatedAt,
      assigneeAgentId: "agent-1",
      latestCommentAt: updatedAt, // no recent comment either
    });

    const watcher = new ProcessWatcher(
      makeConfig({ blockedStuckThresholdHrs: 24 }),
      mock.client
    );
    const result = await watcher.runHeartbeat();

    const blockedFinding = result.newFindings.find((f) => f.checkId === "blocked_ticket_stuck");
    expect(blockedFinding).toBeDefined();
    expect(blockedFinding!.targetIssueId).toBe("issue-blocked");
    expect(blockedFinding!.severity).toBe("warn");
  });

  it("does NOT flag blocked ticket with recent comment", async () => {
    mock.addAgent("agent-1", "BackendEngineer");
    const updatedAt = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(); // 30h ago
    const recentComment = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
    mock.addIssue({
      id: "issue-blocked-active",
      identifier: "AWO-201",
      status: "blocked",
      updatedAt,
      assigneeAgentId: "agent-1",
      latestCommentAt: recentComment,
    });

    const watcher = new ProcessWatcher(
      makeConfig({ blockedStuckThresholdHrs: 24 }),
      mock.client
    );
    const result = await watcher.runHeartbeat();

    expect(result.newFindings.filter((f) => f.checkId === "blocked_ticket_stuck")).toHaveLength(0);
  });

  it("deduplicates: same finding not reported twice across heartbeats", async () => {
    mock.addAgent("agent-1", "BackendEngineer");
    mock.addIssue({
      id: "issue-stale-dedup",
      identifier: "AWO-300",
      status: "in_progress",
      assigneeAgentId: "agent-1",
      updatedAt: new Date(Date.now() - 50 * 60 * 1000).toISOString(),
    });

    const watcher = new ProcessWatcher(makeConfig(), mock.client);

    // First heartbeat — should report
    const first = await watcher.runHeartbeat();
    expect(first.newFindings.some((f) => f.checkId === "stale_in_progress")).toBe(true);

    // Second heartbeat — same issue still stale but should be deduped
    const second = await watcher.runHeartbeat();
    expect(second.newFindings.filter((f) => f.checkId === "stale_in_progress")).toHaveLength(0);
  });

  it("critical findings mention @ceo in the posted comment", async () => {
    mock.addAgent("agent-1", "BackendEngineer");
    const completedAt = new Date(Date.now() - 30 * 1000).toISOString();
    mock.addIssue({
      id: "issue-critical",
      identifier: "AWO-500",
      status: "done",
      completedAt,
      updatedAt: completedAt,
      assigneeAgentId: "agent-1",
      executionRunId: "run-500",
    });
    // Inject hasAutoCommit so the issue produces a critical finding.
    // Inject _commitsSince to prevent test identifier from colliding with real git history.
    // Mock globalThis.fetch so resolve-lane-assignment succeeds and comment posting is not suppressed.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 200 })
    );
    const watcher = new ProcessWatcher(makeConfig({
      _hasAutoCommit: async (_id, _runId) => true,
      _commitsSince: async () => [],
    }), mock.client);
    await watcher.runHeartbeat();
    fetchSpy.mockRestore();

    const criticalComment = mock.postedComments.find(
      (c) => c.issueId === "issue-critical" && c.body.includes("@ceo")
    );
    expect(criticalComment).toBeDefined();
  });

  it("posts daily digest when findings exist", async () => {
    mock.addAgent("agent-1", "BackendEngineer");
    mock.addIssue({
      id: "issue-digest",
      identifier: "AWO-600",
      status: "in_progress",
      assigneeAgentId: "agent-1",
      updatedAt: new Date(Date.now() - 50 * 60 * 1000).toISOString(),
    });

    const watcher = new ProcessWatcher(makeConfig(), mock.client);
    const result = await watcher.runHeartbeat();

    expect(result.newFindings.length).toBeGreaterThan(0);

    const digestComment = mock.postedComments.find((c) => c.issueId === "digest-issue-001");
    expect(digestComment).toBeDefined();
    expect(digestComment!.body).toContain("ProcessWatcher Daily Digest");
    expect(digestComment!.body).toContain("stale_in_progress");
  });

  it("skips digest post if already posted today", async () => {
    mock.addAgent("agent-1", "BackendEngineer");
    mock.addIssue({
      id: "issue-digest-2",
      identifier: "AWO-601",
      status: "in_progress",
      assigneeAgentId: "agent-1",
      updatedAt: new Date(Date.now() - 50 * 60 * 1000).toISOString(),
    });

    const watcher = new ProcessWatcher(makeConfig(), mock.client);

    await watcher.runHeartbeat();
    const countAfterFirst = mock.postedComments.filter(
      (c) => c.issueId === "digest-issue-001"
    ).length;

    // Second heartbeat same day — should NOT post another digest
    await watcher.runHeartbeat();
    const countAfterSecond = mock.postedComments.filter(
      (c) => c.issueId === "digest-issue-001"
    ).length;

    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it("calls resolve-lane-assignment PATCH for done and closed issues", async () => {
    mock.addIssue({
      id: "issue-done-resolve",
      identifier: "AWO-700",
      status: "done",
      completedAt: new Date().toISOString(),
    });
    mock.addIssue({
      id: "issue-closed-resolve",
      identifier: "AWO-701",
      status: "closed",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 200 })
    );

    const watcher = new ProcessWatcher(makeConfig(), mock.client);
    await watcher.runHeartbeat();

    const resolveCalls = fetchSpy.mock.calls.filter(
      ([url]) => (url as string).includes("/resolve-lane-assignment")
    );
    expect(resolveCalls.length).toBe(2);

    fetchSpy.mockRestore();
  });

  it("exits cleanly when board is clean (no errors, no findings)", async () => {
    mock.addAgent("agent-1", "BackendEngineer");
    // Only non-stale, non-blocked, done-with-hygiene issues — nothing to flag

    const watcher = new ProcessWatcher(makeConfig(), mock.client);
    const result = await watcher.runHeartbeat();

    expect(result.newFindings).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

describe("ProcessWatcher checkOffLaneCommits integration", () => {
  // Off-lane commit check requires a real log path. These tests use a
  // temp file to verify parsing without needing the actual upstream setup.

  it("parses OFF-LANE entries from a commit-scope log", async () => {
    const { checkOffLaneCommits } = await import(
      "../../packages/agentos-d/src/services/process-watcher/checks/checkOffLaneCommits.js"
    );

    const os = await import("node:os");
    const { writeFile, unlink } = await import("node:fs/promises");
    const tmp = os.tmpdir();
    const logPath = `${tmp}/pw-test-offlane-${Date.now()}.log`;

    await writeFile(
      logPath,
      [
        "[12:34:56] OFF-LANE abc1234 role=BackendEngineer:",
        "  packages/agentos-d/src/app.ts",
        "  packages/shared/src/index.ts",
        "",
        "[12:35:00] PASS BackendEngineer role=BackendEngineer:",
        "  packages/agentos-d/src/app.ts",
        "",
      ].join("\n")
    );

    try {
      const result = await checkOffLaneCommits({
        logPath,
        reportedCommits: new Set(),
        standingIssueId: "standing-issue-001",
      });

      expect(result.errors).toHaveLength(0);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]!.checkId).toBe("off_lane_commits");
      expect(result.findings[0]!.severity).toBe("warn");
    } finally {
      await unlink(logPath).catch(() => {});
    }
  });

  it("skips already-reported commits (dedup by hash)", async () => {
    const { checkOffLaneCommits } = await import(
      "../../packages/agentos-d/src/services/process-watcher/checks/checkOffLaneCommits.js"
    );

    const os = await import("node:os");
    const { writeFile, unlink } = await import("node:fs/promises");
    const tmp = os.tmpdir();
    const logPath = `${tmp}/pw-test-offlane-dedup-${Date.now()}.log`;

    await writeFile(
      logPath,
      "[12:34:56] OFF-LANE alreadyknown123 role=BackendEngineer:\n  packages/agentos-d/src/app.ts\n\n"
    );

    try {
      const result = await checkOffLaneCommits({
        logPath,
        reportedCommits: new Set(["alreadyknown123"]),
        standingIssueId: "standing-issue-001",
      });

      expect(result.findings).toHaveLength(0);
    } finally {
      await unlink(logPath).catch(() => {});
    }
  });
});
