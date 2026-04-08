import type { AnswerSegment, FreeResponseWarning, UrlCitationAnnotation } from "./types";

export function stripInlineCitationMarkers(text: string): string {
  if (!text) return "";
  return text
    .replace(/(\w)[ \t]*\[(\d+)\][ \t]*(\w)/g, "$1 $3")
    .replace(/[ \t]*\[(\d+)\]/g, "")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ");
}

export function stripCitationMarkersFromSegments(segments: AnswerSegment[]): AnswerSegment[] {
  const sanitized = (segments || [])
    .filter((seg): seg is Extract<AnswerSegment, { type: "text" }> => Boolean(seg) && seg.type === "text")
    .map((seg) => stripInlineCitationMarkers(seg.text))
    .filter((text) => text.trim().length > 0)
    .map((text) => ({ type: "text" as const, text }));
  return sanitized;
}

export function getSegmentTextLength(segments: AnswerSegment[]): number {
  return segments.reduce((total, segment) => total + (segment.type === "text" ? segment.text.trim().length : 0), 0);
}

export function ensureNonEmptySegments(
  segments: AnswerSegment[],
  warnings?: FreeResponseWarning[],
): { answerSegments: AnswerSegment[]; warnings?: FreeResponseWarning[] } {
  if (getSegmentTextLength(segments) > 0) return { answerSegments: segments, warnings };
  const nextWarnings = warnings ? [...warnings] : [];
  nextWarnings.push({
    code: "EMPTY_RESPONSE_FALLBACK",
    message: "Model returned an empty response; returning placeholder.",
  });
  return {
    answerSegments: [{ type: "text", text: "(empty response)" }],
    warnings: nextWarnings,
  };
}

export function segmentWithCitationPills(
  text: string,
  urlCitations: UrlCitationAnnotation[],
  state?: { urlToId?: Map<string, number>; urlMeta?: Map<string, { title?: string }>; nextId?: number },
): { segments: AnswerSegment[]; urlToId: Map<string, number>; urlMeta: Map<string, { title?: string }>; nextId: number } {
  const segments: AnswerSegment[] = [];
  const urlToId = state?.urlToId ?? new Map<string, number>();
  const urlMeta = state?.urlMeta ?? new Map<string, { title?: string }>();
  let nextId = state?.nextId ?? 1;
  const citations = Array.isArray(urlCitations) ? [...urlCitations] : [];

  citations.sort((a, b) => a.start_index - b.start_index);
  let cursor = 0;

  citations.forEach((cite) => {
    if (!cite || !cite.url) return;
    const start = Math.max(0, cite.start_index);
    const end = Math.min(text.length, cite.end_index);
    if (end <= start) return;
    if (start < cursor) return;
    if (start > text.length) return;
    if (start > cursor) {
      segments.push({ type: "text", text: text.slice(cursor, start) });
    }
    let id = urlToId.get(cite.url);
    if (!id) {
      id = nextId;
      nextId += 1;
      urlToId.set(cite.url, id);
    }
    if (!urlMeta.has(cite.url)) {
      urlMeta.set(cite.url, { title: cite.title });
    } else if (!urlMeta.get(cite.url)?.title && cite.title) {
      urlMeta.set(cite.url, { title: cite.title });
    }
    segments.push({ type: "citation", id, url: cite.url, title: cite.title || urlMeta.get(cite.url)?.title });
    cursor = end;
  });

  if (cursor < text.length) {
    segments.push({ type: "text", text: text.slice(cursor) });
  }

  return { segments, urlToId, urlMeta, nextId };
}
