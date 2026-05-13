import { Router } from "express";
import type { Config } from "../config.js";
import { CostMeter } from "./CostMeter.js";
import { ProviderConfigService } from "./provider-config-service.js";
import { getDb } from "../db/index.js";

/**
 * Creates the cost-meter proxy router with circuit-breaker integration.
 *
 * Per-tenant provider topology is loaded from the DB on every request
 * (ProviderConfigService caches with a 60-second TTL so the DB is not hit
 * on every call).  If no DB config exists for a tenant, falls back to the
 * environment-variable defaults so the proxy remains usable before the tenant
 * has been provisioned.
 */
export interface CostMeterRouterHandle {
  router: Router;
  registerCircuitHandler: (cb: (event: any) => void) => void;
}

export function createCostMeterRouter(config: Config): CostMeterRouterHandle {
  const router = Router();

  const configService = new ProviderConfigService(getDb());

  // Fallback configs when a tenant has no DB entries yet
  const fallbackConfigs = [
    {
      name: "openai",
      endpoint: "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY ?? "",
      isPrimary: true,
      fallbackOrder: 0,
    },
    {
      name: "anthropic",
      endpoint: "https://api.anthropic.com/v1",
      apiKey: process.env.ANTHROPIC_API_KEY ?? "",
      isPrimary: false,
      fallbackOrder: 1,
    },
  ];

  // Cached CostMeter instances — one per tenant.
  // CircuitBreaker state lives here so it persists across requests.
  // When topology changes, the per-tenant entry is invalidated via
  // configService.invalidate() + costMeterCache.delete(tenantId).
  const costMeterCache = new Map<string, CostMeter>();

  // Circuit state-change handler registered by ProcessWatcher (via main.ts).
  // Applied to every new CostMeter at construction time.
  let circuitHandler: ((event: any) => void) | null = null;

  function registerCircuitHandler(cb: (event: any) => void): void {
    circuitHandler = cb;
    // Wire up all existing cached CostMeters
    for (const cm of Array.from(costMeterCache.values())) {
      cm.setOnStateChange(cb);
    }
  }

  function buildCostMeter(tenantId: string): CostMeter {
    const cached = costMeterCache.get(tenantId);
    if (cached) return cached;

    const topology = configService.getTopology(tenantId);
    const providerConfigs = topology
      ? topology.providers.map((p) => ({
          name: p.name,
          endpoint: p.endpoint,
          apiKey: p.apiKey,
          isPrimary: p.isPrimary,
          fallbackOrder: p.fallbackOrder,
        }))
      : fallbackConfigs;

    const cm = new CostMeter(config, providerConfigs);
    if (circuitHandler) cm.setOnStateChange(circuitHandler);
    costMeterCache.set(tenantId, cm);
    return cm;
  }

  /**
   * POST /api/proxy/chat-completions
   *
   * Proxy chat completions request with circuit breaker protection.
   * Body:
   *   provider: string  — primary provider name (e.g. "openai")
   *   tenantId: string — tenant ID for isolation
   *   request: object  — OpenAI-compatible chat completion body
   */
  router.post("/chat-completions", async (req, res) => {
    const { provider, tenantId, request } = req.body as {
      provider?: string;
      tenantId?: string;
      request?: unknown;
    };

    if (!provider || !tenantId || !request) {
      return res.status(400).json({
        error: "invalid_request",
        message: "provider, tenantId, and request are required",
      });
    }

    try {
      const costMeter = buildCostMeter(tenantId);
      const result = await costMeter.chatCompletions(
        provider,
        tenantId,
        request as Record<string, unknown>,
      );

      if (result.success) {
        res.json({
          success: true,
          data: result.data,
          usage: result.usage,
          actualProvider: result.actualProvider,
          circuitState: result.circuitState,
          fallbackUsed: result.fallbackUsed,
          retryAttempts: result.retryAttempts,
        });
      } else {
        res.status(502).json({
          success: false,
          error: result.error,
          errorCode: result.errorCode,
          actualProvider: result.actualProvider,
          circuitState: result.circuitState,
          fallbackUsed: result.fallbackUsed,
          retryAttempts: result.retryAttempts,
        });
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      config.logger.error({ error }, "cost-meter chat-completions failed");
      res.status(500).json({
        error: "internal_error",
        message: msg,
      });
    }
  });

  /**
   * GET /api/proxy/circuit-state
   *
   * Get circuit breaker state for monitoring.
   * Query params:
   *   provider: string  — provider name
   *   tenantId: string — tenant ID
   */
  router.get("/circuit-state", (req, res) => {
    const { provider, tenantId } = req.query as Record<string, string>;

    if (!provider || !tenantId) {
      return res.status(400).json({
        error: "invalid_request",
        message: "provider and tenantId query parameters are required",
      });
    }

    try {
      const costMeter = buildCostMeter(tenantId);
      const circuitState = costMeter.getCircuitState(provider, tenantId);
      const allStates = costMeter.getAllCircuitStates(tenantId);

      res.json({
        provider,
        tenantId,
        circuitState,
        allStates: allStates.map(({ provider: p, state }) => ({ provider: p, state })),
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      const details = error instanceof Error ? error.stack : String(error);
      config.logger.error({ error: details ?? msg }, "circuit-state lookup failed");
      res.status(500).json({
        error: "internal_error",
        message: msg,
      });
    }
  });

  /**
   * GET /api/proxy/circuit-events
   *
   * Get circuit breaker events for a provider and tenant.
   * Query params:
   *   provider: string  — provider name
   *   tenantId: string — tenant ID
   *   limit: number    — max events to return (default 50, max 100)
   */
  router.get("/circuit-events", (req, res) => {
    const { provider, tenantId, limit = "50" } = req.query as Record<string, string>;

    if (!provider || !tenantId) {
      return res.status(400).json({
        error: "invalid_request",
        message: "provider and tenantId query parameters are required",
      });
    }

    const limitNum = Math.min(parseInt(limit, 10) || 50, 100);

    try {
      const costMeter = buildCostMeter(tenantId);
      const events = costMeter.getCircuitEvents(provider, tenantId, limitNum);

      res.json({ provider, tenantId, events });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      const details = error instanceof Error ? error.stack : String(error);
      config.logger.error({ error: details ?? msg }, "circuit-events lookup failed");
      res.status(500).json({
        error: "internal_error",
        message: msg,
      });
    }
  });

  return { router, registerCircuitHandler };
}
