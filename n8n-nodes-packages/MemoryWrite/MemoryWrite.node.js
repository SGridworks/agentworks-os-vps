/**
 * MemoryWrite.node — n8n custom node entry point for vault writes.
 *
 * Loaded by n8n at startup from `dist/memory/MemoryWrite.node.js`. HTTP
 * plumbing lives in `memory-core` so it stays testable without n8n.
 */
import { runMemoryWrite } from "./memory-core.js";
const description = {
    displayName: "AgentWorks Memory Write",
    name: "agentworks.memory.write",
    group: ["agents", "storage"],
    version: 1,
    description: "Write a vault page (replace or append)",
    defaults: { name: "Memory Write" },
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
            displayName: "Vault Key",
            name: "key",
            type: "string",
            required: true,
            default: "",
            description: "Forward-slash key, e.g. projects/sgridworks",
        },
        {
            displayName: "Body",
            name: "body",
            type: "string",
            required: true,
            default: "",
        },
        {
            displayName: "Mode",
            name: "mode",
            type: "options",
            required: false,
            default: "replace",
            options: [
                { name: "Replace", value: "replace" },
                { name: "Append", value: "append" },
            ],
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
export class MemoryWrite {
    description = description;
    async execute() {
        const items = this.getInputData();
        const out = [];
        for (let i = 0; i < items.length; i++) {
            const params = {
                tenantId: this.getNodeParameter("tenantId", i),
                key: this.getNodeParameter("key", i),
                body: this.getNodeParameter("body", i),
            };
            const mode = this.getNodeParameter("mode", i, "replace");
            if (mode)
                params.mode = mode;
            const baseUrl = this.getNodeParameter("baseUrl", i, "http://127.0.0.1:3100") ||
                "http://127.0.0.1:3100";
            const result = await runMemoryWrite(params, { baseUrl });
            out.push({ json: { ...items[i]?.json, memoryWrite: result } });
        }
        return [out];
    }
}
//# sourceMappingURL=MemoryWrite.node.js.map