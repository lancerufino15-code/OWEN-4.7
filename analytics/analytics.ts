/**
 * Purpose:
 * - Analytics helpers for logging lecture Q&A events to R2 and summarizing usage.
 *
 * Responsibilities:
 * - Normalize filtered question strings, build deterministic event keys, write events, and aggregate counts over time.
 * - Track last-written analytics key for diagnostics.
 *
 * Used by:
 * - Worker entrypoints (`src/index.ts`, `index.ts`) for lecture analytics endpoints and diagnostics.
 *
 * Key exports:
 * - `TaggingResult`, `OwenAnalyticsEventV1`: analytics event shapes.
 * - `aggregateLectureAnalytics`, `buildAnalyticsEvent`, `writeAnalyticsEvent`: main analytics pipeline helpers.
 *
 * Architecture role:
 * - Called by the worker when writing lecture analytics or serving admin/diagnostic endpoints.
 *
 * Constraints:
 * - Cloudflare Workers runtime using R2; relies on Env bindings for storage and avoids Node APIs.
 */
import type { Env } from "../../types";
import { saveLastAnalyticsKey } from "../../core/diag-store";
import {
  buildCanonicalPromptKey,
  buildPromptAliases,
  cleanPromptPreserveOrder,
  cleanPromptToSentence,
  filterMetadata,
  mergeAliasList,
  selectDisplayPhrase,
} from "./analytics_metadata_filter";

/**
 * Result of metadata filtering/tagging for a user question.
 */
export type TaggingResult = {
  filteredStrings: string[];
  confidence: number | null;
};

/**
 * Canonical analytics event schema written to R2.
 */
export type OwenAnalyticsEventV1 = {
  v: 1;
  ts: string;
  lectureId: string;
  lectureTitle?: string | null;
  status?: string | null;
  docId?: string | null;
  userHash?: string | null;
  sessionId?: string | null;
  question: string;
  cleanedPrompt?: string;
  topics?: string[];
  filteredStrings: string[];
  lectureAnchors?: string[];
  mode: "lecture_qa";
  model?: string | null;
  confidence?: number | null;
};

/** Max number of tags/filtered strings to retain per event. */
export const MAX_TAGS = 12;
const ANALYTICS_EVENT_PREFIX = "owen-analytics/owen-analytics/";
// Canonical prefix keeps analytics writes/reads aligned across worker + admin paths.
const ANALYTICS_BASE_PREFIXES = [ANALYTICS_EVENT_PREFIX];
const ANALYTICS_CACHE_PREFIX = "owen-analytics/aggregates/";
const QUESTIONS_CACHE_PREFIX = "owen-analytics/aggregates/questions/";
const DEFAULT_TOP_TAG_LIMIT = 25;
/** In-memory pointer to the most recently written analytics key. */
export let LAST_ANALYTICS_KEY: string | null = null;

/**
 * Detected schema type when inspecting analytics objects.
 */
export type AnalyticsSchema = "event_v1" | "aggregate_counts" | "top_list" | "unknown";

/**
 * Discovery result used to locate analytics data for a lecture.
 */
export type AnalyticsDiscovery = {
  lectureKey: string;
  prefixUsed: string;
  schema: AnalyticsSchema;
  sampleKey: string | null;
  sampleFields: string[];
  keysScanned: number;
};

/**
 * Single top-tag entry with count.
 */
export type TopTagEntry = { tag: string; count: number };

/**
 * Aggregated top-tags response shape.
 */
export type TopTagsAggregate = {
  docId: string;
  lectureKey: string;
  updatedAt: string;
  limitComputed: number;
  top: TopTagEntry[];
  source: {
    prefix: string;
    schema: AnalyticsSchema;
    lectureKey: string;
    keysRead: number;
    sampleKey?: string | null;
    cached?: boolean;
    cacheKey?: string;
    cacheAgeSeconds?: number;
    truncated?: boolean;
  };
};

/**
 * Single top-question entry with count.
 */
export type TopQuestionEntry = { question: string; count: number };

type CanonicalTopicEntry = {
  count: number;
  displayPhrase: string;
  aliases: string[];
  lastSeenAt?: string;
};

/**
 * Aggregated top-questions response shape.
 */
export type QuestionsAggregate = {
  lectureId: string;
  lectureKey: string;
  totalEvents: number;
  top: TopQuestionEntry[];
  lastUpdated: string | null;
  source: {
    prefix: string;
    lectureKey: string;
    keysRead: number;
    cached?: boolean;
    cacheKey?: string;
    cacheAgeSeconds?: number;
    truncated?: boolean;
  };
};

/**
 * Track the most recent analytics object key in memory for diagnostics.
 *
 * @param key - R2 object key or null to clear.
 * @remarks Side effects: mutates module-level state.
 */
export function setLastAnalyticsKey(key: string | null) {
  LAST_ANALYTICS_KEY = key;
}

function normalizeLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase().replace(/\s+/g, " ");
  const cleaned = lower.replace(/^[^a-z0-9]+/i, "").replace(/[^a-z0-9]+$/i, "");
  return cleaned || null;
}

/**
 * Normalize and de-duplicate labels with a max-length guard.
 *
 * @param list - Raw label list (unknown inputs allowed).
 * @param limit - Maximum number of labels to return.
 * @returns Normalized label list.
 */
