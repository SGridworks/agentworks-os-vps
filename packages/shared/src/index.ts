// Re-export all schemas
export * from "./schema/index.js";

// Re-export JSON schemas for consumers who need the raw JSON Schema objects
export { actionEnvelopeJsonSchema } from "./schema/action.js";
export { policyDecisionJsonSchema } from "./schema/policy-decision.js";

// Re-export crypto utilities
export {
  computeDecisionHash,
  verifyDecisionHash,
  verifyChainIntegrity,
} from "./crypto.js";

// Re-export transparent proxy detection
export {
  detectUpstreamClient,
  type UpstreamClient,
  type TransparentProxyConfig,
} from "./transparent-proxy.js";
