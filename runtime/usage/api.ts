import type { AuthSessionRecord } from "../../../auth/session";
import type { Env } from "../../../types";
import { jsonNoStore } from "../http";
import { requireAdminCostRead, requireRuntimeConfigRead, requireUsageCostExport, requireUsageCostRead } from "../authz";
import { resolveRuntimeConfig } from "../config/resolved_runtime_config";
import { buildLiveUsage, buildUsageAggregateBundle, formatUsageEventsCsv } from "./aggregation";
import { readUsageCache, readUsageEvents, writeUsageCache } from "./storage";
import type { UsageAggregateBundle, UsageQueryFilters } from "./types";

function parseLimit(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(200, parsed)) : undefined;
}

function parseFilters(req: Request): UsageQueryFilters {
  const url = new URL(req.url);
  const granularity = url.searchParams.get("granularity");
  return {
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
    institutionId: url.searchParams.get("institutionId"),
    courseId: url.searchParams.get("courseId"),
    model: url.searchParams.get("model"),
    workflow: url.searchParams.get("workflow"),
    granularity: granularity === "hour" ? "hour" : "day",
    limit: parseLimit(url.searchParams.get("limit")),
  };
}

function applyFacultyScope(filters: UsageQueryFilters, session: AuthSessionRecord): UsageQueryFilters {
  const next = { ...filters };
  if (session.role !== "admin") {
    next.institutionId = next.institutionId || session.institutionId;
    if (session.courseIds.length > 0 && !next.courseId) {
      next.courseId = session.courseIds[0];
    }
  }
  return next;
}

async function loadAggregateBundle(env: Env, filters: UsageQueryFilters): Promise<UsageAggregateBundle> {
  const cached = await readUsageCache<UsageAggregateBundle>(env, "summary", filters);
  if (cached) return cached;
  const events = await readUsageEvents(env, filters);
  const bundle = buildUsageAggregateBundle(events, filters);
  await writeUsageCache(env, "summary", filters, bundle);
  return bundle;
}

export async function handleFacultyCostSummary(req: Request, env: Env): Promise<Response> {
  const rawFilters = parseFilters(req);
  const auth = await requireUsageCostRead(req, env, rawFilters);
  if (!auth.ok) return auth.response;
  const filters = applyFacultyScope(rawFilters, auth.session);
  const bundle = await loadAggregateBundle(env, filters);
  return jsonNoStore(bundle);
}

export async function handleFacultyCostTimeseries(req: Request, env: Env): Promise<Response> {
  const rawFilters = parseFilters(req);
  const auth = await requireUsageCostRead(req, env, rawFilters);
  if (!auth.ok) return auth.response;
  const filters = applyFacultyScope(rawFilters, auth.session);
  const bundle = await loadAggregateBundle(env, filters);
  return jsonNoStore({ filters, timeseries: bundle.timeseries });
}

export async function handleFacultyCostByModel(req: Request, env: Env): Promise<Response> {
  const rawFilters = parseFilters(req);
  const auth = await requireUsageCostRead(req, env, rawFilters);
  if (!auth.ok) return auth.response;
  const filters = applyFacultyScope(rawFilters, auth.session);
  const bundle = await loadAggregateBundle(env, filters);
  return jsonNoStore({ filters, rows: bundle.byModel });
}

export async function handleFacultyCostByWorkflow(req: Request, env: Env): Promise<Response> {
  const rawFilters = parseFilters(req);
  const auth = await requireUsageCostRead(req, env, rawFilters);
  if (!auth.ok) return auth.response;
  const filters = applyFacultyScope(rawFilters, auth.session);
  const bundle = await loadAggregateBundle(env, filters);
  return jsonNoStore({ filters, rows: bundle.byWorkflow });
}

export async function handleFacultyCostSessions(req: Request, env: Env): Promise<Response> {
  const rawFilters = parseFilters(req);
  const auth = await requireUsageCostRead(req, env, rawFilters);
  if (!auth.ok) return auth.response;
  const filters = applyFacultyScope(rawFilters, auth.session);
  const bundle = await loadAggregateBundle(env, filters);
  return jsonNoStore({ filters, rows: bundle.sessions });
}

export async function handleFacultyCostArtifacts(req: Request, env: Env): Promise<Response> {
  const rawFilters = parseFilters(req);
  const auth = await requireUsageCostRead(req, env, rawFilters);
  if (!auth.ok) return auth.response;
  const filters = applyFacultyScope(rawFilters, auth.session);
  const bundle = await loadAggregateBundle(env, filters);
  return jsonNoStore({ filters, rows: bundle.artifacts });
}

export async function handleFacultyCostLive(req: Request, env: Env): Promise<Response> {
  const rawFilters = parseFilters(req);
  const auth = await requireUsageCostRead(req, env, rawFilters);
  if (!auth.ok) return auth.response;
  const filters = applyFacultyScope(rawFilters, auth.session);
  const events = await readUsageEvents(env, filters);
  return jsonNoStore(buildLiveUsage(events));
}

export async function handleFacultyCostExport(req: Request, env: Env): Promise<Response> {
  const rawFilters = parseFilters(req);
  const auth = await requireUsageCostExport(req, env, rawFilters);
  if (!auth.ok) return auth.response;
  const filters = applyFacultyScope(rawFilters, auth.session);
  const format = new URL(req.url).searchParams.get("format") || "json";
  const events = await readUsageEvents(env, filters);
  if (format === "csv") {
    return new Response(formatUsageEventsCsv(events), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
  const bundle = buildUsageAggregateBundle(events, filters);
  return jsonNoStore(bundle);
}

export async function handleAdminCostExport(req: Request, env: Env): Promise<Response> {
  const rawFilters = parseFilters(req);
  const auth = await requireAdminCostRead(req, env, "admin_cost_export");
  if (!auth.ok) return auth.response;
  const format = new URL(req.url).searchParams.get("format") || "json";
  const events = await readUsageEvents(env, rawFilters);
  if (format === "csv") {
    return new Response(formatUsageEventsCsv(events), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
  return jsonNoStore({ filters: rawFilters, events });
}

export async function handleAdminRuntimeConfig(req: Request, env: Env): Promise<Response> {
  const auth = await requireRuntimeConfigRead(req, env, "runtime_config_read");
  if (!auth.ok) return auth.response;
  const config = await resolveRuntimeConfig(env);
  return jsonNoStore({
    flags: config.flags,
    pricing: {
      source: config.pricing.source,
      models: Object.keys(config.pricing.models),
    },
    thresholds: config.thresholds,
  });
}
