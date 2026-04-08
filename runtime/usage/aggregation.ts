import type {
  UsageAggregateBundle,
  UsageArtifactRow,
  UsageEventV1,
  UsageGroupedRow,
  UsageLiveResponse,
  UsageOverviewCards,
  UsageQueryFilters,
  UsageSessionRow,
  UsageTimeseriesPoint,
} from "./types";

function sumNumber(values: Array<number | null | undefined>): number {
  return values.reduce<number>((total, value) => total + (typeof value === "number" && Number.isFinite(value) ? value : 0), 0);
}

function sumUsd(values: Array<number | null | undefined>): number | null {
  let found = false;
  const total = values.reduce<number>((acc, value) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      found = true;
      return acc + value;
    }
    return acc;
  }, 0);
  return found ? Math.round(total * 1_000_000) / 1_000_000 : null;
}

function eventsSince(events: UsageEventV1[], cutoffMs: number): UsageEventV1[] {
  return events.filter((event) => {
    const ts = Date.parse(event.ts);
    return Number.isFinite(ts) && ts >= cutoffMs;
  });
}

export function buildUsageOverview(events: UsageEventV1[], now = new Date()): UsageOverviewCards {
  const nowMs = now.getTime();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime();
  const last7 = nowMs - 6 * 24 * 60 * 60 * 1000;
  const last30 = nowMs - 29 * 24 * 60 * 60 * 1000;
  const todayEvents = eventsSince(events, todayStart);
  const weekEvents = eventsSince(events, last7);
  const monthEvents = eventsSince(events, last30);
  return {
    costTodayUsd: sumUsd(todayEvents.map((event) => event.estimatedUsd.total)),
    costLast7DaysUsd: sumUsd(weekEvents.map((event) => event.estimatedUsd.total)),
    costLast30DaysUsd: sumUsd(monthEvents.map((event) => event.estimatedUsd.total)),
    tokensLast30Days: sumNumber(monthEvents.map((event) => event.tokenUsage.total)),
    totalRequests: events.length,
  };
}

export function buildUsageTimeseries(events: UsageEventV1[], granularity: "hour" | "day" = "day"): UsageTimeseriesPoint[] {
  const groups = new Map<string, UsageEventV1[]>();
  events.forEach((event) => {
    const bucket = granularity === "hour" ? event.hour : event.day;
    const next = groups.get(bucket) || [];
    next.push(event);
    groups.set(bucket, next);
  });
  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, bucketEvents]) => ({
      bucket,
      requestCount: bucketEvents.length,
      totalTokens: sumNumber(bucketEvents.map((event) => event.tokenUsage.total)),
      totalUsd: sumUsd(bucketEvents.map((event) => event.estimatedUsd.total)),
    }));
}

function buildGroupedRows(events: UsageEventV1[], keySelector: (event: UsageEventV1) => string, limit = 20): UsageGroupedRow[] {
  const groups = new Map<string, UsageEventV1[]>();
  events.forEach((event) => {
    const key = keySelector(event) || "unknown";
    const next = groups.get(key) || [];
    next.push(event);
    groups.set(key, next);
  });
  return Array.from(groups.entries())
    .map(([key, bucketEvents]) => ({
      key,
      label: key,
      requestCount: bucketEvents.length,
      totalTokens: sumNumber(bucketEvents.map((event) => event.tokenUsage.total)),
      totalUsd: sumUsd(bucketEvents.map((event) => event.estimatedUsd.total)),
    }))
    .sort((a, b) => (b.totalUsd || 0) - (a.totalUsd || 0) || b.requestCount - a.requestCount)
    .slice(0, limit);
}

export function buildUsageByModel(events: UsageEventV1[], limit = 20): UsageGroupedRow[] {
  return buildGroupedRows(events, (event) => event.modelId, limit);
}

export function buildUsageByWorkflow(events: UsageEventV1[], limit = 20): UsageGroupedRow[] {
  return buildGroupedRows(events, (event) => event.workflow, limit);
}

export function buildTopSessions(events: UsageEventV1[], limit = 20): UsageSessionRow[] {
  const groups = new Map<string, UsageEventV1[]>();
  events.forEach((event) => {
    const key = event.sessionId || event.conversationId || "";
    if (!key) return;
    const next = groups.get(key) || [];
    next.push(event);
    groups.set(key, next);
  });
  return Array.from(groups.entries())
    .map(([sessionId, bucketEvents]) => {
      const latest = bucketEvents[bucketEvents.length - 1];
      return {
        sessionId,
        conversationId: latest?.conversationId ?? null,
        workflow: latest?.workflow || "unknown",
        institutionId: latest?.institutionId ?? null,
        courseId: latest?.courseId ?? null,
        latestAt: latest?.ts || new Date(0).toISOString(),
        requestCount: bucketEvents.length,
        totalTokens: sumNumber(bucketEvents.map((event) => event.tokenUsage.total)),
        totalUsd: sumUsd(bucketEvents.map((event) => event.estimatedUsd.total)),
      };
    })
    .sort((a, b) => (b.totalUsd || 0) - (a.totalUsd || 0) || b.requestCount - a.requestCount)
    .slice(0, limit);
}

