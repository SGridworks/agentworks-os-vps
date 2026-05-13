/**
 * PolicyCheck.node — n8n custom node entry point.
 *
 * Loaded by n8n at startup from `dist/policy-check/PolicyCheck.node.js`. The
 * actual evaluation logic lives in `policy-check-core` so it stays testable
 * outside of n8n. This file only declares the n8n descriptor and the
 * `execute()` glue that pulls parameters out of the workflow item, calls
 * the core, and routes the result onto one of the three outputs.
 *
 * We deliberately avoid importing `n8n-workflow` so this package builds in
 * environments without n8n installed. The shapes below mirror n8n's INodeType
 * v1 spec; n8n duck-types the export at load time.
 */
import { runPolicyCheck, decisionOutputIndex, } from "./policy-check-core.js";
const description = {
    displayName: "AgentWorks Policy Check",
    name: "agentworks.policy_check",
    group: ["conditions", "agents"],
    version: 1,
    description: "Evaluate an action against AgentWorks compliance rules",
    defaults: { name: "Policy Check" },
    inputs: ["main"],
    outputs: ["main", "main", "main"],
    outputNames: ["allow", "block", "review"],
    credentials: [{ name: "agentworksApi", required: false }],
    properties: [
        {
            displayName: "Action Kind",
            name: "actionKind",
            type: "string",
            required: true,
            default: "",
            description: "Lowercase dot-separated kind, e.g. outbound.sms",
        },
        {
            displayName: "Tenant ID",
            name: "tenantId",
            type: "string",
            required: true,
            default: "",
        },
        {
            displayName: "Actor ID",
            name: "actorId",
            type: "string",
            required: true,
            default: "",
        },
        {
            displayName: "Payload (JSON)",
            name: "payload",
            type: "json",
            required: true,
            default: "{}",
        },
        {
            displayName: "Actor Label",
            name: "actorLabel",
            type: "string",
            required: false,
            default: "",
        },
        {
            displayName: "Summary",
            name: "summary",
            type: "string",
            required: false,
            default: "",
        },
        {
            displayName: "Shadow Mode Override",
            name: "shadowMode",
            type: "boolean",
            required: false,
            default: false,
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
export class PolicyCheck {
    description = description;
    async execute() {
        const items = this.getInputData();
        const allowOut = [];
        const blockOut = [];
        const reviewOut = [];
        for (let i = 0; i < items.length; i++) {
            const params = {
                actionKind: this.getNodeParameter("actionKind", i),
                tenantId: this.getNodeParameter("tenantId", i),
                actorId: this.getNodeParameter("actorId", i),
                payload: parseJsonParam(this.getNodeParameter("payload", i, {})),
            };
            const actorLabel = this.getNodeParameter("actorLabel", i, "");
            if (actorLabel)
                params.actorLabel = actorLabel;
            const summary = this.getNodeParameter("summary", i, "");
            if (summary)
                params.summary = summary;
            const shadow = this.getNodeParameter("shadowMode", i, false);
            if (shadow)
                params.shadowMode = true;
            const baseUrl = this.getNodeParameter("baseUrl", i, "http://127.0.0.1:3100") ||
                "http://127.0.0.1:3100";
            const result = await runPolicyCheck(params, { baseUrl });
            const out = { json: { ...items[i]?.json, policyCheck: result } };
            const idx = decisionOutputIndex(result.decision);
            if (idx === 0)
                allowOut.push(out);
            else if (idx === 1)
                blockOut.push(out);
            else
                reviewOut.push(out);
        }
        return [allowOut, blockOut, reviewOut];
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
//# sourceMappingURL=PolicyCheck.node.js.map