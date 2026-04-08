import type { Env } from "../../../types";
import {
  extractChatCompletionContent,
  extractOutputText,
} from "../../runtime/openai";
import { extractOpenAIUsage, type NormalizedUsage } from "../../runtime/openai/usage";
import { resolveModelAdapter } from "../../runtime/model/adapter";
import { segmentWithCitationPills } from "../segments";
import type { AnswerSegment, ChatMessage, CitationSource, UrlCitationAnnotation } from "../types";
import type { ResponsesInputMessage } from "./types";

export type ProviderMode = "responses" | "chat_completions";

export interface ProviderMessageRequest {
  mode: ProviderMode;
  model: string;
  messages?: ChatMessage[];
  input?: ResponsesInputMessage[];
  instructions?: string;
  tools?: unknown[];
  tool_choice?: "auto" | "required";
  include?: string[];
  max_output_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  metadata?: Record<string, unknown>;
}

export interface ProviderSendResult {
  raw: any;
  text: string;
  finishReason?: string;
  status?: string;
  outputTokens?: number;
  incompleteReason?: string;
  usage: NormalizedUsage | null;
}

export type ProviderStreamChunk =
  | { type: "delta"; text: string; raw?: any }
  | {
      type: "final";
      text: string;
      raw?: any;
      finishReason?: string;
      status?: string;
      outputTokens?: number;
      incompleteReason?: string;
      usage?: NormalizedUsage | null;
    };

export type ProviderStreamFrame = {
  eventName?: string;
  payload: any;
};

export interface ChatProvider {
  sendMessage(request: ProviderMessageRequest): Promise<ProviderSendResult>;
  streamMessage(request: ProviderMessageRequest): AsyncGenerator<ProviderStreamChunk>;
}

type WebSearchSource = {
  url: string;
  title?: string;
  domain: string;
  key: string;
  snippet?: string;
  retrievedAt?: number;
};

function buildRequestBody(request: ProviderMessageRequest, stream: boolean): Record<string, unknown> {
  if (request.mode === "responses") {
    const payload: Record<string, unknown> = {
      model: request.model,
      input: request.input || [],
      stream,
    };
    if (request.instructions) payload.instructions = request.instructions;
    if (request.tools) payload.tools = request.tools;
    if (request.tool_choice) payload.tool_choice = request.tool_choice;
    if (request.include) payload.include = request.include;
    if (typeof request.max_output_tokens === "number") payload.max_output_tokens = request.max_output_tokens;
    if (typeof request.temperature === "number") payload.temperature = request.temperature;
    if (typeof request.top_p === "number") payload.top_p = request.top_p;
    if (request.metadata) payload.metadata = request.metadata;
    return payload;
  }

  const payload: Record<string, unknown> = {
    model: request.model,
    messages: request.messages || [],
    stream,
  };
  if (typeof request.max_completion_tokens === "number") {
    payload.max_completion_tokens = request.max_completion_tokens;
  } else if (typeof request.max_output_tokens === "number") {
    payload.max_completion_tokens = request.max_output_tokens;
  }
  if (typeof request.temperature === "number") payload.temperature = request.temperature;
  if (typeof request.top_p === "number") payload.top_p = request.top_p;
  return payload;
}

function extractFinishReason(payload: any): string | undefined {
  return (
    payload?.choices?.[0]?.finish_reason ||
    payload?.response?.output?.[0]?.finish_reason ||
    payload?.output?.[0]?.finish_reason ||
    payload?.response?.stop_reason ||
    payload?.stop_reason ||
    payload?.response?.incomplete_details?.reason ||
    payload?.incomplete_details?.reason ||
    undefined
  );
}

function extractResponseStatus(payload: any): string | undefined {
  return payload?.response?.status || payload?.status || undefined;
}

function extractOutputTokens(payload: any): number | undefined {
  const usage = extractOpenAIUsage(payload);
  return usage.outputTokens || undefined;
}

function extractIncompleteReason(payload: any): string | undefined {
  return payload?.incomplete_details?.reason || payload?.response?.incomplete_details?.reason || undefined;
}

function textFromParts(value: any): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("");
}

