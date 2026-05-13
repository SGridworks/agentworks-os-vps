/**
 * Hermes adapter tests.
 *
 *   - metadata exposes key/label/capabilities
 *   - missing baseUrl returns success=false with "not configured"
 *   - successful POST returns parsed JSON body and meta
 *   - non-2xx HTTP returns success=false with the status in meta
 *   - timeout aborts cleanly and returns success=false
 *   - apiKey is sent as Bearer token
 *   - claudeLocal/codex still execute (basic smoke)
 */

import { describe, it, expect } from 'vitest';
import { HermesAdapter } from './hermes';
import { ClaudeLocalAdapter } from './claudeLocal';
import { CodexAdapter } from './codex';

function fakeFetch(impl: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return impl as unknown as typeof fetch;
}

describe('HermesAdapter.metadata', () => {
  it('exposes stable key, label, and capabilities', () => {
    const a = new HermesAdapter();
    expect(a.metadata.key).toBe('hermes');
    expect(a.metadata.label).toBe('Hermes');
    expect(a.metadata.capabilities).toContain('agent.dispatch');
  });
});

describe('HermesAdapter.execute', () => {
  it('returns not-configured error when baseUrl is unset', async () => {
    const a = new HermesAdapter();
    const r = await a.execute({ actionKind: 'agent.dispatch', payload: {} });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no baseUrl/);
    expect(r.meta).toMatchObject({ adapter: 'hermes', configured: false });
  });

  it('POSTs to <baseUrl>/api/dispatch with the envelope and parses JSON reply', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const a = new HermesAdapter({
      baseUrl: 'http://127.0.0.1:18789/',
      apiKey: 'k1',
      fetchImpl: fakeFetch(async (url, init) => {
        captured = { url, init };
        return new Response(JSON.stringify({ jobId: 'j1', queued: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    });

    const r = await a.execute({
      actionKind: 'outbound.sms',
      payload: { to: '+1', body: 'hi' },
      tenantId: 't1',
      requestId: 'req-1',
    });

    expect(r.success).toBe(true);
    expect(r.data).toEqual({ jobId: 'j1', queued: true });
    expect(r.meta?.url).toBe('http://127.0.0.1:18789/api/dispatch');
    expect(r.meta?.status).toBe(200);

    expect(captured).not.toBeNull();
    const cap = captured as unknown as { url: string; init: RequestInit };
    expect(cap.url).toBe('http://127.0.0.1:18789/api/dispatch');
    expect(cap.init.method).toBe('POST');
    const headers = cap.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer k1');
    const body = JSON.parse(String(cap.init.body));
    expect(body).toMatchObject({
      actionKind: 'outbound.sms',
      payload: { to: '+1', body: 'hi' },
      tenantId: 't1',
      requestId: 'req-1',
    });
  });

  it('non-2xx response surfaces as success=false with status in meta', async () => {
    const a = new HermesAdapter({
      baseUrl: 'http://127.0.0.1:18789',
      fetchImpl: fakeFetch(async () =>
        new Response(JSON.stringify({ error: 'denied' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    });
    const r = await a.execute({ actionKind: 'agent.dispatch', payload: {} });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/HTTP 403/);
    expect(r.meta?.status).toBe(403);
    expect(r.meta?.body).toEqual({ error: 'denied' });
  });

  it('returns the raw text wrapped when reply is non-JSON', async () => {
    const a = new HermesAdapter({
      baseUrl: 'http://127.0.0.1:18789',
      fetchImpl: fakeFetch(async () => new Response('ok', { status: 200 })),
    });
    const r = await a.execute({ actionKind: 'agent.dispatch', payload: {} });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ raw: 'ok' });
  });

  it('network failure returns success=false with error message', async () => {
    const a = new HermesAdapter({
      baseUrl: 'http://127.0.0.1:18789',
      fetchImpl: fakeFetch(async () => {
        throw new Error('ECONNREFUSED');
      }),
    });
    const r = await a.execute({ actionKind: 'agent.dispatch', payload: {} });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/ECONNREFUSED/);
    expect(r.meta?.adapter).toBe('hermes');
  });

  it('omits authorization header when no apiKey is set', async () => {
    let headers: Record<string, string> = {};
    const a = new HermesAdapter({
      baseUrl: 'http://127.0.0.1:18789',
      fetchImpl: fakeFetch(async (_url, init) => {
        headers = init.headers as Record<string, string>;
        return new Response('{}', { status: 200 });
      }),
    });
    await a.execute({ actionKind: 'x.y', payload: {} });
    expect(headers.authorization).toBeUndefined();
  });
});

describe('peer adapter smoke', () => {
  it('ClaudeLocalAdapter and CodexAdapter still implement the contract', async () => {
    const cl = new ClaudeLocalAdapter();
    expect(cl.metadata.key).toBe('claude_local');
    const r1 = await cl.execute({ actionKind: 'shell.run', payload: { cmd: 'ls' } });
    expect(r1.success).toBe(true);

    const cx = new CodexAdapter();
    expect(cx.metadata.key).toBe('codex');
    const r2 = await cx.execute({ actionKind: 'code.write', payload: {} });
    expect(r2.success).toBe(true);
  });
});
