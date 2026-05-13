import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CostMeter, type FetchLike } from './CostMeter.js';
import { CircuitState } from '../circuit-breaker/types.js';

const mockConfig = {
  port: 7710,
  host: '127.0.0.1',
  logLevel: 'info' as const,
  awcpVersion: 'awcp/v0.1',
  dataDir: './data',
  scannerSidecarUrl: 'http://127.0.0.1:3101',
  scannerPollIntervalMs: 30000,
  auditLogRetentionDays: 30
};

function makeMockResponse(init: {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}): Response {
  const status = init.status ?? 200;
  const headers = new Headers(init.headers ?? {});
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => init.body,
    text: async () => JSON.stringify(init.body),
  } as Response;
}

function makeMockFetch(handlers: Record<string, { seq: Array<{ status?: number; body?: unknown; headers?: Record<string, string>; error?: Error }> }>): FetchLike {
  const counters: Record<string, number> = {};
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const provider = Object.keys(handlers).find((p) => urlStr.includes(p));
    if (!provider) throw new Error(`Unexpected fetch URL: ${urlStr}`);

    const cfg = handlers[provider];
    const idx = counters[provider] ?? 0;
    counters[provider] = idx + 1;
    const step = cfg.seq[idx] ?? cfg.seq[cfg.seq.length - 1];

    if (step.error) throw step.error;
    return makeMockResponse({ status: step.status, body: step.body, headers: step.headers });
  }) as unknown as FetchLike;
}

