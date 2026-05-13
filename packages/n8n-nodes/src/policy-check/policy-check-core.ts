/**
 * Core implementation for the agentworks.policy_check n8n custom node.
 *
 * The node ships as a thin n8n wrapper (PolicyCheck.node.ts) around this
 * pure async function. Splitting them lets us test the HTTP plumbing and
 * decision routing without dragging the n8n runtime into vitest.
 *
 * Wire shape:
 *
 *   request:  { actionKind, payload, actorId, tenantId, ... }
 *   response: { decision, ruleId, reason, requestId, reviewed, ... }
 *
 * The endpoint is /api/policy/check on the agentos-d daemon — a thin REST
 * wrapper over the canonical policy.check pipeline used by the MCP server.
 */

export type PolicyDecision = "allow" | "block" | "route_to_review";

export interface PolicyCheckParams {
  /** Canonical lowercase dot-separated action kind, e.g. "outbound.sms". */
  actionKind: string;
  /** Tenant uuid the action belongs to. */
  tenantId: string;
  /** Actor identifier (agent id, user id, or system component). */
  actorId: string;
  /** Free-form action payload — DNC flags, message body, recipient, etc. */
  payload?: Record<string, unknown>;
  /** Optional human label for the actor. */
  actorLabel?: string;
  /** Optional actor type. Defaults to "agent" on the daemon side. */
  actorType?: "human" | "agent" | "system";
  /** Optional one-line summary of the proposed action for audit logs. */
  summary?: string;
  /** Per-call shadowMode override. Default: tenant configuration. */
  shadowMode?: boolean;
}

export interface PolicyCheckResult {
  decision: PolicyDecision;
  ruleId: string | null;
  reason: string;
  requestId: string;
  decisionId: string;
  shadowMode: boolean;
  approvalQueueId: string | null;
  reviewed: boolean;
}

export interface PolicyCheckOptions {
  /** Daemon base URL, e.g. "http://127.0.0.1:3100". */
  baseUrl: string;
  /** Request timeout in ms. Defaults to 10s. */
  timeoutMs?: number;
  /** Optional bearer token. */
  apiKey?: string;
  /** Override fetch — mainly for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function runPolicyCheck(
  params: PolicyCheckParams,
  options: PolicyCheckOptions,
): Promise<PolicyCheckResult> {
  if (!params.actionKind) throw new Error("policy_check: actionKind is required");
  if (!params.tenantId) throw new Error("policy_check: tenantId is required");
  if (!params.actorId) throw new Error("policy_check: actorId is required");

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const url = `${options.baseUrl.replace(/\/$/, "")}/api/policy/check`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

  const body: Record<string, unknown> = {
    tenantId: params.tenantId,
    actionKind: params.actionKind,
    actorId: params.actorId,
    payload: params.payload ?? {},
  };
  if (params.actorLabel) body.actorLabel = params.actorLabel;
  if (params.actorType) body.actorType = params.actorType;
  if (params.summary) body.summary = params.summary;
  if (params.shadowMode !== undefined) body.shadowMode = params.shadowMode;

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`policy_check HTTP ${response.status}: ${errorText}`);
    }
    const json = (await response.json()) as Partial<PolicyCheckResult>;
    if (
      json.decision !== "allow" &&
      json.decision !== "block" &&
      json.decision !== "route_to_review"
    ) {
      throw new Error(`policy_check: unexpected decision in reply: ${String(json.decision)}`);
    }
    return {
      decision: json.decision,
      ruleId: json.ruleId ?? null,
      reason: typeof json.reason === "string" ? json.reason : "",
      requestId: typeof json.requestId === "string" ? json.requestId : "",
      decisionId: typeof json.decisionId === "string" ? json.decisionId : "",
      shadowMode: Boolean(json.shadowMode),
      approvalQueueId: json.approvalQueueId ?? null,
      reviewed: Boolean(json.reviewed),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Maps a PolicyDecision to the n8n output index.
 *
 *   0 = main      (allow)
 *   1 = onBlock   (block)
 *   2 = onReview  (route_to_review)
 *
 * The custom node uses three outputs so workflow authors can branch on
 * decision without writing a downstream IF node — block paths route to a
 * notification, review paths route to an approval queue, allow paths
 * continue with the normal action.
 */
export function decisionOutputIndex(decision: PolicyDecision): 0 | 1 | 2 {
  switch (decision) {
    case "allow":
      return 0;
    case "block":
      return 1;
    case "route_to_review":
      return 2;
  }
}
