export type RuntimeFlagKey =
  | "ENABLE_RUNTIME_CAPABILITY_GATE"
  | "ENABLE_SESSION_V2"
  | "ENABLE_SESSION_RESUME"
  | "ENABLE_USAGE_TRACKING"
  | "ENABLE_COST_TRACKING_UI"
  | "ENABLE_PARITY_FIXTURE_MODE"
  | "ENABLE_RUNTIME_CONFIG_KV_OVERRIDES"
  | "OWEN_STRUCTURED_CHAT_V2_ENABLED"
  | "OWEN_DERIVED_STRUCTURED_STREAM_ENABLED"
  | "OWEN_CONVERSATION_COMPACTION_ENABLED"
  | "OWEN_RUNTIME_HOOKS_ENABLED"
  | "OWEN_USAGE_TRACKING_ENABLED"
  | "OWEN_VISION_ENABLED"
  | "OWEN_MEDICAL_VISION_PROMPTS_ENABLED"
  | "OWEN_VISION_R2_CACHE_ENABLED"
  | "OWEN_VISION_MULTI_IMAGE_ENABLED"
  | "UAO_ENABLED"
  | "UAO_LLM_CLASSIFIER_ENABLED"
  | "UAO_LLM_QC_ENABLED"
  | "ENFORCE_MIN_DISTINCT_SOURCES";

export interface RuntimeFlags {
  runtimeCapabilityGate: boolean;
  sessionV2: boolean;
  sessionResume: boolean;
  usageTracking: boolean;
  costTrackingUi: boolean;
  parityFixtureMode: boolean;
  runtimeConfigKvOverrides: boolean;
  structuredChat: boolean;
  derivedStructuredStream: boolean;
  conversationCompaction: boolean;
  runtimeHooks: boolean;
  visionEnabled: boolean;
  medicalVisionPrompts: boolean;
  visionR2Cache: boolean;
  visionMultiImage: boolean;
  uaoEnabled: boolean;
  uaoLlmClassifierEnabled: boolean;
  uaoLlmQcEnabled: boolean;
  enforceMinDistinctSources: boolean;
}

export function parseBooleanFlag(raw: unknown, fallback = false): boolean {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw === "boolean") return raw;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return false;
  return fallback;
}

export function parseEnabledByDefault(raw: unknown, fallback = true): boolean {
  return parseBooleanFlag(raw, fallback);
}
