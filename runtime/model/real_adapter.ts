import { SseFrameParser } from "../../../lib/streaming/sse";
import type { Env } from "../../../types";
import {
  extractChatCompletionContent,
  extractOutputText,
  retryOpenAI,
  safeJson,
  sendOpenAIWithUnsupportedParamRetry,
} from "../openai";
import { extractOpenAIUsage } from "../openai/usage";
import type { ModelAdapter, ModelAdapterFrame, ModelAdapterRequest, ModelAdapterSendResult } from "./adapter";

function openAIBase(env: Env): string {
  return env.OPENAI_API_BASE?.replace(/\/$/, "") || "https://api.openai.com/v1";
}

function endpointPath(endpoint: ModelAdapterRequest["endpoint"]): string {
  return endpoint === "responses" ? "/responses" : "/chat/completions";
}

function buildHeaders(env: Env, endpoint: ModelAdapterRequest["endpoint"]) {
  return {
    authorization: `Bearer ${env.OPENAI_API_KEY}`,
    "content-type": "application/json",
    ...(endpoint === "responses" ? { "OpenAI-Beta": "assistants=v2" } : {}),
  };
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

function extractIncompleteReason(payload: any): string | undefined {
  return payload?.incomplete_details?.reason || payload?.response?.incomplete_details?.reason || undefined;
}

export function createRealModelAdapter(env: Env): ModelAdapter {
  return {
    async send(request): Promise<ModelAdapterSendResult> {
      const result = await sendOpenAIWithUnsupportedParamRetry<{ data: any; status: number }>({
        payload: request.payload,
        endpoint: request.endpoint,
        env,
        label: request.label,
        send: async (attemptPayload) => {
          const response = await retryOpenAI(
            () =>
              fetch(`${openAIBase(env)}${endpointPath(request.endpoint)}`, {
                method: "POST",
                headers: buildHeaders(env, request.endpoint),
                body: JSON.stringify(attemptPayload),
              }),
            request.label,
          );
          const data = await safeJson(response);
          if (!response.ok) {
            const message = data?.error?.message || response.statusText || "OpenAI request failed.";
            return { ok: false, errorText: message, status: response.status };
          }
          return { ok: true, value: { data, status: response.status } };
        },
      });

      if (!result.ok) {
        const error = new Error(result.errorText || "OpenAI request failed.");
        (error as any).status = result.status || 502;
        throw error;
      }

      const raw = result.value.data;
      const usage = extractOpenAIUsage(raw, request.endpoint);
      return {
        raw,
        text: request.endpoint === "responses" ? extractOutputText(raw).trim() : extractChatCompletionContent(raw).trim(),
        finishReason: extractFinishReason(raw),
        status: request.endpoint === "chat_completions" ? "completed" : extractResponseStatus(raw),
        outputTokens: usage.outputTokens || undefined,
        incompleteReason: extractIncompleteReason(raw),
        usage: usage.totalTokens > 0 ? usage : null,
      };
    },
    async *streamFrames(request): AsyncGenerator<ModelAdapterFrame> {
      const result = await sendOpenAIWithUnsupportedParamRetry<Response>({
        payload: { ...request.payload, stream: true },
        endpoint: request.endpoint,
        env,
        label: `${request.label}:stream`,
        send: async (attemptPayload) => {
          const response = await fetch(`${openAIBase(env)}${endpointPath(request.endpoint)}`, {
            method: "POST",
            headers: buildHeaders(env, request.endpoint),
            body: JSON.stringify(attemptPayload),
          });
          if (!response.ok || !response.body) {
            const errorText = await response.text().catch(() => "OpenAI stream failed.");
            return { ok: false, errorText, status: response.status || 502 };
          }
          return { ok: true, value: response };
        },
      });
      if (!result.ok) {
        const error = new Error(result.errorText || "OpenAI stream failed.");
        (error as any).status = result.status || 502;
        throw error;
      }

      const reader = result.value.body!.getReader();
      const decoder = new TextDecoder();
      const parser = new SseFrameParser();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const frames = parser.push(decoder.decode(value, { stream: true }));
          for (const frame of frames) {
            yield { eventName: frame.eventName, payload: JSON.parse(frame.data) };
          }
        }
        const trailingFrames = parser.push(decoder.decode(new Uint8Array(), { stream: false }));
        for (const frame of trailingFrames) {
          yield { eventName: frame.eventName, payload: JSON.parse(frame.data) };
        }
        for (const frame of parser.finish()) {
          yield { eventName: frame.eventName, payload: JSON.parse(frame.data) };
        }
      } finally {
        reader.releaseLock?.();
      }
    },
  };
}
