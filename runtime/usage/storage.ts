import type { Env } from "../../../types";
import { sha256 } from "../../library";
import type { UsageEventV1, UsageQueryFilters } from "./types";

const USAGE_EVENT_PREFIX = "usage-events/";

function usageDayPrefix(tsIso: string): string {
  const [date] = tsIso.split("T");
  const [year = "0000", month = "00", day = "00"] = (date || "").split("-");
  return `${USAGE_EVENT_PREFIX}${year}/${month}/${day}/`;
}

export function buildUsageEventKey(tsIso: string, requestId: string): string {
  return `${usageDayPrefix(tsIso)}${requestId}.json`;
}

export async function writeUsageEvent(env: Env, event: UsageEventV1): Promise<void> {
  if (!env.OWEN_ANALYTICS) return;
  await env.OWEN_ANALYTICS.put(buildUsageEventKey(event.ts, event.requestId), JSON.stringify(event), {
    httpMetadata: { contentType: "application/json" },
  });
}

function parseDateOnly(value: string | null | undefined): Date | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  const direct = normalized.length === 10 ? `${normalized}T00:00:00.000Z` : normalized;
  const parsed = new Date(direct);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function endOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));
}

export function resolveUsageDateRange(filters: UsageQueryFilters): { from: Date; to: Date } {
  const now = new Date();
  const to = parseDateOnly(filters.to) || now;
  const from = parseDateOnly(filters.from) || new Date(to.getTime() - 29 * 24 * 60 * 60 * 1000);
  return {
    from: startOfUtcDay(from),
    to: endOfUtcDay(to),
  };
}

function* iterUtcDaysInclusive(from: Date, to: Date): Generator<Date> {
  const cursor = startOfUtcDay(from);
  const end = startOfUtcDay(to).getTime();
  while (cursor.getTime() <= end) {
    yield new Date(cursor.getTime());
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

function prefixForDate(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${USAGE_EVENT_PREFIX}${year}/${month}/${day}/`;
}

function eventWithinRange(event: UsageEventV1, from: Date, to: Date): boolean {
  const ts = Date.parse(event.ts);
  return Number.isFinite(ts) && ts >= from.getTime() && ts <= to.getTime();
}

function eventMatchesFilters(event: UsageEventV1, filters: UsageQueryFilters): boolean {
  if (filters.institutionId && event.institutionId !== filters.institutionId) return false;
  if (filters.courseId && event.courseId !== filters.courseId) return false;
  if (filters.model && event.modelId !== filters.model) return false;
  if (filters.workflow && event.workflow !== filters.workflow) return false;
  return true;
}

export async function readUsageEvents(env: Env, filters: UsageQueryFilters): Promise<UsageEventV1[]> {
  if (!env.OWEN_ANALYTICS) return [];
  const { from, to } = resolveUsageDateRange(filters);
  const events: UsageEventV1[] = [];

  for (const day of iterUtcDaysInclusive(from, to)) {
    const prefix = prefixForDate(day);
    let cursor: string | undefined;
    do {
      const page = await env.OWEN_ANALYTICS.list({ prefix, cursor, limit: 500 });
      for (const object of page.objects) {
        const item = await env.OWEN_ANALYTICS.get(object.key);
        if (!item) continue;
        const event = await item.json<UsageEventV1>().catch(() => null);
        if (!event || event.v !== 1) continue;
        if (!eventWithinRange(event, from, to)) continue;
        if (!eventMatchesFilters(event, filters)) continue;
        events.push(event);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return events;
}

export async function buildUsageCacheKey(namespace: string, filters: UsageQueryFilters): Promise<string> {
  const hash = await sha256(JSON.stringify({ namespace, filters }));
  return `usage-cache:${namespace}:${hash}`;
}

export async function readUsageCache<T>(env: Env, namespace: string, filters: UsageQueryFilters): Promise<T | null> {
  if (!env.OWEN_DIAG_KV) return null;
  const key = await buildUsageCacheKey(namespace, filters);
  const cached = await env.OWEN_DIAG_KV.get(key, { type: "json" });
  return cached && typeof cached === "object" ? cached as T : null;
}

export async function writeUsageCache<T>(env: Env, namespace: string, filters: UsageQueryFilters, value: T, ttlSeconds = 120): Promise<void> {
  if (!env.OWEN_DIAG_KV) return;
  const key = await buildUsageCacheKey(namespace, filters);
  await env.OWEN_DIAG_KV.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds });
}
