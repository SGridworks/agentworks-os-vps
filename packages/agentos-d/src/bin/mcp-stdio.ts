#!/usr/bin/env node
/**
 * MCP stdio bridge — translates Claude Desktop's stdio JSON-RPC traffic to
 * the agentos-d HTTP /api/mcp endpoint.
 *
 * Why: Claude Desktop's claude_desktop_config.json only speaks stdio MCP.
 * Our substrate exposes MCP over HTTP because the daemon is shared by many clients
 * (the admin UI, n8n nodes, REST callers). This bridge is the one-way adapter
 * from stdio → HTTP that lets Claude Desktop see the substrate as a normal MCP server.
 *
 * Configuration (claude_desktop_config.json):
 * {
 *   "mcpServers": {
 *     "agentworks": {
 *       "command": "node",
 *       "args": ["/path/to/mcp-stdio.js"],
 *       "env": {
 *         "AGENTOS_API_URL": "http://127.0.0.1:7710",
 *         "AGENTOS_API_KEY": "<your-agent-api-key>"
 *       }
 *     }
 *   }
 * }
 *
 * Wire format:
 *   stdin  — newline-delimited JSON-RPC 2.0 requests (one per line)
 *   stdout — newline-delimited JSON-RPC 2.0 responses
 *   stderr — bridge diagnostics (not JSON-RPC; Claude ignores stderr)
 */

import * as readline from "node:readline";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

const AGENTOS_API_URL = process.env.AGENTOS_API_URL ?? "http://127.0.0.1:7710";
const AGENTOS_API_KEY = process.env.AGENTOS_API_KEY;
const MCP_PATH = "/api/mcp";

function diag(msg: string): void {
  process.stderr.write(`[mcp-bridge] ${msg}\n`);
}

async function postJsonRpc(body: string): Promise<string> {
  const u = new URL(MCP_PATH, AGENTOS_API_URL);
  const lib = u.protocol === "https:" ? httpsRequest : httpRequest;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body)),
  };
  if (AGENTOS_API_KEY) {
    headers["Authorization"] = `Bearer ${AGENTOS_API_KEY}`;
  }
  return await new Promise((resolve, reject) => {
    const req = lib(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname,
        method: "POST",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main(): Promise<void> {
  diag(`bridging stdio → ${AGENTOS_API_URL}${MCP_PATH}`);

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let response: string;
    try {
      response = await postJsonRpc(line);
    } catch (err) {
      // Daemon down or unreachable.
      let id: string | number | null = null;
      try { id = JSON.parse(line).id ?? null; } catch {}
      response = JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: "agentos-d unreachable",
          data: { url: AGENTOS_API_URL, detail: String(err) },
        },
      });
      diag(`request failed: ${String(err)}`);
    }
    process.stdout.write(response + "\n");
  }

  diag("stdin closed, exiting");
}

main().catch((err) => {
  diag(`fatal: ${String(err)}`);
  process.exit(1);
});