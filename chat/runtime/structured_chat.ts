import { encodeSSE } from "../../runtime/http";
import { extractOpenAIUsage } from "../../runtime/openai/usage";
import { buildVisionResponsesInput } from "../../runtime/vision/request-builder";
import type { Env } from "../../../types";
import { buildStructuredResponsePlan, extractRequestSignals, type ResponsePlan } from "../../../universal_answer_orchestrator";
import { getPromptText } from "../../../registry/prompts";
import { getRuntimeFeatures } from "../../runtime/config/runtime-features";
import type { ChatResponseSegment, ChatResponseV2, SourceRef } from "../response_contract";
import { buildResponseV2PlainText } from "../response_contract";
import { AGENTS } from "../agents";
import { buildResponsesToolConfig } from "../../runtime/tools/registry";
import { filterAllowedRuntimeTools } from "../../runtime/tools/policy";
import {
  createChatProvider,
  extractWebSearchSources,
  normalizeWebSearchSources,
  streamProviderFrames,
  type ProviderMessageRequest,
} from "./provider";
import type { ExecutionPlan, ResponsesInputMessage } from "./types";
import { buildSourceRegistry } from "./source_registry";
import { ToolCallBuffer } from "./tool_call_buffer";
import {
  StopGeneration,
  createSegmentSessionState,
  enforcePlanBoundaries,
  finalizeResponseV2,
  validateCompletion,
  validateSegment,
} from "./segment_validator";

const STRUCTURED_MAX_OUTPUT_TOKENS = 2600;

type StructuredCompleteEvent = {
  stopReason: ChatResponseV2["stopReason"];
  truncated: boolean;
};

type StructuredChatCallbacks = {
  onComplete?: (payload: {
    response: ChatResponseV2;
    content: string;
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
      totalTokens: number;
    } | null;
  }) => Promise<void> | void;
  onError?: (error: Error) => Promise<void> | void;
};

function buildSseHeaders() {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, max-age=0, no-cache, no-transform",
    connection: "keep-alive",
  };
}

function supportsStructuredChat(plan: ExecutionPlan, env: Env): boolean {
  return Boolean(
    getRuntimeFeatures(env).structuredChat.enabled &&
      plan.requestKind === "chat" &&
      plan.stream &&
      !plan.explicitJson &&
      plan.providerMode === "responses" &&
      plan.retrieval.mode === "web_search" &&
      !plan.files.length &&
      !plan.hasInlineImages &&
      plan.visionFiles.length === 0,
  );
}

function formatSourceList(sources: SourceRef[]): string {
  if (!sources.length) return "No sources available.";
  return sources
    .map((source) => {
      const snippet = source.snippet ? `\nSnippet: ${source.snippet}` : "";
      return `[${source.id}] ${source.title}\nURL: ${source.url}${snippet}`;
    })
    .join("\n\n");
}

function formatSectionPlan(plan: ResponsePlan): string {
  return plan.sectionPlan
    .map((section, index) => `${index + 1}. ${section.id} -> ${section.title} (${section.allowedTypes.join(", ")})`)
    .join("\n");
}

function buildStructuredInstructions(params: {
  plan: ExecutionPlan;
  responsePlan: ResponsePlan;
  sources: SourceRef[];
}): string {
  const summary = params.plan.compactedTranscript.summary || params.plan.conversationState?.rollingSummary || "";
  const basePrompt = params.plan.baseSystemPrompt;
  const generatorPrompt = getPromptText("chat.structured-generator");
  const sourceIds = params.sources.map((source) => source.id).join(", ");
  const summaryBlock = summary ? `Conversation summary:\n${summary}` : "";

  return [
    basePrompt,
    generatorPrompt,
    summaryBlock,
    `Response plan:\n${JSON.stringify(params.responsePlan, null, 2)}`,
    `Section plan:\n${formatSectionPlan(params.responsePlan)}`,
    `Available sources:\n${formatSourceList(params.sources)}`,
    `Allowed section IDs: ${params.responsePlan.sectionPlan.map((section) => section.id).join(", ")}`,
    `Allowed source IDs: ${sourceIds || "(none)"}`,
    "Use planner-owned sections exactly as provided.",
    "Prefer 1-2 paragraphs or a compact list for the direct answer section.",
    "Only use a table when comparison or structured data is materially better than prose.",
    "If evidence is insufficient, call complete_response with stopReason=\"insufficient_evidence\".",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildSegmentToolSchema(responsePlan: ResponsePlan, sources: SourceRef[]) {
  const sourceIds = sources.map((source) => source.id);
  const sourceItems = sourceIds.length ? { type: "string", enum: sourceIds } : { type: "string" };
  return {
    type: "function",
    name: "emit_segment",
    description: "Emit one complete response segment for the typed UI.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id", "sectionId", "type"],
      properties: {
        id: { type: "string" },
        sectionId: { type: "string", enum: responsePlan.sectionPlan.map((section) => section.id) },
        type: { type: "string", enum: ["header", "paragraph", "list", "table", "code"] },
        text: { type: "string" },
        style: { type: "string", enum: ["bullet", "ordered"] },
        items: { type: "array", items: { type: "string" }, maxItems: responsePlan.maxListItems },
        caption: { type: "string" },
        columns: { type: "array", items: { type: "string" }, maxItems: 8 },
        rows: {
          type: "array",
          items: {
            type: "array",
            items: { type: "string" },
            maxItems: 8,
          },
          maxItems: responsePlan.maxTableRows,
        },
        language: { type: "string" },
        code: { type: "string" },
        sourceIds: {
          type: "array",
          items: sourceItems,
          maxItems: 6,
        },
      },
    },
  };
}

