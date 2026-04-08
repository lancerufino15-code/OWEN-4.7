import { resolveBucketKey } from "../storage";
import type { Env } from "../../../types";
import type { CapabilityGate, RuntimeCapability, RuntimePermissionMode, ToolDecision, ToolInvocationContext, ToolResult, ToolSpec } from "./types";

const PERMISSION_ORDER: RuntimePermissionMode[] = ["read-only", "artifact-write", "admin-elevated"];

function permissionRank(mode: RuntimePermissionMode): number {
  return PERMISSION_ORDER.indexOf(mode);
}

function normalizeCapabilitySet(values: Iterable<RuntimeCapability> | undefined): Set<RuntimeCapability> | null {
  if (!values) return null;
  return new Set(values);
}

function normalizeBucketSet(values: Iterable<string> | undefined): Set<string> {
  const normalized = new Set<string>();
  for (const value of values || []) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    normalized.add(trimmed);
    normalized.add(trimmed.toLowerCase());
    normalized.add(resolveBucketKey(trimmed));
    normalized.add(resolveBucketKey(trimmed).toLowerCase());
  }
  return normalized;
}

function isPermissionModeAllowed(current: RuntimePermissionMode, required: RuntimePermissionMode): boolean {
  return permissionRank(current) >= permissionRank(required);
}

function capabilityDeclared(
  toolId: RuntimeCapability,
  context: ToolInvocationContext,
): ToolDecision | null {
  const declared = new Set(context.declaredAgentTools);
  if (!declared.has(toolId)) {
    return {
      toolId,
      allowed: false,
      reason: "not_declared_by_agent",
      capability: toolId,
      permissionMode: context.permissionMode,
    };
  }
  const allowedRuntimeCapabilities = normalizeCapabilitySet(context.allowedRuntimeCapabilities);
  if (allowedRuntimeCapabilities && !allowedRuntimeCapabilities.has(toolId)) {
    return {
      toolId,
      allowed: false,
      reason: "capability_not_allowed_for_agent",
      capability: toolId,
      permissionMode: context.permissionMode,
    };
  }
  return null;
}

function buildAllowedDecision(toolId: RuntimeCapability, context: ToolInvocationContext, requestedBucket?: string): ToolDecision {
  return {
    toolId,
    allowed: true,
    reason: "allowed",
    capability: toolId,
    permissionMode: context.permissionMode,
    requestedBucket,
  };
}

function buildDeniedDecision(
  toolId: RuntimeCapability,
  context: ToolInvocationContext,
  reason: string,
  requestedBucket?: string,
): ToolDecision {
  return {
    toolId,
    allowed: false,
    reason,
    capability: toolId,
    permissionMode: context.permissionMode,
    requestedBucket,
  };
}

export function createCapabilityGate(env: Env): CapabilityGate {
  return {
    evaluateTool(tool, context) {
      const declarationDecision = capabilityDeclared(tool.toolId, context);
      if (declarationDecision) return declarationDecision;
      if (!context.runtimeGateEnabled) {
        return buildAllowedDecision(tool.toolId, context, context.requestedBucket);
      }
      if (!isPermissionModeAllowed(context.permissionMode, tool.minimumPermissionMode)) {
        return buildDeniedDecision(tool.toolId, context, "permission_mode_denied", context.requestedBucket);
      }
      if (tool.toolId === "files") {
        if (!context.hasFiles) return buildDeniedDecision(tool.toolId, context, "no_files_available", context.requestedBucket);
        if (context.requestedBucket) {
          const bucketDecision = this.evaluateBucketAccess(context, context.requestedBucket);
          if (!bucketDecision.allowed) return bucketDecision;
        }
        return buildAllowedDecision(tool.toolId, context, context.requestedBucket);
      }
      if (tool.toolId === "web_search") {
        if (context.featureEnabled === false) return buildDeniedDecision(tool.toolId, context, "feature_disabled");
        if (!context.webSearchAvailable) {
          return buildDeniedDecision(
            tool.toolId,
            context,
            context.retrievalRequired ? "retrieval_required_but_unavailable" : "web_search_unavailable",
          );
        }
        return buildAllowedDecision(tool.toolId, context);
      }
      return buildAllowedDecision(tool.toolId, context);
    },
    evaluateTools(tools, context) {
      const decisions = Array.from(tools, (tool) => this.evaluateTool(tool, context));
      return {
        allowed: decisions.filter((decision) => decision.allowed).map((decision) => decision.toolId),
        denied: decisions.filter((decision) => !decision.allowed),
        decisions,
      };
    },
    evaluateBucketAccess(context, bucket) {
      if (!context.runtimeGateEnabled) {
        return buildAllowedDecision("files", context, bucket);
      }
      const allowedBuckets = normalizeBucketSet(context.allowedBuckets);
      if (!allowedBuckets.size) {
        return buildDeniedDecision("files", context, "bucket_not_allowed", bucket);
      }
      const normalizedRequested = [
        bucket,
        bucket.toLowerCase(),
        resolveBucketKey(bucket),
        resolveBucketKey(bucket).toLowerCase(),
      ];
      if (normalizedRequested.some((entry) => allowedBuckets.has(entry))) {
        return buildAllowedDecision("files", context, bucket);
      }
      return buildDeniedDecision("files", context, "bucket_not_allowed", bucket);
    },
  };
}

export function serializeToolDecision(decision: ToolDecision): Record<string, unknown> {
  return {
    toolId: decision.toolId,
    capability: decision.capability,
    allowed: decision.allowed,
    reason: decision.reason,
    permissionMode: decision.permissionMode,
    requestedBucket: decision.requestedBucket || null,
  };
}