export function normalizeLabels(list: unknown[], limit = MAX_TAGS): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of list || []) {
    const normalized = normalizeLabel(item);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizeFilteredString(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

function buildFilteredString(question: string, limit: number): string | null {
  if (typeof question !== "string") return null;
  const cleaned = cleanPromptToSentence(question).cleaned;
  if (!cleaned) return null;
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  return tokens.slice(0, limit).join(" ").trim() || null;
}

function sanitizeLectureId(raw: string): { id: string; fallback: boolean } {
  const trimmed = (raw || "").trim().replace(/\s+/g, "-");
  if (!trimmed) {
    console.warn("[ANALYTICS_WARN] lectureId missing; defaulting to unknown-lecture");
    return { id: "unknown-lecture", fallback: true };
  }
  const safe = trimmed.replace(/[^\w.-]+/g, "-");
  if (!safe) {
    console.warn("[ANALYTICS_WARN] lectureId invalid; defaulting to unknown-lecture", { raw });
    return { id: "unknown-lecture", fallback: true };
  }
  return { id: safe, fallback: false };
}

/**
 * Derive a canonical lecture id, preferring docId-based identifiers.
 *
 * @param _lectureTitle - Unused (kept for signature compatibility).
 * @param fallbackId - Doc id or other fallback identifier.
 * @returns Sanitized lecture id string.
 */
export function deriveLectureId(_lectureTitle?: string | null, fallbackId?: string | null): string {
  // Canonical lecture IDs come from docId; avoid title slugs to prevent prefix mismatches.
  const { id } = sanitizeLectureId(fallbackId || "unknown-lecture");
  return id;
}

function makeRandToken(): string {
  try {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

function safeIso(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * Build a deterministic analytics object key based on lectureId and timestamp.
 *
 * @param lectureId - Lecture identifier (will be sanitized).
 * @param tsIso - ISO timestamp string.
 * @returns R2 object key for the event.
 */
export function buildEventKey(lectureId: string, tsIso: string): string {
  const safeTs = (tsIso || safeIso()).replace(/[:.]/g, "-");
  const rand = makeRandToken();
  const { id: safeLecture } = sanitizeLectureId(lectureId);
  // Enforce canonical prefix so admin reads and analytics writes stay in lockstep.
  return `${ANALYTICS_EVENT_PREFIX}${safeLecture}/${safeTs}-${rand}.json`;
}

/**
 * Normalize raw analytics inputs into the v1 event schema.
 *
 * @param input - Raw analytics inputs (lecture ids, question, metadata).
 * @returns Normalized event payload or null when insufficient data.
 */
export function buildAnalyticsEvent(input: {
  lectureId?: string;
  lectureTitle?: string | null;
  status?: string | null;
  question: string;
  docId?: string | null;
  sessionId?: string | null;
  userHash?: string | null;
  model?: string | null;
  lectureAnchors?: string[];
  confidence?: number | null;
  ts?: string;
}): OwenAnalyticsEventV1 | null {
  const ts = input.ts || new Date().toISOString();
  const lectureTitle = typeof input.lectureTitle === "string" ? input.lectureTitle.trim() : "";
  const lectureIdInput =
    typeof input.lectureId === "string" && input.lectureId.trim()
      ? input.lectureId
      : typeof input.docId === "string" && input.docId.trim()
        ? input.docId
        : "unknown-lecture";
  const { id: safeLectureId } = sanitizeLectureId(lectureIdInput);
  const lectureAnchors = Array.isArray(input.lectureAnchors)
    ? normalizeLabels(filterMetadata(input.lectureAnchors, MAX_TAGS))
    : undefined;
  const cleanedMeta = cleanPromptToSentence(input.question);
  const filteredString = buildFilteredString(input.question, MAX_TAGS);
  if (!filteredString || !cleanedMeta.cleaned) return null;
  return {
    v: 1,
    ts,
    lectureId: safeLectureId,
    lectureTitle: lectureTitle || null,
    status: typeof input.status === "string" ? input.status : null,
    docId: input.docId ?? null,
    sessionId: input.sessionId ?? null,
    userHash: input.userHash ?? null,
    question: input.question,
    cleanedPrompt: cleanedMeta.cleaned,
    topics: cleanedMeta.topics,
    filteredStrings: [filteredString],
    lectureAnchors,
    mode: "lecture_qa",
    model: input.model ?? null,
    confidence: typeof input.confidence === "number" ? input.confidence : null,
  };
}

/**
 * Build an R2 key for a cached aggregate of lecture analytics.
 *
 * @param docId - Lecture doc id.
 * @returns R2 key for cached aggregate payload.
 */
export function buildAnalyticsAggregateKey(docId: string) {
  const { id } = sanitizeLectureId(docId || "unknown-lecture");
  return `${ANALYTICS_CACHE_PREFIX}${id}.json`;
}

/**
 * Build an R2 key for cached top-questions aggregation.
 *
 * @param lectureId - Lecture identifier.
 * @returns R2 key for cached questions payload.
 */
export function buildQuestionsAggregateKey(lectureId: string) {
  const { id } = sanitizeLectureId(lectureId || "unknown-lecture");
  return `${QUESTIONS_CACHE_PREFIX}${id}.json`;
}

/**
 * Produce a deterministic set of lecture key candidates from docId.
 *
 * @param docId - Raw doc id to sanitize.
 * @param _lectureTitle - Unused (kept for signature compatibility).
 * @returns Candidate lecture keys for prefix lookups.
 */
export function buildLectureKeyCandidates(docId: string, _lectureTitle?: string | null): string[] {
  const candidates: string[] = [];
  const trimmedDoc = (docId || "").trim();
  if (trimmedDoc) candidates.push(trimmedDoc);
  const { id: safeDoc } = sanitizeLectureId(trimmedDoc || "");
  if (safeDoc && safeDoc !== trimmedDoc) candidates.push(safeDoc);
  return Array.from(new Set(candidates.filter(Boolean)));
}

function normalizeTopList(list: any[]): TopTagEntry[] {
  if (!Array.isArray(list)) return [];
  return list
    .map(item => {
      if (!item) return null;
      const tag = normalizeLabel((item as any).tag ?? (item as any).label);
      const countRaw = (item as any).count ?? (item as any).value ?? (item as any).hits;
      const count = typeof countRaw === "number"
        ? Math.max(0, Math.floor(countRaw))
        : Number.isFinite(Number(countRaw))
          ? Math.max(0, Math.floor(Number(countRaw)))
          : null;
      if (!tag || count === null) return null;
      return { tag, count };
    })
    .filter((item): item is TopTagEntry => Boolean(item));
}

function detectAnalyticsShape(payload: any): { schema: AnalyticsSchema; fields: string[]; tagCounts?: Record<string, number>; topList?: TopTagEntry[]; tags?: string[]; updatedAt?: string | null } {
  if (!payload || typeof payload !== "object") {
    return { schema: "unknown", fields: [] };
  }
  const fields = Object.keys(payload || {}).slice(0, 12);

  if ((payload as any).v === 1 && (payload as any).mode === "lecture_qa") {
    const tags = Array.isArray((payload as any).filteredStrings)
      ? (payload as any).filteredStrings
      : Array.isArray((payload as any).tags)
        ? (payload as any).tags
        : [];
    const updatedAt = typeof (payload as any).ts === "string" ? (payload as any).ts : null;
    return { schema: "event_v1", fields, tags, updatedAt };
  }

  const tagCounts =
    typeof (payload as any).tagCounts === "object" && (payload as any).tagCounts !== null
      ? (payload as any).tagCounts
      : typeof (payload as any).tags === "object" && (payload as any).tags !== null
        ? (payload as any).tags
        : null;
  if (tagCounts) {
    return {
      schema: "aggregate_counts",
      fields,
      tagCounts: tagCounts as Record<string, number>,
      updatedAt:
        typeof (payload as any).updatedAt === "string"
          ? (payload as any).updatedAt
          : typeof (payload as any).ts === "string"
            ? (payload as any).ts
            : null,
    };
  }

  const topList = normalizeTopList(
    Array.isArray((payload as any).top)
      ? (payload as any).top
      : Array.isArray((payload as any).topTags)
        ? (payload as any).topTags
        : [],
  );
  if (topList.length) {
    const updatedAt =
      typeof (payload as any).updatedAt === "string"
        ? (payload as any).updatedAt
        : typeof (payload as any).generatedAt === "string"
          ? (payload as any).generatedAt
          : typeof (payload as any).ts === "string"
            ? (payload as any).ts
            : null;
    return { schema: "top_list", fields, topList, updatedAt };
  }

  return { schema: "unknown", fields };
}

async function inspectAnalyticsObject(bucket: R2Bucket, key: string): Promise<{ schema: AnalyticsSchema; fields: string[]; sampleKey: string }> {
  const res = await bucket.get(key);
  if (!res) return { schema: "unknown", fields: [], sampleKey: key };
  try {
    const payload = await res.json();
    const shape = detectAnalyticsShape(payload);
    return { schema: shape.schema, fields: shape.fields, sampleKey: key };
  } catch {
    return { schema: "unknown", fields: [], sampleKey: key };
  }
}

async function discoverAnalyticsLayout(bucket: R2Bucket, docId: string, _lectureTitle?: string | null): Promise<AnalyticsDiscovery | null> {
  const lectureKeys = buildLectureKeyCandidates(docId);
  for (const base of ANALYTICS_BASE_PREFIXES) {
    const basePrefix = base.endsWith("/") ? base : `${base}/`;
    for (const lectureKey of lectureKeys) {
      const prefix = `${basePrefix}${lectureKey}`;
      const page = await bucket.list({ prefix, limit: 6 });
      const objects = page.objects || [];
      if (!objects.length) continue;
      const sampleKey = objects[0]?.key || null;
      let schema: AnalyticsSchema = "unknown";
      let sampleFields: string[] = [];
      if (sampleKey) {
        const inspected = await inspectAnalyticsObject(bucket, sampleKey);
        schema = inspected.schema;
        sampleFields = inspected.fields;
      }
      return {
        lectureKey,
        prefixUsed: basePrefix,
        schema,
        sampleKey,
        sampleFields,
        keysScanned: objects.length,
      };
    }
  }
  return null;
}

/**
 * Persist a single analytics event to the configured R2 bucket.
 *
 * @param env - Worker environment with OWEN_ANALYTICS binding.
 * @param event - Normalized analytics event payload.
 * @throws When the analytics bucket is missing or the put operation fails.
 * @remarks Side effects: writes to R2, updates LAST_ANALYTICS_KEY, and stores a diagnostic key.
 */
export async function writeAnalyticsEvent(env: Env, event: OwenAnalyticsEventV1): Promise<void> {
  // TEMP DEBUG: Hard fail if binding missing so production logs surface misconfiguration.
  if (!env.OWEN_ANALYTICS) {
    console.error("[ANALYTICS_FATAL] OWEN_ANALYTICS binding is undefined at runtime");
    throw new Error("OWEN_ANALYTICS binding missing");
  }
  const key = buildEventKey(event.lectureId, event.ts || safeIso());
  const body = JSON.stringify(event);
  setLastAnalyticsKey(key);
  saveLastAnalyticsKey(env, key).catch(err => console.warn("[DIAG_KV_WRITE_FAILED]", { key, err: err instanceof Error ? err.message : String(err) }));
  console.log("[ANALYTICS_WRITE_TRY]", { key });
  try {
    await env.OWEN_ANALYTICS.put(key, body, { httpMetadata: { contentType: "application/json" } });
    console.log("[ANALYTICS_WRITE_OK]", { key, bucket: "OWEN_ANALYTICS" });
  } catch (err) {
    console.error("[ANALYTICS_WRITE_FAILED]", { key, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

type CountEntry = { key: string; count: number };

function sortCounts(map: Map<string, number>, limit: number): CountEntry[] {
  return Array.from(map.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function parseDateFromKey(key: string): string | null {
  const parts = key.split("/");
  if (parts.length >= 4 && parts[0] === "owen-analytics" && parts[1] === "owen-analytics") {
    const filename = parts[parts.length - 1] || "";
    const base = filename.replace(/\.json$/i, "");
    const datePart = base.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return datePart;
    return null;
  }
  return null;
}

function extractLectureIdFromKey(key: string): string | null {
  const parts = key.split("/");
  if (parts.length < 3) return null;
  if (parts[0] === "owen-analytics" && parts[1] === "owen-analytics") return parts[2] || null;
  return null;
}

async function listPrefixes(bucket: R2Bucket, prefix: string): Promise<Set<string>> {
  const lectureIds = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 500 });
    for (const obj of page.objects || []) {
      const lectureId = extractLectureIdFromKey(obj.key);
      if (lectureId) lectureIds.add(lectureId);
    }
    for (const prefix of page.delimitedPrefixes || []) {
      const lectureId = extractLectureIdFromKey(prefix);
      if (lectureId) lectureIds.add(lectureId);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return lectureIds;
}

/**
 * Scan common analytics prefixes in R2 to list available lecture IDs.
 *
 * @param bucket - R2 bucket containing analytics events.
 * @returns Sorted lecture ids and the prefix used to discover them.
 */
export async function listAnalyticsLectures(bucket: R2Bucket): Promise<{ lectureIds: string[]; sourcePrefixUsed: string }> {
  const prefixes = [...ANALYTICS_BASE_PREFIXES];
  let sourcePrefixUsed = prefixes[0];
  let lectureIds = await listPrefixes(bucket, prefixes[0]);
  if (lectureIds.size === 0) {
    for (const prefix of prefixes.slice(1)) {
      lectureIds = await listPrefixes(bucket, prefix);
      if (lectureIds.size > 0) {
        sourcePrefixUsed = prefix;
        break;
      }
    }
  }
  return { lectureIds: Array.from(lectureIds.values()).sort(), sourcePrefixUsed };
}

/**
 * Aggregate filtered question string counts and daily volumes for a lecture over a sliding window.
 *
 * @param opts - Aggregation inputs (bucket, lectureId, days, maxEvents).
 * @returns Aggregation payload with counts and truncation metadata.
 * @remarks Side effects: reads multiple R2 objects; stops early when maxEvents reached.
 */
export async function aggregateLectureAnalytics(opts: {
  bucket: R2Bucket;
  lectureId: string;
  days: number;
  maxEvents?: number;
}) {
  const { bucket, lectureId } = opts;
  const { id: safeLectureId } = sanitizeLectureId(lectureId || "unknown-lecture");
  const days = Math.max(1, Math.min(365, Math.floor(opts.days || 30)));
  const maxEvents = Math.max(1, opts.maxEvents ?? 2000);
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const prefixes = [`${ANALYTICS_EVENT_PREFIX}${safeLectureId}/`];
  const strings = new Map<string, number>();
  const topics = new Map<string, CanonicalTopicEntry>();
  const byDay = new Map<string, number>();
  let totalEvents = 0;
  let readEvents = 0;
  let truncated = false;
  let cursor: string | undefined;
  let sourcePrefixUsed: string | null = null;
  let lastUpdated: string | null = null;
  let lastQuestion: string | null = null;
  let lastCleanedQuestion: string | null = null;
  let lastQuestionTs: string | null = null;

  const shouldIncludeDate = (isoDate: string | null) => {
    if (!isoDate) return false;
    const ms = Date.parse(isoDate);
    if (Number.isNaN(ms)) return false;
    return ms >= sinceMs;
  };

  const addCounts = (list: unknown[], map: Map<string, number>) => {
    list.forEach(item => {
      const normalized = normalizeFilteredString(item);
      if (!normalized) return;
      map.set(normalized, (map.get(normalized) || 0) + 1);
    });
  };

  const addCanonicalTopic = (cleanedPrompt: string, eventTs: string | null) => {
    const canonicalKey = buildCanonicalPromptKey(cleanedPrompt);
    if (!canonicalKey) return;
    const aliases = buildPromptAliases(cleanedPrompt, 5);
    const existing = topics.get(canonicalKey);
    const mergedAliases = mergeAliasList(existing?.aliases ?? [], aliases, 5);
    const displayPhrase = selectDisplayPhrase(mergedAliases, existing?.displayPhrase || cleanedPrompt);
    const count = (existing?.count ?? 0) + 1;
    const lastSeenAt = eventTs && (!existing?.lastSeenAt || eventTs > existing.lastSeenAt)
      ? eventTs
      : existing?.lastSeenAt;
    topics.set(canonicalKey, {
      count,
      displayPhrase,
      aliases: mergedAliases,
      lastSeenAt: lastSeenAt || undefined,
    });
  };

  for (const prefix of prefixes) {
    cursor = undefined;
    do {
      const page = await bucket.list({ prefix, cursor, limit: 500 });
      if ((page.objects || []).length === 0 && (page.delimitedPrefixes || []).length === 0) {
        cursor = page.truncated ? page.cursor : undefined;
        continue;
      }
      sourcePrefixUsed = sourcePrefixUsed || prefix;
      for (const obj of page.objects || []) {
        if (readEvents >= maxEvents) {
          truncated = true;
          break;
        }
        const isoDate = parseDateFromKey(obj.key);
        if (!shouldIncludeDate(isoDate)) continue;
        const res = await bucket.get(obj.key);
        if (!res) continue;
        let parsed: OwenAnalyticsEventV1 | null = null;
        try {
          const text = await res.text();
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        if (!parsed || parsed.v !== 1 || parsed.mode !== "lecture_qa") continue;
        totalEvents += 1;
        readEvents += 1;
        const filteredList = Array.isArray(parsed.filteredStrings) ? parsed.filteredStrings : [];
        if (filteredList.length) {
          addCounts(filteredList, strings);
        } else {
          const derived = buildFilteredString(parsed.question, MAX_TAGS);
          if (derived) addCounts([derived], strings);
        }
        const eventTs = typeof parsed.ts === "string" ? parsed.ts : null;
        const cleanedPrompt =
          typeof parsed.cleanedPrompt === "string"
            ? parsed.cleanedPrompt
            : cleanPromptPreserveOrder(parsed.question || "");
        if (cleanedPrompt) addCanonicalTopic(cleanedPrompt, eventTs);
        const dateKey = (parsed.ts || isoDate || "").slice(0, 10);
        if (dateKey) {
          byDay.set(dateKey, (byDay.get(dateKey) || 0) + 1);
        }
        if (eventTs && (!lastUpdated || eventTs > lastUpdated)) lastUpdated = eventTs;
        if (eventTs && (!lastQuestionTs || eventTs > lastQuestionTs)) {
          lastQuestionTs = eventTs;
          lastQuestion = typeof parsed.question === "string" ? parsed.question : null;
          const cleanedCandidate = typeof parsed.cleanedPrompt === "string" ? parsed.cleanedPrompt : "";
          const fallbackCleaned = cleanedCandidate || cleanPromptPreserveOrder(lastQuestion || "");
          lastCleanedQuestion = fallbackCleaned || null;
        }
        if (readEvents >= maxEvents) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    if (readEvents > 0 || truncated) break; // stop if found data in primary or hit limit
  }

  const topStrings = sortCounts(strings, 25).map(entry => ({ text: entry.key, count: entry.count }));
  const topTopics = Array.from(topics.entries())
    .map(([key, entry]) => ({
      key,
      text: entry.displayPhrase,
      count: entry.count,
      aliases: entry.aliases,
      lastSeenAt: entry.lastSeenAt,
    }))
    .sort((a, b) => {
      const delta = b.count - a.count;
      return delta !== 0 ? delta : a.text.localeCompare(b.text);
    })
    .slice(0, 15);
  const byDayArr = Array.from(byDay.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    lectureId,
    days,
    totalEvents,
    strings: topStrings,
    topics: topTopics,
    lastQuestion,
    lastCleanedQuestion,
    byDay: byDayArr,
    lastUpdated,
    truncated,
    sourcePrefixUsed: sourcePrefixUsed || prefixes[0],
  };
}

function sanitizeTopEntries(list: any[]): TopTagEntry[] {
  if (!Array.isArray(list)) return [];
  return list
    .map(item => {
      if (!item) return null;
      const tag = normalizeLabel((item as any).tag ?? (item as any).label ?? (item as any).key);
      const countRaw = (item as any).count ?? (item as any).value ?? (item as any).hits;
      const count = typeof countRaw === "number" ? Math.max(0, Math.floor(countRaw)) : Number.isFinite(Number(countRaw)) ? Math.max(0, Math.floor(Number(countRaw))) : null;
      if (!tag || count === null) return null;
      return { tag, count };
    })
    .filter((v): v is TopTagEntry => Boolean(v));
}

async function loadPreAggregatedTopTags(bucket: R2Bucket, key: string, limit: number) {
  const res = await bucket.get(key);
  if (!res) return null;
  let payload: any = null;
  try {
    payload = await res.json();
  } catch {
    return null;
  }
  const shape = detectAnalyticsShape(payload);
  if (shape.schema === "aggregate_counts" && shape.tagCounts) {
    const map = new Map<string, number>();
    for (const [k, v] of Object.entries(shape.tagCounts)) {
      const tag = normalizeLabel(k);
      const count = typeof v === "number" ? v : Number(v);
      if (!tag || !Number.isFinite(count)) continue;
      map.set(tag, (map.get(tag) || 0) + Math.max(0, Math.floor(count)));
    }
    return {
      top: sortCounts(map, Math.max(limit, DEFAULT_TOP_TAG_LIMIT)).map(entry => ({ tag: entry.key, count: entry.count })),
      updatedAt: shape.updatedAt || payload?.updatedAt || payload?.computedAt || new Date().toISOString(),
      limitComputed: Math.max(limit, DEFAULT_TOP_TAG_LIMIT),
      keysRead: 1,
    };
  }
  if (shape.schema === "top_list" && shape.topList) {
    const top = sanitizeTopEntries(shape.topList).slice(0, Math.max(limit, DEFAULT_TOP_TAG_LIMIT));
    return {
      top,
      updatedAt: shape.updatedAt || payload?.updatedAt || payload?.computedAt || new Date().toISOString(),
      limitComputed: Math.max(limit, DEFAULT_TOP_TAG_LIMIT),
      keysRead: 1,
    };
  }
  return null;
}

async function aggregateTopTagsFromEvents(bucket: R2Bucket, prefix: string, limit: number, maxEvents: number) {
  const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const tags = new Map<string, number>();
  let keysRead = 0;
  let parsed = 0;
  let truncated = false;
  let cursor: string | undefined;
  let latestUpdated: string | null = null;

  do {
    const page = await bucket.list({ prefix: normalizedPrefix, cursor, limit: 500 });
    for (const obj of page.objects || []) {
      if (parsed >= maxEvents) {
        truncated = true;
        break;
      }
      keysRead += 1;
      const res = await bucket.get(obj.key);
      if (!res) continue;
      let payload: any = null;
      try {
        payload = await res.json();
      } catch {
        continue;
      }
      const shape = detectAnalyticsShape(payload);
      if (shape.updatedAt) {
        if (!latestUpdated || shape.updatedAt > latestUpdated) latestUpdated = shape.updatedAt;
      }
      if (shape.schema === "aggregate_counts" && shape.tagCounts) {
        for (const [k, v] of Object.entries(shape.tagCounts)) {
          const tag = normalizeLabel(k);
          const count = typeof v === "number" ? v : Number(v);
          if (!tag || !Number.isFinite(count)) continue;
          tags.set(tag, (tags.get(tag) || 0) + Math.max(0, Math.floor(count)));
        }
        parsed += 1;
      } else if (shape.schema === "top_list" && shape.topList) {
        for (const item of shape.topList) {
          const tag = normalizeLabel(item.tag);
          const count = typeof item.count === "number" ? item.count : Number(item.count);
          if (!tag || !Number.isFinite(count)) continue;
          tags.set(tag, (tags.get(tag) || 0) + Math.max(0, Math.floor(count)));
        }
        parsed += 1;
      } else {
        const tagList = Array.isArray(shape.tags) ? shape.tags : Array.isArray(payload?.tags) ? payload.tags : [];
        if (tagList.length) {
          tagList.forEach(tag => {
            const norm = normalizeLabel(tag);
            if (!norm) return;
            tags.set(norm, (tags.get(norm) || 0) + 1);
          });
        }
        parsed += 1;
      }
      if (parsed >= maxEvents) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const top = sortCounts(tags, Math.max(limit, DEFAULT_TOP_TAG_LIMIT)).map(entry => ({ tag: entry.key, count: entry.count }));
  return {
    top,
    keysRead,
    limitComputed: Math.max(limit, DEFAULT_TOP_TAG_LIMIT),
    updatedAt: latestUpdated || new Date().toISOString(),
    truncated,
  };
}

/**
 * Aggregate most-asked questions for a lecture by scanning its per-lecture folder only.
 * Caps object reads to avoid excessive traversal in large prefixes (default maxObjects = 900).
 */
async function aggregateQuestionsFromEvents(opts: { bucket: R2Bucket; prefix: string; limit: number; maxObjects: number }) {
  const { bucket, limit } = opts;
  const prefix = opts.prefix.endsWith("/") ? opts.prefix : `${opts.prefix}/`;
  const counts = new Map<string, number>();
  let cursor: string | undefined;
  let keysRead = 0;
  let totalEvents = 0;
  let truncated = false;
  let lastUpdated: string | null = null;

  do {
    const page = await bucket.list({ prefix, cursor, limit: 500 });
    for (const obj of page.objects || []) {
      if (keysRead >= opts.maxObjects) {
        truncated = true;
        break;
      }
      keysRead += 1;
      const res = await bucket.get(obj.key);
      if (!res) continue;
      let payload: any = null;
      try {
        payload = await res.json();
      } catch {
        continue;
      }
      const q = normalizeQuestion(payload?.question);
      if (!q) continue;
      counts.set(q, (counts.get(q) || 0) + 1);
      totalEvents += 1;
      const ts = typeof payload?.ts === "string" ? payload.ts : null;
      if (ts && (!lastUpdated || ts > lastUpdated)) lastUpdated = ts;
      if (keysRead >= opts.maxObjects) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const top = Array.from(counts.entries())
    .map(([question, count]) => ({ question, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

  return { top, keysRead, totalEvents, lastUpdated, truncated };
}

async function readCachedTopTags(opts: { bucket: R2Bucket; cacheKey: string; limit: number; cacheTtlSeconds?: number; expectedDocId: string }) {
  const { bucket, cacheKey, limit, cacheTtlSeconds, expectedDocId } = opts;
  const res = await bucket.get(cacheKey);
  if (!res) return null;
  try {
    const payload = JSON.parse(await res.text());
    if (payload?.docId !== expectedDocId) return null;
    const top = sanitizeTopEntries(payload.top).slice(0, limit);
    if (!top.length) return null;
    const updatedAtStr = payload.updatedAt || payload.computedAt;
    const updatedAtMs = updatedAtStr ? Date.parse(updatedAtStr) : NaN;
    const ageSeconds = Number.isFinite(updatedAtMs) ? Math.floor((Date.now() - updatedAtMs) / 1000) : null;
    const ttl = Math.max(10, Math.min(300, Math.floor(payload.maxAgeSeconds ?? cacheTtlSeconds ?? 45)));
    if (ageSeconds !== null && ageSeconds > ttl) return null;
    return {
      docId: payload.docId,
      lectureKey: payload.lectureKey || payload.source?.lectureKey || "",
      updatedAt: updatedAtStr || new Date().toISOString(),
      limitComputed: payload.limitComputed || top.length,
      top,
      source: {
        prefix: payload?.source?.prefix || ANALYTICS_BASE_PREFIXES[0],
        schema: payload?.source?.schema || "unknown",
        lectureKey: payload?.source?.lectureKey || payload.lectureKey || "",
        keysRead: payload?.source?.keysRead ?? 0,
        sampleKey: payload?.source?.sampleKey ?? null,
        cached: true,
        cacheKey,
        cacheAgeSeconds: ageSeconds ?? undefined,
        truncated: payload?.source?.truncated ?? false,
      },
    } as TopTagsAggregate;
  } catch {
    return null;
  }
}

async function writeCachedTopTags(bucket: R2Bucket, cacheKey: string, aggregate: TopTagsAggregate, cacheTtlSeconds?: number) {
  const maxAgeSeconds = Math.max(10, Math.min(300, Math.floor(cacheTtlSeconds ?? 45)));
  const payload = { ...aggregate, maxAgeSeconds };
  try {
    await bucket.put(cacheKey, JSON.stringify(payload), {
      httpMetadata: { contentType: "application/json" },
    });
  } catch (err) {
    console.warn("[ANALYTICS_CACHE_WRITE_FAILED]", { cacheKey, error: err instanceof Error ? err.message : String(err) });
  }
}

function normalizeQuestion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized || null;
}

async function readCachedQuestionsAggregate(opts: { bucket: R2Bucket; cacheKey: string; lectureId: string; limit: number; cacheTtlSeconds?: number }) {
  const { bucket, cacheKey, lectureId, limit, cacheTtlSeconds } = opts;
  const res = await bucket.get(cacheKey);
  if (!res) return null;
  try {
    const payload = JSON.parse(await res.text());
    if (payload?.lectureId !== lectureId) return null;
    const topRaw = Array.isArray(payload?.top) ? payload.top : [];
    const top = topRaw
      .map((item: any) => {
        const question = normalizeQuestion((item as any).question ?? (item as any).label);
        const count = typeof item?.count === "number" ? Math.floor(item.count) : Number(item?.count);
        if (!question || !Number.isFinite(count)) return null;
        return { question, count: Math.max(0, count) };
      })
      .filter((v: any): v is TopQuestionEntry => Boolean(v))
      .slice(0, limit);
    if (!top.length) return null;
    const updated = payload?.lastUpdated;
    const updatedMs = updated ? Date.parse(updated) : NaN;
    const ageSeconds = Number.isFinite(updatedMs) ? Math.floor((Date.now() - updatedMs) / 1000) : null;
    const ttl = Math.max(10, Math.min(300, Math.floor(payload?.maxAgeSeconds ?? cacheTtlSeconds ?? 30)));
    if (ageSeconds !== null && ageSeconds > ttl) return null;
    return {
      lectureId,
      lectureKey: payload?.lectureKey || payload?.source?.lectureKey || "",
      totalEvents: payload?.totalEvents ?? 0,
      top,
      lastUpdated: updated || null,
      source: {
        prefix: payload?.source?.prefix || ANALYTICS_BASE_PREFIXES[0],
        lectureKey: payload?.source?.lectureKey || payload?.lectureKey || "",
        keysRead: payload?.source?.keysRead ?? payload?.keysRead ?? 0,
        cached: true,
        cacheKey,
        cacheAgeSeconds: ageSeconds ?? undefined,
        truncated: payload?.source?.truncated ?? false,
      },
    } as QuestionsAggregate;
  } catch {
    return null;
  }
}

async function writeCachedQuestionsAggregate(bucket: R2Bucket, cacheKey: string, aggregate: QuestionsAggregate, cacheTtlSeconds?: number) {
  const maxAgeSeconds = Math.max(10, Math.min(300, Math.floor(cacheTtlSeconds ?? 30)));
  const payload = { ...aggregate, maxAgeSeconds };
  try {
    await bucket.put(cacheKey, JSON.stringify(payload), {
      httpMetadata: { contentType: "application/json" },
    });
  } catch (err) {
    console.warn("[ANALYTICS_CACHE_WRITE_FAILED]", { cacheKey, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Aggregate the top lecture tags for a docId, preferring pre-aggregated JSON if present.
 *
 * @param opts - Aggregation inputs and cache settings.
 * @returns Top-tags aggregate or null when no data is found.
 * @remarks Side effects: reads/writes R2 cache objects.
 */
export async function loadTopTagsForLecture(opts: {
  bucket: R2Bucket;
  docId: string;
  lectureTitle?: string | null;
  limit?: number;
  maxEvents?: number;
  cacheTtlSeconds?: number;
}): Promise<TopTagsAggregate | null> {
  const { bucket, docId } = opts;
  if (!docId) return null;
  const limit = Math.max(1, Math.min(opts.limit ?? 10, DEFAULT_TOP_TAG_LIMIT));
  const maxEvents = Math.max(limit * 10, Math.min(4000, opts.maxEvents ?? 1500));
  const cacheKey = buildAnalyticsAggregateKey(docId);

  const cached = await readCachedTopTags({
    bucket,
    cacheKey,
    limit,
    cacheTtlSeconds: opts.cacheTtlSeconds,
    expectedDocId: docId,
  });
  if (cached) return cached;

  const layout = await discoverAnalyticsLayout(bucket, docId, opts.lectureTitle);
  if (!layout) return null;

  let aggregate: TopTagsAggregate | null = null;

  if (layout.sampleKey && (layout.schema === "aggregate_counts" || layout.schema === "top_list")) {
    const preAgg = await loadPreAggregatedTopTags(bucket, layout.sampleKey, limit);
    if (preAgg) {
      aggregate = {
        docId,
        lectureKey: layout.lectureKey,
        updatedAt: preAgg.updatedAt,
        limitComputed: preAgg.limitComputed,
        top: preAgg.top.slice(0, limit),
        source: {
          prefix: layout.prefixUsed,
          schema: layout.schema,
          lectureKey: layout.lectureKey,
          keysRead: preAgg.keysRead,
          sampleKey: layout.sampleKey,
          truncated: false,
        },
      };
    }
  }

  if (!aggregate) {
    const agg = await aggregateTopTagsFromEvents(bucket, `${layout.prefixUsed}${layout.lectureKey}`, limit, maxEvents);
    aggregate = {
      docId,
      lectureKey: layout.lectureKey,
      updatedAt: agg.updatedAt,
      limitComputed: agg.limitComputed,
      top: agg.top.slice(0, limit),
      source: {
        prefix: layout.prefixUsed,
        schema: layout.schema === "unknown" ? "event_v1" : layout.schema,
        lectureKey: layout.lectureKey,
        keysRead: agg.keysRead,
        sampleKey: layout.sampleKey,
        truncated: agg.truncated,
      },
    };
  }

  if (aggregate) {
    await writeCachedTopTags(bucket, cacheKey, { ...aggregate, source: { ...aggregate.source, cached: false, cacheKey } }, opts.cacheTtlSeconds);
  }

  return aggregate;
}

/**
 * Aggregate top questions for a lecture using per-event `question` field as signal.
 *
 * @param opts - Aggregation inputs and cache settings.
 * @returns Top-questions aggregate or null when no data is found.
 * @remarks Side effects: reads/writes R2 cache objects.
 */
export async function loadTopQuestionsForLecture(opts: {
  bucket: R2Bucket;
  lectureId: string;
  lectureTitle?: string | null;
  limit?: number;
  maxObjects?: number;
  cacheTtlSeconds?: number;
}): Promise<QuestionsAggregate | null> {
  const { bucket, lectureId } = opts;
  if (!lectureId) return null;
  const limit = Math.max(1, Math.min(25, Math.floor(opts.limit ?? 10)));
  const maxObjects = Math.max(limit * 10, Math.min(2000, Math.floor(opts.maxObjects ?? 900))); // safeguard: cap R2 reads per request
  const cacheKey = buildQuestionsAggregateKey(lectureId);

  const cached = await readCachedQuestionsAggregate({
    bucket,
    cacheKey,
    lectureId,
    limit,
    cacheTtlSeconds: opts.cacheTtlSeconds,
  });
  if (cached) return cached;

  const { id: safeLectureId } = sanitizeLectureId(lectureId || "unknown-lecture");
  const prefixUsed = ANALYTICS_EVENT_PREFIX;
  const lectureKeyUsed = safeLectureId;
  const prefix = `${prefixUsed}${lectureKeyUsed}/`;
  const page = await bucket.list({ prefix, limit: 1 });
  if ((page.objects || []).length === 0) return null;

  const agg = await aggregateQuestionsFromEvents({
    bucket,
    prefix,
    limit,
    maxObjects,
  });

  if (!agg.top.length) return null;

  const aggregate: QuestionsAggregate = {
    lectureId,
    lectureKey: lectureKeyUsed,
    totalEvents: agg.totalEvents,
    top: agg.top,
    lastUpdated: agg.lastUpdated || new Date().toISOString(),
    source: {
      prefix: prefixUsed,
      lectureKey: lectureKeyUsed,
      keysRead: agg.keysRead,
      truncated: agg.truncated,
    },
  };

  await writeCachedQuestionsAggregate(bucket, cacheKey, { ...aggregate, source: { ...aggregate.source, cacheKey, cached: false } }, opts.cacheTtlSeconds);
  return aggregate;
}
