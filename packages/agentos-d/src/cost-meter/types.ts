export enum CircuitState {
  CLOSED = 'closed',
  HALF_OPEN = 'half_open',
  OPEN = 'open',
}

export interface CircuitBreakerConfig {
  failureThreshold: number; // e.g., 0.3 for 30%
  minimumCallCount: number; // e.g., 10 calls before evaluating
  timeWindowMinutes: number; // not currently used, placeholder for rolling window
  probeIntervalMinutes: number; // interval between half-open probes
  transientErrorCodes: string[]; // error codes that trigger retry without counting as failure
}

export interface CircuitBreakerState {
  state: CircuitState;
  lastStateChange: Date;
  failureCount: number;
  totalCount: number;
  nextProbeAt?: Date;
  lastReason?: string;
}

export interface CircuitBreakerEvent {
  provider: string;
  tenantId: string;
  fromState: CircuitState;
  toState: CircuitState;
  timestamp: Date;
  reason: string;
  durationInPreviousStateMs?: number;
}