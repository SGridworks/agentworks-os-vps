/**
 * MemoryWrite.node — n8n custom node entry point for vault writes.
 *
 * Loaded by n8n at startup from `dist/memory/MemoryWrite.node.js`. HTTP
 * plumbing lives in `memory-core` so it stays testable without n8n.
 */

import { runMemoryWrite, type MemoryWriteParams } from "./memory-core.js";

interface N8nNodeProperty {
  displayName: string;
  name: string;
  type: string;
  required?: boolean;
  default?: unknown;
  options?: Array<{ name: string; value: string }>;
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

  async execute(this: N8nExecuteFunctions): Promise<N8nExecutionItem[][]> {
    const items = this.getInputData();
    const out: N8nExecutionItem[] = [];

    for (let i = 0; i < items.length; i++) {
      const params: MemoryWriteParams = {
        tenantId: this.getNodeParameter("tenantId", i) as string,
        key: this.getNodeParameter("key", i) as string,
        body: this.getNodeParameter("body", i) as string,
      };
      const mode = this.getNodeParameter("mode", i, "replace") as
        | "replace"
        | "append";
      if (mode) params.mode = mode;

      const baseUrl =
        (this.getNodeParameter("baseUrl", i, "http://127.0.0.1:3100") as string) ||
        "http://127.0.0.1:3100";

      const result = await runMemoryWrite(params, { baseUrl });
      out.push({ json: { ...items[i]?.json, memoryWrite: result } });
    }

    return [out];
  }
}
