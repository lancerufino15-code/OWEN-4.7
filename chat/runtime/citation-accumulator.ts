import type { AnswerSegment, CitationSource } from "../types";
import {
  buildCitedAnswerPayload,
  extractCitationSnapshot,
  extractWebSearchSources,
  normalizeSourceKey,
  normalizeWebSearchSources,
} from "./provider";

type SourceEntry = {
  key: string;
  url: string;
  id?: number;
  title?: string;
  domain?: string;
  snippet?: string;
  retrievedAt?: number;
};

function pickRicherText(current?: string, next?: string): string | undefined {
  const currentValue = typeof current === "string" ? current.trim() : "";
  const nextValue = typeof next === "string" ? next.trim() : "";
  if (!currentValue) return nextValue || undefined;
  if (!nextValue) return currentValue || undefined;
  return nextValue.length > currentValue.length ? nextValue : currentValue;
}

function buildTextFromSegments(segments: AnswerSegment[]): string {
  return (segments || [])
    .map((segment) => (segment.type === "text" ? segment.text : ""))
    .join("")
    .trim();
}

function mergeAdjacentTextSegments(segments: AnswerSegment[]): AnswerSegment[] {
  const merged: AnswerSegment[] = [];
  for (const segment of segments || []) {
    if (!segment) continue;
    const last = merged[merged.length - 1];
    if (segment.type === "text" && last?.type === "text") {
      last.text += segment.text;
      continue;
    }
    merged.push({ ...segment });
  }
  return merged;
}

export class CitationAccumulator {
  private readonly sourceMap = new Map<string, SourceEntry>();
  private readonly searchOrder: string[] = [];
  private readonly citedOrder: string[] = [];
  private readonly consultedMap = new Map<string, unknown>();
  private readonly emittedSourceKeys = new Set<string>();

  private stableText = "";
  private stableSegments: AnswerSegment[] = [];
  private answerSegments: AnswerSegment[] = [];
  private answerText = "";
  private canonicalized = false;

  appendStableText(text: string) {
    if (!text) return;
    this.stableText += text;
    if (!this.answerSegments.length) {
      this.stableSegments.push({ type: "text", text });
    }
  }

  mergeSearchSources(rawSources: unknown[]): CitationSource[] {
    const normalized = normalizeWebSearchSources(rawSources);
    normalized.forEach((source, index) => {
      const key = source.key || normalizeSourceKey(source.url);
      this.upsertSource(
        {
          key,
          url: source.url,
          title: source.title,
          domain: source.domain,
          snippet: source.snippet,
          retrievedAt: source.retrievedAt,
        },
        { preferCited: false },
      );
      if (!this.consultedMap.has(key)) {
        this.consultedMap.set(key, rawSources[index]);
      }
    });
    return this.drainNewSources();
  }

  mergeProviderPayload(raw: any): CitationSource[] {
    if (!raw) return [];
    this.mergeSearchSources(extractWebSearchSources(raw));
    const snapshot = extractCitationSnapshot(raw);
    if (!snapshot) return this.drainNewSources();
    const cited = buildCitedAnswerPayload(raw);
    if (cited.sources.length || cited.answerSegments.length) {
      this.applyCitedPayload(cited);
    }
    return this.drainNewSources();
  }

  setAnswerSegments(segments: AnswerSegment[], answerText = buildTextFromSegments(segments)) {
    this.answerSegments = mergeAdjacentTextSegments(segments);
    this.answerText = answerText;
    this.canonicalized = true;
  }

  getSourceCount(): number {
    return this.materializeSources().length;
  }

  getStableTextLength(): number {
    return (this.answerText || this.stableText).trim().length;
  }

  drainNewSources(): CitationSource[] {
    if (!this.canonicalized) return [];
    const next = this.materializeSources().filter((source) => !this.emittedSourceKeys.has(normalizeSourceKey(source.url)));
    next.forEach((source) => this.emittedSourceKeys.add(normalizeSourceKey(source.url)));
    return next;
  }