function buildCompletionToolSchema() {
  return {
    type: "function",
    name: "complete_response",
    description: "Finalize the response once all required segments have been emitted.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["stopReason", "truncated"],
      properties: {
        stopReason: {
          type: "string",
          enum: ["complete", "max_sections", "max_segments", "max_tokens", "insufficient_evidence", "user_input_required"],
        },
        truncated: { type: "boolean" },
      },
    },
  };
}

async function buildBaseInput(plan: ExecutionPlan, env: Env): Promise<ResponsesInputMessage[]> {
  return buildVisionResponsesInput({
    env,
    explicitSystemMessages: plan.messages.filter((message) => message.role === "system"),
    historyMessages: plan.compactedTranscript.preservedMessages.filter((message) => message.role !== "system"),
    fileContexts: [],
    topChunks: new Map(),
    visionFiles: [],
  });
}

async function gatherSources(plan: ExecutionPlan, env: Env, baseInput: ResponsesInputMessage[]): Promise<SourceRef[]> {
  const provider = createChatProvider(env);
  const toolPolicy = filterAllowedRuntimeTools(["web_search"], {
    env,
    requestId: plan.conversationId || "structured-chat",
    agentId: plan.agentId,
    permissionMode: plan.permissionMode,
    allowedBuckets: plan.allowedBuckets,
    allowedRuntimeCapabilities: plan.allowedRuntimeCapabilities as Array<"files" | "web_search" | "none">,
    declaredAgentTools: AGENTS[plan.agentId]?.tools || [],
    webSearchAvailable: true,
    hasFiles: false,
    featureEnabled: true,
    retrievalRequired: plan.retrieval.required,
  });
  const webSearchDecision = toolPolicy.decisions.find((decision) => decision.toolId === "web_search");
  if (webSearchDecision && !webSearchDecision.allowed && plan.retrieval.required) {
    throw new Error(`capability_denied:web_search:${webSearchDecision.reason}`);
  }
  const toolConfig = buildResponsesToolConfig(toolPolicy.allowed, "required");
  const retrievalPrompt = [
    "Search the web for authoritative sources relevant to the user's latest request.",
    "Do not answer the question in detail.",
    "Use web search before replying.",
    "Return one short sentence only: sources gathered.",
  ].join("\n");
  const result = await provider.sendMessage({
    mode: "responses",
    model: plan.modelId,
    input: baseInput,
    instructions: retrievalPrompt,
    ...toolConfig,
    max_output_tokens: 64,
    metadata: { owen_mode: "structured_chat_source_prefetch" },
  });
  const normalized = normalizeWebSearchSources(extractWebSearchSources(result.raw));
  return buildSourceRegistry(normalized);
}

function buildGeneratorRequest(params: {
  plan: ExecutionPlan;
  baseInput: ResponsesInputMessage[];
  responsePlan: ResponsePlan;
  sources: SourceRef[];
}): ProviderMessageRequest {
  return {
    mode: "responses",
    model: params.plan.modelId,
    input: params.baseInput,
    instructions: buildStructuredInstructions({
      plan: params.plan,
      responsePlan: params.responsePlan,
      sources: params.sources,
    }),
    tools: [buildSegmentToolSchema(params.responsePlan, params.sources), buildCompletionToolSchema()],
    tool_choice: "required",
    max_output_tokens: STRUCTURED_MAX_OUTPUT_TOKENS,
    metadata: { owen_mode: "structured_chat_v2" },
  };
}

function buildInsufficientEvidenceResponse(responsePlan: ResponsePlan, sources: SourceRef[]): ChatResponseV2 {
  const section = responsePlan.sectionPlan[0];
  const segments: ChatResponseSegment[] = section
    ? [
        {
          id: "segment-insufficient-evidence",
          sectionId: section.id,
          type: "paragraph",
          text: "I could not gather enough reliable evidence to answer this with the structured source-backed flow.",
        },
      ]
    : [];
  return finalizeResponseV2({
    sections: responsePlan.sectionPlan.map((section, index) => ({
      id: section.id,
      title: section.title,
      order: index + 1,
    })),
    segments,
    sources,
    stopReason: "insufficient_evidence",
    truncated: false,
  });
}

