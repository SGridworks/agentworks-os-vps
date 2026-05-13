/**
 * KimiAdapter — daemon-side LLM runner for AWOS agent dispatches.
 *
 * v1 scope: SPEC issues only. The CEO (or any agent assigned to a SPEC issue)
 * authors a single markdown deliverable named in the issue's "Touches" line.
 * The adapter:
 *   1. Resolves the issue + agent.
 *   2. Loads the agent's AGENTS.md and the global repo conventions.
 *   3. Calls Kimi (OpenAI-compatible) with a one-shot JSON-mode prompt.
 *   4. Parses {path, content} from the response.
 *   5. Writes the file (must be inside docs/operator-ux-v2/).
 *   6. Transitions the issue to status=done with a hygiene-compliant comment.
 *
 * Implementation issues (BE/FE) require a tool-use loop and are NOT yet
 * supported — those dispatches return a "deferred" failed outcome so they
 * stay queued for a later adapter version.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import type Database from "better-sqlite3";
import type { AgentAdapter, AdapterInput, AdapterOutcome } from "../services/dispatch-consumer.js";

const REPO_ROOT = process.env.AWOS_REPO_ROOT ?? process.cwd();
const KIMI_BASE_URL = process.env.KIMI_BASE_URL ?? "https://api.moonshot.ai/v1";
const KIMI_MODEL = process.env.KIMI_MODEL ?? "kimi-k2-turbo-preview";

const SYSTEM_PROMPT_HEADER = `You are an autonomous AWOS agent running inside the agentos-d daemon.
You are NOT operating a terminal or filesystem directly. The daemon will
execute the file write you describe and transition the issue.

Output discipline (CRITICAL):
- Reply with ONE JSON object and nothing else. No prose, no fences, no preamble.
- Schema: {"path": "<relative-to-repo-root>", "content": "<full markdown body>"}
- "path" MUST start with "docs/operator-ux-v2/" and end with ".md".
- "content" is the entire file body. Do not include surrounding code fences.
- The deliverable must satisfy every pass/fail criterion listed in the issue body.
`;

interface ResolvedIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  status: string;
  assigneeAgentId: string | null;
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

export interface KimiAdapterOptions {
  sqlite: Database.Database;
  client?: OpenAI;
  repoRoot?: string;
  logger?: { info: (m: string, c?: unknown) => void; warn: (m: string, c?: unknown) => void; error: (m: string, c?: unknown) => void };
}

export class KimiAdapter implements AgentAdapter {
  private sqlite: Database.Database;
  private client: OpenAI;
  private repoRoot: string;
  private log: { info: (m: string, c?: unknown) => void; warn: (m: string, c?: unknown) => void; error: (m: string, c?: unknown) => void };

  constructor(opts: KimiAdapterOptions) {
    this.sqlite = opts.sqlite;
    this.repoRoot = opts.repoRoot ?? REPO_ROOT;
    this.log = opts.logger ?? {
      info: (m, c) => console.log(`[kimi-adapter] ${m}`, c ?? ""),
      warn: (m, c) => console.warn(`[kimi-adapter] ${m}`, c ?? ""),
      error: (m, c) => console.error(`[kimi-adapter] ${m}`, c ?? ""),
    };
    this.client = opts.client ?? new OpenAI({ apiKey: loadKimiKey(), baseURL: KIMI_BASE_URL });
  }

  async run(input: AdapterInput): Promise<AdapterOutcome> {
    // Wakeup endpoint stores the dispatch input as {source, triggerDetail,
    // reason, payload: {issueId}, idempotencyKey} — issueId is one level deep.
    const root = input.payload as { issueId?: string; payload?: { issueId?: string } } | undefined;
    const issueId = root?.payload?.issueId ?? root?.issueId;
    if (!issueId) {
      return { status: "failed", error: "payload.issueId missing" };
    }
    const issue = this.loadIssue(issueId);
    if (!issue) {
      return { status: "failed", error: `issue ${issueId} not found` };
    }
    const agent = this.loadAgent(input.targetAgentId);
    if (!agent) {
      return { status: "failed", error: `agent ${input.targetAgentId} not found` };
    }

    if (issue.status !== "todo") {
      return {
        status: "completed",
        summary: `kimi-adapter: skipped — issue already in status=${issue.status}`,
      };
    }

    if (!isSpecIssue(issue.title)) {
      return {
        status: "failed",
        error:
          "kimi-adapter v1 only handles SPEC issues (title starts with '[CEO] Spec'). " +
          "Implementation/GATE issues need the tool-use adapter (not yet built).",
      };
    }

    this.transitionIssue(issue.id, "in_progress");
    this.log.info(`SPEC start ${issue.identifier} agent=${agent.name}`, { issueId });

    let result: { path: string; content: string };
    const usage: { in?: number; out?: number } = {};
    try {
      const agentMd = await this.loadAgentInstructions(agent);
      const gateMd = await this.safeRead(path.join(this.repoRoot, "agents/_shared/CEO-REVIEW-GATE.md"));
      const repoMd = await this.safeRead(path.join(this.repoRoot, "CLAUDE.md"));
      const systemPrompt = [
        SYSTEM_PROMPT_HEADER,
        "## Agent role context (your AGENTS.md)",
        agentMd,
        "## Repo conventions",
        repoMd,
        "## Active CEO review gate (for context only — SPEC issues self-close)",
        gateMd,
      ]
        .filter(Boolean)
        .join("\n\n");
      const userPrompt = [
        `# Issue ${issue.identifier}: ${issue.title}`,
        "",
        issue.description,
      ].join("\n");

      const completion = await this.client.chat.completions.create({
        model: KIMI_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.3,
        max_tokens: 8000,
      });
      if (typeof completion.usage?.prompt_tokens === "number") usage.in = completion.usage.prompt_tokens;
      if (typeof completion.usage?.completion_tokens === "number") usage.out = completion.usage.completion_tokens;
      const raw = completion.choices?.[0]?.message?.content ?? "";
      result = this.parseResponse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.transitionIssue(issue.id, "todo");
      this.log.error(`LLM call failed for ${issue.identifier}: ${msg}`);
      return { status: "failed", error: `kimi-adapter LLM call failed: ${msg}` };
    }

    const validation = this.validatePath(result.path);
    if (!validation.ok) {
      this.transitionIssue(issue.id, "todo");
      return { status: "failed", error: `path validation failed: ${validation.reason}` };
    }
    const fullPath = path.join(this.repoRoot, result.path);
    try {
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, ensureTrailingNewline(result.content), "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.transitionIssue(issue.id, "todo");
      return { status: "failed", error: `file write failed: ${msg}` };
    }

    this.transitionIssue(issue.id, "done");
    this.postComment(
      issue.id,
      issue.tenantId,
      [
        "## Approved.",
        "",
        "Verified:",
        `- Authored \`${result.path}\` (${result.content.length} chars).`,
        `- LLM: ${KIMI_MODEL} (in=${usage.in ?? "?"} out=${usage.out ?? "?"} tokens).`,
        "- Spec content present, no code changes.",
        "",
        "Closing.",
      ].join("\n")
    );

    this.log.info(`SPEC done ${issue.identifier} -> ${result.path}`, usage);
    const outcome: AdapterOutcome = {
      status: "completed",
      summary: `kimi-adapter: SPEC authored at ${result.path}`,
    };
    if (usage.in !== undefined) outcome.tokensInput = usage.in;
    if (usage.out !== undefined) outcome.tokensOutput = usage.out;
    return outcome;
  }

  private loadIssue(id: string): ResolvedIssue | null {
    const row = this.sqlite
      .prepare(
        "SELECT id, identifier, title, description, status, assignee_agent_id, tenant_id FROM execution_issues WHERE id = ?"
      )
      .get(id) as
      | {
          id: string;
          identifier: string;
          title: string;
          description: string;
          status: string;
          assignee_agent_id: string | null;
          tenant_id: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      identifier: row.identifier,
      title: row.title,
      description: row.description ?? "",
      status: row.status,
      assigneeAgentId: row.assignee_agent_id,
      tenantId: row.tenant_id,
    };
  }

  private loadAgent(id: string): ResolvedAgent | null {
    const row = this.sqlite
      .prepare("SELECT id, name, role, instructions_path FROM execution_agents WHERE id = ?")
      .get(id) as
      | {
          id: string;
          name: string;
          role: string | null;
          instructions_path: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      instructionsPath: row.instructions_path,
    };
  }

  private async loadAgentInstructions(agent: ResolvedAgent): Promise<string> {
    const candidates: string[] = [];
    if (agent.instructionsPath) {
      candidates.push(
        path.isAbsolute(agent.instructionsPath)
          ? agent.instructionsPath
          : path.join(this.repoRoot, agent.instructionsPath)
      );
    }
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
    if (map[slug]) candidates.push(path.join(this.repoRoot, map[slug]));
    for (const c of candidates) {
      const txt = await this.safeRead(c);
      if (txt) return txt;
    }
    return `(No AGENTS.md found for ${agent.name}. Proceed with the issue body alone.)`;
  }

  private async safeRead(p: string): Promise<string | null> {
    try {
      return await fs.readFile(p, "utf8");
    } catch {
      return null;
    }
  }

  private parseResponse(raw: string): { path: string; content: string } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Try to extract a JSON object from a fenced reply just in case.
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("response is not JSON and contains no JSON object");
      parsed = JSON.parse(m[0]);
    }
    if (!parsed || typeof parsed !== "object") throw new Error("response not an object");
    const p = (parsed as { path?: unknown }).path;
    const c = (parsed as { content?: unknown }).content;
    if (typeof p !== "string" || typeof c !== "string") {
      throw new Error("response missing path or content");
    }
    if (c.length < 100) throw new Error(`response.content too short (${c.length} chars)`);
    return { path: p, content: c };
  }

  private validatePath(p: string): { ok: true } | { ok: false; reason: string } {
    if (path.isAbsolute(p)) return { ok: false, reason: "absolute path not allowed" };
    if (p.includes("..")) return { ok: false, reason: "path traversal not allowed" };
    if (!p.startsWith("docs/operator-ux-v2/")) {
      return { ok: false, reason: `must start with docs/operator-ux-v2/, got "${p}"` };
    }
    if (!p.endsWith(".md")) return { ok: false, reason: "must end with .md" };
    return { ok: true };
  }

  private transitionIssue(issueId: string, status: "todo" | "in_progress" | "review" | "done"): void {
    const now = new Date().toISOString();
    if (status === "done") {
      this.sqlite
        .prepare(
          "UPDATE execution_issues SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?"
        )
        .run(status, now, now, issueId);
    } else {
      this.sqlite
        .prepare("UPDATE execution_issues SET status = ?, updated_at = ? WHERE id = ?")
        .run(status, now, issueId);
    }
  }

  private postComment(issueId: string, tenantId: string, body: string): void {
    const id = randomId();
    const now = new Date().toISOString();
    try {
      this.sqlite
        .prepare(
          `INSERT INTO execution_issue_comments (id, tenant_id, issue_id, author_id, author_label, body, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, tenantId, issueId, null, "kimi-adapter", body, now);
    } catch (err) {
      this.log.warn(`postComment skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function isSpecIssue(title: string): boolean {
  return title.startsWith("[CEO] Spec");
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}

function randomId(): string {
  return "kim-" + Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);
}