  finalize(): {
    answerText: string;
    answerSegments: AnswerSegment[];
    sources: CitationSource[];
    consultedSources: unknown[];
  } {
    if (!this.canonicalized) {
      this.canonicalizeSourceIds();
      this.canonicalized = true;
    }
    const sources = this.materializeSources();
    const answerSegments = this.answerSegments.length
      ? mergeAdjacentTextSegments(this.answerSegments)
      : mergeAdjacentTextSegments(this.stableSegments.length ? this.stableSegments : this.stableText ? [{ type: "text", text: this.stableText }] : []);
    const answerText = (this.answerText || buildTextFromSegments(answerSegments) || this.stableText).trim();
    return {
      answerText,
      answerSegments,
      sources,
      consultedSources: Array.from(this.consultedMap.values()).filter(Boolean),
    };
  }

  private applyCitedPayload(payload: ReturnType<typeof buildCitedAnswerPayload>) {
    const sourceKeyById = new Map<number, string>();
    payload.sources.forEach((source) => {
      const key = normalizeSourceKey(source.url);
      sourceKeyById.set(source.id, key);
      this.upsertSource(
        {
          key,
          url: source.url,
          title: source.title,
          domain: source.domain,
          snippet: source.snippet,
          retrievedAt: source.retrievedAt,
        },
        { preferCited: true },
      );
    });
    this.canonicalizeSourceIds();
    const canonicalSources = this.materializeSources();
    const canonicalIdByKey = new Map(canonicalSources.map((source) => [normalizeSourceKey(source.url), source.id]));
    const remapped = payload.answerSegments.map((segment) => {
      if (segment.type !== "citation") return segment;
      const sourceKey = segment.url ? normalizeSourceKey(segment.url) : sourceKeyById.get(segment.id);
      const canonicalId = sourceKey ? canonicalIdByKey.get(sourceKey) : undefined;
      if (!canonicalId) return segment;
      return { ...segment, id: canonicalId };
    });
    this.answerSegments = mergeAdjacentTextSegments(remapped);
    this.answerText = payload.answerText || buildTextFromSegments(this.answerSegments);
    this.canonicalized = true;
  }

  private upsertSource(source: SourceEntry, opts: { preferCited: boolean }) {
    const key = source.key || normalizeSourceKey(source.url);
    if (!key || !source.url) return;
    const existing = this.sourceMap.get(key);
    if (existing) {
      existing.title = pickRicherText(existing.title, source.title);
      existing.domain = pickRicherText(existing.domain, source.domain);
      existing.snippet = pickRicherText(existing.snippet, source.snippet);
      existing.retrievedAt = Math.max(existing.retrievedAt || 0, source.retrievedAt || 0) || undefined;
    } else {
      this.sourceMap.set(key, { ...source, key });
    }
    if (!this.searchOrder.includes(key)) {
      this.searchOrder.push(key);
    }
    if (opts.preferCited && !this.citedOrder.includes(key)) {
      this.citedOrder.push(key);
    }
  }

  private canonicalizeSourceIds() {
    const orderedKeys = [...this.citedOrder, ...this.searchOrder, ...Array.from(this.sourceMap.keys())]
      .filter((key, index, values) => values.indexOf(key) === index);
    orderedKeys.forEach((key, index) => {
      const entry = this.sourceMap.get(key);
      if (entry) entry.id = index + 1;
    });
  }

  private materializeSources(): CitationSource[] {
    this.canonicalizeSourceIds();
    return Array.from(this.sourceMap.values())
      .filter((entry): entry is SourceEntry & { id: number } => Number.isFinite(entry.id))
      .sort((a, b) => a.id - b.id)
      .map((entry) => ({
        id: entry.id,
        url: entry.url,
        title: entry.title,
        domain: entry.domain,
        snippet: entry.snippet,
        retrievedAt: entry.retrievedAt,
      }));
  }
}
