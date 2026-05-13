/**
 * MemoryRead.node — n8n custom node entry point for vault reads.
 *
 * Loaded by n8n at startup from `dist/memory/MemoryRead.node.js`. The HTTP
 * plumbing lives in `memory-core` so it stays testable outside of n8n; this
 * file declares the n8n descriptor and the `execute()` glue.
 */

import { runMemoryRead, type MemoryReadParams } from "./memory-core.js";

interface N8nNodeProperty {
  displayName: string;
  name: string;
  type: string;
  required?: boolean;
  default?: unknown;
  description?: string;
  options?: Array<{ name: string; value: unknown }>;
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
  displayName: "AgentWorks Memory Read",
  name: "agentworks.memory.read",
  group: ["agents", "storage"],
  version: 1,
  description: "Read a vault page by tenant + key",
  defaults: { name: "Memory Read" },
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
      displayName: "Detail Tier",
      name: "tier",
      type: "options",
      required: false,
      default: "detail",
      options: [
        { name: "Index (summary/trigger only, no body)", value: "index" },
        { name: "Detail (full body)", value: "detail" },
      ],
      description: "index = fast listing view; detail = full content",
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

export class MemoryRead {
  description = description;

  async execute(this: N8nExecuteFunctions): Promise<N8nExecutionItem[][]> {
    const items = this.getInputData();
    const out: N8nExecutionItem[] = [];

    for (let i = 0; i < items.length; i++) {
      const params: MemoryReadParams = {
        tenantId: this.getNodeParameter("tenantId", i) as string,
        key: this.getNodeParameter("key", i) as string,
        tier: this.getNodeParameter("tier", i, "detail") as "index" | "detail",
      };
      const baseUrl =
        (this.getNodeParameter("baseUrl", i, "http://127.0.0.1:3100") as string) ||
        "http://127.0.0.1:3100";
      const result = await runMemoryRead(params, { baseUrl });
      out.push({ json: { ...items[i]?.json, memoryRead: result } });
    }

    return [out];
  }
}
