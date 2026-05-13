/**
 * Hermes adapter.
 *
 * Hermes is the user's local agent platform; it exposes an HTTP gateway that
 * accepts dispatch requests. When an endpoint is configured, this adapter
 * POSTs the action to that endpoint and returns the gateway's reply. When no
 * endpoint is set, it returns a structured "not configured" result so the
 * substrate can route through review or fall back to another adapter without
 * exploding.
 *
 * Configuration is intentionally minimal: pass `baseUrl` (and optional
 * `apiKey`) at construction time. The substrate (or installer) is responsible
 * for resolving the URL — the adapter doesn't read env vars itself, so it
 * stays trivially testable.
 */

import type {
  AdapterEnvelope,
  AdapterMetadata,
  AdapterResult,
  AgentAdapter,
} from './base';

export interface HermesAdapterConfig {
  /** Base URL of the Hermes gateway, e.g. "http://127.0.0.1:18789". */
  baseUrl?: string;
  /** Bearer token presented to the gateway. Optional. */
  apiKey?: string;
  /** Request timeout in ms. Defaults to 15s. */
  timeoutMs?: number;
  /** Override fetch — mainly for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class HermesAdapter implements AgentAdapter {
  readonly metadata: AdapterMetadata = {
    key: 'hermes',
    label: 'Hermes',
    capabilities: ['agent.dispatch', 'vault.read', 'vault.write', 'shell.run'],
  };

  private readonly config: HermesAdapterConfig;

  constructor(config: HermesAdapterConfig = {}) {
    this.config = config;
  }

  async execute(envelope: AdapterEnvelope): Promise<AdapterResult> {
    if (!this.config.baseUrl) {
      return {
        success: false,
        error: 'Hermes adapter has no baseUrl configured',
        meta: { adapter: 'hermes', configured: false },
      };
    }

    const fetchImpl = this.config.fetchImpl ?? fetch;
    const timeout = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const url = `${this.config.baseUrl.replace(/\/$/, '')}/api/dispatch`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;

    const startedAt = Date.now();
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          actionKind: envelope.actionKind,
          payload: envelope.payload,
          tenantId: envelope.tenantId,
          requestId: envelope.requestId,
        }),
        signal: controller.signal,
      });

      const latencyMs = Date.now() - startedAt;
      const text = await response.text();
      const parsed = parseJsonOrNull(text);

      if (!response.ok) {
        return {
          success: false,
          error: `Hermes returned HTTP ${response.status}`,
          meta: {
            adapter: 'hermes',
            url,
            status: response.status,
            latencyMs,
            body: parsed ?? text,
          },
        };
      }

      return {
        success: true,
        data: parsed ?? { raw: text },
        meta: { adapter: 'hermes', url, status: response.status, latencyMs },
      };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const reason = err instanceof Error ? err.message : 'unknown';
      return {
        success: false,
        error: `Hermes dispatch failed: ${reason}`,
        meta: { adapter: 'hermes', url, latencyMs },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseJsonOrNull(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
