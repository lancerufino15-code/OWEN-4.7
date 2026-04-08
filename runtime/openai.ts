import type { Env } from "../../types";
import { safeJson as readSafeJson } from "./http";
import {
  getConfiguredDefaultTextModel,
  getDefaultModel,
  isAllowedModel,
  isImageModel,
  resolveModelId,
  resolveModelSamplingSupport,
  type OpenAIEndpoint,
  type SamplingEnv,
} from "./model-selection";

type SendOpenAIResult<T> = { ok: true; value: T } | { ok: false; errorText: string; status?: number };
type OpenAIJson = any;
type TokenLimit = { max_tokens?: number; max_completion_tokens?: number };
type OpenAIFetchOptions = RequestInit & { json?: unknown };

const RETRY_DELAYS_MS = [0, 500, 1500];

export {
  getConfiguredDefaultTextModel,
  getDefaultModel,
  isAllowedModel,
  isImageModel,
  resolveModelId,
};

export function normalizeModelKey(model?: string | null): string {
  return (model || "").trim().toLowerCase();
}

export function resolveSamplingSupport(
  model: string,
  endpoint: OpenAIEndpoint,
  env?: SamplingEnv,
  forceStripSampling?: boolean,
): { supportsTemperature: boolean; supportsTopP: boolean } {
  return resolveModelSamplingSupport(model, endpoint, env, forceStripSampling);
}

export function modelSupportsFileSearch(model: string): boolean {
  const normalized = normalizeModelKey(model);
  if (!normalized) return false;
  return !normalized.startsWith("dall-e") && !normalized.startsWith("gpt-image");
}

export function shouldRetryUnsupportedParams(message: string): boolean {
  const lowered = (message || "").toLowerCase();
  if (!lowered) return false;
  if (lowered.includes("unsupported parameter") && (lowered.includes("temperature") || lowered.includes("top_p"))) {
    return true;
  }
  if (lowered.includes("unknown parameter") && lowered.includes("seed")) {
    return true;
  }
  return false;
}

function guessImageMimeTypeFromFilename(name: string): string {
  const lowered = (name || "").toLowerCase();
  if (lowered.endsWith(".png")) return "image/png";
  if (lowered.endsWith(".jpg") || lowered.endsWith(".jpeg")) return "image/jpeg";
  if (lowered.endsWith(".webp")) return "image/webp";
  if (lowered.endsWith(".gif")) return "image/gif";
  if (lowered.endsWith(".bmp")) return "image/bmp";
  if (lowered.endsWith(".tif") || lowered.endsWith(".tiff")) return "image/tiff";
  if (lowered.endsWith(".heic")) return "image/heic";
  return "";
}

function guessMimeTypeFromFilename(name: string): string {
  const lowered = (name || "").toLowerCase();
  if (lowered.endsWith(".pdf")) return "application/pdf";
  if (lowered.endsWith(".doc")) return "application/msword";
  if (lowered.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lowered.endsWith(".txt")) return "text/plain";
  if (lowered.endsWith(".csv")) return "text/csv";
  if (lowered.endsWith(".tsv")) return "text/tab-separated-values";
  const image = guessImageMimeTypeFromFilename(name);
  if (image) return image;
  return "application/octet-stream";
}

function normalizeOpenAIUploadTarget(filename: string, mimeType?: string) {
  if (/\.tsv$/i.test(filename)) {
    return {
      filename: filename.replace(/\.tsv$/i, ".txt"),
      mimeType: "text/plain",
    };
  }
  const normalizedMimeType = (mimeType || "").trim();
  const resolvedMimeType =
    normalizedMimeType && normalizedMimeType.toLowerCase() !== "application/octet-stream"
      ? normalizedMimeType
      : guessMimeTypeFromFilename(filename);
  return {
    filename,
    mimeType: resolvedMimeType,
  };
}

export function sanitizeOpenAIPayload(
  payload: Record<string, unknown>,
  opts: { endpoint: OpenAIEndpoint; env?: SamplingEnv; model?: string; forceStripSampling?: boolean },
): { payload: Record<string, unknown>; removedKeys: string[] } {
  const sanitized: Record<string, unknown> = { ...payload };
  const removedKeys: string[] = [];
  if (Object.prototype.hasOwnProperty.call(sanitized, "seed")) {
    delete sanitized.seed;
    removedKeys.push("seed");
  }
  const model =
    typeof opts.model === "string" && opts.model.trim()
      ? opts.model
      : typeof sanitized.model === "string"
        ? sanitized.model
        : "";
  const support = resolveSamplingSupport(model, opts.endpoint, opts.env, opts.forceStripSampling);
  if (!support.supportsTemperature && Object.prototype.hasOwnProperty.call(sanitized, "temperature")) {
    delete sanitized.temperature;
    removedKeys.push("temperature");
  }
  if (!support.supportsTopP && Object.prototype.hasOwnProperty.call(sanitized, "top_p")) {
    delete sanitized.top_p;
    removedKeys.push("top_p");
  }
  return { payload: sanitized, removedKeys };
}

