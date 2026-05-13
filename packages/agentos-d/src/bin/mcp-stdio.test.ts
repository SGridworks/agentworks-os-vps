import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

describe('mcp-stdio bridge', () => {
  it('forwards JSON-RPC request to daemon and returns response', async () => {
    // Mock MCP HTTP endpoint
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const response = JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: ['tool1', 'tool2', 'tool3', 'tool4'],
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(response);
      });
    });
    await new Promise((r) => server.listen(0, r as any));
    const port = (server.address() as any).port;

    const env = { ...process.env, AGENTOS_API_URL: `http://127.0.0.1:${port}` };
    const binaryPath = resolve(__dirname, '../../dist/bin/mcp-stdio.js');
    const child = spawn('node', [binaryPath], { env });

    const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    child.stdin.write(request + '\n');
    child.stdin.end();

    const output = await new Promise<string>((resolveOutput) => {
      let data = '';
      child.stdout.on('data', (c) => (data += c));
      child.on('close', () => resolveOutput(data.trim()));
    });

    const parsed = JSON.parse(output);
    expect(parsed).toMatchObject({ jsonrpc: '2.0', id: 1, result: ['tool1', 'tool2', 'tool3', 'tool4'] });

    server.close();
  });
});
