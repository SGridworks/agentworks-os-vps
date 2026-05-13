# Circuit Breaker Implementation

This document describes the circuit breaker implementation for LLM provider failover in AgentWorks OS.

## Overview

The circuit breaker pattern prevents cascading failures by automatically routing LLM calls to fallback providers when the primary provider experiences capacity pressure or high failure rates.

## Architecture

The implementation consists of:

1. **CircuitBreaker class** - Core state machine implementation
2. **API routes** - REST endpoints for monitoring and control
3. **Integration points** - Where external adapters should call the circuit breaker

## State Machine

The circuit breaker has three states:

- **CLOSED** - Normal operation, calls go to primary provider
- **OPEN** - Circuit is open, calls are routed to fallback provider
- **HALF_OPEN** - Probing primary provider to check if it's recovered

### State Transitions

```
CLOSED → OPEN: Failure rate exceeds threshold (default 30%) over minimum calls (default 10)
OPEN → HALF_OPEN: Probe interval elapsed (default 5 minutes)
HALF_OPEN → CLOSED: Probe call succeeds
HALF_OPEN → OPEN: Probe call fails
```

## Configuration

Default configuration:

```typescript
{
  failureThreshold: 0.3,        // 30% failure rate
  minimumCallCount: 10,         // Minimum calls before evaluating
  timeWindowMinutes: 5,         // Rolling window for failure rate
  probeIntervalMinutes: 5,      // How often to probe when open
  transientErrorCodes: [        // Errors that trigger retry before counting
    'adapter_failed',
    '429',
    '5xx',
    'timeout'
  ]
}
```

## API Endpoints

### Get Circuit States
```
GET /api/providers/circuit-state?tenantId=<tenant-id>
```

Returns all provider circuit states for a tenant.

### Get Specific Provider State
```
GET /api/providers/:provider/circuit-state?tenantId=<tenant-id>
```

Returns circuit state for a specific provider.

### Get Circuit Events
```
GET /api/providers/:provider/circuit-events?tenantId=<tenant-id>&limit=<n>
```

Returns recent circuit breaker events for a provider.

### Manual Reset
```
POST /api/providers/:provider/reset
Body: { tenantId: string, reason: string }
```

Manually reset a circuit breaker to CLOSED state.

### Record Call Result
```
POST /api/providers/:provider/record-result
Body: { 
  tenantId: string, 
  success: boolean, 
  errorCode?: string 
}
```

Record a call result for circuit breaker logic.

### Check If Call Should Be Allowed
```
GET /api/providers/:provider/should-allow?tenantId=<tenant-id>
```

Check if a call should be allowed based on circuit state.

## Integration

The circuit breaker should be integrated into adapter implementations at the provider level:

1. Before making an LLM call, check `shouldAllow(provider, tenantId)`
2. If not allowed, use fallback provider immediately
3. After call completes, record result with `recordSuccess()` or `recordFailure()`
4. Include circuit state in usage telemetry

Example integration:

```typescript
async function makeLlmCall(provider: string, tenantId: string, prompt: string) {
  // Check if primary provider is available
  if (!circuitBreaker.shouldAllow(provider, tenantId)) {
    // Use fallback provider
    return await makeLlmCall(fallbackProvider, tenantId, prompt);
  }
  
  try {
    const result = await primaryAdapter.call(prompt);
    circuitBreaker.recordSuccess(provider, tenantId);
    return result;
  } catch (error) {
    circuitBreaker.recordFailure(provider, tenantId, error.code);
    
    // Retry on transient errors
    if (isTransientError(error.code)) {
      return await makeLlmCall(fallbackProvider, tenantId, prompt);
    }
    
    throw error;
  }
}
```

## Usage Telemetry Integration

The circuit breaker state should be included in usage telemetry (AWO-169):

```json
{
  "inputTokens": 150,
  "outputTokens": 250,
  "totalTokens": 400,
  "estimatedCostUsd": 0.004,
  "providerLatencyMs": 1200,
  "primaryModelUsed": "gpt-oss:120b",
  "circuitState": "open",        // closed | half_open | open
  "actualProviderUsed": "ollama-cloud"  // May differ from primary if circuit open
}
```

## Testing

Run circuit breaker tests:

```bash
npm test src/circuit-breaker/CircuitBreaker.test.ts
```

## Future Enhancements

1. **Persistent Storage** - Store circuit states in database for recovery
2. **Metrics Export** - Prometheus/OpenTelemetry metrics
3. **Dynamic Configuration** - Runtime config updates via API
4. **Machine Learning** - Adaptive thresholds based on historical patterns
5. **Cost Optimization** - Route based on cost as well as availability