import { CircuitBreaker } from "../circuit-breaker/CircuitBreaker.js";
import { CircuitState, CircuitBreakerState } from "../circuit-breaker/types.js";
import type { Config } from "../config.js";

/**
 * Configuration for a provider in the cost meter
 */
export interface ProviderConfig {
  /** Provider name (e.g., "openai", "anthropic", "ollama-cloud") */
  name: string;
  
  /** Provider endpoint URL */
  endpoint: string;
  
  /** API key for the provider */
  apiKey?: string;
  
  /** Whether this is a primary provider */
  isPrimary: boolean;
  
  /** Fallback order (lower number = higher priority) */
  fallbackOrder: number;
  
  /** Circuit breaker configuration override */
  circuitBreakerConfig?: Partial<{
    failureThreshold: number;
    minimumCallCount: number;
    timeWindowMinutes: number;
    probeIntervalMinutes: number;
    transientErrorCodes: string[];
  }>;
}

/**
 * Cost meter result with usage telemetry
 */
export interface CostMeterResult {
  /** Whether the call succeeded */
  success: boolean;
  
  /** Response data from the provider */
  data?: any;
  
  /** Error if call failed */
  error?: string;
  
  /** Error code if call failed */
  errorCode?: string;
  
  /** Provider that was actually used */
  actualProvider: string;
  
  /** Circuit breaker state at the time of the call */
  circuitState: string;
  
  /** Usage telemetry */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
    providerLatencyMs?: number;
    primaryModelUsed?: string;
    actualProviderUsed?: string;
    providerRateLimitHeaders?: Record<string, string> | null;
  };
  
  /** Whether fallback was used */
  fallbackUsed: boolean;
  
  /** Number of retry attempts */
  retryAttempts: number;
}

/**
 * Cost meter proxy that routes calls to LLM providers with circuit breaker protection
 */
/**
 * A fetch-like function for making HTTP requests.
 * Exposed so tests can inject a mock.
 */
