import type { Env } from "../../../types";
import type { AgentCapability } from "../../../runtime/permission-context";
import { createCapabilityGate } from "../permissions";
import type { RuntimeToolId } from "./registry";
import { RUNTIME_TOOL_SPECS } from "./specs";

export interface RuntimeToolPolicyInput {
  env?: Env;
  requestId?: string;
  agentId?: string;
  permissionMode?: "read-only" | "artifact-write" | "admin-elevated";
  allowedBuckets?: Iterable<string>;
  allowedRuntimeCapabilities?: Iterable<AgentCapability>;
  requestedBucket?: string;
  declaredAgentTools: Iterable<AgentCapability>;
  webSearchAvailable: boolean;
  hasFiles: boolean;
  featureEnabled?: boolean;
  runtimeGateEnabled?: boolean;
  retrievalRequired?: boolean;
}

export interface RuntimeToolDecision {
  toolId: RuntimeToolId;
  allowed: boolean;
  reason: string;
}

function declaredToolSet(tools: Iterable<AgentCapability>): Set<AgentCapability> {
  return new Set(tools);
}

export function evaluateRuntimeToolPolicy(
  toolId: RuntimeToolId,
  input: RuntimeToolPolicyInput,
): RuntimeToolDecision {
  if (input.env) {
    const gate = createCapabilityGate(input.env);
    return gate.evaluateTool(RUNTIME_TOOL_SPECS[toolId], {
      requestId: input.requestId,
      agentId: input.agentId || "default",
      permissionMode: input.permissionMode || "read-only",
      runtimeGateEnabled: input.runtimeGateEnabled ?? true,
      declaredAgentTools: input.declaredAgentTools as Iterable<RuntimeToolId>,
      allowedRuntimeCapabilities: input.allowedRuntimeCapabilities as Iterable<RuntimeToolId> | undefined,
      allowedBuckets: input.allowedBuckets,
      requestedBucket: input.requestedBucket,
      hasFiles: input.hasFiles,
      webSearchAvailable: input.webSearchAvailable,
      retrievalRequired: input.retrievalRequired,
      featureEnabled: input.featureEnabled,
    });
  }
  const declared = declaredToolSet(input.declaredAgentTools);
  if (!declared.has(toolId)) {
    return { toolId, allowed: false, reason: "not_declared_by_agent" };
  }

  if (toolId === "files") {
    return input.hasFiles
      ? { toolId, allowed: true, reason: "allowed" }
      : { toolId, allowed: false, reason: "no_files_available" };
  }

  if (input.featureEnabled === false) {
    return { toolId, allowed: false, reason: "feature_disabled" };
  }
  if (!input.webSearchAvailable) {
    return { toolId, allowed: false, reason: "web_search_unavailable" };
  }
  return { toolId, allowed: true, reason: "allowed" };
}

export function filterAllowedRuntimeTools(
  toolIds: Iterable<RuntimeToolId>,
  input: RuntimeToolPolicyInput,
): { allowed: RuntimeToolId[]; decisions: RuntimeToolDecision[] } {
  const decisions = Array.from(toolIds, (toolId) => evaluateRuntimeToolPolicy(toolId, input));
  return {
    allowed: decisions.filter((decision) => decision.allowed).map((decision) => decision.toolId),
    decisions,
  };
}
