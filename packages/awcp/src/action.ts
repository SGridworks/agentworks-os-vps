/**
 * AWCP — Canonical Action Schema
 *
 * Re-exports the canonical action envelope schema from @agentworks/shared
 * and adds AWCP-specific action-kind constants and helpers.
 *
 * Spec: AWCP v0.1 Section 1
 */

export {
  ActorSchema,
  type Actor,
  ActionContextSchema,
  type ActionContext,
  ActionEnvelopeSchema,
  type ActionEnvelope,
  actionEnvelopeJsonSchema,
} from "@agentworks/shared/schema";



// Canonical action-kind values registered in AWCP v0.1
export const ACTION_KINDS = {
  OUTBOUND_SMS: "outbound.sms",
  OUTBOUND_EMAIL: "outbound.email",
  OUTBOUND_CALL: "outbound.call",
  OUTBOUND_DIRECT_MESSAGE: "outbound.direct_message",
  LEAD_GENERATION: "lead.generation",
  LEAD_ENRICH: "lead.enrich",
  CRM_WRITE: "crm.write",
  LLM_COMPLETION: "llm.completion",
  DATA_EXPORT: "data.export",
  DATA_DELETE: "data.delete",
} as const;

export type ActionKindValue =
  (typeof ACTION_KINDS)[keyof typeof ACTION_KINDS];

/** All registered AWCP action-kind values. */
export const REGISTERED_ACTION_KINDS: string[] = Object.values(ACTION_KINDS);

/**
 * Validates a string is a registered AWCP action-kind.
 * Note: this checks against known values; dynamic kinds must be
 * registered in the AWCP spec before use.
 */
export function isRegisteredActionKind(kind: string): boolean {
  return REGISTERED_ACTION_KINDS.includes(kind);
}
