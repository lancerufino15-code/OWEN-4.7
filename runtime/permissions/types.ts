import type { AuthSessionRecord } from "../../../auth/session";
import type { FileReference } from "../../chat/types";

export type RuntimePermissionMode = "read-only" | "artifact-write" | "admin-elevated";
export type RuntimeCapability = "files" | "web_search";

export interface ToolSpec {
  toolId: RuntimeCapability;
  capability: RuntimeCapability;
  minimumPermissionMode: RuntimePermissionMode;
  bucketScoped?: boolean;
  description: string;
}

export interface ToolInvocationContext {
  requestId?: string;
  principal?: AuthSessionRecord | null;
  agentId: string;
  permissionMode: RuntimePermissionMode;
  runtimeGateEnabled: boolean;
  declaredAgentTools: Iterable<RuntimeCapability>;
  allowedRuntimeCapabilities?: Iterable<RuntimeCapability>;
  allowedBuckets?: Iterable<string>;
  requestedFiles?: FileReference[];
  requestedBucket?: string;
  hasFiles: boolean;
  webSearchAvailable: boolean;
  retrievalRequired?: boolean;
  featureEnabled?: boolean;
}

export interface ToolDecision {
  toolId: RuntimeCapability;
  allowed: boolean;
  reason: string;
  capability: RuntimeCapability;
  permissionMode: RuntimePermissionMode;
  requestedBucket?: string;
}

export interface ToolResult {
  allowed: RuntimeCapability[];
  denied: ToolDecision[];
  decisions: ToolDecision[];
}

export interface CapabilityGate {
  evaluateTool: (tool: ToolSpec, context: ToolInvocationContext) => ToolDecision;
  evaluateTools: (tools: Iterable<ToolSpec>, context: ToolInvocationContext) => ToolResult;
  evaluateBucketAccess: (context: ToolInvocationContext, bucket: string) => ToolDecision;
}
