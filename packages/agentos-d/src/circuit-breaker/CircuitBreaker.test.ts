import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker, CircuitState } from './CircuitBreaker.js';

describe('CircuitBreaker', () => {
  let circuitBreaker: CircuitBreaker;

  beforeEach(() => {
    circuitBreaker = new CircuitBreaker({
      failureThreshold: 0.3,
      minimumCallCount: 5,
      timeWindowMinutes: 5,
      probeIntervalMinutes: 1,
      transientErrorCodes: ['adapter_failed', '429', '5xx', 'timeout'],
    });
  });

  afterEach(() => {
    circuitBreaker.clear();
  });

  describe('initial state', () => {
    it('should start in CLOSED state', () => {
      const state = circuitBreaker.getState('test-provider', 'test-tenant');
      expect(state.state).toBe(CircuitState.CLOSED);
      expect(state.failureCount).toBe(0);
      expect(state.totalCount).toBe(0);
    });
  });

  describe('recordSuccess', () => {
    it('should increment totalCount on success', () => {
      circuitBreaker.recordSuccess('test-provider', 'test-tenant');
      const state = circuitBreaker.getState('test-provider', 'test-tenant');
      expect(state.state).toBe(CircuitState.CLOSED);
      expect(state.totalCount).toBe(1); // success increments totalCount
    });

    it('should close circuit from HALF_OPEN on success', () => {
      // Force circuit to OPEN by opening it first via failures
      for (let i = 0; i < 5; i++) {
        circuitBreaker.recordFailure('test-provider', 'test-tenant', 'internal_error');
      }
      expect(circuitBreaker.getState('test-provider', 'test-tenant').state).toBe(CircuitState.OPEN);

      // Set probe time to the past so shouldAllow transitions to HALF_OPEN
      const key = 'test-provider:test-tenant';
      const internalStates = (circuitBreaker as any).states;
      const existing = internalStates.get(key);
      existing.nextProbeAt = new Date(Date.now() - 1000);
      internalStates.set(key, existing);

      // shouldAllow transitions to HALF_OPEN
      circuitBreaker.shouldAllow('test-provider', 'test-tenant');
      expect(circuitBreaker.getState('test-provider', 'test-tenant').state).toBe(CircuitState.HALF_OPEN);

      // Now record success
      circuitBreaker.recordSuccess('test-provider', 'test-tenant');

      const newState = circuitBreaker.getState('test-provider', 'test-tenant');
      expect(newState.state).toBe(CircuitState.CLOSED);
    });
  });

  describe('recordFailure', () => {
    it('should count non-transient errors in rolling window', () => {
      circuitBreaker.recordFailure('test-provider', 'test-tenant', 'internal_error');
      const state = circuitBreaker.getState('test-provider', 'test-tenant');
      expect(state.state).toBe(CircuitState.CLOSED); // not enough calls yet
    });

    it('should not count transient errors toward threshold', () => {
      circuitBreaker.recordFailure('test-provider', 'test-tenant', 'adapter_failed');
      // transient errors keep circuit closed
      const state = circuitBreaker.getState('test-provider', 'test-tenant');
      expect(state.state).toBe(CircuitState.CLOSED);
    });

    it('should not count process_lost errors at all', () => {
      circuitBreaker.recordFailure('test-provider', 'test-tenant', 'process_lost');
      const state = circuitBreaker.getState('test-provider', 'test-tenant');
      expect(state.state).toBe(CircuitState.CLOSED);
      expect(state.totalCount).toBe(0); // process_lost increments nothing
      expect(state.failureCount).toBe(0);
    });

    it('should open circuit when rolling failure threshold is exceeded', () => {
      // Record 4 failures (below threshold of 5)
      for (let i = 0; i < 4; i++) {
        circuitBreaker.recordFailure('test-provider', 'test-tenant', 'internal_error');
      }

      let state = circuitBreaker.getState('test-provider', 'test-tenant');
      expect(state.state).toBe(CircuitState.CLOSED);

      // One more failure should open the circuit (4/5 = 80% failure rate)
      circuitBreaker.recordFailure('test-provider', 'test-tenant', 'internal_error');

      state = circuitBreaker.getState('test-provider', 'test-tenant');
      expect(state.state).toBe(CircuitState.OPEN);
    });
  });

  describe('shouldAllow', () => {
    it('should allow calls when CLOSED', () => {
      expect(circuitBreaker.shouldAllow('test-provider', 'test-tenant')).toBe(true);
    });

    it('should allow calls when HALF_OPEN', () => {
      // Force to OPEN first
      for (let i = 0; i < 5; i++) {
        circuitBreaker.recordFailure('test-provider', 'test-tenant', 'internal_error');
      }
      expect(circuitBreaker.getState('test-provider', 'test-tenant').state).toBe(CircuitState.OPEN);

      // Manually set nextProbeAt to the past
      const key = 'test-provider:test-tenant';
      const internalStates = (circuitBreaker as any).states;
      const existing = internalStates.get(key);
      existing.nextProbeAt = new Date(Date.now() - 1000);
      internalStates.set(key, existing);

      // shouldAllow transitions to HALF_OPEN and returns true
      expect(circuitBreaker.shouldAllow('test-provider', 'test-tenant')).toBe(true);
      expect(circuitBreaker.getState('test-provider', 'test-tenant').state).toBe(CircuitState.HALF_OPEN);
    });

    it('should not allow calls when OPEN and probe time not reached', () => {
      for (let i = 0; i < 5; i++) {
        circuitBreaker.recordFailure('test-provider', 'test-tenant', 'internal_error');
      }
      const state = circuitBreaker.getState('test-provider', 'test-tenant');
      expect(state.state).toBe(CircuitState.OPEN);
      // Should not allow yet (probe time in future)
      expect(circuitBreaker.shouldAllow('test-provider', 'test-tenant')).toBe(false);
    });

    it('should allow probe calls when OPEN and probe time reached', () => {
      for (let i = 0; i < 5; i++) {
        circuitBreaker.recordFailure('test-provider', 'test-tenant', 'internal_error');
      }

      // Manually set nextProbeAt to the past
      const key = 'test-provider:test-tenant';
      const internalStates = (circuitBreaker as any).states;
      const existing = internalStates.get(key);
      existing.nextProbeAt = new Date(Date.now() - 1000);
      internalStates.set(key, existing);

      expect(circuitBreaker.shouldAllow('test-provider', 'test-tenant')).toBe(true);

      const newState = circuitBreaker.getState('test-provider', 'test-tenant');
      expect(newState.state).toBe(CircuitState.HALF_OPEN);
    });
  });

  describe('tenant isolation', () => {
    it('should isolate states between tenants', () => {
      for (let i = 0; i < 5; i++) {
        circuitBreaker.recordFailure('test-provider', 'tenant-a', 'internal_error');
      }

      const stateA = circuitBreaker.getState('test-provider', 'tenant-a');
      expect(stateA.state).toBe(CircuitState.OPEN);

      const stateB = circuitBreaker.getState('test-provider', 'tenant-b');
      expect(stateB.state).toBe(CircuitState.CLOSED);
    });
  });

  describe('events', () => {
    it('should log state transition events', () => {
      for (let i = 0; i < 5; i++) {
        circuitBreaker.recordFailure('test-provider', 'test-tenant', 'internal_error');
      }

      const events = circuitBreaker.getEventsForProvider('test-provider', 'test-tenant');
      expect(events).toHaveLength(1);
      expect(events[0].fromState).toBe(CircuitState.CLOSED);
      expect(events[0].toState).toBe(CircuitState.OPEN);
      expect(events[0].reason).toContain('Failure rate');
    });

    it('should track duration in previous state', () => {
      circuitBreaker.recordFailure('test-provider', 'test-tenant', 'internal_error');
      // Wait a little
      const start = Date.now();
      while (Date.now() - start < 50) { /* spin */ }

      for (let i = 0; i < 4; i++) {
        circuitBreaker.recordFailure('test-provider', 'test-tenant', 'internal_error');
      }

      const events = circuitBreaker.getEventsForProvider('test-provider', 'test-tenant');
      expect(events).toHaveLength(1);
      expect(events[0].durationInPreviousStateMs).toBeGreaterThanOrEqual(50);
    });
  });

  describe('reset', () => {
    it('should manually reset circuit to CLOSED', () => {
      for (let i = 0; i < 5; i++) {
        circuitBreaker.recordFailure('test-provider', 'test-tenant', 'internal_error');
      }

      expect(circuitBreaker.getState('test-provider', 'test-tenant').state).toBe(CircuitState.OPEN);

      circuitBreaker.reset('test-provider', 'test-tenant', 'Manual intervention');

      const state = circuitBreaker.getState('test-provider', 'test-tenant');
      expect(state.state).toBe(CircuitState.CLOSED);
      expect(state.failureCount).toBe(0);
      expect(state.totalCount).toBe(0);
    });
  });
});
