import type { Env } from "../../../types";
import { resolveRuntimeConfig } from "../config/resolved_runtime_config";
import type { RuntimeModelPricing } from "../config/pricing";
import type { UsageAvailability, UsageUsdBreakdown } from "./types";

export type UsagePricingResolution = {
  modelKey: string | null;
  pricing: RuntimeModelPricing | null;
  source: "defaults" | "env_json" | "kv" | "override" | "unknown";
};

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function componentCost(tokens: number, usdPerMillion: number | undefined): number | null {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  if (typeof usdPerMillion !== "number" || !Number.isFinite(usdPerMillion)) return null;
  return roundUsd((tokens / 1_000_000) * usdPerMillion);
}

export async function resolveUsagePricing(env: Env, modelId: string): Promise<UsagePricingResolution> {
  const config = await resolveRuntimeConfig(env);
  const normalizedModelId = (modelId || "").trim();
  const entry = config.pricing.models[normalizedModelId];
  if (!entry) {
    return {
      modelKey: normalizedModelId || null,
      pricing: null,
      source: "unknown",
    };
  }
  return {
    modelKey: normalizedModelId,
    pricing: entry,
    source: config.pricing.source === "test_override" ? "override" : config.pricing.source,
  };
}

export function estimateUsageUsd(
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    totalTokens: number;
  } | null | undefined,
  pricing: RuntimeModelPricing | null,
): { estimatedUsd: UsageUsdBreakdown; availability: UsageAvailability } {
  if (!usage) {
    return {
      estimatedUsd: { total: null, input: null, output: null, cacheCreation: null, cacheRead: null },
      availability: "unavailable",
    };
  }
  if (!pricing) {
    return {
      estimatedUsd: { total: null, input: null, output: null, cacheCreation: null, cacheRead: null },
      availability: usage.totalTokens > 0 ? "partial" : "unavailable",
    };
  }
  const input = componentCost(usage.inputTokens, pricing.inputUsdPerMillion);
  const output = componentCost(usage.outputTokens, pricing.outputUsdPerMillion);
  const cacheCreation = componentCost(usage.cacheCreationInputTokens, pricing.cacheCreationUsdPerMillion);
  const cacheRead = componentCost(usage.cacheReadInputTokens, pricing.cacheReadUsdPerMillion);
  const hasUnknownComponent = [input, output, cacheCreation, cacheRead].some((value) => value === null);
  const total = hasUnknownComponent
    ? null
    : roundUsd((input || 0) + (output || 0) + (cacheCreation || 0) + (cacheRead || 0));
  return {
    estimatedUsd: {
      total,
      input,
      output,
      cacheCreation,
      cacheRead,
    },
    availability: hasUnknownComponent ? "partial" : "exact",
  };
}
