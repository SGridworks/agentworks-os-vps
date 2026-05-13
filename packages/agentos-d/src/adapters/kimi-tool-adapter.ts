/**
 * KimiToolAdapter — multi-turn tool-use loop for BE/FE implementation issues.
 *
 * Tools exposed to the model:
 *   - read_file(path)
 *   - list_dir(path)
 *   - grep(pattern, path?)
 *   - write_file(path, content)
 *   - edit_file(path, old_string, new_string)
 *   - run_test(package_dir)        // bounded vitest run
 *   - submit_for_review(summary)   // finishes the run
 *
 * Lane discipline: writes are restricted by agent role.
 *   BackendEngineer → packages/{agentos-d,memory,policy-engine,shared}/**
 *   FrontendEngineer → packages/admin-ui/**
 * Reads are unrestricted within the repo.
 *
 * Safety:
 *   - 30-turn cap, 60s per LLM call, 90s per run_test, 100KB read cap.
 *   - Path traversal blocked (no .. segments, no absolute paths above repo).
 *   - AGENTS.md / CLAUDE.md / .git / agents/_shared write blocked everywhere.
 *   - On max-turns hit: issue reverts to todo, no review reassignment.
 */
import { promises as fs, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import type Database from "better-sqlite3";
import type { AgentAdapter, AdapterInput, AdapterOutcome } from "../services/dispatch-consumer.js";

const REPO_ROOT = process.env.AWOS_REPO_ROOT ?? process.cwd();
const KIMI_BASE_URL = process.env.KIMI_BASE_URL ?? "https://api.moonshot.ai/v1";
const KIMI_MODEL = process.env.KIMI_TOOL_MODEL ?? process.env.KIMI_MODEL ?? "kimi-k2-turbo-preview";
const MAX_TURNS = Number(process.env.AWOS_TOOL_MAX_TURNS ?? "50");
const FILE_READ_CAP_BYTES = 100_000;
const TEST_TIMEOUT_MS = 90_000;

const CEO_AGENT_ID = "704c0f26-757a-4e4d-922f-3695895bc95c";

const BE_LANE_PREFIXES = [
  "packages/agentos-d/",
  "packages/memory/",
  "packages/policy-engine/",
  "packages/shared/",
  "packages/scanner-worker/",
  "packages/pdf/",
  "tests/",
];
const FE_LANE_PREFIXES = ["packages/admin-ui/"];
const ALWAYS_BLOCK_WRITE = [
  "agents/",
  ".git/",
  "AGENTS.md",
  "CLAUDE.md",
  "PLAN.md",
  ".gstack/",
  ".paperclip/",
  ".agentworks/",
  "node_modules/",
];

interface ResolvedIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  status: string;
  tenantId: string;
}
interface ResolvedAgent {
  id: string;
  name: string;
  role: string | null;
  instructionsPath: string | null;
}

function loadKimiKey(): string {
  const k = process.env.KIMI_API_KEY ?? process.env.MOONSHOT_API_KEY;
  if (k) return k;
  throw new Error("KIMI_API_KEY missing: set KIMI_API_KEY or MOONSHOT_API_KEY env var");
}

export interface KimiToolAdapterOptions {
  sqlite: Database.Database;
  client?: OpenAI;
  repoRoot?: string;
  logger?: { info: (m: string, c?: unknown) => void; warn: (m: string, c?: unknown) => void; error: (m: string, c?: unknown) => void };
}

interface ToolContext {
  issue: ResolvedIssue;
  agent: ResolvedAgent;
  lane: { allowed: string[]; label: string };
  filesTouched: Set<string>;
  testRuns: number;
}

const TOOL_DEFS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file relative to repo root. Returns first 100KB.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Path relative to repo root." } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List entries in a directory relative to repo root.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Recursive grep across the repo (or under path). Returns up to 100 matching lines with file:line prefixes.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern (extended)." },
          path: { type: "string", description: "Optional subdir. Defaults to repo root." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file inside your lane. Returns ok/error.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace exact substring 'old_string' with 'new_string' in the file. old_string must appear exactly once.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_test",
      description: "Run vitest in a package directory. Returns truncated stdout/stderr and pass/fail. 90s timeout.",
      parameters: {
        type: "object",
        properties: {
          package_dir: { type: "string", description: "Path relative to repo root, e.g. packages/memory" },
          test_file: { type: "string", description: "Optional specific test file or pattern to narrow the run." },
        },
        required: ["package_dir"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_for_review",
      description: "Finish: transition issue to review, reassign to CEO, post a Ready for review comment. Call once when all pass/fail criteria are met.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "What you changed and how you verified." },
        },
        required: ["summary"],
      },
    },
  },
];

