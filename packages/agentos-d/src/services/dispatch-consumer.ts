/**
 * DispatchConsumer — drains dispatch_queue rows that target known agents.
 *
 * What this is: scaffolding. The consumer claims a queued row by atomically
 * transitioning it queued→dispatched, looks up the target agent, hands the
 * task to a pluggable AgentAdapter, then transitions the row to completed
 * (or failed on adapter error). It also stamps the agent's runtime_state
 * heartbeat with token + cost counters returned by the adapter.
 *
 * What this is NOT: an LLM runtime. The default adapter is `stubAdapter`,
 * which immediately reports completion. Real adapters (claude-local,
 * Anthropic-direct, etc.) plug in via `setAdapter()` or by passing one to
 * the constructor.
 *
 * Disabled by default. Enable with AGENTOS_DISPATCH_CONSUMER_ENABLED=true.
 */

import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface AdapterAgentSummary {
  id: string;
  tenantId: string;
  role: string | null;
  model: string | null;
  adapterType: string | null;
  instructionsPath: string | null;
}

export interface AdapterInput {
  taskId: string;
  tenantId: string;
  taskKind: string;
  targetAgentId: string;
  agent: AdapterAgentSummary;
  payload: Record<string, unknown>;
  /** Risk evaluation from autopilot bucketing logic */
  riskScore?: number;
  /** Reasons for risk evaluation */
  reasons?: string[];
  /** Autopilot decision */
  autopilotDecision?: "allow" | "needsApproval" | "risky";
}

export type AdapterOutcome =
  | {
      status: "completed";
      summary?: string;
      tokensInput?: number;
      tokensOutput?: number;
      tokensCached?: number;
      costCents?: number;
    }
  | { status: "failed"; error: string };

export interface AgentAdapter {
  /** Adapter must not mutate dispatch_queue rows; return outcome to consumer. */
  run(input: AdapterInput): Promise<AdapterOutcome>;
}

/**
 * No-op adapter. Reports completion immediately. Useful for testing the
 * consumer plumbing and as a placeholder when no real adapter is registered.
 */
export const stubAdapter: AgentAdapter = {
  async run() {
    return {
      status: "completed",
      summary: "stub adapter: dispatch acknowledged",
    };
  },
};

export interface DispatchConsumerOptions {
  sqlite: Database;
  adapter?: AgentAdapter;
  /** How often to tick when started. Ignored when calling tick() directly. */
  intervalMs?: number;
  /** Max queued items handled per tick. */
  batchSize?: number;
  /** Skip target agents in these statuses. Default ["paused", "retired"]. */
  skipAgentStatuses?: string[];
  /** Optional logger. */
  logger?: { info: (msg: string, ctx?: unknown) => void; warn: (msg: string, ctx?: unknown) => void; error: (msg: string, ctx?: unknown) => void };
}

export interface TickResult {
  scanned: number;
  claimed: number;
  completed: number;
  failed: number;
}

interface DispatchRow {
  id: string;
  tenant_id: string;
  task_kind: string;
  target_agent_id: string;
  input: string;
  status: "queued" | "dispatched" | "completed" | "failed";
  created_at: string;
}

interface AgentRow {
  id: string;
  tenant_id: string;
  status: string;
  role: string | null;
  model: string | null;
  adapter_type: string | null;
  instructions_path: string | null;
}

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_BATCH = 5;

export class DispatchConsumer {
  private readonly sqlite: Database;
  private adapter: AgentAdapter;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly skipStatuses: Set<string>;
  private readonly logger: NonNullable<DispatchConsumerOptions["logger"]>;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(opts: DispatchConsumerOptions) {
    this.sqlite = opts.sqlite;
    this.adapter = opts.adapter ?? stubAdapter;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH;
    this.skipStatuses = new Set(opts.skipAgentStatuses ?? ["paused", "retired"]);
    this.logger =
      opts.logger ?? {
        info: () => {},
        warn: () => {},
        error: () => {},
      };
  }

