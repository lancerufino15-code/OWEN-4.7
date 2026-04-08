import { AGENTS } from "../agents";
import { getDefaultModel, isAllowedModel, isImageModel, resolveModelId } from "../../runtime/model-selection";
import { getRuntimeFeatures } from "../../runtime/config/runtime-features";
import type { RuntimePermissionMode } from "../../runtime/permissions";
import { buildVisionSystemPrompt, inferVisionMode, normalizeVisionMode } from "../../runtime/vision/prompts";
import { messageContentToPlainText, messagesHaveInlineImages, normalizeChatMessagesPreservingImages } from "../../runtime/vision/messages";
import { normalizeResponseMode, normalizeResolvedResponseMode, resolveResponseMode, hasMultipleSentences, hasQuotedText, tryComputeArithmetic } from "../response-mode";
import type { Env } from "../../../types";
import type { ChatMessage, ChatRequestBody, FileReference, ResponseMode } from "../types";
import {
  buildStrategyInstructions,
  classifyHeuristic,
  extractRequestSignals,
  selectStrategy,
} from "../../../universal_answer_orchestrator";
import { compactChatHistory } from "./history-compactor";
import { loadConversationState } from "./conversation-state";
import type { ExecutionPlan, RetrievalPlan } from "./types";

const DEFAULT_MAX_CONTEXT_CHARS = 12_000;
const DEFAULT_MAX_RETRIEVAL_CHUNKS = 5;
const DEFAULT_MIN_SOURCES = 8;

type LegacyChatBody = Record<string, unknown>;

export const sanitizeChatMessages = normalizeChatMessagesPreservingImages;

function normalizeFileReferences(input: unknown): FileReference[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item): FileReference | null => {
      if (!item || typeof item !== "object") return null;
      const source = item as Record<string, unknown>;
      const bucket = typeof source.bucket === "string" ? source.bucket.trim() : "";
      const key = typeof source.key === "string" ? source.key.trim() : "";
      if (!bucket || !key) return null;
      return {
        bucket,
        key,
        textKey: typeof source.textKey === "string" ? source.textKey.trim() : undefined,
        displayName: typeof source.displayName === "string" ? source.displayName.trim() : undefined,
        fileId: typeof source.fileId === "string" ? source.fileId.trim() : typeof source.file_id === "string" ? source.file_id.trim() : undefined,
        visionFileId: typeof source.visionFileId === "string" ? source.visionFileId.trim() : typeof source.vision_file_id === "string" ? source.vision_file_id.trim() : undefined,
      };
    })
    .filter((item): item is FileReference => Boolean(item));
}

function getLastUserPrompt(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const text = messageContentToPlainText(message.content);
    if (text.trim()) return text.trim();
  }
  return "";
}

function gatherFileReferences(body: ChatRequestBody): FileReference[] {
  return normalizeFileReferences([...(body.files || []), ...(body.attachments || []), ...(body.fileRefs || [])]);
}

function promoteLegacyBody(raw: LegacyChatBody): ChatRequestBody | null {
  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  if (!message) return null;
  return {
    messages: [{ role: "user", content: message }],
    agentId: typeof raw.agentId === "string" ? raw.agentId : undefined,
    model: typeof raw.model === "string" ? raw.model : undefined,
    responseMode: typeof raw.responseMode === "string" ? raw.responseMode as ResponseMode : undefined,
    files: normalizeFileReferences(raw.files),
    attachments: normalizeFileReferences(raw.attachments),
    fileRefs: normalizeFileReferences(raw.fileRefs),
    conversation_id: typeof raw.conversation_id === "string" ? raw.conversation_id.trim() : undefined,
    meta_tags: Array.isArray(raw.meta_tags) ? raw.meta_tags.filter((tag): tag is string => typeof tag === "string") : undefined,
    stream: typeof raw.stream === "boolean" ? raw.stream : undefined,
  };
}

function shouldStreamByDefault(request: Request, explicitStream: boolean | undefined, requestKind: ExecutionPlan["requestKind"]): boolean {
  if (requestKind === "instant" || requestKind === "image") return false;
  if (requestKind === "continuation") {
    if (typeof explicitStream === "boolean") return explicitStream;
    return (request.headers.get("accept") || "").includes("text/event-stream");
  }
  if (typeof explicitStream === "boolean") return explicitStream;
  const accept = request.headers.get("accept") || "";
  if (accept.includes("application/json")) return false;
  return true;
}

function buildRetrievalPlan(
  lastUserPrompt: string,
  files: FileReference[],
  strategy: string,
  hasSystemMessages: boolean,
): RetrievalPlan {
  const shouldUseWebSearch =
    !files.length &&
    !hasSystemMessages &&
    Boolean(lastUserPrompt.trim()) &&
    strategy !== "CREATIVE_NARRATIVE";
  const required = files.length > 0 || shouldUseWebSearch || strategy === "RETRIEVAL_AUGMENTED";
  return {
    required,
    mode: files.length > 0 ? "attachments" : required ? "web_search" : "none",
    maxChunks: DEFAULT_MAX_RETRIEVAL_CHUNKS,
    contextCharBudget: DEFAULT_MAX_CONTEXT_CHARS,
    minSources: DEFAULT_MIN_SOURCES,
    selectedDocBias: files.map((file) => file.key),
    sourceDiversity: true,
  };
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((value) => (value || "").trim()).filter(Boolean)));
}

