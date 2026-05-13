/**
 * Dispatch.node — n8n custom node entry point.
 *
 * Loaded by n8n at startup from `dist/dispatch/Dispatch.node.js`. The HTTP
 * plumbing lives in `dispatch-core` so it stays testable without n8n.
 */

import { runDispatch, type DispatchParams } from "./dispatch-core.js";

interface N8nNodeProperty {
  displayName: string;
  name: string;
  type: string;
  required?: boolean;
  default?: unknown;
  description?: string;
}

interface N8nNodeDescription {
  displayName: string;
  name: string;
  group: string[];
  version: number;
  description: string;
  defaults: { name: string };
  inputs: string[];
  outputs: string[];
  credentials?: Array<{ name: string; required?: boolean }>;
  properties: N8nNodeProperty[];
}

interface N8nExecutionItem {
  json: Record<string, unknown>;
}

interface N8nExecuteFunctions {
  getInputData(): N8nExecutionItem[];
  getNodeParameter(name: string, itemIndex: number, fallback?: unknown): unknown;
}

const description: N8nNodeDescription = {
  displayName: "AgentWorks Dispatch",
  name: "agentworks.dispatch",
  group: ["agents"],
  version: 1,
  description: "Dispatch a task to an AgentWorks agent",
  defaults: { name: "Dispatch" },
  inputs: ["main"],
  outputs: ["main"],
  properties: [
    {
      displayName: "Tenant ID",
      name: "tenantId",
      type: "string",
      required: true,
      default: "",
    },
    {
      displayName: "Task Kind",
      name: "taskKind",
      type: "string",
      required: true,
      default: "",
      description: "Lowercase dot-separated, e.g. outbound.sms",
    },
    {
      displayName: "Target Agent ID",
      name: "targetAgentId",
      type: "string",
      required: true,
      default: "",
    },
    {
      displayName: "Input (JSON)",
      name: "input",
      type: "json",
      required: false,
      default: "{}",
    },
    {
      displayName: "Policy Decision ID",
      name: "policyDecisionId",
      type: "string",
      required: false,
      default: "",
      description: "Optional link to the policy decision that allowed this dispatch",
    },
    {
      displayName: "Daemon Base URL",
      name: "baseUrl",
      type: "string",
      required: false,
      default: "http://127.0.0.1:3100",
    },
  ],
};

export class Dispatch {
  description = description;

  async execute(this: N8nExecuteFunctions): Promise<N8nExecutionItem[][]> {
    const items = this.getInputData();
    const out: N8nExecutionItem[] = [];

    for (let i = 0; i < items.length; i++) {
      const params: DispatchParams = {
        tenantId: this.getNodeParameter("tenantId", i) as string,
        taskKind: this.getNodeParameter("taskKind", i) as string,
        targetAgentId: this.getNodeParameter("targetAgentId", i) as string,
        input: parseJsonParam(this.getNodeParameter("input", i, {})),
      };
      const policyDecisionId = this.getNodeParameter("policyDecisionId", i, "") as string;
      if (policyDecisionId) params.policyDecisionId = policyDecisionId;

      const baseUrl =
        (this.getNodeParameter("baseUrl", i, "http://127.0.0.1:3100") as string) ||
        "http://127.0.0.1:3100";

      const result = await runDispatch(params, { baseUrl });
      out.push({ json: { ...items[i]?.json, dispatch: result } });
    }

    return [out];
  }
}

function parseJsonParam(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === "object" && raw !== null) return raw as Record<string, unknown>;
  return {};
}
