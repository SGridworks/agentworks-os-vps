import { CircuitState, CircuitBreakerConfig, CircuitBreakerState, CircuitBreakerEvent } from './types.js';

export { CircuitState } from './types.js';

/**
 * Default configuration for circuit breaker
 */
const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 0.3, // 30%
  minimumCallCount: 10,
  timeWindowMinutes: 5,
  probeIntervalMinutes: 5,
  transientErrorCodes: ['adapter_failed', '429', '5xx', 'timeout']
};

/**
 * Circuit breaker implementation for LLM provider failover
 */
export class CircuitBreaker {
  private states: Map<string, CircuitBreakerState> = new Map();
  private events: CircuitBreakerEvent[] = [];
  private config: CircuitBreakerConfig;
  private onStateChange: ((event: CircuitBreakerEvent) => void) | null = null;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register a callback for circuit state-change events.
   * Used by ProcessWatcher to re-emit CB events as process:event messages.
   */
  setOnStateChange(cb: (event: CircuitBreakerEvent) => void): void {
    this.onStateChange = cb;
  }

  /**
   * Record a successful call for a provider
   */
  recordSuccess(provider: string, tenantId: string): void {
    const key = this.getKey(provider, tenantId);
    const state = this.getOrCreateState(key, provider, tenantId);

    state.totalCount++;

    // If circuit was half-open and call succeeded, close it
    if (state.state === CircuitState.HALF_OPEN) {
      this.transitionTo(key, CircuitState.CLOSED, 'Half-open probe succeeded');
    }
  }

  /**
   * Record a failed call for a provider
   */
  recordFailure(provider: string, tenantId: string, errorCode?: string): void {
    const key = this.getKey(provider, tenantId);
    const state = this.getOrCreateState(key, provider, tenantId);

    // process_lost and network_error are infrastructure failures — do not count
    // toward circuit breaker state at all.
    if (errorCode === 'process_lost' || errorCode === 'network_error') {
      return;
    }

    state.totalCount++;

    // Transient errors don't count toward threshold — they trigger a retry on
    // the fallback provider first. Only non-transient errors count.
    const isTransient = errorCode && this.config.transientErrorCodes.includes(errorCode);
    if (isTransient) {
      return;
    }

    state.failureCount++;

    // Check if we should open the circuit
    if (
      state.state === CircuitState.CLOSED &&
      state.totalCount >= this.config.minimumCallCount
    ) {
      const failureRate = state.failureCount / state.totalCount;
      if (failureRate >= this.config.failureThreshold) {
        this.transitionTo(
          key,
          CircuitState.OPEN,
          `Failure rate ${(failureRate * 100).toFixed(1)}% exceeded threshold ${this.config.failureThreshold * 100}%`,
        );
      }
    }
  }

  /**
   * Should we allow a call to this provider?
   */
  shouldAllow(provider: string, tenantId: string): boolean {
    const key = this.getKey(provider, tenantId);
    const state = this.getOrCreateState(key, provider, tenantId);

    switch (state.state) {
      case CircuitState.CLOSED:
      case CircuitState.HALF_OPEN:
        return true;
      case CircuitState.OPEN:
        // Check if it's time for a probe
        if (!state.nextProbeAt || new Date() >= state.nextProbeAt) {
          this.transitionTo(key, CircuitState.HALF_OPEN, 'Starting probe call');
          return true;
        }
        return false;
    }
  }

  /**
   * Get current state for a provider
   */
  getState(provider: string, tenantId: string): CircuitBreakerState {
    const key = this.getKey(provider, tenantId);
    return this.getOrCreateState(key, provider, tenantId);
  }

  /**
   * Get all states for a tenant
   */
  getStatesForTenant(
    tenantId: string,
  ): Array<{ provider: string; state: CircuitBreakerState }> {
    const result: Array<{ provider: string; state: CircuitBreakerState }> = [];

    for (const [key, state] of Array.from(this.states.entries())) {
      if (key.endsWith(`:${tenantId}`)) {
        const provider = key.split(':')[0] ?? '';
        result.push({ provider, state });
      }
    }

    return result;
  }

  /**
   * Get recent events
   */
  getEvents(limit = 100): CircuitBreakerEvent[] {
    return this.events.slice(-limit);
  }

  /**
   * Get events for a specific provider and tenant
   */
  getEventsForProvider(
    provider: string,
    tenantId: string,
    limit = 50,
  ): CircuitBreakerEvent[] {
    return this.events
      .filter((e) => e.provider === provider && e.tenantId === tenantId)
      .slice(-limit);
  }

  /**
   * Reset circuit breaker for a provider (manual intervention).
   * Also clears failure/total counters.
   */
  reset(provider: string, tenantId: string, reason: string): void {
    const key = this.getKey(provider, tenantId);
    this.transitionTo(key, CircuitState.CLOSED, `Manual reset: ${reason}`);
  }

  /**
   * Clear ALL state. For testing only.
   */
  clear(): void {
    this.states.clear();
    this.events = [];
  }

  private getKey(provider: string, tenantId: string): string {
    return `${provider}:${tenantId}`;
  }

  private getOrCreateState(
    key: string,
    provider: string,
    tenantId: string,
  ): CircuitBreakerState {
    if (!this.states.has(key)) {
      this.states.set(key, {
        state: CircuitState.CLOSED,
        lastStateChange: new Date(),
        failureCount: 0,
        totalCount: 0,
      });
    }

    return this.states.get(key)!;
  }

  private transitionTo(key: string, newState: CircuitState, reason: string): void {
    const state = this.states.get(key)!;
    const oldState = state.state;

    if (oldState === newState) {
      return;
    }

    const now = new Date();
    const durationInPreviousStateMs = now.getTime() - state.lastStateChange.getTime();

    // Update state
    state.state = newState;
    state.lastStateChange = now;
    state.lastReason = reason;

    // Handle state-specific transitions
    if (newState === CircuitState.OPEN) {
      // Schedule next probe
      state.nextProbeAt = new Date(
        now.getTime() + this.config.probeIntervalMinutes * 60 * 1000,
      );
      state.failureCount = 0; // Reset failure count when opening
      state.totalCount = 0;
    } else if (newState === CircuitState.CLOSED) {
      // Reset counters when closing
      state.failureCount = 0;
      state.totalCount = 0;
      // Use delete (not assignment) so exactOptionalPropertyTypes sees "absent"
      // rather than "explicitly undefined"
      delete (state as unknown as Record<string, unknown>).nextProbeAt;
    }

    // Log event
    const [prov = '', ten = ''] = key.split(':');
    const event: CircuitBreakerEvent = {
      provider: prov,
      tenantId: ten,
      fromState: oldState,
      toState: newState,
      timestamp: now,
      reason,
      durationInPreviousStateMs,
    };

    this.events.push(event);

    // Keep only last 1000 events to prevent memory leak
    if (this.events.length > 1000) {
      this.events = this.events.slice(-1000);
    }

    // Notify external listener (ProcessWatcher) so it can re-emit as process:event
    this.onStateChange?.(event);
  }
}