describe('CostMeter', () => {
  let costMeter: CostMeter;

  const providerConfigs = [
    { name: 'openai', endpoint: 'https://openai/v1', apiKey: 'pk-openai', isPrimary: true, fallbackOrder: 0 },
    { name: 'anthropic', endpoint: 'https://anthropic/v1', apiKey: 'pk-anthropic', isPrimary: false, fallbackOrder: 1 },
  ];

  describe('successful call', () => {
    it('should return data and populate usage telemetry', async () => {
      const mockFetch = makeMockFetch({
        openai: {
          seq: [{
            status: 200,
            body: {
              id: 'chatcmpl-1',
              model: 'gpt-4o',
              choices: [{ message: { role: 'assistant', content: 'hi' } }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
            },
            headers: { 'x-ratelimit-remaining-tokens': '1234', 'retry-after': '0' }
          }]
        }
      });

      costMeter = new CostMeter(mockConfig, providerConfigs, mockFetch);
      const result = await costMeter.chatCompletions('openai', 't1', {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }]
      });

      expect(result.success).toBe(true);
      expect(result.actualProvider).toBe('openai');
      expect(result.circuitState).toBe(CircuitState.CLOSED);
      expect(result.fallbackUsed).toBe(false);
      expect(result.retryAttempts).toBe(0);
      expect(result.usage?.inputTokens).toBe(10);
      expect(result.usage?.outputTokens).toBe(5);
      expect(result.usage?.totalTokens).toBe(15);
      expect(result.usage?.primaryModelUsed).toBe('gpt-4o');
      expect(result.usage?.actualProviderUsed).toBe('openai');
      expect(result.usage?.estimatedCostUsd).toBeGreaterThan(0);
      expect(result.usage?.providerLatencyMs).toBeGreaterThanOrEqual(0);
      expect(result.usage?.providerRateLimitHeaders).toEqual({
        'x-ratelimit-remaining-tokens': '1234',
        'retry-after': '0'
      });
    });
  });

  describe('retry on transient 429', () => {
    it('should retry on fallback when primary returns 429', async () => {
      const mockFetch = makeMockFetch({
        openai: { seq: [{ status: 429, body: { error: 'rate limited' } }] },
        anthropic: {
          seq: [{
            status: 200,
            body: {
              id: 'msg-1',
              model: 'claude-3-sonnet',
              choices: [{ message: { role: 'assistant', content: 'hello from fallback' } }],
              usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
            }
          }]
        }
      });

      costMeter = new CostMeter(mockConfig, providerConfigs, mockFetch);
      const result = await costMeter.chatCompletions('openai', 't1', {
        model: 'claude-3-sonnet',
        messages: [{ role: 'user', content: 'Hi' }]
      });

      expect(result.success).toBe(true);
      expect(result.actualProvider).toBe('anthropic');
      expect(result.fallbackUsed).toBe(true);
      expect(result.retryAttempts).toBe(1);
      expect(result.usage?.actualProviderUsed).toBe('anthropic');

      // Primary should remain CLOSED because 429 is transient
      expect(costMeter.getCircuitState('openai', 't1')).toBe(CircuitState.CLOSED);
    });
  });

  describe('no retry on network errors', () => {
    it('should not fallback when primary throws a network error (ECONNREFUSED)', async () => {
      const netError = new Error('fetch failed');
      (netError as any).code = 'ECONNREFUSED';

      const mockFetch = makeMockFetch({
        openai: { seq: [{ error: netError }] },
        anthropic: { seq: [] }
      });

      costMeter = new CostMeter(mockConfig, providerConfigs, mockFetch);
      const result = await costMeter.chatCompletions('openai', 't1', {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hi' }]
      });

      // ECONNREFUSED is a network error — classified as 'network_error'.
      // Per AWO-173 spec: process_lost / network errors do NOT count toward
      // circuit-breaker state and do NOT trigger a fallback retry.
      // With only one provider (openai), there is no fallback to try.
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('network_error');
      expect(result.fallbackUsed).toBe(false); // network errors do not trigger retry
      expect(result.retryAttempts).toBe(0);
      expect(result.actualProvider).toBe('openai');
    });

    it('should not increment circuit-breaker failure count on network_error', async () => {
      // Make 5 network-error calls — none should count toward failure threshold
      const netError = new Error('fetch failed');
      (netError as any).code = 'ECONNREFUSED';

      const mockFetch = makeMockFetch({
        openai: { seq: Array(5).fill({ error: netError }) },
        anthropic: { seq: [] }
      });

      costMeter = new CostMeter(mockConfig, providerConfigs, mockFetch);

      for (let i = 0; i < 5; i++) {
        const result = await costMeter.chatCompletions('openai', 't1', {
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'Hi' }]
        });
        expect(result.errorCode).toBe('network_error');
        expect(result.success).toBe(false);
      }

      // Circuit should still be CLOSED — network errors don't count toward threshold
      expect(costMeter.getCircuitState('openai', 't1')).toBe(CircuitState.CLOSED);
    });
  });

  describe('per-tenant isolation', () => {
    it('should isolate circuit state between tenants', async () => {
      const mockFetch = makeMockFetch({
        openai: { seq: [{ status: 500, body: { error: 'boom' } }] },
        anthropic: { seq: [{ status: 500, body: { error: 'boom' } }] }
      });

      costMeter = new CostMeter(mockConfig, providerConfigs, mockFetch);

      // Drive tenant-a into OPEN by recording 10 hard failures
      for (let i = 0; i < 10; i++) {
        await costMeter.chatCompletions('openai', 'tenant-a', { model: 'gpt-4', messages: [] });
      }

      expect(costMeter.getCircuitState('openai', 'tenant-a')).toBe(CircuitState.OPEN);
      expect(costMeter.getCircuitState('openai', 'tenant-b')).toBe(CircuitState.CLOSED);
    });
  });

  describe('circuit breaker state machine via cost meter', () => {
    it('should open circuit after threshold of hard failures, then close on probe success', async () => {
      let callCount = 0;
      const mockFetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
        callCount++;
        // Every call fails with 500 (hard failure)
        return makeMockResponse({ status: 500, body: { error: 'boom' } });
      }) as unknown as FetchLike;

      costMeter = new CostMeter(mockConfig, providerConfigs, mockFetch);

      // 10 hard failures should open the circuit
      for (let i = 0; i < 10; i++) {
        const r = await costMeter.chatCompletions('openai', 't1', { model: 'gpt-4', messages: [] });
        expect(r.success).toBe(false);
      }

      expect(costMeter.getCircuitState('openai', 't1')).toBe(CircuitState.OPEN);

      // Also drive anthropic into OPEN so fallback is blocked too
      for (let i = 0; i < 10; i++) {
        const r = await costMeter.chatCompletions('anthropic', 't1', { model: 'gpt-4', messages: [] });
        expect(r.success).toBe(false);
      }
      expect(costMeter.getCircuitState('anthropic', 't1')).toBe(CircuitState.OPEN);

      // Next call should be blocked (no new fetch)
      const beforeBlock = callCount;
      const blocked = await costMeter.chatCompletions('openai', 't1', { model: 'gpt-4', messages: [] });
      expect(blocked.success).toBe(false);
      expect(callCount).toBe(beforeBlock); // no additional fetch issued

      // Manually force HALF_OPEN by resetting probe time
      const cb = (costMeter as any).circuitBreaker as import('../circuit-breaker/CircuitBreaker.js').CircuitBreaker;
      const key = 'openai:t1';
      const states = (cb as any).states as Map<string, any>;
      const st = states.get(key);
      st.nextProbeAt = new Date(Date.now() - 1000);
      states.set(key, st);

      // Now swap fetch to succeed for the probe
      (mockFetch as any).mockImplementation(async () => {
        return makeMockResponse({
          status: 200,
          body: {
            id: 'ok',
            model: 'gpt-4',
            choices: [{ message: { role: 'assistant', content: 'ok' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          }
        });
      });

      const probeResult = await costMeter.chatCompletions('openai', 't1', { model: 'gpt-4', messages: [] });
      expect(probeResult.success).toBe(true);
      expect(costMeter.getCircuitState('openai', 't1')).toBe(CircuitState.CLOSED);
    });
  });

  describe('usage telemetry on failure', () => {
    it('should include actualProviderUsed and latency even when all providers fail', async () => {
      const mockFetch = makeMockFetch({
        openai: { seq: [{ status: 500, body: { error: 'boom' } }] },
        anthropic: { seq: [{ status: 500, body: { error: 'boom' } }] }
      });

      costMeter = new CostMeter(mockConfig, providerConfigs, mockFetch);
      const result = await costMeter.chatCompletions('openai', 't1', { model: 'gpt-4', messages: [] });

      expect(result.success).toBe(false);
      expect(result.usage?.actualProviderUsed).toBe('openai');
      expect(result.usage?.providerLatencyMs).toBeGreaterThanOrEqual(0);
    });
  });
});