export function isStructuredChatEligible(plan: ExecutionPlan, env: Env): boolean {
  return supportsStructuredChat(plan, env);
}

export async function streamStructuredChat(
  plan: ExecutionPlan,
  env: Env,
  callbacks: StructuredChatCallbacks = {},
): Promise<Response> {
  const responsePlan = buildStructuredResponsePlan({
    message: plan.lastUserPrompt,
    classification: plan.classification,
    selection: plan.strategy,
    signals: extractRequestSignals(plan.lastUserPrompt),
  });
  const sections = responsePlan.sectionPlan.map((section, index) => ({
    id: section.id,
    title: section.title,
    order: index + 1,
  }));

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encodeSSE({ event, data: JSON.stringify(data) }));
      };

      (async () => {
        try {
          send("response.start", {
            plan: responsePlan,
            conversationId: plan.conversationId,
            resolvedResponseMode: plan.resolvedResponseMode,
            model: plan.modelId,
          });
          sections.forEach((section) => send("section.add", section));

          const baseInput = await buildBaseInput(plan, env);
          const sources = await gatherSources(plan, env, baseInput);

          if (!sources.length) {
            const response = buildInsufficientEvidenceResponse(responsePlan, sources);
            response.segments.forEach((segment) => send("segment.add", segment));
            send("response.complete", {
              stopReason: response.stopReason,
              truncated: response.truncated,
            });
            await callbacks.onComplete?.({
              response,
              content: buildResponseV2PlainText(response),
              usage: null,
            });
            controller.close();
            return;
          }

          sources.forEach((source) => send("source.add", source));

          const state = createSegmentSessionState(responsePlan, sources);
          const toolBuffer = new ToolCallBuffer();
          const segments: ChatResponseSegment[] = [];
          let malformedCalls = 0;
          let completed = false;
          let finalUsage: {
            inputTokens: number;
            outputTokens: number;
            cacheCreationInputTokens: number;
            cacheReadInputTokens: number;
            totalTokens: number;
          } | null = null;

          for await (const frame of streamProviderFrames(env, buildGeneratorRequest({
            plan,
            baseInput,
            responsePlan,
            sources,
          }))) {
            const usage = extractOpenAIUsage(frame.payload, "responses");
            if (usage.totalTokens > 0) {
              finalUsage = usage;
            }
            const calls = toolBuffer.pushFrame(frame.eventName, frame.payload);
            for (const call of calls) {
              try {
                if (call.name === "emit_segment") {
                  const segment = validateSegment(call.arguments, state);
                  enforcePlanBoundaries(segment, state);
                  segments.push(segment);
                  send("segment.add", segment);
                  continue;
                }

                if (call.name === "complete_response") {
                  const completion = validateCompletion(call.arguments);
                  const response = finalizeResponseV2({
                    sections,
                    segments,
                    sources,
                    stopReason: completion.stopReason,
                    truncated: completion.truncated,
                  });
                  send("response.complete", completion satisfies StructuredCompleteEvent);
                  await callbacks.onComplete?.({
                    response,
                    content: buildResponseV2PlainText(response),
                    usage: finalUsage,
                  });
                  completed = true;
                  controller.close();
                  return;
                }
              } catch (error) {
                if (error instanceof StopGeneration) {
                  const response = finalizeResponseV2({
                    sections,
                    segments,
                    sources,
                    stopReason: error.stopReason,
                    truncated: true,
                  });
                  send("response.complete", {
                    stopReason: error.stopReason,
                    truncated: true,
                  } satisfies StructuredCompleteEvent);
                  await callbacks.onComplete?.({
                    response,
                    content: buildResponseV2PlainText(response),
                    usage: finalUsage,
                  });
                  completed = true;
                  controller.close();
                  return;
                }
                malformedCalls += 1;
                if (malformedCalls < 2) {
                  console.warn("[structured_chat] dropped malformed tool call", {
                    name: call.name,
                    message: error instanceof Error ? error.message : String(error),
                  });
                  continue;
                }
                throw error;
              }
            }
          }

          if (!completed) {
            throw new Error("Missing complete_response");
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          await callbacks.onError?.(err);
          const isCapabilityDenied = err.message.startsWith("capability_denied:");
          send("response.error", {
            code: isCapabilityDenied ? "capability_denied" : "structured_stream_failed",
            message: err.message,
          });
          controller.close();
        }
      })();
    },
  });

  return new Response(stream, { headers: buildSseHeaders() });
}
