/**
 * @agentworks/policy-engine
 * YAML rule pack loader + evaluator for AgentWorks OS compliance engine.
 */

export { loadPackFromFile, loadPackFromString, packAppliesToActionKind } from "./loader.js";
export { evaluatePack, evaluatePacks, buildPolicyDecision } from "./evaluator.js";
export type { EvaluationResult, PolicyEngineOpts, LoaderOpts } from "./types.js";
