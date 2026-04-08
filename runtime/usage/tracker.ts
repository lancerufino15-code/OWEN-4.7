import type { Env } from "../../../types";
import { recordMetricEvent } from "../../../observability/metrics";
import type { UsageEventInput, UsageEventV1 } from "./types";
import { estimateUsageUsd, resolveUsagePricing } from "./pricing";
import { writeUsageEvent } from "./storage";

function coerceToken(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toUsageStatus(input: UsageEventInput["usage"], costAvailability: "exact" | "partial" | "unavailable") {
  if (!input) return "unavailable" as const;
  if (costAvailability === "partial") return "partial" as const;
  if (input.totalTokens > 0) return "exact" as const;
  return "partial" as const;
}

export async function trackUsageEvent(env: Env, input: UsageEventInput): Promise<UsageEventV1> {
  const pricing = await resolveUsagePricing(env, input.modelId);
  const estimated = estimateUsageUsd(input.usage, pricing.pricing);
  const ts = new Date().toISOString();
  const [rawDay = ts.slice(0, 10), time = "00:00:00.000Z"] = ts.split("T");
  const day = rawDay || ts.slice(0, 10);
  const event: UsageEventV1 = {
    v: 1,
    ts,
    day,
    hour: `${day}T${time.slice(0, 2)}:00:00.000Z`,
    requestId: input.requestId,
    route: input.route,
    workflow: input.workflow,
    sessionId: input.sessionId ?? null,
    conversationId: input.conversationId ?? null,
    userId: input.userId ?? null,
    role: input.role ?? null,
    institutionId: input.institutionId ?? null,
    courseId: input.courseId ?? null,
    lectureId: input.lectureId ?? null,
    artifactType: input.artifactType ?? null,
    artifactCode: input.artifactCode ?? null,
    modelId: input.modelId,
    provider: input.provider,
    latencyMs: input.latencyMs ?? null,
    success: Boolean(input.success),
    errorCode: input.errorCode ?? null,
    permissionMode: input.permissionMode ?? null,
    toolSet: Array.from(new Set(Array.from(input.toolSet || []).filter(Boolean))),
    usageStatus: toUsageStatus(input.usage, estimated.availability),
    tokenUsage: {
      input: coerceToken(input.usage?.inputTokens),
      output: coerceToken(input.usage?.outputTokens),
      cacheCreation: coerceToken(input.usage?.cacheCreationInputTokens),
      cacheRead: coerceToken(input.usage?.cacheReadInputTokens),
      total: coerceToken(input.usage?.totalTokens),
    },
    estimatedUsd: estimated.estimatedUsd,
    pricing: {
      modelKey: pricing.modelKey,
      known: Boolean(pricing.pricing),
      source: pricing.source,
    },
    metadata: input.metadata,
  };
  await writeUsageEvent(env, event);
  await recordMetricEvent(env, {
    name: "usage_event",
    requestId: input.requestId,
    metadata: {
      workflow: input.workflow,
      modelId: input.modelId,
      success: input.success,
      usageStatus: event.usageStatus,
    },
    institutionId: input.institutionId ?? undefined,
    courseId: input.courseId ?? undefined,
    lectureId: input.lectureId ?? undefined,
    userId: input.userId ?? undefined,
    role: input.role ?? undefined,
  }).catch(() => undefined);
  return event;
}
