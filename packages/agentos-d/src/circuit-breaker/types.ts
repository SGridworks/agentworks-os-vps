/**
 * Circuit breaker state machine states
 */
export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open'
}

/**
 * Configuration for circuit breaker per provider
 */
export interface CircuitBreakerConfig {
  /** Failure rate threshold (0.0 - 1.0, default 0.3) */
  failureThreshold: number;
  
  /** Minimum number of calls before evaluating threshold (default 10) */
  minimumCallCount: number;
  
  /** Time window for rolling failure rate calculation in minutes (default 5) */
  timeWindowMinutes: number;
  
  /** Probe interval when circuit is open in minutes (default 5) */
  probeIntervalMinutes: number;
  
  /** Transient error codes that trigger retry before counting toward threshold */
  transientErrorCodes: string[];
}

/**
 * Circuit breaker state for a specific provider and tenant
 */
export interface CircuitBreakerState {
  /** Current state of the circuit */
  state: CircuitState;
  
  /** When the circuit state last changed */
  lastStateChange: Date;
  
  /** Reason for the last state change */
  lastReason?: string;
  
  /** Number of consecutive failures in current time window */
  failureCount: number;
  
  /** Total number of calls in current time window */
  totalCount: number;
  
  /** When the next probe should be sent (only for OPEN state) */
  nextProbeAt?: Date;
  
  /** Fallback provider to use when circuit is open */
  fallbackProvider?: string;
}

/**
 * Event logged when circuit breaker state changes
 */
export interface CircuitBreakerEvent {
  /** Provider that triggered the event */
  provider: string;
  
  /** Tenant ID for isolation */
  tenantId: string;
  
  /** Previous state */
  fromState: CircuitState;
  
  /** New state */
  toState: CircuitState;
  
  /** When the state change occurred */
  timestamp: Date;
  
  /** Reason for the state change */
  reason: string;
  
  /** Duration the circuit was in the previous state (if applicable) */
  durationInPreviousStateMs?: number;
}