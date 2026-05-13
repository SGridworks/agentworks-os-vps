import { Router } from "express";
import type { Config } from "../config.js";
import { CircuitBreaker } from "../circuit-breaker/CircuitBreaker.js";
import { CircuitState } from "../circuit-breaker/types.js";

/**
 * Creates the circuit breaker API routes
 */
export function createCircuitBreakerRouter(config: Config): Router {
  const router = Router();
  
  // Initialize circuit breaker instance
  // In production, this should be a singleton managed by the app
  const circuitBreaker = new CircuitBreaker({
    failureThreshold: 0.3,
    minimumCallCount: 10,
    timeWindowMinutes: 5,
    probeIntervalMinutes: 5,
    transientErrorCodes: ['adapter_failed', '429', '5xx', 'timeout']
  });

  /**
   * GET /api/providers/circuit-state
   * 
   * Returns circuit breaker states for all providers for a tenant
   * Query params:
   * - tenantId: required, the tenant ID
   */
  router.get('/circuit-state', (req, res) => {
    const { tenantId } = req.query;
    
    if (!tenantId || typeof tenantId !== 'string') {
      return res.status(400).json({ 
        error: 'invalid_request', 
        message: 'tenantId query parameter is required' 
      });
    }
    
    try {
      const states = circuitBreaker.getStatesForTenant(tenantId);
      
      // Transform to API response format
      const response = {
        tenantId,
        providers: states.map(({ provider, state }) => ({
          provider,
          state: state.state,
          lastStateChange: state.lastStateChange.toISOString(),
          lastReason: state.lastReason,
          failureCount: state.failureCount,
          totalCount: state.totalCount,
          nextProbeAt: state.nextProbeAt?.toISOString()
        }))
      };
      
      res.json(response);
    } catch (error) {
      config.logger.error({ error, tenantId }, 'Error getting circuit states');
      res.status(500).json({ 
        error: 'internal_error', 
        message: 'Failed to retrieve circuit states' 
      });
    }
  });

  /**
   * GET /api/providers/:provider/circuit-state
   * 
   * Returns circuit breaker state for a specific provider and tenant
   * Query params:
   * - tenantId: required, the tenant ID
   */
  router.get('/:provider/circuit-state', (req, res) => {
    const { provider } = req.params;
    const { tenantId } = req.query;
    
    if (!tenantId || typeof tenantId !== 'string') {
      return res.status(400).json({ 
        error: 'invalid_request', 
        message: 'tenantId query parameter is required' 
      });
    }
    
    try {
      const state = circuitBreaker.getState(provider, tenantId);
      
      const response = {
        provider,
        tenantId,
        state: state.state,
        lastStateChange: state.lastStateChange.toISOString(),
        lastReason: state.lastReason,
        failureCount: state.failureCount,
        totalCount: state.totalCount,
        nextProbeAt: state.nextProbeAt?.toISOString()
      };
      
      res.json(response);
    } catch (error) {
      config.logger.error({ error, provider, tenantId }, 'Error getting circuit state');
      res.status(500).json({ 
        error: 'internal_error', 
        message: 'Failed to retrieve circuit state' 
      });
    }
  });

  /**
   * GET /api/providers/:provider/circuit-events
   * 
   * Returns recent circuit breaker events for a provider and tenant
   * Query params:
   * - tenantId: required, the tenant ID
   * - limit: optional, max number of events to return (default 50, max 100)
   */
  router.get('/:provider/circuit-events', (req, res) => {
    const { provider } = req.params;
    const { tenantId, limit = '50' } = req.query;
    
    if (!tenantId || typeof tenantId !== 'string') {
      return res.status(400).json({ 
        error: 'invalid_request', 
        message: 'tenantId query parameter is required' 
      });
    }
    
    const limitNum = Math.min(parseInt(limit as string, 10) || 50, 100);
    
    try {
      const events = circuitBreaker.getEventsForProvider(provider, tenantId, limitNum);
      
      const response = {
        provider,
        tenantId,
        events: events.map(event => ({
          fromState: event.fromState,
          toState: event.toState,
          timestamp: event.timestamp.toISOString(),
          reason: event.reason,
          durationInPreviousStateMs: event.durationInPreviousStateMs
        }))
      };
      
      res.json(response);
    } catch (error) {
      config.logger.error({ error, provider, tenantId }, 'Error getting circuit events');
      res.status(500).json({ 
        error: 'internal_error', 
        message: 'Failed to retrieve circuit events' 
      });
    }
  });

  /**
   * POST /api/providers/:provider/reset
   * 
   * Manually reset a circuit breaker for a provider
   * Body:
   * - tenantId: required, the tenant ID
   * - reason: required, reason for manual reset
   */
  router.post('/:provider/reset', (req, res) => {
    const { provider } = req.params;
    const { tenantId, reason } = req.body;
    
    if (!tenantId || typeof tenantId !== 'string') {
      return res.status(400).json({ 
        error: 'invalid_request', 
        message: 'tenantId is required in request body' 
      });
    }
    
    if (!reason || typeof reason !== 'string') {
      return res.status(400).json({ 
        error: 'invalid_request', 
        message: 'reason is required in request body' 
      });
    }
    
    try {
      circuitBreaker.reset(provider, tenantId, reason);
      
      res.json({ 
        success: true, 
        message: `Circuit breaker for ${provider} reset to CLOSED`,
        provider,
        tenantId,
        reason
      });
    } catch (error) {
      config.logger.error({ error, provider, tenantId }, 'Error resetting circuit breaker');
      res.status(500).json({ 
        error: 'internal_error', 
        message: 'Failed to reset circuit breaker' 
      });
    }
  });

  /**
   * POST /api/providers/:provider/record-result
   * 
   * Record a call result (success or failure) for circuit breaker logic
   * This would be called by an external adapter
   * Body:
   * - tenantId: required, the tenant ID
   * - success: required, boolean indicating if call succeeded
   * - errorCode: optional, error code if call failed
   */
  router.post('/:provider/record-result', (req, res) => {
    const { provider } = req.params;
    const { tenantId, success, errorCode } = req.body;
    
    if (!tenantId || typeof tenantId !== 'string') {
      return res.status(400).json({ 
        error: 'invalid_request', 
        message: 'tenantId is required in request body' 
      });
    }
    
    if (typeof success !== 'boolean') {
      return res.status(400).json({ 
        error: 'invalid_request', 
        message: 'success is required and must be a boolean' 
      });
    }
    
    try {
      if (success) {
        circuitBreaker.recordSuccess(provider, tenantId);
      } else {
        circuitBreaker.recordFailure(provider, tenantId, errorCode);
      }
      
      const state = circuitBreaker.getState(provider, tenantId);
      
      res.json({ 
        success: true,
        provider,
        tenantId,
        circuitState: state.state,
        recorded: success ? 'success' : 'failure'
      });
    } catch (error) {
      config.logger.error({ error, provider, tenantId }, 'Error recording call result');
      res.status(500).json({ 
        error: 'internal_error', 
        message: 'Failed to record call result' 
      });
    }
  });

  /**
   * GET /api/providers/:provider/should-allow
   * 
   * Check if a call should be allowed based on circuit breaker state
   * Query params:
   * - tenantId: required, the tenant ID
   */
  router.get('/:provider/should-allow', (req, res) => {
    const { provider } = req.params;
    const { tenantId } = req.query;
    
    if (!tenantId || typeof tenantId !== 'string') {
      return res.status(400).json({ 
        error: 'invalid_request', 
        message: 'tenantId query parameter is required' 
      });
    }
    
    try {
      const shouldAllow = circuitBreaker.shouldAllow(provider, tenantId);
      const state = circuitBreaker.getState(provider, tenantId);
      
      res.json({ 
        provider,
        tenantId,
        shouldAllow,
        circuitState: state.state,
        nextProbeAt: state.nextProbeAt?.toISOString()
      });
    } catch (error) {
      config.logger.error({ error, provider, tenantId }, 'Error checking circuit state');
      res.status(500).json({ 
        error: 'internal_error', 
        message: 'Failed to check circuit state' 
      });
    }
  });

  return router;
}