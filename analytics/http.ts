import type { Env } from "../../types";
import { requireAdmin, requireLectureAnalyticsRead } from "../runtime/authz";
import { jsonNoStore, readRequestJsonBody } from "../runtime/http";
import { aggregateLectureAnalytics, loadTopQuestionsForLecture } from "./analytics";

export function coerceLectureTags(raw: unknown) {
  const counts = new Map<string, number>();
  if (!Array.isArray(raw)) return [];
  raw.forEach((entry) => {
    if (typeof entry === "string") {
      const tag = entry.trim().toLowerCase();
      if (tag) counts.set(tag, (counts.get(tag) || 0) + 1);
      return;
    }
    if (entry && typeof entry === "object") {
      const tagRaw = typeof (entry as any).tag === "string" ? (entry as any).tag.trim().toLowerCase() : "";
      const count = typeof (entry as any).count === "number" ? Math.max(1, Math.floor((entry as any).count)) : 1;
      if (tagRaw) counts.set(tagRaw, (counts.get(tagRaw) || 0) + count);
    }
  });
  return Array.from(counts.entries()).map(([tag, count]) => ({ tag, count }));
}

export async function loadLectureAnalytics(env: Env, docId: string) {
  const fallback = {
    docId,
    strings: [],
    topics: [],
    last_question: null,
    last_cleaned_question: null,
    questions: [],
    updated_at: new Date().toISOString(),
    lastUpdated: null,
  };
  try {
    if (!env.OWEN_ANALYTICS) return fallback;
    const aggregate = await aggregateLectureAnalytics({
      bucket: env.OWEN_ANALYTICS,
      lectureId: docId,
      days: 365,
    });
    const topQuestions =
      await loadTopQuestionsForLecture({
        bucket: env.OWEN_ANALYTICS,
        lectureId: docId,
        limit: 10,
      }).catch(() => null);
    const updates = [aggregate.lastUpdated, topQuestions?.lastUpdated].filter(Boolean) as string[];
    const lastUpdated = updates.sort().slice(-1)[0] || null;
    return {
      docId,
      strings: aggregate.strings || [],
      topics: aggregate.topics || [],
      last_question: aggregate.lastQuestion || null,
      last_cleaned_question: aggregate.lastCleanedQuestion || null,
      questions: topQuestions?.top || [],
      updated_at: lastUpdated || new Date().toISOString(),
      lastUpdated,
    };
  } catch (err) {
    console.error("[ANALYTICS_READ_FAILED]", { docId, error: err instanceof Error ? err.message : String(err) });
    return fallback;
  }
}

export async function appendLectureAnalytics(env: Env, docId: string) {
  return loadLectureAnalytics(env, docId);
}

export async function handleLectureAnalyticsRead(req: Request, env: Env): Promise<Response> {
  const auth = await requireLectureAnalyticsRead(req, env, "lecture_analytics_read");
  if (!auth.ok) return auth.response;
  const url = new URL(req.url);
  const docId =
    url.searchParams.get("docId") ||
    url.searchParams.get("doc_id") ||
    url.searchParams.get("lectureId") ||
    "";
  if (!docId) {
    return jsonNoStore({ error: "Missing docId." }, 400);
  }
  return jsonNoStore(await loadLectureAnalytics(env, docId));
}

export async function handleAdminAnalyticsWrite(req: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(req, env, "admin_analytics");
  if (!admin.ok) return admin.response;
  const body = await readRequestJsonBody(req);
  if (!body || typeof body !== "object") {
    return jsonNoStore({ error: "Send JSON { docId }." }, 400);
  }
  const docId =
    typeof (body as any).docId === "string"
      ? (body as any).docId.trim()
      : typeof (body as any).doc_id === "string"
        ? (body as any).doc_id.trim()
        : typeof (body as any).lectureId === "string"
          ? (body as any).lectureId.trim()
          : "";
  if (!docId) {
    return jsonNoStore({ error: "Missing docId." }, 400);
  }
  return jsonNoStore(await appendLectureAnalytics(env, docId));
}

export const handleLectureAnalyticsReadRoute = handleLectureAnalyticsRead;
export const handleLectureAnalyticsWriteRoute = handleAdminAnalyticsWrite;
