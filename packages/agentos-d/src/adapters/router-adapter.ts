/**
 * RouterAdapter — picks which underlying adapter handles each dispatch.
 *
 * Routing is by the issue's title prefix:
 *   "[CEO] Spec —" → spec adapter (one-shot markdown author)
 *   "[BackendEngineer]" / "[FrontendEngineer]" → tool adapter (multi-turn)
 *   "[CEO] GATE:" → not yet supported (defers; child impl issues must be done first)
 */
import type Database from "better-sqlite3";
import type { AgentAdapter, AdapterInput, AdapterOutcome } from "../services/dispatch-consumer.js";
import { KimiAdapter } from "./kimi-adapter.js";
import { KimiToolAdapter } from "./kimi-tool-adapter.js";
import { KimiReviewAdapter } from "./kimi-review-adapter.js";

const CEO_AGENT_ID = "704c0f26-757a-4e4d-922f-3695895bc95c";

export interface RouterAdapterOptions {
  sqlite: Database.Database;
}

export class RouterAdapter implements AgentAdapter {
  private spec: KimiAdapter;
  private tool: KimiToolAdapter;
  private review: KimiReviewAdapter;
  private sqlite: Database.Database;

  constructor(opts: RouterAdapterOptions) {
    this.sqlite = opts.sqlite;
    this.spec = new KimiAdapter({ sqlite: opts.sqlite });
    this.tool = new KimiToolAdapter({ sqlite: opts.sqlite });
    this.review = new KimiReviewAdapter({ sqlite: opts.sqlite });
  }

  async run(input: AdapterInput): Promise<AdapterOutcome> {
    const root = input.payload as { issueId?: string; payload?: { issueId?: string } } | undefined;
    const issueId = root?.payload?.issueId ?? root?.issueId;
    if (!issueId) return { status: "failed", error: "router: payload.issueId missing" };
    const row = this.sqlite
      .prepare("SELECT title, status, assignee_agent_id FROM execution_issues WHERE id = ?")
      .get(issueId) as { title: string; status: string; assignee_agent_id: string | null } | undefined;
    if (!row) return { status: "failed", error: `router: issue ${issueId} not found` };
    if (row.status === "review" && row.assignee_agent_id === CEO_AGENT_ID) {
      return this.review.run(input);
    }
    const t = row.title;
    if (t.startsWith("[CEO] Spec")) return this.spec.run(input);
    if (t.startsWith("[BackendEngineer]") || t.startsWith("[FrontendEngineer]") || t.startsWith("[PythonEngineer]")) {
      return this.tool.run(input);
    }
    if (t.startsWith("[CEO] GATE")) {
      return {
        status: "failed",
        error: "router: GATE issues require all child impl issues done; defer until then.",
      };
    }
    return { status: "failed", error: `router: no adapter for title "${t.slice(0, 40)}…"` };
  }
}