function extractStreamDeltaText(payload: any): string {
  if (!payload) return "";
  if (Array.isArray(payload.choices)) {
    const collected = payload.choices
      .map((choice: any) => textFromParts(choice?.delta?.content || choice?.delta?.text))
      .filter(Boolean)
      .join("");
    if (collected) return collected;
  }
  if (typeof payload.output_text_delta === "string") return payload.output_text_delta;
  if (typeof payload.delta === "string") return payload.delta;
  if (typeof payload.delta?.text === "string") return payload.delta.text;
  if (typeof payload.delta?.content === "string") return payload.delta.content;
  return textFromParts(payload.delta?.content ?? payload.delta);
}

function extractStreamFinalText(payload: any, eventName?: string): string {
  if (!payload) return "";
  if (eventName === "response.completed" || payload?.type === "response.completed") {
    return extractOutputText(payload).trim();
  }
  if (typeof payload.output_text === "string") return payload.output_text;
  if (typeof payload.response?.output_text === "string") return payload.response.output_text;
  return "";
}

function buildAdapterLabel(request: ProviderMessageRequest, phase: "json" | "stream"): string {
  const modeLabel = typeof request.metadata?.owen_mode === "string" ? String(request.metadata.owen_mode).trim() : "";
  return `chat-provider:${request.mode}:${phase}:${modeLabel || request.model}`;
}

export async function* streamProviderFrames(
  env: Env,
  request: ProviderMessageRequest,
): AsyncGenerator<ProviderStreamFrame> {
  const adapter = resolveModelAdapter(env);
  const payload = buildRequestBody(request, true);
  for await (const frame of adapter.streamFrames({
    endpoint: request.mode,
    payload,
    label: buildAdapterLabel(request, "stream"),
  })) {
    yield frame;
  }
}

export function createChatProvider(env: Env): ChatProvider {
  return {
    async sendMessage(request) {
      const adapter = resolveModelAdapter(env);
      return adapter.send({
        endpoint: request.mode,
        payload: buildRequestBody(request, false),
        label: buildAdapterLabel(request, "json"),
      });
    },
    async *streamMessage(request) {
      let accumulatedText = "";
      let finalText = "";
      let finalRaw: any = null;
      let finishReason: string | undefined;
      let status: string | undefined;
      let outputTokens: number | undefined;
      let incompleteReason: string | undefined;
      let usage: NormalizedUsage | null = null;

      const handlePayload = (eventName: string | undefined, payload: any): ProviderStreamChunk | null => {
        if (payload?.error || payload?.type === "response.error") {
          throw new Error(payload.error?.message || payload.error || "OpenAI stream failed.");
        }
        const delta = extractStreamDeltaText(payload);
        if (delta) {
          accumulatedText += delta;
        }
        const finalCandidate = extractStreamFinalText(payload, eventName);
        if (finalCandidate && finalCandidate.length >= finalText.length) {
          finalText = finalCandidate;
          finalRaw = payload;
        }
        if (eventName === "response.completed" || payload?.type === "response.completed") {
          finalRaw = payload;
        }
        finishReason = extractFinishReason(payload) || finishReason;
        status = extractResponseStatus(payload) || status;
        outputTokens = extractOutputTokens(payload) ?? outputTokens;
        incompleteReason = extractIncompleteReason(payload) || incompleteReason;
        const normalizedUsage = extractOpenAIUsage(payload, request.mode);
        if (normalizedUsage.totalTokens > 0) {
          usage = normalizedUsage;
        }
        return delta ? { type: "delta", text: delta, raw: payload } : null;
      };

      for await (const frame of streamProviderFrames(env, request)) {
        const chunk = handlePayload(frame.eventName, frame.payload);
        if (chunk) yield chunk;
      }

      yield {
        type: "final",
        text: finalText || accumulatedText,
        raw: finalRaw,
        finishReason,
        status,
        outputTokens,
        incompleteReason,
        usage,
      };
    },
  };
}