export async function sendOpenAIWithUnsupportedParamRetry<T>(opts: {
  payload: Record<string, unknown>;
  endpoint: OpenAIEndpoint;
  env?: SamplingEnv;
  label: string;
  send: (payload: Record<string, unknown>) => Promise<SendOpenAIResult<T>>;
}): Promise<
  | { ok: true; value: T; attempts: number; sanitizedPayload: Record<string, unknown> }
  | { ok: false; errorText: string; status?: number; attempts: number; sanitizedPayload: Record<string, unknown> }
> {
  const firstAttempt = sanitizeOpenAIPayload(opts.payload, {
    endpoint: opts.endpoint,
    env: opts.env,
  });
  const first = await opts.send(firstAttempt.payload);
  if (first.ok) {
    return { ok: true, value: first.value, attempts: 1, sanitizedPayload: firstAttempt.payload };
  }
  const errorText = first.errorText || "OpenAI request failed.";
  if (!shouldRetryUnsupportedParams(errorText)) {
    return { ok: false, errorText, status: first.status, attempts: 1, sanitizedPayload: firstAttempt.payload };
  }
  const retryAttempt = sanitizeOpenAIPayload(opts.payload, {
    endpoint: opts.endpoint,
    env: opts.env,
    forceStripSampling: true,
  });
  const additionalRemovals = retryAttempt.removedKeys.filter((key) => !firstAttempt.removedKeys.includes(key));
  if (!additionalRemovals.length) {
    return { ok: false, errorText, status: first.status, attempts: 1, sanitizedPayload: firstAttempt.payload };
  }
  console.warn("[OpenAI] Retrying without unsupported parameters", {
    label: opts.label,
    endpoint: opts.endpoint,
    removed: additionalRemovals,
  });
  const second = await opts.send(retryAttempt.payload);
  if (second.ok) {
    return { ok: true, value: second.value, attempts: 2, sanitizedPayload: retryAttempt.payload };
  }
  return {
    ok: false,
    errorText: second.errorText || errorText,
    status: second.status ?? first.status,
    attempts: 2,
    sanitizedPayload: retryAttempt.payload,
  };
}

export async function safeJson(response: Response): Promise<OpenAIJson> {
  return readSafeJson(response);
}

export async function openAIJsonFetch(env: Env, path: string, options: OpenAIFetchOptions = {}) {
  const base = env.OPENAI_API_BASE?.replace(/\/$/, "") || "https://api.openai.com/v1";
  const url = path.startsWith("http") ? path : `${base}${path}`;
  const { json, headers, body, ...rest } = options;
  const init: RequestInit = {
    ...rest,
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json",
      ...(headers || {}),
    },
    body: json !== undefined ? JSON.stringify(json) : body,
  };
  const resp = await fetch(url, init);
  const data = await safeJson(resp);
  if (!resp.ok) {
    const message = data?.error?.message || data?.message || resp.statusText || "OpenAI request failed.";
    throw new Error(message);
  }
  return data;
}

export function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function retryOpenAI(fn: (attempt: number) => Promise<Response>, label: string): Promise<Response> {
  let lastResp: Response | null = null;
  for (let i = 0; i < RETRY_DELAYS_MS.length; i += 1) {
    if (i > 0) {
      await delay(RETRY_DELAYS_MS[i] ?? 0);
    }
    const resp = await fn(i);
    lastResp = resp;
    if (resp.ok) return resp;
    const status = resp.status;
    const retryable = status === 429 || (status >= 500 && status < 600);
    if (!retryable || i === RETRY_DELAYS_MS.length - 1) {
      return resp;
    }
    try {
      const clone = resp.clone();
      const body = await safeJson(clone);
      console.warn("[Retry] OpenAI retry", { label, attempt: i + 1, status, body });
    } catch {
      console.warn("[Retry] OpenAI retry", { label, attempt: i + 1, status });
    }
  }
  return lastResp as Response;
}

export function extractChatCompletionContent(payload: any) {
  const message = payload?.choices?.[0]?.message;
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  return "";
}

