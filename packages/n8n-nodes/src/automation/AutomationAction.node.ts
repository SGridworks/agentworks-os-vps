import {
  runAutomationAction,
  type AutomationOperation,
  type AutomationParams,
} from "./automation-core.js";

interface N8nNodeProperty {
  displayName: string;
  name: string;
  type: string;
  required?: boolean;
  default?: unknown;
  description?: string;
  options?: Array<{ name: string; value: string }>;
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
  displayName: "AgentWorks Automation",
  name: "agentworks.automation",
  group: ["agents"],
  version: 1,
  description: "Run an AgentWorks automation action",
  defaults: { name: "Automation" },
  inputs: ["main"],
  outputs: ["main"],
  properties: [
    {
      displayName: "Operation",
      name: "operation",
      type: "options",
      required: true,
      default: "issue.create",
      options: [
        { name: "Issue Create", value: "issue.create" },
        { name: "Issue Update", value: "issue.update" },
        { name: "Approval Enqueue", value: "approval.enqueue" },
        { name: "Cost Event", value: "cost.event" },
        { name: "Scanner Finding", value: "scanner.finding" },
        { name: "Webhook Intake", value: "webhook.intake" },
      ],
    },
    { displayName: "Tenant ID", name: "tenantId", type: "string", required: true, default: "" },
    { displayName: "Company ID", name: "companyId", type: "string", default: "" },
    { displayName: "Issue ID", name: "issueId", type: "string", default: "" },
    { displayName: "Payload (JSON)", name: "payload", type: "json", default: "{}" },
    {
      displayName: "Daemon Base URL",
      name: "baseUrl",
      type: "string",
      default: "http://127.0.0.1:7710",
    },
  ],
};

export class AutomationAction {
  description = description;

  async execute(this: N8nExecuteFunctions): Promise<N8nExecutionItem[][]> {
    const items = this.getInputData();
    const out: N8nExecutionItem[] = [];

    for (let i = 0; i < items.length; i++) {
      const params: AutomationParams = {
        operation: this.getNodeParameter("operation", i) as AutomationOperation,
        tenantId: this.getNodeParameter("tenantId", i) as string,
        payload: parseJsonParam(this.getNodeParameter("payload", i, {})),
      };
      const companyId = this.getNodeParameter("companyId", i, "") as string;
      if (companyId) params.companyId = companyId;
      const issueId = this.getNodeParameter("issueId", i, "") as string;
      if (issueId) params.issueId = issueId;
      const baseUrl = this.getNodeParameter("baseUrl", i, "http://127.0.0.1:7710") as string;

      const result = await runAutomationAction(params, { baseUrl });
      out.push({ json: { ...items[i]?.json, automation: result } });
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