function extractOutputItems(payload: any): any[] {
  if (Array.isArray(payload?.response?.output)) return payload.response.output;
  if (Array.isArray(payload?.output)) return payload.output;
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asSourceCandidate(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  const url = typeof record?.url === "string" ? record.url.trim() : "";
  return url ? record : null;
}

function collectKnownSearchSources(payload: unknown, results: unknown[]): void {
  const record = asRecord(payload);
  if (!record) return;

  const explicitSources = Array.isArray(record.sources) ? record.sources : [];
  explicitSources.forEach((entry) => {
    if (asSourceCandidate(entry)) results.push(entry);
  });

  const searchResults = Array.isArray(record.results) ? record.results : [];
  searchResults.forEach((result) => {
    const resultRecord = asRecord(result);
    const content = Array.isArray(resultRecord?.content) ? resultRecord.content : [];
    content.forEach((entry) => {
      if (asSourceCandidate(entry)) results.push(entry);
    });
  });

  const direct = asSourceCandidate(record);
  if (direct) results.push(record);
}

function walkSearchSourceCandidates(
  value: unknown,
  results: unknown[],
  state: { seen: number },
  depth = 0,
): void {
  if (depth > 6 || state.seen >= 200) return;
  if (!value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (state.seen >= 200) break;
      state.seen += 1;
      walkSearchSourceCandidates(entry, results, state, depth + 1);
    }
    return;
  }

  const record = asRecord(value);
  if (!record) return;

  const direct = asSourceCandidate(record);
  if (direct) {
    results.push(record);
  }

  for (const [key, child] of Object.entries(record)) {
    if (state.seen >= 200) break;
    if (/annotation|citation|message|output_text|delta/i.test(key)) continue;
    if (key === "output") continue;
    state.seen += 1;
    walkSearchSourceCandidates(child, results, state, depth + 1);
  }
}

function normalizeUrlCitation(raw: any): UrlCitationAnnotation | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.type && raw.type !== "url_citation") return null;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  const start = Number(raw.start_index ?? raw.startIndex ?? raw.start);
  const end = Number(raw.end_index ?? raw.endIndex ?? raw.end);
  if (!url || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const title = typeof raw.title === "string" ? raw.title.trim() : undefined;
  return { start_index: start, end_index: end, url, title: title || undefined };
}

function extractOutputTextPartsWithCitations(payload: any): Array<{ text: string; citations: UrlCitationAnnotation[] }> {
  const parts: Array<{ text: string; citations: UrlCitationAnnotation[] }> = [];
  const output = extractOutputItems(payload);
  output.forEach((item: any) => {
    const content = Array.isArray(item?.content) ? item.content : [];
    content.forEach((part: any) => {
      const text = typeof part?.text === "string" ? part.text : "";
      if (!text) return;
      const annotations = Array.isArray(part?.annotations) ? part.annotations : [];
      const metadataCitations = Array.isArray(part?.citation_metadata?.citations)
        ? part.citation_metadata.citations
        : Array.isArray(part?.citation_metadata)
          ? part.citation_metadata
          : [];
      const directCitations = Array.isArray(part?.citations) ? part.citations : [];
      const citations = [...annotations, ...metadataCitations, ...directCitations]
        .map(normalizeUrlCitation)
        .filter((entry): entry is UrlCitationAnnotation => Boolean(entry));
      parts.push({ text, citations });
    });
  });
  return parts;
}

export function extractWebSearchSources(payload: any): unknown[] {
  const sources: unknown[] = [];
  collectKnownSearchSources(payload, sources);
  const output = extractOutputItems(payload);
  output.forEach((item: any) => {
    if (item?.type !== "web_search_call") return;
    const list = Array.isArray(item?.action?.sources) ? item.action.sources : [];
    list.forEach((entry: unknown) => {
      if (asSourceCandidate(entry)) sources.push(entry);
    });
  });
  output.forEach((item: any) => {
    collectKnownSearchSources(item, sources);
    collectKnownSearchSources(item?.action, sources);
    collectKnownSearchSources(item?.result, sources);
    collectKnownSearchSources(item?.data, sources);
  });
  walkSearchSourceCandidates(payload, sources, { seen: 0 });
  return sources;
}

function getDomainFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname || url;
  } catch {
    return url.replace(/^https?:\/\//i, "").split("/")[0] || url;
  }
}

export function normalizeSourceKey(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.search = "";
    if (parsed.pathname.endsWith("/") && parsed.pathname !== "/") {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }
    return parsed.toString();
  } catch {
    return value.trim();
  }
}

