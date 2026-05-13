# RFC 001 — Canonical Action Schema v0.1

**Status**: Approved (2026-04-28 by TechLead; action schema + tests shipped in packages/shared/src/schema/action.ts)
**Author**: TechLead
**Created**: 2026-04-27
**Blocks**: AWO-4 (in_progress), AWO-26 (DB migration), AWO-37/38 (policy-engine), AWO-92 (AWCP spec)
**Review**: CEO + ComplianceConsultant must sign off before implementation

---

## Problem

Every interception point (MCP tool calls, n8n nodes, REST API submissions, custom adapters) needs a common wire format for agent actions. Without a canonical schema, shadow mode is just logging — there is no structured data to match rules against, no consistent audit trail, and no way to route actions to the approval queue.

The schema must handle non-LLM actions: SMS, email, CRM writes, n8n workflow steps, browser interactions. It must NOT be a thin wrapper around LLM provider response shapes.

---

## Design Principles

1. Action-centric, not agent-centric. The schema describes what was done, not what model produced it.
2. Hierarchical `action_kind` with namespace prefix (e.g., `outbound.sms`, `crm.write`, `llm.completion`). Prevents collision as action types grow.
3. Structured `payload` per action_kind. Raw provider responses go into `evidence.raw` if needed, not into the primary payload.
4. Append-only `request_id` for deduplication and hash-chaining in the audit trail.
5. `context` carries references to vault documents, conversation history, projects — not the data itself.

---

## Schema

```typescript
// packages/shared/src/schema/action.ts

import { z } from "zod";

/**
 * Top-level action envelope. Every agent action serializes into this.
 * All interception points (MCP, n8n, REST, adapters) map into this format.
 */
export const ActionEnvelopeSchema = z.object({
  /** Unique per-action request ID. Used for deduplication and hash-chaining. */
  requestId: z.string().uuid(),
  /** ISO 8601 timestamp of when the action was proposed. */
  proposedAt: z.string().datetime(),
  /** Tenant that owns this action. */
  tenantId: z.string().uuid(),
  /** Actor who initiated the action. */
  actor: ActorSchema,
  /** What kind of action this is. Namespace prefix prevents collision. */
  actionKind: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/, {
    message:
      "actionKind must be lowercase dot-separated (e.g. outbound.sms, crm.write)",
  }),
  /** Structured payload. Shape depends on actionKind. */
  payload: z.record(z.unknown()),
  /** References to external state — vault docs, conversations, projects. */
  context: ActionContextSchema,
  /** Whether this action has been reviewed by a human. */
  reviewed: z.boolean().default(false),
  /** If reviewed, who reviewed it. */
  reviewerId: z.string().optional(),
  reviewedAt: z.string().datetime().optional(),
});

export const ActorSchema = z.object({
  id: z.string(),
  type: z.enum(["human", "agent", "system"]),
  /** Display name for audit readability. */
  label: z.string(),
  /** Optional: credentials or role context that may affect policy evaluation. */
  role: z.string().optional(),
  /** Optional: adapter source (e.g. "claude-local", "opencode", "n8n"). */
  adapterKey: z.string().optional(),
});

export const ActionContextSchema = z.object({
  /** Vault document IDs this action read from or wrote to. */
  vaultRefs: z.array(z.string()).default([]),
  /** Conversation/message IDs this action was part of. */
  conversationRefs: z.array(z.string()).default([]),
  /** Project IDs this action is scoped to. */
  projectRefs: z.array(z.string()).default([]),
  /** Original raw provider response, if applicable. Stored for evidence. */
  raw: z.record(z.unknown()).optional(),
  /** Any additional structured metadata. */
  meta: z.record(z.unknown()).default({}),
});

export type ActionEnvelope = z.infer<typeof ActionEnvelopeSchema>;
export type Actor = z.infer<typeof ActorSchema>;
export type ActionContext = z.infer<typeof ActionContextSchema>;
```

### Payload Shapes by action_kind

Payload structure is defined per action_kind namespace. The top-level `payload` is a flat map; intercepting code does a type switch on `actionKind` to extract structured fields.

**Required base fields present in every payload** (enforced by the policy engine, not the schema):

| actionKind prefix | Required payload fields | Example |
|---|---|---|
| `outbound.*` | `recipient`, `channel`, `content` | outbound.sms, outbound.email |
| `crm.*` | `entity`, `operation`, `recordId` | crm.write, crm.delete |
| `llm.*` | `model`, `prompt`, `completion` | llm.completion |
| `memory.*` | `operation`, `path` | memory.read, memory.write |
| `workflow.*` | `workflowId`, `stepId`, `nodeType` | workflow.trigger, workflow.step |
| `browser.*` | `url`, `operation` | browser.navigate, browser.click |

Envelope validators MUST NOT reject actions with unknown actionKind values — new action kinds are added without schema changes. The payload is opaque to the envelope schema.

---

## JSON Schema Export

```typescript
// packages/shared/src/schema/action.ts
import { zodToJsonSchema } from "zod-to-json-schema";

export const actionEnvelopeJsonSchema = zodToJsonSchema(ActionEnvelopeSchema, "actionEnvelope");
```

This exports a standard JSON Schema document consumed by:
- n8n custom nodes for input validation
- The policy engine for structured matching
- The admin UI for formatting action inspector
- The Compliance Evidence Report generator

---

## Wire Format Invariants

1. `requestId` must be generated client-side before serialization. Prevents double-submission.
2. `tenantId` is non-optional. Multi-tenant isolation is enforced at the transport layer — the schema enforces it appears in every action.
3. `actionKind` is a dot-namespaced string. No enums in the schema — new action kinds ship without schema changes.
4. Timestamps are UTC ISO 8601 strings, not Unix epoch integers.
5. Payload fields are flat (no nested objects beyond one level). Simplifies JSON path matching in the policy engine.

---

## What This Schema Is NOT

- It is NOT a wrapper around LLM provider API response shapes. The `llm.completion` payload contains normalized fields (model, prompt, completion), not provider-specific response objects.
- It does NOT define policy rules. Those live in rule packs (YAML), not the schema.
- It does NOT carry action outcomes (allowed/blocked/routed). That is the PolicyDecision record, defined in RFC 002.

---

## Relation to Existing Paperclip Schema

Extends the paperclip `activity_log` pattern:
- `activity_log.actorId` → `actor.id` (same string shape)
- `activity_log.action` → `actionKind` (same semantic)
- `activity_log.agentId` → `actor.id` (links to agents table)
- New `action_log` table (RFC 002) captures full ActionEnvelope + PolicyDecision

The existing `activity_log` table is NOT overloaded. A new `action_log` table is introduced per the anti-pattern list.

---

## Implementation Notes

- Schema lives in `packages/shared/src/schema/action.ts`
- Exported as both Zod types (TS) and JSON Schema (runtime validation, n8n, rule engine)
- No new DB tables required for the envelope itself — it is a wire format
- The DB tables (action_log, policy_decisions) are defined in RFC 002
- ComplianceConsultant must sign off on actionKind namespace before EOD Day 3

---

## Open Questions

1. Should `actionKind` carry a version suffix (e.g., `outbound.sms.v1`)? Defer to AWCP spec — version prefix in the wire format vs. version in the rule engine.
2. Should `context.raw` be required for `llm.*` actions only? Yes — raw is only for LLM evidence, not for all action types.
3. Should we support batch actions (multiple payload items in one envelope)? Defer to v1.1. v1 ships one action per envelope.
