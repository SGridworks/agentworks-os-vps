/**
 * Core implementation for the agentworks.dispatch n8n custom node.
 *
 * Thin wrapper over `POST /api/dispatch` on agentos-d. The substrate writes
 * the dispatch_queue row and returns the task id; the node hands the result
 * back to the workflow so downstream branches can act on the queued task.
 */

export type DispatchStatus = "queued" | "dispatched" | "completed" | "failed";

export interface DispatchParams {
  /** Tenant uuid the task belongs to. */
  tenantId: string;
  /** Canonical dot-separated kind, e.g. "outbound.sms". */
  taskKind: string;
  /** Target agent id — opaque string the agent runtime maps to a worker. */
  targetAgentId: string;
  /** Free-form task input. The substrate JSON-serializes it as-is. */
  input?: Record<string, unknown>;
  /** Optional link to the policy decision that allowed this dispatch. */
  policyDecisionId?: string;
}

export interface DispatchResult {
  taskId: string;
  status: DispatchStatus;
  taskKind: string;
  targetAgentId: string;
  tenantId: string;
  createdAt: string;
}

export interface DispatchClientOptions {
  /** Daemon base URL, e.g. "http://127.0.0.1:3100". */
  baseUrl: string;
  /** Optional bearer token. */
  apiKey?: string;
  /** Request timeout in ms. Defaults to 10s. */
  timeoutMs?: number;
  /** Override fetch — mainly for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function runDispatch(
  params: DispatchParams,
  options: DispatchClientOptions,
): Promise<DispatchResult> {
  if (!params.tenantId) throw new Error("dispatch: tenantId is required");
  if (!params.taskKind) throw new Error("dispatch: taskKind is required");
  if (!params.targetAgentId) throw new Error("dispatch: targetAgentId is required");

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const url = `${options.baseUrl.replace(/\/$/, "")}/api/dispatch`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

  const body: Record<string, unknown> = {
    tenantId: params.tenantId,
    taskKind: params.taskKind,
    targetAgentId: params.targetAgentId,
    input: params.input ?? {},
  };
  if (params.policyDecisionId) body.policyDecisionId = params.policyDecisionId;

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`dispatch HTTP ${response.status}: ${errorText}`);
    }
    const json = (await response.json()) as Partial<DispatchResult>;
    if (typeof json.taskId !== "string" || typeof json.status !== "string") {
      throw new Error("dispatch: unexpected reply shape");
    }
    if (
      json.status !== "queued" &&
      json.status !== "dispatched" &&
      json.status !== "completed" &&
      json.status !== "failed"
    ) {
      throw new Error(`dispatch: unknown status: ${String(json.status)}`);
    }
    return {
      taskId: json.taskId,
      status: json.status,
      taskKind: typeof json.taskKind === "string" ? json.taskKind : params.taskKind,
      targetAgentId:
        typeof json.targetAgentId === "string" ? json.targetAgentId : params.targetAgentId,
      tenantId: typeof json.tenantId === "string" ? json.tenantId : params.tenantId,
      createdAt: typeof json.createdAt === "string" ? json.createdAt : new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}
