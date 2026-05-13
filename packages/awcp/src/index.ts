/**
 * @agentworks/awcp — AgentWorks Compliance Protocol (AWCP)
 *
 * Canonical TypeScript re-exports for the AWCP v0.1 spec:
 *   - Canonical Action Schema        (Section 1)
 *   - Policy Check Request/Response  (Section 2)
 *   - Audit Log Entry Format         (Section 3)
 *   - Rule Pack Manifest Format      (Section 4)
 *
 * Usage:
 *   import { ActionEnvelopeSchema, PolicyCheckRequest } from "@agentworks/awcp";
 *
 * Sub-path exports:
 *   import { ... } from "@agentworks/awcp/action";
 *   import { ... } from "@agentworks/awcp/policy-check";
 *   import { ... } from "@agentworks/awcp/audit-log";
 *   import { ... } from "@agentworks/awcp/rule-pack";
 *
 * Spec: docs/awcp.md and docs/awcp/SPEC.md
 */

// Re-export all sub-modules
export * from "./action.js";
export * from "./policy-check.js";
export * from "./audit-log.js";
export * from "./rule-pack.js";

// ============================================================
// Package-level constants
// ============================================================

/** AWCP spec version string, e.g. "awcp/v0.1" */
export const AWCP_SPEC_VERSION = "awcp/v0.1";

/** AWCP spec status */
export const AWCP_SPEC_STATUS = "draft" as const;

/** AWCP spec status label */
export const AWCP_SPEC_STATUS_LABEL =
  "DRAFT v0.1 — breaking changes allowed until v1.0 stable";

/** URL to the AWCP spec in the agentworks-os repository */
export const AWCP_SPEC_URL =
  "https://github.com/SGridworks/agentworks-os/blob/main/docs/awcp/SPEC.md";