export type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class CostMeter {
  private circuitBreaker: CircuitBreaker;
  private providerConfigs: Map<string, ProviderConfig> = new Map();
  private config: Config;
  private fetch: FetchLike;

  constructor(config: Config, providerConfigs: ProviderConfig[], fetch_: FetchLike = globalThis.fetch.bind(globalThis)) {
    this.config = config;
    this.fetch = fetch_;
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 0.3,
      minimumCallCount: 10,
      timeWindowMinutes: 5,
      probeIntervalMinutes: 5,
      transientErrorCodes: ['adapter_failed', '429', '5xx', 'timeout']
    });

    // Store provider configurations
    for (const providerConfig of providerConfigs) {
      this.providerConfigs.set(providerConfig.name, providerConfig);
      
      // Apply circuit breaker config override if provided
      if (providerConfig.circuitBreakerConfig) {
        // Custom CB config per-provider is noted; default config is used for now
      }
    }
  }

  /**
   * Make a chat completion call with circuit breaker protection and fallback
   */
  async chatCompletions(
    primaryProvider: string, 
    tenantId: string, 
    request: any
  ): Promise<CostMeterResult> {
    const startTime = Date.now();
    let attempts = 0;
    let lastError: Error | null = null;
    let fallbackUsed = false;

    // Get ordered list of providers to try (primary first, then fallbacks)
    const providersToTry = this.getProvidersToTry(primaryProvider);

    for (const provider of providersToTry) {
      attempts++;
      
      // Check if we should allow this provider
      if (!this.circuitBreaker.shouldAllow(provider, tenantId)) {
        console.debug(`Circuit breaker blocked ${provider} for tenant ${tenantId}`);
        continue;
      }

      try {
        // Make the actual API call
        const result = await this.makeProviderCall(provider, request);
        
        // Record success
        this.circuitBreaker.recordSuccess(provider, tenantId);
        
        const latency = Date.now() - startTime;
        
        return {
          success: true,
          data: result.data,
          actualProvider: provider,
          circuitState: this.circuitBreaker.getState(provider, tenantId).state,
          usage: {
            ...result.usage,
            providerLatencyMs: latency,
            actualProviderUsed: provider,
          },
          fallbackUsed: fallbackUsed,
          retryAttempts: attempts - 1
        };
        
      } catch (error: any) {
        lastError = error;
        
        // Determine error code
        const errorCode = this.getErrorCode(error);
        
        // Record failure
        this.circuitBreaker.recordFailure(provider, tenantId, errorCode);
        
        // Check if this is a transient error that should trigger retry
        const isTransient = this.isTransientError(errorCode);
        
        if (isTransient && attempts < providersToTry.length) {
          // Try next provider
        fallbackUsed = true;
        console.debug(
          `Transient error from ${provider}, trying fallback: ${error.message}`
        );
          continue;
        } else {
          // No more providers to try or non-transient error
          break;
        }
      }
    }

    // All providers failed
    const latency = Date.now() - startTime;
    
    return {
      success: false,
      error: lastError?.message || 'All providers failed',
      errorCode: lastError ? this.getErrorCode(lastError) : 'unknown',
      actualProvider: primaryProvider,
      circuitState: this.circuitBreaker.getState(primaryProvider, tenantId).state,
      usage: {
        providerLatencyMs: latency,
        actualProviderUsed: primaryProvider
      },
      fallbackUsed: fallbackUsed,
      retryAttempts: attempts - 1
    };
  }

  /**
   * Get circuit breaker state for monitoring
   */
  getCircuitState(provider: string, tenantId: string): CircuitState {
    return this.circuitBreaker.getState(provider, tenantId).state;
  }

  /**
   * Get all circuit states for a tenant
   */
  getAllCircuitStates(tenantId: string): Array<{ provider: string; state: CircuitBreakerState }> {
    return this.circuitBreaker.getStatesForTenant(tenantId);
  }

  /**
   * Register a callback for circuit breaker state-change events.
   * Calls through to the underlying CircuitBreaker listener.
   */
  setOnStateChange(cb: (event: any) => void): void {
    this.circuitBreaker.setOnStateChange(cb);
  }

  /**
   * Get recent circuit breaker events
   */
  getCircuitEvents(provider: string, tenantId: string, limit?: number): any[] {
    return this.circuitBreaker.getEventsForProvider(provider, tenantId, limit);
  }

  /**
   * Get ordered list of providers to try (primary first, then fallbacks)
   */
  private getProvidersToTry(primaryProvider: string): string[] {
    const providers: string[] = [primaryProvider];
    
    // Add fallback providers in order
    const fallbacks = Array.from(this.providerConfigs.values())
      .filter(p => !p.isPrimary && p.name !== primaryProvider)
      .sort((a, b) => a.fallbackOrder - b.fallbackOrder)
      .map(p => p.name);
    
    return [...providers, ...fallbacks];
  }

  /**
   * Make an actual provider call
   */
  private async makeProviderCall(provider: string, request: any): Promise<any> {
    const config = this.providerConfigs.get(provider);
    if (!config) {
      throw new Error(`Unknown provider: ${provider}`);
    }

    const url = `${config.endpoint}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    const response = await this.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const error = new Error(`Provider ${provider} returned ${response.status}: ${body}`);
      (error as any).status = response.status;
      (error as any).code = response.status === 429 ? '429' : response.status >= 500 ? '5xx' : 'unknown';
      throw error;
    }

    const data = await response.json() as {
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };

    // Extract usage from OpenAI-compatible response shape
    const usage = data.usage ? {
      inputTokens: data.usage.prompt_tokens,
      outputTokens: data.usage.completion_tokens,
      totalTokens: data.usage.total_tokens,
      estimatedCostUsd: this.estimateCost(request.model, data.usage),
      primaryModelUsed: request.model,
    } : undefined;

    // Capture rate-limit headers
    const rateLimitHeaders: Record<string, string> | null = {};
    const rateLimitKeys = ['x-ratelimit-remaining-tokens', 'x-ratelimit-remaining-requests', 'retry-after', 'x-ratelimit-reset'];
    for (const key of rateLimitKeys) {
      const val = response.headers.get(key);
      if (val) rateLimitHeaders[key] = val;
    }

    return {
      data,
      usage: {
        ...usage,
        providerRateLimitHeaders: Object.keys(rateLimitHeaders).length > 0 ? rateLimitHeaders : null,
      },
    };
  }

  /**
   * Estimate cost based on model and token counts
   */
  private estimateCost(model: string, usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }): number {
    // OpenAI GPT-4o pricing (per 1M tokens as of 2024)
    const pricing: Record<string, { input: number; output: number }> = {
      'gpt-4o': { input: 5.0, output: 15.0 },
      'gpt-4o-mini': { input: 0.15, output: 0.6 },
      'gpt-4-turbo': { input: 10.0, output: 30.0 },
      'gpt-4': { input: 30.0, output: 60.0 },
      'claude-3-5-sonnet': { input: 3.0, output: 15.0 },
      'claude-3-opus': { input: 15.0, output: 75.0 },
    };
    const p = pricing[model] || { input: 5.0, output: 15.0 };
    return (usage.prompt_tokens * p.input + usage.completion_tokens * p.output) / 1_000_000;
  }

  /**
   * Get error code from error object.
   * 'process_lost' and network errors (ECONNREFUSED, ETIMEDOUT, etc.) are
   * infrastructure-layer failures that do NOT count toward circuit-breaker state.
   */
  private getErrorCode(error: any): string {
    // Check message-based codes first (more specific), then numeric codes
    if (error.message?.includes('process_lost')) return 'process_lost';
    if (error.message?.includes('timeout')) return 'timeout';
    // Network errors are infrastructure failures — exclude from circuit-breaker
    if (
      error.code === 'ECONNREFUSED' ||
      error.code === 'ENOTFOUND' ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'ENETUNREACH' ||
      error.code === 'EAI_AGAIN' ||
      error.message?.includes('fetch failed') ||
      error.message?.includes('network error')
    ) {
      return 'network_error';
    }
    // Then numeric/status-based codes
    if (error.status) return error.status.toString();
    if (error.code) return error.code;
    return 'unknown';
  }

  /**
   * Check if error code represents a transient error
   */
  private isTransientError(errorCode: string): boolean {
    const transientCodes = ['adapter_failed', '429', '5xx', 'timeout'];
    return transientCodes.includes(errorCode);
  }
}