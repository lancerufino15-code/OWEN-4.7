import type { RuntimePermissionMode } from "../permissions";

export type UsageAvailability = "exact" | "partial" | "unavailable";

export type UsageTokenCounts = {
  input: number | null;
  output: number | null;
  cacheCreation: number | null;
  cacheRead: number | null;
  total: number | null;
};

export type UsageUsdBreakdown = {
  total: number | null;
  input: number | null;
  output: number | null;
  cacheCreation: number | null;
  cacheRead: number | null;
};

export type UsageEventV1 = {
  v: 1;
  ts: string;
  day: string;
  hour: string;
  requestId: string;
  route: string;
  workflow: string;
  sessionId?: string | null;
  conversationId?: string | null;
  userId?: string | null;
  role?: string | null;
  institutionId?: string | null;
  courseId?: string | null;
  lectureId?: string | null;
  artifactType?: "study_guide" | "anki" | "artifact" | null;
  artifactCode?: string | null;
  modelId: string;
  provider: string;
  latencyMs: number | null;
  success: boolean;
  errorCode?: string | null;
  permissionMode?: RuntimePermissionMode | null;
  toolSet: string[];
  usageStatus: UsageAvailability;
  tokenUsage: UsageTokenCounts;
  estimatedUsd: UsageUsdBreakdown;
  pricing: {
    modelKey: string | null;
    known: boolean;
    source: "defaults" | "env_json" | "kv" | "override" | "unknown";
  };
  metadata?: Record<string, unknown>;
};

export type UsageEventInput = {
  requestId: string;
  route: string;
  workflow: string;
  sessionId?: string | null;
  conversationId?: string | null;
  userId?: string | null;
  role?: string | null;
  institutionId?: string | null;
  courseId?: string | null;
  lectureId?: string | null;
  artifactType?: UsageEventV1["artifactType"];
  artifactCode?: string | null;
  modelId: string;
  provider: string;
  latencyMs?: number | null;
  success: boolean;
  errorCode?: string | null;
  permissionMode?: RuntimePermissionMode | null;
  toolSet?: Iterable<string>;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    totalTokens: number;
  } | null;
  metadata?: Record<string, unknown>;
};

export type UsageQueryFilters = {
  from?: string | null;
  to?: string | null;
  institutionId?: string | null;
  courseId?: string | null;
  model?: string | null;
  workflow?: string | null;
  granularity?: "hour" | "day";
  limit?: number;
};

export type UsageOverviewCards = {
  costTodayUsd: number | null;
  costLast7DaysUsd: number | null;
  costLast30DaysUsd: number | null;
  tokensLast30Days: number;
  totalRequests: number;
};

export type UsageTimeseriesPoint = {
  bucket: string;
  requestCount: number;
  totalTokens: number;
  totalUsd: number | null;
};

export type UsageGroupedRow = {
  key: string;
  label: string;
  requestCount: number;
  totalTokens: number;
  totalUsd: number | null;
};

export type UsageSessionRow = {
  sessionId: string;
  conversationId?: string | null;
  workflow: string;
  institutionId?: string | null;
  courseId?: string | null;
  latestAt: string;
  requestCount: number;
  totalTokens: number;
  totalUsd: number | null;
};

export type UsageArtifactRow = {
  artifactType: string;
  artifactCode: string;
  workflow: string;
  lectureId?: string | null;
  latestAt: string;
  requestCount: number;
  totalTokens: number;
  totalUsd: number | null;
};

export type UsageLiveResponse = {
  windowMinutes: number;
  recentSpendUsd: number | null;
  burnRateUsdPerHour: number | null;
  requestCount: number;
  modelMix: UsageGroupedRow[];
  recentRequests: Array<{
    requestId: string;
    workflow: string;
    modelId: string;
    sessionId?: string | null;
    conversationId?: string | null;
    totalUsd: number | null;
    ts: string;
    permissionMode?: RuntimePermissionMode | null;
  }>;
};

export type UsageAggregateBundle = {
  filters: UsageQueryFilters;
  overview: UsageOverviewCards;
  timeseries: UsageTimeseriesPoint[];
  byModel: UsageGroupedRow[];
  byWorkflow: UsageGroupedRow[];
  sessions: UsageSessionRow[];
  artifacts: UsageArtifactRow[];
};
