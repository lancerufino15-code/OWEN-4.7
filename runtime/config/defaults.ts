import type { RuntimeFlags } from "./runtime_flags";
import type { RuntimePricingTable } from "./pricing";

export const RUNTIME_CONFIG_KV_KEY = "runtime:config:v1";

export const DEFAULT_RUNTIME_FLAGS: RuntimeFlags = {
  runtimeCapabilityGate: true,
  sessionV2: true,
  sessionResume: true,
  usageTracking: true,
  costTrackingUi: false,
  parityFixtureMode: false,
  runtimeConfigKvOverrides: false,
  structuredChat: false,
  derivedStructuredStream: false,
  conversationCompaction: false,
  runtimeHooks: false,
  visionEnabled: true,
  medicalVisionPrompts: false,
  visionR2Cache: false,
  visionMultiImage: false,
  uaoEnabled: false,
  uaoLlmClassifierEnabled: false,
  uaoLlmQcEnabled: false,
  enforceMinDistinctSources: false,
};

export const DEFAULT_MIN_DISTINCT_SOURCES = 8;
export const DEFAULT_LONG_ANSWER_THRESHOLD_CHARS = 900;
export const DEFAULT_UAO_CLASSIFIER_CONFIDENCE = 0.62;
export const DEFAULT_COMPACTION_MAX_ESTIMATED_TOKENS = 10_000;
export const DEFAULT_COMPACTION_PRESERVE_RECENT_MESSAGES = 4;

export const DEFAULT_RUNTIME_MODEL_PRICING: RuntimePricingTable = {
  "gpt-5.2": {
    inputUsdPerMillion: 1.25,
    outputUsdPerMillion: 10,
    cacheCreationUsdPerMillion: 1.25,
    cacheReadUsdPerMillion: 0.125,
  },
  "gpt-5.1": {
    inputUsdPerMillion: 1.25,
    outputUsdPerMillion: 10,
    cacheCreationUsdPerMillion: 1.25,
    cacheReadUsdPerMillion: 0.125,
  },
  "gpt-5-mini": {
    inputUsdPerMillion: 0.25,
    outputUsdPerMillion: 2,
    cacheCreationUsdPerMillion: 0.25,
    cacheReadUsdPerMillion: 0.025,
  },
  "gpt-4.1": {
    inputUsdPerMillion: 2,
    outputUsdPerMillion: 8,
    cacheCreationUsdPerMillion: 2,
    cacheReadUsdPerMillion: 0.2,
  },
  "gpt-4.1-mini": {
    inputUsdPerMillion: 0.4,
    outputUsdPerMillion: 1.6,
    cacheCreationUsdPerMillion: 0.4,
    cacheReadUsdPerMillion: 0.04,
  },
  "gemini-3.1-pro-preview": {
    inputUsdPerMillion: 3.5,
    outputUsdPerMillion: 10.5,
  },
};
