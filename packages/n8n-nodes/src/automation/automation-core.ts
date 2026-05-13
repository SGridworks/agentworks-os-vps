export type AutomationOperation =
  | "issue.create"
  | "issue.update"
  | "approval.enqueue"
  | "cost.event"
  | "scanner.finding"
  | "webhook.intake";

export interface AutomationParams {
  operation: AutomationOperation;
  tenantId: string;
  companyId?: string;
  issueId?: string;
  payload?: Record<string, unknown>;
}

export interface AutomationResult {
  operation: AutomationOperation;
  status: number;
  data: Record<string, unknown>;
}

export interface AutomationClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function runAutomationAction(
  params: AutomationParams,
  options: AutomationClientOptions,
): Promise<AutomationResult> {
  if (!params.tenantId) throw new Error("automation: tenantId is required");
  const target = endpointFor(params);
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

  try {
    const response = await fetchImpl(`${options.baseUrl.replace(/\/$/, "")}${target.path}`, {
      method: target.method,
      headers,
      body: JSON.stringify({ tenantId: params.tenantId, ...(params.payload ?? {}) }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`automation ${params.operation} HTTP ${response.status}: ${text}`);
    }
    const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    return { operation: params.operation, status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

function endpointFor(params: AutomationParams): { method: string; path: string } {
  switch (params.operation) {
    case "issue.create":
      if (!params.companyId) throw new Error("automation: companyId is required");
      return { method: "POST", path: `/api/companies/${params.companyId}/issues` };
    case "issue.update":
      if (!params.issueId) throw new Error("automation: issueId is required");
      return { method: "PATCH", path: `/api/issues/${params.issueId}` };
    case "approval.enqueue":
      return { method: "POST", path: "/api/approval-queue" };
    case "cost.event":
      if (!params.companyId) throw new Error("automation: companyId is required");
      return { method: "POST", path: `/api/companies/${params.companyId}/cost-events` };
    case "scanner.finding":
      return { method: "POST", path: "/api/scanner/findings" };
    case "webhook.intake":
      return { method: "POST", path: "/api/webhooks/intake" };
  }
}
