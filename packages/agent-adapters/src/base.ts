/**
 * Adapter base contract.
 *
 * Every agent platform we plug into (Claude Local, Codex, Hermes, ...) speaks
 * a different wire protocol; each adapter normalizes that into the same
 * substrate-facing shape so the daemon doesn't care which runtime is on the
 * other side. Adapters never invent their own envelope shape — the canonical
 * `ActionEnvelope` from `@agentworks/shared` is the truth across the system.
 *
 * The local `AdapterEnvelope` is a smaller projection used only at adapter
 * boundaries while we wire callers gradually onto the canonical envelope.
 * Keep it minimal; if you need a new field, push it through ActionEnvelope.
 */

export interface AdapterEnvelope {
  /** Canonical actionKind — lowercase dot-separated, e.g. "outbound.sms". */
  actionKind: string;
  /** Free-form payload; adapters MUST NOT mutate this object. */
  payload: Record<string, unknown>;
  /** Optional tenant id. Pass-through for adapters that scope by tenant. */
  tenantId?: string;
  /** Optional request id for traceability. Defaults are caller's problem. */
  requestId?: string;
}

export interface AdapterResult {
  /** Did the adapter believe the call landed cleanly? */
  success: boolean;
  /** Adapter-shaped success payload (only when success=true). */
  data?: Record<string, unknown>;
  /** Adapter-shaped error explanation (only when success=false). */
  error?: string;
  /** Free-form metadata, e.g. latency, target endpoint, dispatched job id. */
  meta?: Record<string, unknown>;
}

export interface AdapterMetadata {
  /** Stable key for the adapter, e.g. "claude_local", "codex", "hermes". */
  key: string;
  /** Human label for admin UI surfaces. */
  label: string;
  /** Best-effort capability tags (e.g. "vault.read", "outbound.sms"). */
  capabilities: string[];
}

export interface AgentAdapter {
  readonly metadata: AdapterMetadata;
  execute(envelope: AdapterEnvelope): Promise<AdapterResult>;
}
