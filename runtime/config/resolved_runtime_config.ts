import type { Env } from "../../../types";
import {
  DEFAULT_COMPACTION_MAX_ESTIMATED_TOKENS,
  DEFAULT_COMPACTION_PRESERVE_RECENT_MESSAGES,
  DEFAULT_LONG_ANSWER_THRESHOLD_CHARS,
  DEFAULT_MIN_DISTINCT_SOURCES,
  DEFAULT_RUNTIME_FLAGS,
  DEFAULT_RUNTIME_MODEL_PRICING,
  DEFAULT_UAO_CLASSIFIER_CONFIDENCE,
  RUNTIME_CONFIG_KV_KEY,
} from "./defaults";
import { mergePricingTables, normalizePricingTable, type RuntimePricingConfig, type RuntimePricingTable } from "./pricing";
import { parseBooleanFlag, parseEnabledByDefault, type RuntimeFlags } from "./runtime_flags";

export interface ResolvedRuntimeConfig {
  flags: RuntimeFlags;
  thresholds: {
    minDistinctSources: number;
    longAnswerThresholdChars: number;
    uaoClassifierConfidenceThreshold: number;
    conversationCompactionMaxEstimatedTokens: number;
    conversationCompactionPreserveRecentMessages: number;
    typewriterSpeedMs?: number;
    visionInlineMaxBytes?: number;
  };
  pricing: RuntimePricingConfig;
  sources: {
    flags: Array<"defaults" | "env" | "env_json" | "kv" | "test_override">;
    pricing: RuntimePricingConfig["source"][];
  };
}

export interface RuntimeConfigOverrideInput {
  flags?: Partial<RuntimeFlags>;
  thresholds?: Partial<ResolvedRuntimeConfig["thresholds"]>;
  pricing?: Partial<RuntimePricingConfig>;
}

type PartialResolvedRuntimeConfig = {
  flags?: Partial<RuntimeFlags>;
  thresholds?: Partial<ResolvedRuntimeConfig["thresholds"]>;
  pricing?: {
    version?: string;
    source?: RuntimePricingConfig["source"];
    models?: RuntimePricingTable;
  };
};

const resolvedRuntimeConfigCache = new WeakMap<Env, Promise<ResolvedRuntimeConfig>>();