export function normalizeWebSearchSources(rawSources: unknown[]): WebSearchSource[] {
  const map = new Map<string, WebSearchSource>();
  (rawSources || []).forEach((entry) => {
    if (!entry || typeof entry !== "object") return;
    const rawUrl = typeof (entry as any).url === "string" ? (entry as any).url.trim() : "";
    if (!rawUrl) return;
    const key = normalizeSourceKey(rawUrl);
    if (!key) return;
    const title = typeof (entry as any).title === "string" ? (entry as any).title.trim() : "";
    const snippetCandidate =
      (typeof (entry as any).snippet === "string" && (entry as any).snippet.trim()) ||
      (typeof (entry as any).description === "string" && (entry as any).description.trim()) ||
      (typeof (entry as any).text === "string" && (entry as any).text.trim()) ||
      "";
    const retrievedAt =
      typeof (entry as any).retrieved_at === "number"
        ? (entry as any).retrieved_at
        : typeof (entry as any).retrievedAt === "number"
          ? (entry as any).retrievedAt
          : undefined;
    if (!map.has(key)) {
      map.set(key, {
        url: key,
        key,
        title: title || undefined,
        domain: getDomainFromUrl(key),
        snippet: snippetCandidate || undefined,
        retrievedAt,
      });
      return;
    }
    const existing = map.get(key);
    if (existing && title && (!existing.title || title.length > existing.title.length)) existing.title = title;
    if (existing && snippetCandidate && (!existing.snippet || snippetCandidate.length > existing.snippet.length)) {
      existing.snippet = snippetCandidate;
    }
    if (existing && retrievedAt && (!existing.retrievedAt || retrievedAt > existing.retrievedAt)) {
      existing.retrievedAt = retrievedAt;
    }
  });
  return Array.from(map.values());
}

export function mergeCitationSources(
  citationSources: CitationSource[],
  searchSources: WebSearchSource[],
): CitationSource[] {
  const lookup = new Map(searchSources.map((source) => [normalizeSourceKey(source.url), source]));
  return citationSources.map((source) => {
    const match = lookup.get(normalizeSourceKey(source.url));
    return {
      ...source,
      title: source.title || match?.title,
      domain: source.domain || match?.domain,
      snippet: source.snippet || match?.snippet,
      retrievedAt: source.retrievedAt || match?.retrievedAt,
    };
  });
}

export function buildFallbackSources(searchSources: WebSearchSource[]): CitationSource[] {
  return searchSources.map((source, index) => ({
    id: index + 1,
    url: source.url,
    title: source.title,
    domain: source.domain,
    snippet: source.snippet,
    retrievedAt: source.retrievedAt,
  }));
}

function buildCitationSources(urlToId: Map<string, number>, urlMeta: Map<string, { title?: string }>): CitationSource[] {
  const sources: CitationSource[] = [];
  for (const [url, id] of urlToId.entries()) {
    const meta = urlMeta.get(url);
    sources.push({
      id,
      url,
      title: meta?.title,
      domain: getDomainFromUrl(url),
    });
  }
  return sources;
}

export function buildCitedAnswerPayload(payload: any): {
  answerSegments: AnswerSegment[];
  sources: CitationSource[];
  consultedSources?: unknown[];
  answerText: string;
} {
  const parts = extractOutputTextPartsWithCitations(payload);
  if (!parts.length) {
    const text = extractOutputText(payload).trim();
    return {
      answerSegments: text ? [{ type: "text", text }] : [],
      sources: [],
      consultedSources: extractWebSearchSources(payload),
      answerText: text,
    };
  }

  const state = { urlToId: new Map<string, number>(), urlMeta: new Map<string, { title?: string }>(), nextId: 1 };
  const answerSegments: AnswerSegment[] = [];
  let answerText = "";

  parts.forEach((part) => {
    const result = segmentWithCitationPills(part.text, part.citations, state);
    answerSegments.push(...result.segments);
    state.nextId = result.nextId;
    answerText += part.text;
  });

  return {
    answerSegments,
    sources: buildCitationSources(state.urlToId, state.urlMeta),
    consultedSources: extractWebSearchSources(payload),
    answerText: answerText.trim(),
  };
}

export function extractCitationSnapshot(payload: any): ReturnType<typeof buildCitedAnswerPayload> | null {
  const parts = extractOutputTextPartsWithCitations(payload);
  const consultedSources = extractWebSearchSources(payload);
  if (!parts.length && !consultedSources.length) return null;
  return buildCitedAnswerPayload(payload);
}