  setAdapter(adapter: AgentAdapter): void {
    this.adapter = adapter;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.safeTick();
    }, this.intervalMs);
    this.logger.info("dispatch-consumer started", {
      intervalMs: this.intervalMs,
      batchSize: this.batchSize,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info("dispatch-consumer stopped");
    }
  }

  async tick(): Promise<TickResult> {
    if (this.running) {
      return { scanned: 0, claimed: 0, completed: 0, failed: 0 };
    }
    this.running = true;
    try {
      return await this.runTick();
    } finally {
      this.running = false;
    }
  }

  private async safeTick(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      this.logger.error("dispatch-consumer tick failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async runTick(): Promise<TickResult> {
    const queued = this.fetchQueued();
    const result: TickResult = {
      scanned: queued.length,
      claimed: 0,
      completed: 0,
      failed: 0,
    };

    for (const row of queued) {
      const claimed = this.tryClaim(row.id);
      if (!claimed) continue;
      result.claimed++;

      const agent = this.lookupAgent(row.target_agent_id);
      if (!agent) {
        this.markFailed(row.id, "target agent not found");
        result.failed++;
        continue;
      }
      if (agent.tenant_id !== row.tenant_id) {
        this.markFailed(row.id, "tenant mismatch");
        result.failed++;
        continue;
      }
      if (this.skipStatuses.has(agent.status)) {
        this.markFailed(row.id, `agent in status ${agent.status}`);
        result.failed++;
        continue;
      }

      let payload: Record<string, unknown>;
      let riskScore: number | undefined;
      let reasons: string[] | undefined;
      let autopilotDecision: "allow" | "needsApproval" | "risky" | undefined;
      
      try {
        const parsed = JSON.parse(row.input) as Record<string, unknown>;
        payload = parsed;
        // Extract autopilot risk evaluation if present
        if (typeof parsed.riskScore === "number") {
          riskScore = parsed.riskScore;
        }
        if (Array.isArray(parsed.reasons)) {
          reasons = parsed.reasons as string[];
        }
        if (typeof parsed.autopilotDecision === "string" && 
            ["allow", "needsApproval", "risky"].includes(parsed.autopilotDecision)) {
          autopilotDecision = parsed.autopilotDecision as "allow" | "needsApproval" | "risky";
        }
      } catch {
        payload = {};
      }

      let outcome: AdapterOutcome;
      try {
        // exactOptionalPropertyTypes: build conditionally, never pass undefined.
        const adapterInput: Parameters<typeof this.adapter.run>[0] = {
          taskId: row.id,
          tenantId: row.tenant_id,
          taskKind: row.task_kind,
          targetAgentId: row.target_agent_id,
          agent: {
            id: agent.id,
            tenantId: agent.tenant_id,
            role: agent.role,
            model: agent.model,
            adapterType: agent.adapter_type,
            instructionsPath: agent.instructions_path,
          },
          payload,
        };
        if (riskScore !== undefined) adapterInput.riskScore = riskScore;
        if (reasons !== undefined) adapterInput.reasons = reasons;
        if (autopilotDecision !== undefined) adapterInput.autopilotDecision = autopilotDecision;
        outcome = await this.adapter.run(adapterInput);
      } catch (err) {
        outcome = {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        };
      }

      if (outcome.status === "completed") {
        this.markCompleted(row.id);
        this.recordHeartbeat(agent, outcome);
        result.completed++;
      } else {
        this.markFailed(row.id, outcome.error);
        result.failed++;
      }
    }

    return result;
  }

  private fetchQueued(): DispatchRow[] {
    return this.sqlite
      .prepare(
        `SELECT id, tenant_id, task_kind, target_agent_id, input, status, created_at
         FROM dispatch_queue
         WHERE status = 'queued'
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(this.batchSize) as DispatchRow[];
  }

  /** Atomic claim: returns true iff this call moved queued→dispatched. */
  private tryClaim(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.sqlite
      .prepare(
        `UPDATE dispatch_queue
         SET status = 'dispatched', dispatched_at = ?
         WHERE id = ? AND status = 'queued'`
      )
      .run(now, id);
    return result.changes === 1;
  }

  private lookupAgent(agentId: string): AgentRow | undefined {
    return this.sqlite
      .prepare(
        `SELECT id, tenant_id, status, role, model, adapter_type, instructions_path
         FROM execution_agents WHERE id = ?`
      )
      .get(agentId) as AgentRow | undefined;
  }

  private markCompleted(id: string): void {
    this.sqlite
      .prepare(
        `UPDATE dispatch_queue
         SET status = 'completed', completed_at = ?
         WHERE id = ? AND status = 'dispatched'`
      )
      .run(new Date().toISOString(), id);
  }

  private markFailed(id: string, error: string): void {
    this.sqlite
      .prepare(
        `UPDATE dispatch_queue
         SET status = 'failed', completed_at = ?, error = ?
         WHERE id = ? AND status IN ('queued', 'dispatched')`
      )
      .run(new Date().toISOString(), error, id);
  }

  private recordHeartbeat(agent: AgentRow, outcome: Extract<AdapterOutcome, { status: "completed" }>): void {
    const now = new Date().toISOString();
    const existing = this.sqlite
      .prepare(
        `SELECT total_input_tokens, total_output_tokens, total_cached_input_tokens, total_cost_cents
         FROM execution_agent_runtime_state WHERE agent_id = ?`
      )
      .get(agent.id) as
      | {
          total_input_tokens: number;
          total_output_tokens: number;
          total_cached_input_tokens: number;
          total_cost_cents: number;
        }
      | undefined;

    const tokensInput = outcome.tokensInput ?? 0;
    const tokensOutput = outcome.tokensOutput ?? 0;
    const tokensCached = outcome.tokensCached ?? 0;
    const costCents = outcome.costCents ?? 0;

    if (existing) {
      this.sqlite
        .prepare(
          `UPDATE execution_agent_runtime_state SET
             last_run_status = 'succeeded',
             last_run_at = ?,
             total_input_tokens = total_input_tokens + ?,
             total_output_tokens = total_output_tokens + ?,
             total_cached_input_tokens = total_cached_input_tokens + ?,
             total_cost_cents = total_cost_cents + ?,
             updated_at = ?
           WHERE agent_id = ?`
        )
        .run(now, tokensInput, tokensOutput, tokensCached, costCents, now, agent.id);
    } else {
      this.sqlite
        .prepare(
          `INSERT INTO execution_agent_runtime_state
             (agent_id, tenant_id, last_run_id, last_run_status, last_run_at,
              total_input_tokens, total_output_tokens, total_cached_input_tokens,
              total_cost_cents, updated_at)
           VALUES (?, ?, ?, 'succeeded', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          agent.id,
          agent.tenant_id,
          randomUUID(),
          now,
          tokensInput,
          tokensOutput,
          tokensCached,
          costCents,
          now
        );
    }

    this.sqlite
      .prepare(`UPDATE execution_agents SET last_heartbeat_at = ? WHERE id = ?`)
      .run(now, agent.id);
  }
}

export function dispatchConsumerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  // Default ON. Without a consumer, dispatch_queue rows accumulate forever
  // and the wakeup endpoint looks broken to operators. The default adapter
  // is the no-op stubAdapter, so enabling-by-default is safe — it only
  // transitions queued→completed without invoking real LLMs. Set to
  // "false" explicitly to disable.
  return env.AGENTOS_DISPATCH_CONSUMER_ENABLED !== "false";
}

export function dispatchConsumerOptionsFromEnv(
  env: Record<string, string | undefined> = process.env
): { intervalMs: number; batchSize: number } {
  const interval = Number(env.AGENTOS_DISPATCH_CONSUMER_INTERVAL_MS);
  const batch = Number(env.AGENTOS_DISPATCH_CONSUMER_BATCH);
  return {
    intervalMs: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_INTERVAL_MS,
    batchSize: Number.isFinite(batch) && batch > 0 ? batch : DEFAULT_BATCH,
  };
}