export function extractOutputText(payload: any): string {
  if (!payload) return "";
  const stringifyContent = (content: any[]): string =>
    content
      .map((part: any) => {
        if (typeof part?.text === "string") return part.text;
        if (part && typeof part.json === "object") return JSON.stringify(part.json);
        return "";
      })
      .filter(Boolean)
      .join("");

  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }
  if (Array.isArray(payload.output_text)) {
    const joined = payload.output_text.filter(Boolean).join("\n");
    if (joined.trim()) return joined;
  }
  if (typeof payload.response?.output_text === "string" && payload.response.output_text.trim()) {
    return payload.response.output_text;
  }
  if (Array.isArray(payload.response?.output_text)) {
    const joined = payload.response.output_text.filter(Boolean).join("\n");
    if (joined.trim()) return joined;
  }
  if (Array.isArray(payload.output)) {
    const joined = payload.output
      .map((item: any) => (Array.isArray(item?.content) ? stringifyContent(item.content) : ""))
      .filter(Boolean)
      .join("\n");
    if (joined.trim()) return joined;
  }
  if (Array.isArray(payload.response?.output)) {
    const joined = payload.response.output
      .map((item: any) => (Array.isArray(item?.content) ? stringifyContent(item.content) : ""))
      .filter(Boolean)
      .join("\n");
    if (joined.trim()) return joined;
  }
  return "";
}

export function extractOutputTextLength(payload: any): number {
  if (!payload) return 0;
  const outputText = payload.output_text ?? payload.response?.output_text;
  if (typeof outputText === "string") return outputText.length;
  if (Array.isArray(outputText)) {
    return outputText.filter(Boolean).join("\n").length;
  }
  return extractOutputText(payload).length;
}

export function extractOutputItems(payload: any): any[] {
  if (Array.isArray(payload?.response?.output)) return payload.response.output;
  if (Array.isArray(payload?.output)) return payload.output;
  return [];
}

export function extractFinishReason(payload: any): string | undefined {
  const direct = payload?.finish_reason ?? payload?.response?.finish_reason;
  if (typeof direct === "string" && direct.trim()) return direct;
  const output = extractOutputItems(payload);
  for (const item of output) {
    if (typeof item?.status === "string" && item.status.trim()) return item.status;
    if (typeof item?.finish_reason === "string" && item.finish_reason.trim()) return item.finish_reason;
  }
  return undefined;
}

export function extractResponseStatus(payload: any): string | undefined {
  const status = payload?.status ?? payload?.response?.status;
  return typeof status === "string" && status.trim() ? status : undefined;
}

export function extractOutputTokens(payload: any): number | undefined {
  const usage = payload?.usage ?? payload?.response?.usage;
  const outputTokens = usage?.output_tokens ?? usage?.completion_tokens;
  return typeof outputTokens === "number" && Number.isFinite(outputTokens) ? outputTokens : undefined;
}

export function extractIncompleteReason(payload: any): string | undefined {
  const incomplete = payload?.incomplete_details ?? payload?.response?.incomplete_details;
  if (typeof incomplete?.reason === "string" && incomplete.reason.trim()) return incomplete.reason;
  return undefined;
}

export function buildTokenLimit(model: string, desired: number, apiType: "chat" | "responses" = "chat"): TokenLimit {
  const normalized = (model || "").toLowerCase();
  const needsMaxCompletion =
    apiType === "responses" ||
    normalized === "gpt-5.2" ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3");
  return needsMaxCompletion ? { max_completion_tokens: desired } : { max_tokens: desired };
}

export function withMaxOutputTokens(payload: Record<string, unknown>, n: number) {
  payload.max_output_tokens = n;
  delete payload.max_completion_tokens;
  delete payload.max_tokens;
  return payload;
}

export async function uploadBytesToOpenAI(
  env: Env,
  bytes: Uint8Array,
  filename: string,
  purpose: string,
  mimeType?: string,
): Promise<string | null> {
  const uploadTarget = normalizeOpenAIUploadTarget(filename, mimeType);
  const form = new FormData();
  form.append("purpose", purpose);
  const blobPart: BlobPart = bytes as unknown as BlobPart;
  form.append("file", new File([blobPart], uploadTarget.filename, { type: uploadTarget.mimeType }));
  const base = env.OPENAI_API_BASE?.replace(/\/$/, "") || "https://api.openai.com/v1";
  const resp = await fetch(`${base}/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form,
  });
  const data = await safeJson(resp);
  if (!resp.ok) {
    const msg = data?.error?.message || "OpenAI file upload failed";
    console.warn("[OpenAI] File upload failed", {
      filename: uploadTarget.filename,
      purpose,
      mimeType: uploadTarget.mimeType,
      status: resp.status,
      message: msg,
    });
    throw new Error(msg);
  }
  const uploadedId = typeof data?.id === "string" ? data.id : "";
  return uploadedId || null;
}
