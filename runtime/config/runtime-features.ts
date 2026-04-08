import type { Env } from "../../../types";
import { DEFAULT_VISION_INLINE_MAX_BYTES } from "../vision/ingest";
import { resolveRuntimeConfigSync } from "./resolved_runtime_config";

export interface RuntimeFeatures {
  capabilityGate: {
    enabled: boolean;
  };
  session: {
    v2Enabled: boolean;
    resumeEnabled: boolean;
  };
  structuredChat: {
    enabled: boolean;
    derivedStreamEnabled: boolean;
  };
  freeResponse: {
    minDistinctSources: number;
    enforceMinDistinctSources: boolean;
  };
  uao: {
    enabled: boolean;
    llmClassifierEnabled: boolean;
    llmQcEnabled: boolean;
    classifierConfidenceThreshold: number;
  };
  rendering: {
    longAnswerThresholdChars: number;
    typewriterSpeedMs?: number;
  };
  conversationCompaction: {
    enabled: boolean;
    maxEstimatedTokens: number;
    preserveRecentMessages: number;
  };
  hooks: {
    enabled: boolean;
  };
  usageTracking: {
    enabled: boolean;
  };
  costTrackingUi: {
    enabled: boolean;
  };
  parityFixtureMode: {
    enabled: boolean;
  };
  runtimeConfigKvOverrides: {
    enabled: boolean;
  };
  vision: {
    enabled: boolean;
    medicalPromptsEnabled: boolean;
    inlineMaxBytes: number;
    r2CacheEnabled: boolean;
    multiImageEnabled: boolean;
  };
}

export function getRuntimeFeatures(env: Env): RuntimeFeatures {
  const resolved = resolveRuntimeConfigSync(env);
  return {
    capabilityGate: {
      enabled: resolved.flags.runtimeCapabilityGate,
    },
    session: {
      v2Enabled: resolved.flags.sessionV2,
      resumeEnabled: resolved.flags.sessionResume,
    },
    structuredChat: {
      enabled: resolved.flags.structuredChat,
      derivedStreamEnabled: resolved.flags.derivedStructuredStream,
    },
    freeResponse: {
      minDistinctSources: resolved.thresholds.minDistinctSources,
      enforceMinDistinctSources: resolved.flags.enforceMinDistinctSources,
    },
    uao: {
      enabled: resolved.flags.uaoEnabled,
      llmClassifierEnabled: resolved.flags.uaoLlmClassifierEnabled,
      llmQcEnabled: resolved.flags.uaoLlmQcEnabled,
      classifierConfidenceThreshold: resolved.thresholds.uaoClassifierConfidenceThreshold,
    },
    rendering: {
      longAnswerThresholdChars: resolved.thresholds.longAnswerThresholdChars,
      typewriterSpeedMs: resolved.thresholds.typewriterSpeedMs,
    },
    conversationCompaction: {
      enabled: resolved.flags.conversationCompaction,
      maxEstimatedTokens: resolved.thresholds.conversationCompactionMaxEstimatedTokens,
      preserveRecentMessages: resolved.thresholds.conversationCompactionPreserveRecentMessages,
    },
    hooks: {
      enabled: resolved.flags.runtimeHooks,
    },
    usageTracking: {
      enabled: resolved.flags.usageTracking,
    },
    costTrackingUi: {
      enabled: resolved.flags.costTrackingUi,
    },
    parityFixtureMode: {
      enabled: resolved.flags.parityFixtureMode,
    },
    runtimeConfigKvOverrides: {
      enabled: resolved.flags.runtimeConfigKvOverrides,
    },
    vision: {
      enabled: resolved.flags.visionEnabled,
      medicalPromptsEnabled: resolved.flags.medicalVisionPrompts,
      inlineMaxBytes: resolved.thresholds.visionInlineMaxBytes ?? DEFAULT_VISION_INLINE_MAX_BYTES,
      r2CacheEnabled: resolved.flags.visionR2Cache,
      multiImageEnabled: resolved.flags.visionMultiImage,
    },
  };
}