export class KimiToolAdapter implements AgentAdapter {
  private sqlite: Database.Database;
  private client: OpenAI;
  private repoRoot: string;
  private log: { info: (m: string, c?: unknown) => void; warn: (m: string, c?: unknown) => void; error: (m: string, c?: unknown) => void };

  constructor(opts: KimiToolAdapterOptions) {
    this.sqlite = opts.sqlite;
    this.repoRoot = opts.repoRoot ?? REPO_ROOT;
    this.log = opts.logger ?? {
      info: (m, c) => console.log(`[kimi-tool] ${m}`, c ?? ""),
      warn: (m, c) => console.warn(`[kimi-tool] ${m}`, c ?? ""),
      error: (m, c) => console.error(`[kimi-tool] ${m}`, c ?? ""),
    };
    this.client = opts.client ?? new OpenAI({ apiKey: loadKimiKey(), baseURL: KIMI_BASE_URL });
  }

  async run(input: AdapterInput): Promise<AdapterOutcome> {
    const root = input.payload as { issueId?: string; payload?: { issueId?: string } } | undefined;
    const issueId = root?.payload?.issueId ?? root?.issueId;
    if (!issueId) return { status: "failed", error: "payload.issueId missing" };

    const issue = this.loadIssue(issueId);
    if (!issue) return { status: "failed", error: `issue ${issueId} not found` };
    const agent = this.loadAgent(input.targetAgentId);
    if (!agent) return { status: "failed", error: `agent ${input.targetAgentId} not found` };
    if (issue.status !== "todo") {
      return {
        status: "completed",
        summary: `kimi-tool: skipped — issue already in status=${issue.status}`,
      };
    }

    const lane = laneFor(agent);
    if (!lane) {
      return { status: "failed", error: `kimi-tool: no lane defined for role ${agent.role ?? agent.name}` };
    }

    this.transitionIssue(issue.id, "in_progress");
    this.log.info(`IMPL start ${issue.identifier} agent=${agent.name} lane=${lane.label}`);

    const ctx: ToolContext = {
      issue,
      agent,
      lane,
      filesTouched: new Set(),
      testRuns: 0,
    };

    const agentInstructionsAbs = this.absInRepo(this.agentInstructionsPath(agent));
    const agentMd = (agentInstructionsAbs && this.safeRead(agentInstructionsAbs)) || "(no AGENTS.md)";
    const repoMd = this.safeRead(path.join(this.repoRoot, "CLAUDE.md")) ?? "";
    const gateMd = this.safeRead(path.join(this.repoRoot, "agents/_shared/CEO-REVIEW-GATE.md")) ?? "";
    const sharedDocs = this.collectSharedDocs();

    const systemPrompt = [
      `You are an autonomous AWOS ${agent.name} working an Operator UX v2 implementation ticket inside the agentos-d daemon.`,
      "",
      "## Hard rules (the daemon enforces these — violations return tool errors)",
      `- Your write lane: ${lane.label} (${lane.allowed.join(", ")})`,
      "- Reads are unrestricted across the repo. Writes outside your lane are refused.",
      "- Never edit AGENTS.md, CLAUDE.md, or anything under agents/ or .git/.",
      "- You have at most " + MAX_TURNS + " turns. After your work passes its self-checks, call submit_for_review exactly once.",
      "",
      "## Workflow",
      "1. Read the issue body. Identify every file in the 'Touches' line.",
      "2. Read the relevant spec doc under docs/operator-ux-v2/ that this ticket implements.",
      "3. Read the existing files you will modify so your edits align with current code style and types.",
      "4. Apply edits via edit_file (preferred for surgical changes) or write_file (for new files).",
      "5. Run tests in the affected package(s) via run_test. Iterate until they pass.",
      "6. Call submit_for_review with a concise summary referencing files changed and test results.",
      "",
      "## Codebase conventions (from CLAUDE.md)",
      repoMd,
      "",
      "## Your role doc (AGENTS.md)",
      agentMd,
      "",
      "## Active CEO review gate",
      gateMd,
      "",
      "## Other shared docs you may consult",
      sharedDocs,
    ].join("\n");

    const userPrompt = [
      `# Issue ${issue.identifier}: ${issue.title}`,
      "",
      issue.description,
    ].join("\n");

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    let totalIn = 0;
    let totalOut = 0;
    let summary: string | null = null;
    let lastError: string | null = null;
    const toolHist: Record<string, number> = {};
    let turnsUsed = 0;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      turnsUsed = turn + 1;
      let completion: OpenAI.Chat.Completions.ChatCompletion;
      try {
        completion = await this.client.chat.completions.create({
          model: KIMI_MODEL,
          messages,
          tools: TOOL_DEFS,
          tool_choice: "auto",
          temperature: 0.2,
          max_tokens: 4000,
        });
      } catch (err) {
        lastError = `LLM call failed turn ${turn}: ${err instanceof Error ? err.message : String(err)}`;
        this.log.error(lastError);
        break;
      }
      totalIn += completion.usage?.prompt_tokens ?? 0;
      totalOut += completion.usage?.completion_tokens ?? 0;
      const choice = completion.choices?.[0];
      if (!choice) {
        lastError = "no completion choice";
        break;
      }
      const msg = choice.message;
      messages.push(msg);

      const toolCalls = msg.tool_calls ?? [];
      if (toolCalls.length === 0) {
        // Nudge: model emitted text but no tool call. Encourage finishing.
        messages.push({
          role: "user",
          content:
            "You produced text without a tool call. To make progress, call a tool. " +
            "When the issue's pass/fail criteria are met, call submit_for_review.",
        });
        continue;
      }

      let submitted = false;
      for (const call of toolCalls) {
        if (call.type === "function") {
          const n = call.function.name;
          toolHist[n] = (toolHist[n] ?? 0) + 1;
        }
        const result = await this.dispatchTool(call, ctx);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: typeof result.content === "string" ? result.content : JSON.stringify(result.content),
        });
        if (result.submitted) {
          summary = result.summary ?? "(no summary)";
          submitted = true;
        }
      }
      if (submitted) break;
    }
    const histStr = Object.entries(toolHist)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");

    const usage = { in: totalIn, out: totalOut };
    if (summary) {
      this.transitionIssue(issue.id, "review", CEO_AGENT_ID);
      this.postComment(
        issue.id,
        issue.tenantId,
        [
          "## Ready for review",
          "",
          summary,
          "",
          `Files touched: ${[...ctx.filesTouched].map((p) => "`" + p + "`").join(", ") || "(none recorded)"}`,
          `LLM: ${KIMI_MODEL} (in=${usage.in} out=${usage.out} tokens, turns used).`,
          "",
          "Reassigned to CEO for review gate.",
        ].join("\n")
      );
      this.fireCeoReviewWakeup(issue.tenantId, issue.id);
      this.log.info(`IMPL submit ${issue.identifier}`, { ...usage, files: ctx.filesTouched.size, turns: turnsUsed, hist: histStr });
      const outcome: AdapterOutcome = {
        status: "completed",
        summary: `kimi-tool: ${issue.identifier} submitted for review (${ctx.filesTouched.size} files)`,
      };
      if (usage.in) outcome.tokensInput = usage.in;
      if (usage.out) outcome.tokensOutput = usage.out;
      return outcome;
    }

    // Did not submit — revert to todo so a future wakeup can retry.
    this.transitionIssue(issue.id, "todo");
    const reason = lastError ?? `max-turns ${MAX_TURNS} hit without submit_for_review`;
    this.postComment(
      issue.id,
      issue.tenantId,
      [
        "## kimi-tool adapter: did not finish",
        "",
        `Reason: ${reason}`,
        `Tool calls: ${histStr || "(none)"}`,
        `Files touched in attempt: ${[...ctx.filesTouched].map((p) => "`" + p + "`").join(", ") || "(none)"}`,
        `LLM: ${KIMI_MODEL} (in=${usage.in} out=${usage.out} tokens, turns=${turnsUsed}).`,
        "",
        "Issue reverted to todo. Manual triage needed.",
      ].join("\n")
    );
    this.log.warn(`IMPL bail ${issue.identifier}: ${reason} | turns=${turnsUsed} hist=${histStr || "(none)"} files=${ctx.filesTouched.size}`);
    return { status: "failed", error: `kimi-tool: ${reason}` };
  }

  private async dispatchTool(
    call: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
    ctx: ToolContext
  ): Promise<{ content: string; submitted?: boolean; summary?: string }> {
    if (call.type !== "function") {
      return { content: `error: unsupported tool call type "${call.type}"` };
    }
    const name = call.function.name;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      return { content: `error: tool args were not valid JSON` };
    }
    try {
      switch (name) {
        case "read_file":
          return { content: await this.toolReadFile(String(args.path ?? "")) };
        case "list_dir":
          return { content: await this.toolListDir(String(args.path ?? "")) };
        case "grep":
          return { content: await this.toolGrep(String(args.pattern ?? ""), args.path ? String(args.path) : undefined) };
        case "write_file":
          return { content: await this.toolWriteFile(String(args.path ?? ""), String(args.content ?? ""), ctx) };
        case "edit_file":
          return {
            content: await this.toolEditFile(
              String(args.path ?? ""),
              String(args.old_string ?? ""),
              String(args.new_string ?? ""),
              ctx
            ),
          };
        case "run_test":
          return {
            content: await this.toolRunTest(String(args.package_dir ?? ""), args.test_file ? String(args.test_file) : undefined, ctx),
          };
        case "submit_for_review":
          return { content: "ok: submitted", submitted: true, summary: String(args.summary ?? "") };
        default:
          return { content: `error: unknown tool ${name}` };
      }
    } catch (err) {
      return { content: `error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // ===== tool implementations =====

  private async toolReadFile(rel: string): Promise<string> {
    const abs = this.absInRepo(rel);
    if (!abs) return `error: invalid path "${rel}"`;
    if (!existsSync(abs)) return `error: file not found: ${rel}`;
    const buf = await fs.readFile(abs);
    if (buf.length > FILE_READ_CAP_BYTES) {
      return (
        `--- ${rel} (truncated to ${FILE_READ_CAP_BYTES}/${buf.length} bytes) ---\n` +
        buf.subarray(0, FILE_READ_CAP_BYTES).toString("utf8")
      );
    }
    return `--- ${rel} (${buf.length} bytes) ---\n` + buf.toString("utf8");
  }

  private async toolListDir(rel: string): Promise<string> {
    const abs = this.absInRepo(rel || ".");
    if (!abs) return `error: invalid path "${rel}"`;
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const lines = entries
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    return lines.join("\n");
  }

  private async toolGrep(pattern: string, rel?: string): Promise<string> {
    if (!pattern) return "error: pattern required";
    const abs = rel ? this.absInRepo(rel) : this.repoRoot;
    if (!abs) return `error: invalid path "${rel ?? ""}"`;
    return await new Promise((resolve) => {
      const args = [
        "-rn",
        "--max-count=4",
        "-E",
        "--exclude-dir=node_modules",
        "--exclude-dir=.git",
        "--exclude-dir=dist",
        "--exclude-dir=.next",
        pattern,
        abs,
      ];
      const proc = spawn("/usr/bin/grep", args);
      let out = "";
      let bytes = 0;
      proc.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes < 12_000) out += chunk.toString("utf8");
      });
      proc.stderr.on("data", () => {
        // ignore — grep noise
      });
      proc.on("close", () => {
        const cleaned = out
          .split("\n")
          .filter(Boolean)
          .slice(0, 100)
          .map((l) => l.replace(this.repoRoot + "/", ""))
          .join("\n");
        resolve(cleaned || "(no matches)");
      });
      setTimeout(() => proc.kill("SIGKILL"), 8000);
    });
  }

  private async toolWriteFile(rel: string, content: string, ctx: ToolContext): Promise<string> {
    const guard = this.guardWrite(rel, ctx);
    if (!guard.ok) return `error: ${guard.reason}`;
    await fs.mkdir(path.dirname(guard.abs), { recursive: true });
    await fs.writeFile(guard.abs, content, "utf8");
    ctx.filesTouched.add(rel);
    return `ok: wrote ${content.length} bytes to ${rel}`;
  }

  private async toolEditFile(rel: string, oldStr: string, newStr: string, ctx: ToolContext): Promise<string> {
    if (!oldStr) return "error: old_string is empty";
    const guard = this.guardWrite(rel, ctx);
    if (!guard.ok) return `error: ${guard.reason}`;
    if (!existsSync(guard.abs)) return `error: file not found: ${rel} (use write_file for new files)`;
    const orig = await fs.readFile(guard.abs, "utf8");
    const occurrences = orig.split(oldStr).length - 1;
    if (occurrences === 0) return `error: old_string not found in ${rel}`;
    if (occurrences > 1) {
      return `error: old_string occurs ${occurrences} times in ${rel}; widen old_string for uniqueness`;
    }
    const next = orig.replace(oldStr, newStr);
    await fs.writeFile(guard.abs, next, "utf8");
    ctx.filesTouched.add(rel);
    return `ok: replaced one occurrence in ${rel} (${orig.length} → ${next.length} bytes)`;
  }

  private async toolRunTest(rel: string, testFile: string | undefined, ctx: ToolContext): Promise<string> {
    ctx.testRuns++;
    if (ctx.testRuns > 10) return "error: test-run budget exhausted (10 max per run)";
    const abs = this.absInRepo(rel);
    if (!abs) return `error: invalid package_dir "${rel}"`;
    if (!existsSync(abs)) return `error: package_dir not found: ${rel}`;
    return await new Promise((resolve) => {
      const args = ["vitest", "run", "--reporter=basic"];
      if (testFile) args.push(testFile);
      const proc = spawn("npx", args, { cwd: abs, env: { ...process.env, CI: "1" } });
      let out = "";
      let bytes = 0;
      const cap = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes < 12_000) out += chunk.toString("utf8");
      };
      proc.stdout.on("data", cap);
      proc.stderr.on("data", cap);
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        proc.kill("SIGKILL");
      }, TEST_TIMEOUT_MS);
      proc.on("close", (code) => {
        clearTimeout(timer);
        const verdict = killed ? "TIMED_OUT" : code === 0 ? "PASS" : "FAIL";
        const tail = out.split("\n").slice(-60).join("\n");
        resolve(`run_test: ${verdict} (exit=${code ?? "killed"})\n--- tail ---\n${tail}`);
      });
    });
  }

  // ===== helpers =====

  private guardWrite(rel: string, ctx: ToolContext): { ok: true; abs: string } | { ok: false; reason: string } {
    if (!rel) return { ok: false, reason: "path is empty" };
    if (path.isAbsolute(rel)) return { ok: false, reason: "absolute path not allowed" };
    if (rel.includes("..")) return { ok: false, reason: "path traversal not allowed" };
    const norm = rel.replace(/^\.\//, "");
    for (const blocked of ALWAYS_BLOCK_WRITE) {
      if (norm.startsWith(blocked)) return { ok: false, reason: `writes under ${blocked} are blocked` };
    }
    const inLane = ctx.lane.allowed.some((p) => norm.startsWith(p));
    if (!inLane) {
      return {
        ok: false,
        reason: `path "${norm}" is outside your lane (${ctx.lane.label}). Allowed prefixes: ${ctx.lane.allowed.join(", ")}`,
      };
    }
    return { ok: true, abs: path.join(this.repoRoot, norm) };
  }

  private absInRepo(rel: string): string | null {
    if (!rel) return null;
    if (path.isAbsolute(rel)) return null;
    if (rel.includes("..")) return null;
    return path.join(this.repoRoot, rel.replace(/^\.\//, ""));
  }

  private collectSharedDocs(): string {
    const files = ["agents/_shared/CLOSE-COMMENT-HYGIENE.md", "agents/_shared/COMMIT-SCOPE.md"];
    const parts: string[] = [];
    for (const f of files) {
      const txt = this.safeRead(path.join(this.repoRoot, f));
      if (txt) parts.push(`### ${f}\n${txt}`);
    }
    return parts.join("\n\n");
  }

  private agentInstructionsPath(agent: ResolvedAgent): string {
    if (agent.instructionsPath) return agent.instructionsPath;
    const slug = (agent.role ?? agent.name).toLowerCase().replace(/[^a-z]/g, "");
    const map: Record<string, string> = {
      ceo: "agents/ceo/AGENTS.md",
      backendengineer: "agents/backend/AGENTS.md",
      frontendengineer: "agents/frontend/AGENTS.md",
      pythonengineer: "agents/python/AGENTS.md",
      qaengineer: "agents/qa/AGENTS.md",
      techlead: "agents/techlead/AGENTS.md",
      technicalwriter: "agents/writer/AGENTS.md",
      complianceconsultant: "agents/compliance/AGENTS.md",
    };
    return map[slug] ?? "agents/backend/AGENTS.md";
  }

  private safeRead(p: string): string | null {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  }

  private loadIssue(id: string): ResolvedIssue | null {
    const row = this.sqlite
      .prepare(
        "SELECT id, identifier, title, description, status, tenant_id FROM execution_issues WHERE id = ?"
      )
      .get(id) as
      | { id: string; identifier: string; title: string; description: string; status: string; tenant_id: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      identifier: row.identifier,
      title: row.title,
      description: row.description ?? "",
      status: row.status,
      tenantId: row.tenant_id,
    };
  }

  private loadAgent(id: string): ResolvedAgent | null {
    const row = this.sqlite
      .prepare("SELECT id, name, role, instructions_path FROM execution_agents WHERE id = ?")
      .get(id) as
      | { id: string; name: string; role: string | null; instructions_path: string | null }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      instructionsPath: row.instructions_path,
    };
  }

  private transitionIssue(issueId: string, status: "todo" | "in_progress" | "review" | "done", assigneeAgentId?: string): void {
    const now = new Date().toISOString();
    if (assigneeAgentId !== undefined) {
      this.sqlite
        .prepare("UPDATE execution_issues SET status = ?, updated_at = ?, assignee_agent_id = ? WHERE id = ?")
        .run(status, now, assigneeAgentId, issueId);
    } else if (status === "done") {
      this.sqlite
        .prepare("UPDATE execution_issues SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?")
        .run(status, now, now, issueId);
    } else {
      this.sqlite
        .prepare("UPDATE execution_issues SET status = ?, updated_at = ? WHERE id = ?")
        .run(status, now, issueId);
    }
  }

  private postComment(issueId: string, tenantId: string, body: string): void {
    const id = "kt-" + Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);
    const now = new Date().toISOString();
    try {
      this.sqlite
        .prepare(
          `INSERT INTO execution_issue_comments (id, tenant_id, issue_id, author_id, author_label, body, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, tenantId, issueId, null, "kimi-tool-adapter", body, now);
    } catch (err) {
      this.log.warn(`postComment skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private fireCeoReviewWakeup(tenantId: string, issueId: string): void {
    try {
      const id = randomUUID();
      const input = JSON.stringify({
        source: "auto-review",
        triggerDetail: "submit-for-review",
        reason: "kimi-tool: submitted for review; auto-trigger CEO review",
        payload: { issueId },
        idempotencyKey: `auto-review-${issueId}-${Date.now()}`,
      });
      this.sqlite
        .prepare(
          `INSERT INTO dispatch_queue (id, tenant_id, task_kind, target_agent_id, input, status, created_at)
           VALUES (?, ?, 'agent.wakeup', ?, ?, 'queued', ?)`
        )
        .run(id, tenantId, CEO_AGENT_ID, input, new Date().toISOString());
    } catch (err) {
      this.log.warn(`fireCeoReviewWakeup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function laneFor(agent: ResolvedAgent): { allowed: string[]; label: string } | null {
  // Use the specific name (BackendEngineer, FrontendEngineer) — the role
  // column in this substrate is the generic class ("engineer") which
  // doesn't disambiguate the lane.
  const slug = agent.name.toLowerCase().replace(/[^a-z]/g, "");
  if (slug === "backendengineer") return { allowed: BE_LANE_PREFIXES, label: "BE" };
  if (slug === "frontendengineer") return { allowed: FE_LANE_PREFIXES, label: "FE" };
  if (slug === "pythonengineer")
    return { allowed: ["packages/scanner-worker/"], label: "PY" };
  return null;
}
