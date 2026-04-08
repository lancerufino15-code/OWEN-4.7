import { extractChatCompletionContent, extractOutputText } from "../openai";
import { extractOpenAIUsage } from "../openai/usage";
import type { ModelAdapter, ModelAdapterFrame, ModelAdapterRequest, ModelAdapterSendResult } from "./adapter";
import { matchMockFixture, type MockModelFixtureCatalog } from "./fixtures";

function buildFrames(request: ModelAdapterRequest, text: string, response: any): ModelAdapterFrame[] {
  if (request.endpoint === "chat_completions") {
    const midpoint = Math.max(1, Math.floor(text.length / 2));
    return [
      { payload: { choices: [{ delta: { content: text.slice(0, midpoint) } }] } },
      { payload: { choices: [{ delta: { content: text.slice(midpoint) } }] } },
      { payload: response },
    ];
  }
  const midpoint = Math.max(1, Math.floor(text.length / 2));
  return [
    { eventName: "response.output_text.delta", payload: { output_text_delta: text.slice(0, midpoint) } },
    { eventName: "response.output_text.delta", payload: { output_text_delta: text.slice(midpoint) } },
    { eventName: "response.completed", payload: response },
  ];
}

function buildSendResult(request: ModelAdapterRequest, response: any): ModelAdapterSendResult {
  const text = request.endpoint === "responses"
    ? extractOutputText(response).trim()
    : extractChatCompletionContent(response).trim();
  const usage = extractOpenAIUsage(response, request.endpoint);
  return {
    raw: response,
    text,
    finishReason:
      response?.choices?.[0]?.finish_reason ||
      response?.response?.output?.[0]?.finish_reason ||
      response?.output?.[0]?.finish_reason ||
      response?.response?.stop_reason ||
      response?.stop_reason ||
      undefined,
    status: response?.response?.status || response?.status || (request.endpoint === "chat_completions" ? "completed" : undefined),
    outputTokens: usage.outputTokens || undefined,
    incompleteReason: response?.incomplete_details?.reason || response?.response?.incomplete_details?.reason || undefined,
    usage: usage.totalTokens > 0 ? usage : null,
  };
}

export function createMockModelAdapter(catalog: MockModelFixtureCatalog): ModelAdapter {
  return {
    async send(request) {
      const fixture = matchMockFixture(catalog, request);
      return buildSendResult(request, fixture.response);
    },
    async *streamFrames(request) {
      const fixture = matchMockFixture(catalog, request);
      const response = fixture.response;
      const text = request.endpoint === "responses"
        ? extractOutputText(response).trim()
        : extractChatCompletionContent(response).trim();
      const frames = fixture.frames || buildFrames(request, text, response);
      for (const frame of frames) {
        yield frame;
      }
    },
  };
}
