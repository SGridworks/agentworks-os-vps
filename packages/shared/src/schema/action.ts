/**
 * RFC 001 — Canonical Action Schema v0.1
 * Wire format for all agent actions crossing the substrate.
 * Every interception point (MCP, n8n, REST, adapters) maps into this format.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Actor who initiated the action.
 * type: human (end user), agent (AI agent), system (substrate-internal: scheduler, scanner, etc.)
 */
export const ActorSchema = z.object({
  id: z.string(),
  type: z.enum(["human", "agent", "system"]),
  label: z.string(),
  role: z.string().optional(),
  adapterKey: z.string().optional(),
});

export type Actor = z.infer<typeof ActorSchema>;

/**
 * References to external state — vault documents, conversations, projects.
 * Data itself lives in those systems; only refs cross the wire.
 */
export const ActionContextSchema = z.object({
  vaultRefs: z.array(z.string()).default([]),
  conversationRefs: z.array(z.string()).default([]),
  projectRefs: z.array(z.string()).default([]),
  raw: z.record(z.unknown()).optional(),
  meta: z.record(z.unknown()).default({}),
});

export type ActionContext = z.infer<typeof ActionContextSchema>;

/**
 * Top-level action envelope. Every agent action serializes into this.
 * All interception points (MCP, n8n, REST, adapters) map into this format.
 */
export const ActionEnvelopeSchema = z.object({
  requestId: z.string().uuid(),
  proposedAt: z.string().datetime(),
  tenantId: z.string().uuid(),
  actor: ActorSchema,
  actionKind: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/, {
    message:
      "actionKind must be lowercase dot-separated (e.g. outbound.sms, crm.write)",
  }),
  payload: z.record(z.unknown()),
  context: ActionContextSchema,
  reviewed: z.boolean().default(false),
  reviewerId: z.string().optional(),
  reviewedAt: z.string().datetime().optional(),
});

export type ActionEnvelope = z.infer<typeof ActionEnvelopeSchema>;

// JSON Schema export for n8n nodes, rule engine, admin UI, Compliance Evidence Report
export const actionEnvelopeJsonSchema = zodToJsonSchema(
  ActionEnvelopeSchema,
  "ActionEnvelope"
);