export async function buildExecutionPlan(
  request: Request,
  env: Env,
  body: ChatRequestBody,
  conversationScope: string,
): Promise<ExecutionPlan> {
  const fallbackAgent = AGENTS.default ?? Object.values(AGENTS)[0];
  if (!fallbackAgent) {
    throw new Error("Default agent configuration missing.");
  }
  const runtimeFeatures = getRuntimeFeatures(env);
  const messages = normalizeChatMessagesPreservingImages(body.messages);
  const hasInlineImages = messagesHaveInlineImages(messages);
  if (hasInlineImages && !runtimeFeatures.vision.enabled) {
    throw new Error("Inline vision inputs are disabled.");
  }
  const lastUserPrompt = getLastUserPrompt(messages);
  const hasSystemMessages = messages.some((message) => message.role === "system");
  const requestedResponseMode = normalizeResponseMode(body.responseMode) || "auto";
  const providedVisionMode = normalizeVisionMode(body.visionMode);
  if (body.visionMode !== undefined && !providedVisionMode) {
    throw new Error("visionMode must be one of auto, general, pathology, histology, or ocr.");
  }
  const agentId = typeof body.agentId === "string" && AGENTS[body.agentId] ? body.agentId : fallbackAgent.id;
  const agent = AGENTS[agentId] || fallbackAgent;
  const requestedModel = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
  if (requestedModel && !isAllowedModel(requestedModel)) {
    throw new Error("Model not allowed.");
  }
  const modelKey = requestedModel && isAllowedModel(requestedModel) ? requestedModel : getDefaultModel(env);
  const modelId = resolveModelId(modelKey, env);
  const files = gatherFileReferences(body);
  const visionFiles = files.filter((file) => Boolean(file.visionFileId));
  const hasVisionInputs = hasInlineImages || visionFiles.length > 0;
  const visionMode = (() => {
    const explicit = providedVisionMode || "auto";
    if (explicit !== "auto") return explicit;
    if (!hasVisionInputs) return "auto";
    if (!runtimeFeatures.vision.medicalPromptsEnabled) return "general";
    return inferVisionMode(lastUserPrompt, explicit);
  })();
  const arithmetic = tryComputeArithmetic(lastUserPrompt);
  const resolvedResponseMode = normalizeResolvedResponseMode(requestedResponseMode) ||
    resolveResponseMode(lastUserPrompt, requestedResponseMode, {
      hasAttachments: files.length > 0 || hasInlineImages,
      hasSystemMessages,
      hasQuotedText: hasQuotedText(lastUserPrompt),
      hasMultipleSentences: hasMultipleSentences(lastUserPrompt),
      hasSimpleArithmetic: Boolean(arithmetic),
    });

  const requestSignals = extractRequestSignals(lastUserPrompt);
  const classification = classifyHeuristic(lastUserPrompt);
  const strategy = selectStrategy(classification, requestSignals, {
    webSearchAvailable: agent.tools.includes("web_search"),
    forceThinking: requestedResponseMode === "thinking",
  });
  const requestKind: ExecutionPlan["requestKind"] = isImageModel(modelKey)
    ? "image"
    : resolvedResponseMode === "instant"
      ? "instant"
      : body.continuation?.text
        ? "continuation"
        : "chat";
  const retrieval = buildRetrievalPlan(lastUserPrompt, files, strategy.strategy, hasSystemMessages);
  const conversationState = await loadConversationState(env, conversationScope, body.conversation_id);
  const compactedTranscript = compactChatHistory(messages, conversationState);
  const permissionMode: RuntimePermissionMode = agent.defaultPermissionMode || "read-only";
  const allowedBuckets = uniqueStrings(agent.allowedBuckets || agent.defaultBuckets || []);
  const allowedRuntimeCapabilities = uniqueStrings(agent.allowedRuntimeCapabilities || agent.tools || []);

  return {
    requestKind,
    stream: shouldStreamByDefault(request, body.stream, requestKind),
    explicitJson: request.headers.get("accept")?.includes("application/json") || body.stream === false || requestKind === "instant" || requestKind === "image",
    legacyMode: messages.length === 1 && typeof messages[0]?.content === "string",
    permissionMode,
    allowedBuckets,
    allowedRuntimeCapabilities,
    conversationId: body.conversation_id,
    conversationScope,
    agentId,
    requestedModel,
    modelKey,
    modelId,
    providerMode: retrieval.mode === "none" && !files.length && !visionFiles.length && !hasInlineImages ? "chat_completions" : "responses",
    responseMode: requestedResponseMode,
    resolvedResponseMode,
    classification,
    strategy,
    retrieval,
    runQa: requestKind !== "instant" && requestKind !== "image",
    allowRewrite: requestKind !== "instant" && requestKind !== "image",
    messages,
    lastUserPrompt,
    files,
    visionFiles,
    hasInlineImages,
    visionMode,
    continuationText: typeof body.continuation?.text === "string" ? body.continuation.text.trim() : undefined,
    tags: Array.isArray(body.meta_tags) ? body.meta_tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0) : [],
    conversationState,
    compactedTranscript,
    baseSystemPrompt: hasVisionInputs
      ? buildVisionSystemPrompt(agent.systemPrompt || fallbackAgent.systemPrompt, visionMode, lastUserPrompt)
      : agent.systemPrompt || fallbackAgent.systemPrompt,
  };
}

export function buildPlanStrategyInstructions(plan: ExecutionPlan): string {
  return buildStrategyInstructions(plan.strategy.strategy, plan.classification, extractRequestSignals(plan.lastUserPrompt), {
    minSources: plan.retrieval.minSources,
    enforceMinSources: false,
  });
}

export function parseChatRequestBody(raw: unknown): ChatRequestBody | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (Array.isArray((raw as Record<string, unknown>).messages)) {
    return raw as ChatRequestBody;
  }
  return promoteLegacyBody(raw as LegacyChatBody);
}
