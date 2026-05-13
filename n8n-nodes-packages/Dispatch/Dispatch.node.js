/**
 * Dispatch.node — n8n custom node entry point.
 *
 * Loaded by n8n at startup from `dist/dispatch/Dispatch.node.js`. The HTTP
 * plumbing lives in `dispatch-core` so it stays testable without n8n.
 */
import { runDispatch } from "./dispatch-core.js";
const description = {
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
    async execute() {
        const items = this.getInputData();
        const out = [];
        for (let i = 0; i < items.length; i++) {
            const params = {
                tenantId: this.getNodeParameter("tenantId", i),
                taskKind: this.getNodeParameter("taskKind", i),
                targetAgentId: this.getNodeParameter("targetAgentId", i),
                input: parseJsonParam(this.getNodeParameter("input", i, {})),
            };
            const policyDecisionId = this.getNodeParameter("policyDecisionId", i, "");
            if (policyDecisionId)
                params.policyDecisionId = policyDecisionId;
            const baseUrl = this.getNodeParameter("baseUrl", i, "http://127.0.0.1:3100") ||
                "http://127.0.0.1:3100";
            const result = await runDispatch(params, { baseUrl });
            out.push({ json: { ...items[i]?.json, dispatch: result } });
        }
        return [out];
    }
}
function parseJsonParam(raw) {
    if (typeof raw === "string") {
        try {
            const parsed = JSON.parse(raw);
            return typeof parsed === "object" && parsed !== null
                ? parsed
                : {};
        }
        catch {
            return {};
        }
    }
    if (typeof raw === "object" && raw !== null)
        return raw;
    return {};
}
//# sourceMappingURL=Dispatch.node.js.map