export function buildTopArtifacts(events: UsageEventV1[], limit = 20): UsageArtifactRow[] {
  const groups = new Map<string, UsageEventV1[]>();
  events.forEach((event) => {
    if (!event.artifactType || !event.artifactCode) return;
    const key = `${event.artifactType}:${event.artifactCode}`;
    const next = groups.get(key) || [];
    next.push(event);
    groups.set(key, next);
  });
  return Array.from(groups.entries())
    .map(([key, bucketEvents]) => {
      const latest = bucketEvents[bucketEvents.length - 1];
      const [artifactType = "artifact", artifactCode = key] = key.split(":");
      return {
        artifactType,
        artifactCode,
        workflow: latest?.workflow || "unknown",
        lectureId: latest?.lectureId ?? null,
        latestAt: latest?.ts || new Date(0).toISOString(),
        requestCount: bucketEvents.length,
        totalTokens: sumNumber(bucketEvents.map((event) => event.tokenUsage.total)),
        totalUsd: sumUsd(bucketEvents.map((event) => event.estimatedUsd.total)),
      };
    })
    .sort((a, b) => (b.totalUsd || 0) - (a.totalUsd || 0) || b.requestCount - a.requestCount)
    .slice(0, limit);
}

export function buildLiveUsage(events: UsageEventV1[], windowMinutes = 10): UsageLiveResponse {
  const cutoff = Date.now() - windowMinutes * 60 * 1000;
  const recent = events.filter((event) => {
    const ts = Date.parse(event.ts);
    return Number.isFinite(ts) && ts >= cutoff;
  });
  const recentSpendUsd = sumUsd(recent.map((event) => event.estimatedUsd.total));
  const burnRateUsdPerHour =
    typeof recentSpendUsd === "number"
      ? Math.round((recentSpendUsd * (60 / windowMinutes)) * 1_000_000) / 1_000_000
      : null;
  return {
    windowMinutes,
    recentSpendUsd,
    burnRateUsdPerHour,
    requestCount: recent.length,
    modelMix: buildUsageByModel(recent, 10),
    recentRequests: recent
      .slice(-20)
      .reverse()
      .map((event) => ({
        requestId: event.requestId,
        workflow: event.workflow,
        modelId: event.modelId,
        sessionId: event.sessionId ?? null,
        conversationId: event.conversationId ?? null,
        totalUsd: event.estimatedUsd.total,
        ts: event.ts,
        permissionMode: event.permissionMode ?? null,
      })),
  };
}

export function buildUsageAggregateBundle(events: UsageEventV1[], filters: UsageQueryFilters): UsageAggregateBundle {
  return {
    filters,
    overview: buildUsageOverview(events),
    timeseries: buildUsageTimeseries(events, filters.granularity || "day"),
    byModel: buildUsageByModel(events, filters.limit || 20),
    byWorkflow: buildUsageByWorkflow(events, filters.limit || 20),
    sessions: buildTopSessions(events, filters.limit || 20),
    artifacts: buildTopArtifacts(events, filters.limit || 20),
  };
}

function escapeCsv(value: unknown): string {
  const text = value == null ? "" : String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, "\"\"")}"`;
}

export function formatUsageEventsCsv(events: UsageEventV1[]): string {
  const headers = [
    "ts",
    "requestId",
    "route",
    "workflow",
    "sessionId",
    "conversationId",
    "userId",
    "role",
    "institutionId",
    "courseId",
    "lectureId",
    "artifactType",
    "artifactCode",
    "modelId",
    "provider",
    "latencyMs",
    "success",
    "errorCode",
    "permissionMode",
    "toolSet",
    "usageStatus",
    "inputTokens",
    "outputTokens",
    "cacheCreationTokens",
    "cacheReadTokens",
    "totalTokens",
    "inputUsd",
    "outputUsd",
    "cacheCreationUsd",
    "cacheReadUsd",
    "totalUsd",
  ];
  const rows = events.map((event) => [
    event.ts,
    event.requestId,
    event.route,
    event.workflow,
    event.sessionId ?? "",
    event.conversationId ?? "",
    event.userId ?? "",
    event.role ?? "",
    event.institutionId ?? "",
    event.courseId ?? "",
    event.lectureId ?? "",
    event.artifactType ?? "",
    event.artifactCode ?? "",
    event.modelId,
    event.provider,
    event.latencyMs ?? "",
    event.success,
    event.errorCode ?? "",
    event.permissionMode ?? "",
    event.toolSet.join("|"),
    event.usageStatus,
    event.tokenUsage.input ?? "",
    event.tokenUsage.output ?? "",
    event.tokenUsage.cacheCreation ?? "",
    event.tokenUsage.cacheRead ?? "",
    event.tokenUsage.total ?? "",
    event.estimatedUsd.input ?? "",
    event.estimatedUsd.output ?? "",
    event.estimatedUsd.cacheCreation ?? "",
    event.estimatedUsd.cacheRead ?? "",
    event.estimatedUsd.total ?? "",
  ]);
  return [headers, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\n");
}