function parsePositiveInteger(raw: unknown, fallback: number): number {
  const parsed = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function parseOptionalPositiveInteger(raw: unknown): number | undefined {
  const parsed = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function parseClassifierThreshold(raw: unknown, fallback: number): number {
  const parsed = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) return fallback;
  return parsed;
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function hasOwn(source: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function readBooleanOverride(
  raw: Record<string, unknown>,
  ...keys: Array<{ key: string; fallback: boolean }>
): boolean | undefined {
  for (const candidate of keys) {
    if (!hasOwn(raw, candidate.key)) continue;
    return parseBooleanFlag(raw[candidate.key], candidate.fallback);
  }
  return undefined;
}

function readEnabledByDefaultOverride(
  raw: Record<string, unknown>,
  ...keys: Array<{ key: string; fallback: boolean }>
): boolean | undefined {
  for (const candidate of keys) {
    if (!hasOwn(raw, candidate.key)) continue;
    return parseEnabledByDefault(raw[candidate.key], candidate.fallback);
  }
  return undefined;
}

function normalizeRuntimeFlags(raw: Record<string, unknown> | null | undefined): Partial<RuntimeFlags> {
  if (!raw) return {};
  const normalized: Partial<RuntimeFlags> = {};
  const assign = <K extends keyof RuntimeFlags>(key: K, value: RuntimeFlags[K] | undefined) => {
    if (value !== undefined) normalized[key] = value;
  };

  assign("runtimeCapabilityGate", readBooleanOverride(raw,
    { key: "ENABLE_RUNTIME_CAPABILITY_GATE", fallback: DEFAULT_RUNTIME_FLAGS.runtimeCapabilityGate },
    { key: "runtimeCapabilityGate", fallback: DEFAULT_RUNTIME_FLAGS.runtimeCapabilityGate },
  ));
  assign("sessionV2", readBooleanOverride(raw,
    { key: "ENABLE_SESSION_V2", fallback: DEFAULT_RUNTIME_FLAGS.sessionV2 },
    { key: "sessionV2", fallback: DEFAULT_RUNTIME_FLAGS.sessionV2 },
  ));
  assign("sessionResume", readBooleanOverride(raw,
    { key: "ENABLE_SESSION_RESUME", fallback: DEFAULT_RUNTIME_FLAGS.sessionResume },
    { key: "sessionResume", fallback: DEFAULT_RUNTIME_FLAGS.sessionResume },
  ));
  assign("usageTracking", readBooleanOverride(raw,
    { key: "ENABLE_USAGE_TRACKING", fallback: DEFAULT_RUNTIME_FLAGS.usageTracking },
    { key: "usageTracking", fallback: DEFAULT_RUNTIME_FLAGS.usageTracking },
  ));
  assign("costTrackingUi", readBooleanOverride(raw,
    { key: "ENABLE_COST_TRACKING_UI", fallback: DEFAULT_RUNTIME_FLAGS.costTrackingUi },
    { key: "costTrackingUi", fallback: DEFAULT_RUNTIME_FLAGS.costTrackingUi },
  ));
  assign("parityFixtureMode", readBooleanOverride(raw,
    { key: "ENABLE_PARITY_FIXTURE_MODE", fallback: DEFAULT_RUNTIME_FLAGS.parityFixtureMode },
    { key: "parityFixtureMode", fallback: DEFAULT_RUNTIME_FLAGS.parityFixtureMode },
  ));
  assign("runtimeConfigKvOverrides", readBooleanOverride(raw,
    { key: "ENABLE_RUNTIME_CONFIG_KV_OVERRIDES", fallback: DEFAULT_RUNTIME_FLAGS.runtimeConfigKvOverrides },
    { key: "runtimeConfigKvOverrides", fallback: DEFAULT_RUNTIME_FLAGS.runtimeConfigKvOverrides },
  ));
  assign("structuredChat", readBooleanOverride(raw,
    { key: "OWEN_STRUCTURED_CHAT_V2_ENABLED", fallback: DEFAULT_RUNTIME_FLAGS.structuredChat },
    { key: "structuredChat", fallback: DEFAULT_RUNTIME_FLAGS.structuredChat },
  ));
  assign("derivedStructuredStream", readBooleanOverride(raw,
    { key: "OWEN_DERIVED_STRUCTURED_STREAM_ENABLED", fallback: DEFAULT_RUNTIME_FLAGS.derivedStructuredStream },
    { key: "derivedStructuredStream", fallback: DEFAULT_RUNTIME_FLAGS.derivedStructuredStream },
  ));
  assign("conversationCompaction", readBooleanOverride(raw,
    { key: "OWEN_CONVERSATION_COMPACTION_ENABLED", fallback: DEFAULT_RUNTIME_FLAGS.conversationCompaction },
    { key: "conversationCompaction", fallback: DEFAULT_RUNTIME_FLAGS.conversationCompaction },
  ));
  assign("runtimeHooks", readBooleanOverride(raw,
    { key: "OWEN_RUNTIME_HOOKS_ENABLED", fallback: DEFAULT_RUNTIME_FLAGS.runtimeHooks },
    { key: "runtimeHooks", fallback: DEFAULT_RUNTIME_FLAGS.runtimeHooks },
  ));
  assign("visionEnabled", readEnabledByDefaultOverride(raw,
    { key: "OWEN_VISION_ENABLED", fallback: DEFAULT_RUNTIME_FLAGS.visionEnabled },
    { key: "visionEnabled", fallback: DEFAULT_RUNTIME_FLAGS.visionEnabled },
  ));
  assign("medicalVisionPrompts", readBooleanOverride(raw,
    { key: "OWEN_MEDICAL_VISION_PROMPTS_ENABLED", fallback: DEFAULT_RUNTIME_FLAGS.medicalVisionPrompts },
    { key: "medicalVisionPrompts", fallback: DEFAULT_RUNTIME_FLAGS.medicalVisionPrompts },
  ));
  assign("visionR2Cache", readBooleanOverride(raw,
    { key: "OWEN_VISION_R2_CACHE_ENABLED", fallback: DEFAULT_RUNTIME_FLAGS.visionR2Cache },
    { key: "visionR2Cache", fallback: DEFAULT_RUNTIME_FLAGS.visionR2Cache },
  ));
  assign("visionMultiImage", readBooleanOverride(raw,
    { key: "OWEN_VISION_MULTI_IMAGE_ENABLED", fallback: DEFAULT_RUNTIME_FLAGS.visionMultiImage },
    { key: "visionMultiImage", fallback: DEFAULT_RUNTIME_FLAGS.visionMultiImage },
  ));
  assign("uaoEnabled", readBooleanOverride(raw,
    { key: "UAO_ENABLED", fallback: DEFAULT_RUNTIME_FLAGS.uaoEnabled },
    { key: "uaoEnabled", fallback: DEFAULT_RUNTIME_FLAGS.uaoEnabled },
  ));
  assign("uaoLlmClassifierEnabled", readBooleanOverride(raw,
    { key: "UAO_LLM_CLASSIFIER_ENABLED", fallback: DEFAULT_RUNTIME_FLAGS.uaoLlmClassifierEnabled },
    { key: "uaoLlmClassifierEnabled", fallback: DEFAULT_RUNTIME_FLAGS.uaoLlmClassifierEnabled },
  ));
  assign("uaoLlmQcEnabled", readBooleanOverride(raw,
    { key: "UAO_LLM_QC_ENABLED", fallback: DEFAULT_RUNTIME_FLAGS.uaoLlmQcEnabled },
    { key: "uaoLlmQcEnabled", fallback: DEFAULT_RUNTIME_FLAGS.uaoLlmQcEnabled },
  ));
  assign("enforceMinDistinctSources", readBooleanOverride(raw,
    { key: "ENFORCE_MIN_DISTINCT_SOURCES", fallback: DEFAULT_RUNTIME_FLAGS.enforceMinDistinctSources },
    { key: "enforceMinDistinctSources", fallback: DEFAULT_RUNTIME_FLAGS.enforceMinDistinctSources },
  ));

  return normalized;
}

function buildEnvConfig(env: Env): PartialResolvedRuntimeConfig {
  const envFlags: Partial<RuntimeFlags> = {
    runtimeCapabilityGate: parseBooleanFlag(env.ENABLE_RUNTIME_CAPABILITY_GATE, DEFAULT_RUNTIME_FLAGS.runtimeCapabilityGate),
    sessionV2: parseBooleanFlag(env.ENABLE_SESSION_V2, DEFAULT_RUNTIME_FLAGS.sessionV2),
    sessionResume: parseBooleanFlag(env.ENABLE_SESSION_RESUME, DEFAULT_RUNTIME_FLAGS.sessionResume),
    usageTracking: parseBooleanFlag(env.ENABLE_USAGE_TRACKING ?? env.OWEN_USAGE_TRACKING_ENABLED, DEFAULT_RUNTIME_FLAGS.usageTracking),
    costTrackingUi: parseBooleanFlag(env.ENABLE_COST_TRACKING_UI, DEFAULT_RUNTIME_FLAGS.costTrackingUi),
    parityFixtureMode: parseBooleanFlag(env.ENABLE_PARITY_FIXTURE_MODE, DEFAULT_RUNTIME_FLAGS.parityFixtureMode),
    runtimeConfigKvOverrides: parseBooleanFlag(env.ENABLE_RUNTIME_CONFIG_KV_OVERRIDES, DEFAULT_RUNTIME_FLAGS.runtimeConfigKvOverrides),
    structuredChat: parseBooleanFlag(env.OWEN_STRUCTURED_CHAT_V2_ENABLED, DEFAULT_RUNTIME_FLAGS.structuredChat),
    derivedStructuredStream: parseBooleanFlag(env.OWEN_DERIVED_STRUCTURED_STREAM_ENABLED, DEFAULT_RUNTIME_FLAGS.derivedStructuredStream),
    conversationCompaction: parseBooleanFlag(env.OWEN_CONVERSATION_COMPACTION_ENABLED, DEFAULT_RUNTIME_FLAGS.conversationCompaction),
    runtimeHooks: parseBooleanFlag(env.OWEN_RUNTIME_HOOKS_ENABLED, DEFAULT_RUNTIME_FLAGS.runtimeHooks),
    visionEnabled: parseEnabledByDefault(env.OWEN_VISION_ENABLED, DEFAULT_RUNTIME_FLAGS.visionEnabled),
    medicalVisionPrompts: parseBooleanFlag(env.OWEN_MEDICAL_VISION_PROMPTS_ENABLED, DEFAULT_RUNTIME_FLAGS.medicalVisionPrompts),
    visionR2Cache: parseBooleanFlag(env.OWEN_VISION_R2_CACHE_ENABLED, DEFAULT_RUNTIME_FLAGS.visionR2Cache),
    visionMultiImage: parseBooleanFlag(env.OWEN_VISION_MULTI_IMAGE_ENABLED, DEFAULT_RUNTIME_FLAGS.visionMultiImage),
    uaoEnabled: parseBooleanFlag(env.UAO_ENABLED, DEFAULT_RUNTIME_FLAGS.uaoEnabled),
    uaoLlmClassifierEnabled: parseBooleanFlag(env.UAO_LLM_CLASSIFIER_ENABLED, DEFAULT_RUNTIME_FLAGS.uaoLlmClassifierEnabled),
    uaoLlmQcEnabled: parseBooleanFlag(env.UAO_LLM_QC_ENABLED, DEFAULT_RUNTIME_FLAGS.uaoLlmQcEnabled),
    enforceMinDistinctSources: parseBooleanFlag(env.ENFORCE_MIN_DISTINCT_SOURCES ?? env.FREE_RESPONSE_ENFORCE_MIN_UNIQUE_SOURCES, DEFAULT_RUNTIME_FLAGS.enforceMinDistinctSources),
  };

  return {
    flags: envFlags,
    thresholds: {
      minDistinctSources: parsePositiveInteger(env.MIN_DISTINCT_SOURCES ?? env.FREE_RESPONSE_MIN_UNIQUE_SOURCES, DEFAULT_MIN_DISTINCT_SOURCES),
      longAnswerThresholdChars: parsePositiveInteger(env.LONG_ANSWER_THRESHOLD_CHARS, DEFAULT_LONG_ANSWER_THRESHOLD_CHARS),
      uaoClassifierConfidenceThreshold: parseClassifierThreshold(env.UAO_CLASSIFIER_CONFIDENCE_THRESHOLD, DEFAULT_UAO_CLASSIFIER_CONFIDENCE),
      conversationCompactionMaxEstimatedTokens: parsePositiveInteger(
        env.OWEN_CONVERSATION_COMPACTION_MAX_ESTIMATED_TOKENS,
        DEFAULT_COMPACTION_MAX_ESTIMATED_TOKENS,
      ),
      conversationCompactionPreserveRecentMessages: parsePositiveInteger(
        env.OWEN_CONVERSATION_COMPACTION_PRESERVE_RECENT_MESSAGES,
        DEFAULT_COMPACTION_PRESERVE_RECENT_MESSAGES,
      ),
      typewriterSpeedMs: parseOptionalPositiveInteger(env.TYPEWRITER_SPEED),
      visionInlineMaxBytes: parseOptionalPositiveInteger(env.OWEN_VISION_INLINE_MAX_BYTES),
    },
  };
}

function mergeResolvedConfigs(...configs: Array<PartialResolvedRuntimeConfig | undefined>): ResolvedRuntimeConfig {
  const sources = {
    flags: ["defaults"] as Array<"defaults" | "env" | "env_json" | "kv" | "test_override">,
    pricing: ["defaults"] as RuntimePricingConfig["source"][],
  };
  let flags: RuntimeFlags = { ...DEFAULT_RUNTIME_FLAGS };
  let thresholds: ResolvedRuntimeConfig["thresholds"] = {
    minDistinctSources: DEFAULT_MIN_DISTINCT_SOURCES,
    longAnswerThresholdChars: DEFAULT_LONG_ANSWER_THRESHOLD_CHARS,
    uaoClassifierConfidenceThreshold: DEFAULT_UAO_CLASSIFIER_CONFIDENCE,
    conversationCompactionMaxEstimatedTokens: DEFAULT_COMPACTION_MAX_ESTIMATED_TOKENS,
    conversationCompactionPreserveRecentMessages: DEFAULT_COMPACTION_PRESERVE_RECENT_MESSAGES,
  };
  let pricingVersion = "runtime-defaults-v1";
  let pricingSource: RuntimePricingConfig["source"] = "defaults";
  let pricingModels: RuntimePricingTable = { ...DEFAULT_RUNTIME_MODEL_PRICING };

  for (const config of configs) {
    if (!config) continue;
    if (config.flags) flags = { ...flags, ...config.flags };
    if (config.thresholds) thresholds = { ...thresholds, ...config.thresholds };
    if (config.pricing?.models) {
      pricingModels = mergePricingTables(pricingModels, config.pricing.models);
    }
    if (config.pricing?.version) pricingVersion = config.pricing.version;
    if (config.pricing?.source) pricingSource = config.pricing.source;
  }

  return {
    flags,
    thresholds,
    pricing: {
      version: pricingVersion,
      source: pricingSource,
      models: pricingModels,
    },
    sources,
  };
}

function buildEnvJsonConfig(env: Env): PartialResolvedRuntimeConfig {
  const flagJson = parseJsonObject(env.RUNTIME_FLAGS_JSON);
  const pricingJson = parseJsonObject(env.MODEL_PRICING_OVERRIDES_JSON);
  const pricingModels = normalizePricingTable(pricingJson?.models ?? pricingJson);
  return {
    flags: normalizeRuntimeFlags(flagJson),
    pricing: Object.keys(pricingModels).length
      ? {
          version: pricingJson?.version && typeof pricingJson.version === "string" ? pricingJson.version : "runtime-env-json-v1",
          source: "env_json",
          models: pricingModels,
        }
      : undefined,
  };
}

function normalizeKvConfig(raw: unknown): PartialResolvedRuntimeConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const thresholdSource = source.thresholds && typeof source.thresholds === "object"
    ? source.thresholds as Record<string, unknown>
    : null;
  const thresholds: Partial<ResolvedRuntimeConfig["thresholds"]> = {};
  if (thresholdSource) {
    if (hasOwn(thresholdSource, "minDistinctSources")) {
      thresholds.minDistinctSources = parsePositiveInteger(thresholdSource.minDistinctSources, DEFAULT_MIN_DISTINCT_SOURCES);
    }
    if (hasOwn(thresholdSource, "longAnswerThresholdChars")) {
      thresholds.longAnswerThresholdChars = parsePositiveInteger(thresholdSource.longAnswerThresholdChars, DEFAULT_LONG_ANSWER_THRESHOLD_CHARS);
    }
    if (hasOwn(thresholdSource, "uaoClassifierConfidenceThreshold")) {
      thresholds.uaoClassifierConfidenceThreshold = parseClassifierThreshold(
        thresholdSource.uaoClassifierConfidenceThreshold,
        DEFAULT_UAO_CLASSIFIER_CONFIDENCE,
      );
    }
    if (hasOwn(thresholdSource, "conversationCompactionMaxEstimatedTokens")) {
      thresholds.conversationCompactionMaxEstimatedTokens = parsePositiveInteger(
        thresholdSource.conversationCompactionMaxEstimatedTokens,
        DEFAULT_COMPACTION_MAX_ESTIMATED_TOKENS,
      );
    }
    if (hasOwn(thresholdSource, "conversationCompactionPreserveRecentMessages")) {
      thresholds.conversationCompactionPreserveRecentMessages = parsePositiveInteger(
        thresholdSource.conversationCompactionPreserveRecentMessages,
        DEFAULT_COMPACTION_PRESERVE_RECENT_MESSAGES,
      );
    }
    if (hasOwn(thresholdSource, "typewriterSpeedMs")) {
      thresholds.typewriterSpeedMs = parseOptionalPositiveInteger(thresholdSource.typewriterSpeedMs);
    }
    if (hasOwn(thresholdSource, "visionInlineMaxBytes")) {
      thresholds.visionInlineMaxBytes = parseOptionalPositiveInteger(thresholdSource.visionInlineMaxBytes);
    }
  }
  const pricingModels = normalizePricingTable(
    (source.pricing && typeof source.pricing === "object" && !Array.isArray(source.pricing))
      ? ((source.pricing as Record<string, unknown>).models ?? source.pricing)
      : source.pricing,
  );
  return {
    flags: normalizeRuntimeFlags((source.flags && typeof source.flags === "object" ? source.flags : source) as Record<string, unknown>),
    thresholds: Object.keys(thresholds).length ? thresholds : undefined,
    pricing: Object.keys(pricingModels).length
      ? {
          version: typeof source.pricingVersion === "string"
            ? source.pricingVersion
            : typeof (source.pricing as Record<string, unknown> | undefined)?.version === "string"
              ? (source.pricing as Record<string, unknown>).version as string
              : "runtime-kv-v1",
          source: "kv",
          models: pricingModels,
        }
      : undefined,
  };
}

export function resolveRuntimeConfigSync(
  env: Env,
  opts: { overrides?: RuntimeConfigOverrideInput } = {},
): ResolvedRuntimeConfig {
  const overrideConfig = opts.overrides
    ? {
        flags: opts.overrides.flags,
        thresholds: opts.overrides.thresholds,
        pricing: opts.overrides.pricing
          ? {
              version: opts.overrides.pricing.version,
              source: opts.overrides.pricing.source ?? "test_override",
              models: opts.overrides.pricing.models,
            }
          : undefined,
      }
    : undefined;
  return mergeResolvedConfigs(
    {},
    buildEnvConfig(env),
    buildEnvJsonConfig(env),
    overrideConfig,
  );
}

export async function resolveRuntimeConfig(
  env: Env,
  opts: { overrides?: RuntimeConfigOverrideInput; skipCache?: boolean } = {},
): Promise<ResolvedRuntimeConfig> {
  if (!opts.skipCache && !opts.overrides) {
    const cached = resolvedRuntimeConfigCache.get(env);
    if (cached) return cached;
  }

  const promise = (async () => {
    const base = resolveRuntimeConfigSync(env);
    let kvConfig: PartialResolvedRuntimeConfig | undefined;
    if (base.flags.runtimeConfigKvOverrides && env.OWEN_DIAG_KV) {
      const stored = await env.OWEN_DIAG_KV.get(RUNTIME_CONFIG_KV_KEY, { type: "json" });
      kvConfig = normalizeKvConfig(stored);
    }
    const overrideConfig = opts.overrides
      ? {
          flags: opts.overrides.flags,
          thresholds: opts.overrides.thresholds,
          pricing: opts.overrides.pricing
            ? {
                version: opts.overrides.pricing.version,
                source: opts.overrides.pricing.source ?? "test_override",
                models: opts.overrides.pricing.models,
              }
            : undefined,
        }
      : undefined;
    const envJsonConfig = buildEnvJsonConfig(env);
    const resolved = mergeResolvedConfigs(
      {},
      buildEnvConfig(env),
      envJsonConfig,
      kvConfig,
      overrideConfig,
    );

    resolved.sources.flags = ["defaults", "env"];
    if (Object.keys(envJsonConfig.flags || {}).length) resolved.sources.flags.push("env_json");
    if (kvConfig && (kvConfig.flags || kvConfig.thresholds || kvConfig.pricing?.models)) resolved.sources.flags.push("kv");
    if (opts.overrides) resolved.sources.flags.push("test_override");

    resolved.sources.pricing = ["defaults"];
    if (Object.keys(envJsonConfig.pricing?.models || {}).length) resolved.sources.pricing.push("env_json");
    if (kvConfig?.pricing?.models && Object.keys(kvConfig.pricing.models).length) resolved.sources.pricing.push("kv");
    if (opts.overrides?.pricing?.models && Object.keys(opts.overrides.pricing.models).length) resolved.sources.pricing.push("test_override");

    return resolved;
  })();

  if (!opts.skipCache && !opts.overrides) {
    resolvedRuntimeConfigCache.set(env, promise);
  }
  return promise;
}
