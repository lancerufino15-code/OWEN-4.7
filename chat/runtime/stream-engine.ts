import { getAppConfig } from "../../../app/config";
import type { AuthSessionRecord } from "../../../auth/session";
import { buildAuditActor, getRequestId, writeAuditEvent } from "../../../observability/audit";
import { recordMetricEvent } from "../../../observability/metrics";
import { createRuntimeSessionStore } from "../../../runtime/session-store";
import type { Env } from "../../../types";
import { getRuntimeFeatures } from "../../runtime/config/runtime-features";
import { buildResponsesToolConfig } from "../../runtime/tools/registry";
import { filterAllowedRuntimeTools } from "../../runtime/tools/policy";
import { appendSetCookie, json, jsonNoStore, readRequestJsonBody } from "../../runtime/http";
import { saveRuntimeSessionFromConversation } from "../../runtime/session";
import { trackUsageEvent } from "../../runtime/usage/tracker";
import { isImageModel } from "../../runtime/model-selection";
import { lookupBucket } from "../../runtime/storage";
import { buildVisionResponsesInput } from "../../runtime/vision/request-builder";
import { messageContentToPlainText } from "../../runtime/vision/messages";
import { AGENTS } from "../agents";
import { appendMetaTags, saveConversationTags, storeConversationTags } from "../conversations";
import type { ChatResponseStopReason, ChatResponseV2, SourceRef } from "../response_contract";
import { isGreetingOrAck, tryComputeArithmetic } from "../response-mode";
import { ensureNonEmptySegments, getSegmentTextLength, stripCitationMarkersFromSegments, stripInlineCitationMarkers } from "../segments";
import type { AnswerSegment, ChatMessage, ChatRequestBody, CitationSource, FileReference, ResolvedResponseMode } from "../types";
import {
  buildRenderHints,
  buildStructuredResponsePlan,
  extractRequestSignals,
  findUserInputRequiredBoundary,
  USER_INPUT_REQUIRED_STOP_REASON,
} from "../../../universal_answer_orchestrator";
import { deriveConversationState, saveConversationState } from "./conversation-state";
import { CitationAccumulator } from "./citation-accumulator";
import { buildDerivedResponseV2, deriveResponseSegmentsFromText } from "./derived-response-v2";
import { buildInstructionLayers, renderInstructionLayers } from "./instruction-builder";
import { sanitizeChatAnswerSegments, stripTrailingSourcesSection } from "./markdown-safe";
import { applyOutputQa } from "./output-qa";
import {
  createChatProvider,
  normalizeSourceKey,
  normalizeWebSearchSources,
  type ProviderMessageRequest,
  type ProviderSendResult,
} from "./provider";
import { buildExecutionPlan, buildPlanStrategyInstructions, parseChatRequestBody } from "./request-plan";
import { rankContextChunks } from "./retrieval-ranker";
import { SemanticStreamBuffer, type SemanticStreamBlock, SEMANTIC_STREAM_PENDING_CHAR_LIMIT } from "./semantic-stream-buffer";
import { buildSourceRegistry } from "./source_registry";
import { StreamBuffer, type StreamBufferFlushResult } from "./stream-buffer";
import { encodeChatEvent } from "./stream-protocol";
import { isStructuredChatEligible, streamStructuredChat } from "./structured_chat";
import { ChatTurnTelemetry } from "./telemetry";
import type { ExecutionPlan, FileContextRecord, ResponsesInputContent, ResponsesInputMessage } from "./types";

const ANSWER_MAX_OUTPUT_TOKENS = 2600;
const ANSWER_MAX_CONTINUATIONS = 6;
const INSTANT_MAX_OUTPUT_TOKENS = 650;
const INSTANT_TEMPERATURE = 0.2;
const CONTINUATION_TAIL_CHARS = 2000;
const FILE_CONTEXT_CHAR_LIMIT = 60_000;
const DERIVED_STRUCTURED_STREAM_DECISION_MS = 250;
const CONTINUATION_INSTRUCTION =
  "You are continuing a partially generated answer only if the previous answer was cut off mid-thought. " +
  "If the previous answer already ended with a short tailoring follow-up that asks the user for more context, stop immediately and return no additional content. " +
  "Do not repeat earlier content or add a '(Continuing...)' label.";
const INSTANT_SYSTEM_PROMPT = `
You are OWEN, a concise assistant.
Answer the user's request directly in 1-2 sentences.
If the request is a greeting or acknowledgement, reply briefly and naturally.
If the request is simple arithmetic, return only the answer.
Be concise but complete.
`.trim();

type ConversationContext = {
  scope: string;
  setCookie?: string;
  authSession: AuthSessionRecord | null;
};

type PreparedExecution = {
  plan: ExecutionPlan;
  instructions: string;
  fileContexts: FileContextRecord[];
  topChunks: Map<string, string[]>;
  baseMessages: ChatMessage[];
  baseInput: ResponsesInputMessage[];
};

type ExecutionOutcome = {
  ok: true;
  content: string;
  continuation?: string;
  answerSegments: AnswerSegment[];
  sources: CitationSource[];
  responseV2?: ChatResponseV2;
  consultedSources?: unknown[];
  warnings?: Array<{ code: string; message: string; details?: Record<string, number> }>;
  renderHints: ReturnType<typeof buildRenderHints>;
  finishReason?: string;
  incompleteReason?: string;
  truncated?: boolean;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    totalTokens: number;
  } | null;
};

type GeneratedTextResult = {
  text: string;
  fullText: string;
  truncated: boolean;
  attempts: number;
  finishReason?: string;
  status?: string;
  incompleteReason?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    totalTokens: number;
  } | null;
};

class CapabilityDeniedError extends Error {
  readonly status: number;
  readonly capability: string;
  readonly reason: string;
  readonly requestedBucket?: string;

  constructor(capability: string, reason: string, requestedBucket?: string) {
    super(`capability_denied:${capability}:${reason}`);
    this.name = "CapabilityDeniedError";
    this.status = 403;
    this.capability = capability;
    this.reason = reason;
    this.requestedBucket = requestedBucket;
  }
}

function accumulateUsage(
  left: GeneratedTextResult["usage"] | ExecutionOutcome["usage"] | null | undefined,
  right: GeneratedTextResult["usage"] | ExecutionOutcome["usage"] | null | undefined,
) {
  if (!left && !right) return null;
  return {
    inputTokens: (left?.inputTokens || 0) + (right?.inputTokens || 0),
    outputTokens: (left?.outputTokens || 0) + (right?.outputTokens || 0),
    cacheCreationInputTokens: (left?.cacheCreationInputTokens || 0) + (right?.cacheCreationInputTokens || 0),
    cacheReadInputTokens: (left?.cacheReadInputTokens || 0) + (right?.cacheReadInputTokens || 0),
    totalTokens: (left?.totalTokens || 0) + (right?.totalTokens || 0),
  };
}

function deriveWorkflowLabel(plan: ExecutionPlan): string {
  if (plan.requestKind === "instant") return "chat.instant";
  if (plan.requestKind === "continuation") return "chat.continue";
  if (plan.requestKind === "image") return "chat.image";
  if (plan.retrieval.mode === "web_search") return "chat.retrieval";
  if (plan.files.length > 0) return "chat.attachments";
  return "chat.answer";
}

function deriveRequestedToolSet(plan: ExecutionPlan): string[] {
  const tools = new Set<string>();
  if (plan.files.length > 0) tools.add("files");
  if (plan.retrieval.mode === "web_search") tools.add("web_search");
  return Array.from(tools);
}

async function recordCapabilityDenied(
  env: Env,
  details: {
    requestId: string;
    plan: ExecutionPlan;
    capability: string;
    reason: string;
    requestedBucket?: string;
  },
): Promise<void> {
  await recordMetricEvent(env, {
    name: "runtime_capability_denied",
    requestId: details.requestId,
    role: undefined,
    metadata: {
      agentId: details.plan.agentId,
      capability: details.capability,
      reason: details.reason,
      requestedBucket: details.requestedBucket,
      permissionMode: details.plan.permissionMode,
    },
  }).catch(() => undefined);
}

async function assertPlanCapabilitiesAllowed(env: Env, plan: ExecutionPlan, requestId: string): Promise<void> {
  const agentTools = AGENTS[plan.agentId]?.tools || [];
  for (const file of plan.files) {
    const decision = filterAllowedRuntimeTools(["files"], {
      env,
      requestId,
      agentId: plan.agentId,
      permissionMode: plan.permissionMode,
      allowedBuckets: plan.allowedBuckets,
      allowedRuntimeCapabilities: plan.allowedRuntimeCapabilities as Array<"files" | "web_search" | "none">,
      requestedBucket: file.bucket,
      declaredAgentTools: agentTools,
      webSearchAvailable: false,
      hasFiles: true,
      featureEnabled: true,
    }).decisions[0];
    if (decision && !decision.allowed) {
      await recordCapabilityDenied(env, {
        requestId,
        plan,
        capability: "files",
        reason: decision.reason,
        requestedBucket: file.bucket,
      });
      throw new CapabilityDeniedError("files", decision.reason, file.bucket);
    }
  }
  if (plan.retrieval.mode === "web_search") {
    const decision = filterAllowedRuntimeTools(["web_search"], {
      env,
      requestId,
      agentId: plan.agentId,
      permissionMode: plan.permissionMode,
      allowedBuckets: plan.allowedBuckets,
      allowedRuntimeCapabilities: plan.allowedRuntimeCapabilities as Array<"files" | "web_search" | "none">,
      declaredAgentTools: agentTools,
      webSearchAvailable: true,
      hasFiles: plan.files.length > 0,
      featureEnabled: true,
      retrievalRequired: plan.retrieval.required,
    }).decisions[0];
    if (decision && !decision.allowed && plan.retrieval.required) {
      await recordCapabilityDenied(env, {
        requestId,
        plan,
        capability: "web_search",
        reason: decision.reason,
      });
      throw new CapabilityDeniedError("web_search", decision.reason);
    }
  }
}

async function persistRuntimeCompletionSession(
  env: Env,
  plan: ExecutionPlan,
  answerText: string,
  requestId: string,
): Promise<void> {
  if (!plan.conversationId) return;
  const createdAt = Date.now();
  const messages: Array<{
    id: string;
    role: "system" | "user" | "assistant";
    content: string;
    createdAt: number;
    metadata?: Record<string, unknown>;
  }> = plan.messages.map((message, index) => ({
    id: `msg-${plan.conversationId}-${index + 1}`,
    role: message.role,
    content: messageContentToPlainText(message.content),
    createdAt: createdAt - (plan.messages.length - index) * 1000,
    metadata: index === plan.messages.length - 1 ? { requestId } : undefined,
  }));
  messages.push({
    id: `msg-${plan.conversationId}-assistant-${Date.now().toString(36)}`,
    role: "assistant" as const,
    content: answerText,
    createdAt: Date.now(),
    metadata: { requestId, model: plan.modelId, responseMode: plan.responseMode, resolvedResponseMode: plan.resolvedResponseMode },
  });
  await saveRuntimeSessionFromConversation(env, plan.conversationScope, {
    id: plan.conversationId,
    title: plan.lastUserPrompt.slice(0, 80) || "Conversation",
    createdAt,
    updatedAt: Date.now(),
    selectedDocId: plan.files[0]?.key || null,
    selectedDocTitle: plan.files[0]?.displayName || "",
    truncated: plan.compactedTranscript.triggered,
    messages,
  }, { source: "runtime_completion", lastRequestId: requestId });
}

async function recordChatUsage(
  env: Env,
  context: ConversationContext,
  plan: ExecutionPlan,
  requestPath: string,
  requestId: string,
  startedAt: number,
  success: boolean,
  usage: ExecutionOutcome["usage"] | GeneratedTextResult["usage"] | null | undefined,
  errorCode?: string,
) {
  const session = context.authSession;
  await trackUsageEvent(env, {
    requestId,
    route: requestPath,
    workflow: deriveWorkflowLabel(plan),
    sessionId: plan.conversationId || null,
    conversationId: plan.conversationId || null,
    userId: session?.userId || null,
    role: session?.role || null,
    institutionId: session?.institutionId || null,
    courseId: session?.courseIds?.[0] || null,
    lectureId: plan.files[0]?.key || null,
    modelId: plan.modelId,
    provider: "openai",
    latencyMs: Date.now() - startedAt,
    success,
    errorCode: errorCode || null,
    permissionMode: plan.permissionMode,
    toolSet: deriveRequestedToolSet(plan),
    usage: usage || null,
    metadata: {
      requestKind: plan.requestKind,
      responseMode: plan.resolvedResponseMode,
      retrievalMode: plan.retrieval.mode,
    },
  }).catch(() => undefined);
}

function buildSseHeaders() {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, max-age=0, no-cache, no-transform",
    connection: "keep-alive",
  };
}

function ensureInstantSentenceClosure(text: string): string {
  const trimmed = (text || "").trim();
  if (!trimmed) return "";
  if (/[.!?]["'”’)\]]*$/.test(trimmed)) return trimmed;
  return `${trimmed}.`;
}

function resolveInstantGreeting(text: string): string | null {
  if (!isGreetingOrAck(text)) return null;
  if (/\b(thanks|thx)\b/i.test(text)) return "You're welcome.";
  if (/\b(ok|okay|k|lol)\b/i.test(text)) return "Got it.";
  return "Hi!";
}

function normalizeContinuationText(body: ChatRequestBody): string {
  return typeof body.continuation?.text === "string" ? body.continuation.text.trim() : "";
}

function stripExtensions(value?: string | null) {
  if (!value) return "";
  return value.replace(/\.ocr\.txt$/i, "").replace(/\.txt$/i, "").replace(/\.pdf$/i, "");
}

function uniqueStrings(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(trimmed);
  }
  return results;
}

function isTextKeyByExtension(key: string) {
  return /\.(txt|csv|json|xml|md|markdown|html|log)$/i.test(key);
}

function isTextContentType(contentType: string) {
  const lowered = (contentType || "").toLowerCase();
  return Boolean(
    lowered.startsWith("text/") ||
      lowered.includes("json") ||
      lowered.includes("csv") ||
      lowered.includes("xml"),
  );
}

function buildOcrCandidateKeys(file: FileReference) {
  const trimmedKey = file.key?.trim() || "";
  const trimmedTextKey = file.textKey?.trim() || "";
  const base = stripExtensions(trimmedKey);
  const textKeyBase = stripExtensions(trimmedTextKey);
  const baseLower = base.toLowerCase();
  return uniqueStrings([
    trimmedTextKey,
    trimmedTextKey ? `${trimmedTextKey}.ocr.txt` : null,
    trimmedTextKey ? `${trimmedTextKey}.txt` : null,
    trimmedKey ? `${trimmedKey}.ocr.txt` : null,
    trimmedKey ? `${trimmedKey}.txt` : null,
    base ? `${base}.ocr.txt` : null,
    base ? `${base}.txt` : null,
    base ? `ocr/${base}.txt` : null,
    base ? `ocr/${base}.ocr.txt` : null,
    base ? `transcripts/${base}.txt` : null,
    base ? `transcripts/${base}.ocr.txt` : null,
    textKeyBase ? `${textKeyBase}.ocr.txt` : null,
    textKeyBase ? `${textKeyBase}.txt` : null,
    baseLower ? `${baseLower}.txt` : null,
    baseLower ? `${baseLower}.ocr.txt` : null,
  ]);
}

function buildOriginalTextCandidates(file: FileReference) {
  const trimmedKey = file.key?.trim() || "";
  const trimmedTextKey = file.textKey?.trim() || "";
  const base = stripExtensions(trimmedKey);
  return uniqueStrings([
    isTextKeyByExtension(trimmedKey) ? trimmedKey : null,
    isTextKeyByExtension(trimmedTextKey) ? trimmedTextKey : null,
    base ? `${base}.txt` : null,
    trimmedKey ? `${trimmedKey}.txt` : null,
  ]);
}

async function loadFileTextFromBucket(bucket: R2Bucket, file: FileReference) {
  const candidates = [
    ...buildOcrCandidateKeys(file).map((key) => ({ key, source: "ocr" as const })),
    ...buildOriginalTextCandidates(file).map((key) => ({ key, source: "original" as const })),
  ];
  for (const candidate of candidates) {
    try {
      const object = await bucket.get(candidate.key);
      if (!object) continue;
      const contentType = object.httpMetadata?.contentType || "";
      const treatAsText = candidate.source === "ocr" || isTextKeyByExtension(candidate.key);
      if (!treatAsText && !isTextContentType(contentType)) continue;
      const text = await object.text();
      if (!text.trim()) continue;
      return { text, source: candidate.source, key: candidate.key };
    } catch {
      continue;
    }
  }
  return null;
}

async function loadFileContexts(
  files: FileReference[],
  env: Env,
  plan: ExecutionPlan,
  requestId: string,
): Promise<FileContextRecord[]> {
  const contexts: FileContextRecord[] = [];
  let consumedChars = 0;
  for (const file of files) {
    const fileDecision = filterAllowedRuntimeTools(["files"], {
      env,
      requestId,
      agentId: plan.agentId,
      permissionMode: plan.permissionMode,
      allowedBuckets: plan.allowedBuckets,
      allowedRuntimeCapabilities: plan.allowedRuntimeCapabilities as Array<"files" | "web_search" | "none">,
      requestedBucket: file.bucket,
      declaredAgentTools: AGENTS[plan.agentId]?.tools || [],
      webSearchAvailable: false,
      hasFiles: true,
      featureEnabled: true,
    }).decisions[0];
    if (!fileDecision?.allowed) {
      await recordCapabilityDenied(env, {
        requestId,
        plan,
        capability: "files",
        reason: fileDecision?.reason || "capability_denied",
        requestedBucket: file.bucket,
      });
      throw new CapabilityDeniedError("files", fileDecision?.reason || "capability_denied", file.bucket);
    }
    const lookup = lookupBucket(env, file.bucket);
    if (!lookup) continue;
    const record = await loadFileTextFromBucket(lookup.bucket, file);
    if (!record) continue;
    if (consumedChars >= FILE_CONTEXT_CHAR_LIMIT) break;
    const remaining = FILE_CONTEXT_CHAR_LIMIT - consumedChars;
    let text = record.text;
    if (text.length > remaining) {
      text = `${text.slice(0, remaining)}\n[Attachment truncated due to context limit]`;
    }
    consumedChars += text.length;
    contexts.push({
      displayName: file.displayName || file.key,
      source: record.source,
      text,
      bucket: file.bucket,
      resolvedBucket: lookup.name,
      originalKey: file.key,
      resolvedKey: record.key,
      textKey: file.textKey,
    });
  }
  return contexts;
}

function buildChatMessages(
  plan: ExecutionPlan,
  instructions: string,
  fileContexts: FileContextRecord[],
  topChunks: Map<string, string[]>,
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: instructions }];
  const explicitSystemMessages = plan.messages.filter((message) => message.role === "system");
  explicitSystemMessages.forEach((message) => messages.push(message));

  fileContexts.forEach((context) => {
    const selectedChunks = topChunks.get(context.resolvedKey) || [context.text];
    const attachmentText = selectedChunks
      .map((chunk, index) => `Attachment: ${context.displayName}\nChunk ${index + 1}:\n${chunk}`)
      .join("\n\n");
    messages.push({ role: "user", content: attachmentText });
  });

  const preserved = plan.compactedTranscript.preservedMessages.filter((message) => message.role !== "system");
  preserved.forEach((message) => messages.push(message));
  return messages;
}

function clipAnswerTail(answer: string, limit = CONTINUATION_TAIL_CHARS): string {
  const trimmed = (answer || "").trim();
  if (trimmed.length <= limit) return trimmed;
  return trimmed.slice(-limit);
}

function combineSegments(segments: string[]): string {
  return segments.reduce((acc, segment) => {
    if (!segment) return acc;
    if (!acc) return segment;
    const needsSpace =
      !acc.endsWith("\n") &&
      !segment.startsWith("\n") &&
      !acc.endsWith(" ") &&
      !segment.startsWith(" ");
    const midWord = /[A-Za-z0-9]$/.test(acc) && /^[A-Za-z0-9]/.test(segment);
    return acc + (needsSpace && !midWord ? " " : "") + segment;
  }, "");
}

function hasUnbalancedDelimiters(text: string): boolean {
  const stack: string[] = [];
  const openers: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const closers = new Set(Object.values(openers));
  for (const character of text) {
    if (openers[character]) {
      stack.push(openers[character]);
      continue;
    }
    if (closers.has(character)) {
      if (!stack.length) return true;
      if (character !== stack.pop()) return true;
    }
  }
  const quoteCount = (text.match(/"/g) || []).length;
  const openCurly = (text.match(/“/g) || []).length;
  const closeCurly = (text.match(/”/g) || []).length;
  if (quoteCount % 2 === 1) return true;
  if (openCurly !== closeCurly) return true;
  return stack.length > 0;
}

function isUnfinishedListLine(line: string): boolean {
  const trimmed = (line || "").trim();
  if (!trimmed) return false;
  if (/^[-*+]\s*$/.test(trimmed)) return true;
  if (/^\d+[.)]\s*$/.test(trimmed)) return true;
  return false;
}

function endsMidWord(text: string): boolean {
  const trimmed = (text || "").trim();
  if (!trimmed || /[.!?…)]$/.test(trimmed)) return false;
  const tokens = trimmed.split(/\s+/);
  const lastToken = (tokens[tokens.length - 1] || "").toLowerCase();
  if (!/^[a-z]{3,}$/.test(lastToken)) return false;
  if (new Set(["a", "an", "the", "and", "or", "but", "so", "to", "of", "in", "on", "at", "by", "for"]).has(lastToken)) {
    return false;
  }
  return trimmed.length > 80 || tokens.length > 12;
}

function detectIncompleteReason(text: string): string | null {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  if (hasUnbalancedDelimiters(trimmed)) return "unbalanced_delimiters";
  const lastLine = trimmed.split(/\r?\n/).pop() || "";
  if (isUnfinishedListLine(lastLine)) return "unfinished_list";
  if (/[,;:—-]\s*$/.test(trimmed)) return "dangling_punctuation";
  if (endsMidWord(trimmed)) return "mid_word";
  return null;
}

function trimAtUserInputRequiredBoundary(text: string): {
  text: string;
  stopReason?: typeof USER_INPUT_REQUIRED_STOP_REASON;
  trimmed: boolean;
} {
  const boundary = findUserInputRequiredBoundary(text);
  if (boundary === null) {
    return { text, trimmed: false };
  }
  const nextText = boundary < text.length ? text.slice(0, boundary).trim() : text.trim();
  return {
    text: nextText,
    stopReason: USER_INPUT_REQUIRED_STOP_REASON,
    trimmed: boundary < text.length,
  };
}

function normalizeHeadingText(line: string): string {
  return line
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[-*•]\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/[:.]+$/, "")
    .trim()
    .toLowerCase();
}

function isLikelyHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^#{1,6}\s+\S/.test(trimmed)) return true;
  if (/^\*\*[A-Za-z0-9].*\*\*:?$/.test(trimmed)) return true;
  if (/^[A-Z][A-Za-z0-9 ()./'-]{1,80}:?$/.test(trimmed) && !/^[-*•]/.test(trimmed)) {
    return trimmed.split(/\s+/).length <= 10;
  }
  return false;
}

function findTrailingHeading(text: string): string | null {
  const lines = (text || "").split(/\r?\n/).slice(-8).reverse();
  for (const line of lines) {
    if (isLikelyHeading(line)) return normalizeHeadingText(line);
  }
  return null;
}

function stripDuplicateLeadingHeaders(segment: string, prior: string): string {
  const priorHeading = findTrailingHeading(prior);
  const lines = (segment || "").split(/\r?\n/);
  while (lines.length) {
    const line = lines[0] || "";
    if (!isLikelyHeading(line)) break;
    if (priorHeading && normalizeHeadingText(line) === priorHeading) {
      lines.shift();
      continue;
    }
    break;
  }
  while (lines.length && !(lines[0] || "").trim()) lines.shift();
  return lines.join("\n");
}

function prepareContinuationSegment(
  segment: string,
  prior: string,
): { text: string } {
  return { text: stripDuplicateLeadingHeaders(segment, prior) };
}

function looksTruncatedText(text: string): boolean {
  const trimmed = (text || "").trim();
  if (!trimmed) return false;
  if (trimmed.endsWith("</table>")) return false;
  if (/[.!?…)]$/.test(trimmed)) return false;
  if (trimmed.endsWith("...")) return true;
  const lastLine = trimmed.split(/\r?\n/).pop()?.trim() || "";
  if (/[,;:/-]\s*$/.test(lastLine)) return true;
  return trimmed.length > 500 && !/[.!?…)]$/.test(lastLine);
}

function shouldContinueAnswer(
  result: ProviderSendResult,
  maxOutputTokens: number,
  segmentText: string,
  accumulatedText = segmentText,
): boolean {
  if (findUserInputRequiredBoundary(accumulatedText) !== null) return false;
  const finish = (result.finishReason || "").toLowerCase();
  const incomplete = (result.incompleteReason || "").toLowerCase();
  if (finish === "length" || finish === "max_tokens") return true;
  if (incomplete.includes("max") || incomplete.includes("length")) return true;
  if (result.status && result.status !== "completed" && result.status !== "finished") return true;
  if (detectIncompleteReason(accumulatedText)) return true;
  const nearCap = typeof result.outputTokens === "number" && result.outputTokens >= maxOutputTokens - 20;
  if (nearCap) return true;
  return looksTruncatedText(segmentText) && (nearCap || segmentText.length >= 1200);
}

function buildContinuationMessages(baseMessages: ChatMessage[], accumulatedText: string, resumeInstruction?: string): ChatMessage[] {
  return [
    ...baseMessages,
    { role: "assistant", content: clipAnswerTail(accumulatedText) || "(previous answer abbreviated for continuation)" },
    { role: "user", content: resumeInstruction || CONTINUATION_INSTRUCTION },
  ];
}

function buildContinuationResponsesInput(
  baseInput: ResponsesInputMessage[],
  accumulatedText: string,
  resumeInstruction?: string,
): ResponsesInputMessage[] {
  const continuationParts: ResponsesInputContent[] = [];
  if (accumulatedText) {
    continuationParts.push({
      type: "input_text",
      text: `Partial answer so far:\n${clipAnswerTail(accumulatedText)}`,
    });
  }
  continuationParts.push({ type: "input_text", text: resumeInstruction || CONTINUATION_INSTRUCTION });
  return [...baseInput, { role: "user", content: continuationParts }];
}

function resolveFreeResponseMinSources(env: Env): number {
  return getRuntimeFeatures(env).freeResponse.minDistinctSources;
}

function resolveLongAnswerThreshold(env: Env): number {
  return getRuntimeFeatures(env).rendering.longAnswerThresholdChars;
}

function resolveTypewriterSpeedMs(env: Env): number | undefined {
  return getRuntimeFeatures(env).rendering.typewriterSpeedMs;
}

function buildFreeResponseWarnings(params: {
  citationCount: number;
  minUniqueSources: number;
  searchSourceCount: number;
  hasSearchSources: boolean;
}) {
  const warnings: Array<{ code: "INSUFFICIENT_SOURCES" | "NO_WEB_SOURCES"; message: string; details?: Record<string, number> }> = [];
  if (!params.hasSearchSources) {
    warnings.push({
      code: "NO_WEB_SOURCES",
      message: "No web sources were returned for this answer.",
      details: { searchSourceCount: params.searchSourceCount },
    });
  }
  if (params.citationCount < params.minUniqueSources) {
    warnings.push({
      code: "INSUFFICIENT_SOURCES",
      message: `Returned ${params.citationCount} distinct citation sources; target was ${params.minUniqueSources}.`,
      details: {
        citationCount: params.citationCount,
        minUniqueSources: params.minUniqueSources,
        searchSourceCount: params.searchSourceCount,
      },
    });
  }
  return warnings;
}

function buildFallbackCitationSources(
  normalizedSources: ReturnType<typeof normalizeWebSearchSources>,
): CitationSource[] {
  return normalizedSources.map((source, index) => ({
    id: index + 1,
    url: source.url,
    title: source.title,
    domain: source.domain,
    snippet: source.snippet,
    retrievedAt: source.retrievedAt,
  }));
}

function sanitizeFinalChatPayload(params: {
  answerSegments: AnswerSegment[];
  answerText: string;
  sources: CitationSource[];
}): {
  answerSegments: AnswerSegment[];
  answerText: string;
  sources: CitationSource[];
} {
  const baseSegments: AnswerSegment[] = params.answerSegments.length
    ? params.answerSegments
    : params.answerText
      ? [{ type: "text", text: params.answerText }]
      : [];
  const sanitized = sanitizeChatAnswerSegments(baseSegments, {
    stripTrailingSourcesSection: params.sources.length > 0,
  });

  return {
    answerSegments: sanitized.answerSegments,
    answerText: sanitized.answerText,
    sources: Array.isArray(params.sources) ? params.sources : [],
  };
}

function getDerivedSectionTitle(plan: ExecutionPlan): string {
  return buildStructuredResponsePlan({
    message: plan.lastUserPrompt,
    classification: plan.classification,
    selection: plan.strategy,
    signals: extractRequestSignals(plan.lastUserPrompt),
  }).sectionPlan[0]?.title || "Answer";
}

function resolveStructuredStopReason(
  truncated?: boolean,
  explicitStopReason?: ChatResponseStopReason,
): ChatResponseStopReason {
  if (explicitStopReason) return explicitStopReason;
  return truncated ? "max_tokens" : "complete";
}

function buildDerivedResponsePayload(params: {
  plan: ExecutionPlan;
  answerText: string;
  sources: CitationSource[];
  truncated?: boolean;
  stopReason?: ChatResponseStopReason;
}): ChatResponseV2 | undefined {
  const rawText = params.sources.length ? stripTrailingSourcesSection(params.answerText) : params.answerText.trim();
  const responseV2 = buildDerivedResponseV2({
    text: rawText,
    sources: params.sources,
    sectionTitle: getDerivedSectionTitle(params.plan),
    stopReason: resolveStructuredStopReason(params.truncated, params.stopReason),
    truncated: params.truncated,
  });
  return responseV2 || undefined;
}

function forceInstantRenderHintsIfStructured(
  renderHints: ReturnType<typeof buildRenderHints>,
  responseV2?: ChatResponseV2,
): ReturnType<typeof buildRenderHints> {
  if (!responseV2) return renderHints;
  return {
    ...renderHints,
    renderMode: "instant",
  };
}

function buildStructuredSourceRefs(sources: CitationSource[]): SourceRef[] {
  return buildSourceRegistry(
    (sources || []).map((source) => ({
      url: source.url,
      title: source.title,
      domain: source.domain,
      snippet: source.snippet,
    })),
  );
}

function finalizeRetrievalAnswerPayload(
  raw: any,
  env: Env,
  accumulator = new CitationAccumulator(),
): {
  answerText: string;
  answerSegments: AnswerSegment[];
  sources: CitationSource[];
  consultedSources: unknown[];
  warnings?: Array<{ code: string; message: string; details?: Record<string, number> }>;
} {
  if (raw) {
    accumulator.mergeProviderPayload(raw);
  }
  const finalized = accumulator.finalize();
  const consultedSources = finalized.consultedSources || [];
  const normalizedSources = normalizeWebSearchSources(consultedSources);
  const citationSources = finalized.sources || [];
  const allowlist = new Set(normalizedSources.map((source) => normalizeSourceKey(source.url)));
  const invalidCitations = allowlist.size
    ? citationSources.filter((source) => !allowlist.has(normalizeSourceKey(source.url)))
    : citationSources;
  const shouldStripCitations = !normalizedSources.length || !citationSources.length || invalidCitations.length > 0;
  let answerSegments = shouldStripCitations ? stripCitationMarkersFromSegments(finalized.answerSegments) : finalized.answerSegments;
  let sources = shouldStripCitations ? buildFallbackCitationSources(normalizedSources) : citationSources;
  if (getSegmentTextLength(answerSegments) === 0 && finalized.answerText) {
    answerSegments = [{ type: "text", text: stripInlineCitationMarkers(finalized.answerText) }];
  }
  const sanitized = sanitizeFinalChatPayload({
    answerSegments,
    answerText: finalized.answerText,
    sources,
  });
  const warnings = buildFreeResponseWarnings({
    citationCount: citationSources.length,
    minUniqueSources: resolveFreeResponseMinSources(env),
    searchSourceCount: normalizedSources.length,
    hasSearchSources: normalizedSources.length > 0,
  });
  const ensured = ensureNonEmptySegments(sanitized.answerSegments, warnings.length ? warnings : undefined);
  return {
    answerText: ensured.answerSegments.map((segment) => (segment.type === "text" ? segment.text : "")).join("").trim(),
    answerSegments: ensured.answerSegments,
    sources: sanitized.sources,
    consultedSources,
    warnings: ensured.warnings,
  };
}

async function resolveConversationContext(request: Request, env: Env): Promise<ConversationContext> {
  if (!env.DOCS_KV || typeof env.DOCS_KV.put !== "function") {
    return { scope: "anonymous", authSession: null };
  }
  const sessionStore = createRuntimeSessionStore(env, getAppConfig(env, request));
  const { scope, browserSession, authSession } = await sessionStore.resolveConversationScope(request);
  return {
    scope,
    setCookie: browserSession.cookie,
    authSession,
  };
}

async function parseRequestBody(request: Request): Promise<ChatRequestBody | null> {
  const raw = await readRequestJsonBody(request);
  return parseChatRequestBody(raw);
}

async function prepareExecution(plan: ExecutionPlan, env: Env, requestId: string): Promise<PreparedExecution> {
  const fileContexts = plan.files.length ? await loadFileContexts(plan.files, env, plan, requestId) : [];
  const topChunks = fileContexts.length ? rankContextChunks(plan.lastUserPrompt, fileContexts, plan.retrieval) : new Map<string, string[]>();
  const strategyInstructions = buildPlanStrategyInstructions(plan);
  const layers = buildInstructionLayers(plan, strategyInstructions, fileContexts);
  const instructions = renderInstructionLayers(layers);
  const baseInput = await buildVisionResponsesInput({
    env,
    explicitSystemMessages: plan.messages.filter((message) => message.role === "system"),
    historyMessages: plan.compactedTranscript.preservedMessages.filter((message) => message.role !== "system"),
    fileContexts,
    topChunks,
    visionFiles: plan.visionFiles,
    inlineMaxBytes: getRuntimeFeatures(env).vision.inlineMaxBytes,
  });
  return {
    plan,
    instructions,
    fileContexts,
    topChunks,
    baseMessages: buildChatMessages(plan, instructions, fileContexts, topChunks),
    baseInput,
  };
}

async function buildProviderRequest(
  prepared: PreparedExecution,
  env: Env,
  requestId: string,
  accumulatedText = "",
): Promise<ProviderMessageRequest> {
  const { plan } = prepared;
  if (plan.providerMode === "responses") {
    const toolPolicy = filterAllowedRuntimeTools(["web_search"], {
      env,
      requestId,
      agentId: plan.agentId,
      permissionMode: plan.permissionMode,
      allowedBuckets: plan.allowedBuckets,
      allowedRuntimeCapabilities: plan.allowedRuntimeCapabilities as Array<"files" | "web_search" | "none">,
      declaredAgentTools: AGENTS[plan.agentId]?.tools || [],
      webSearchAvailable: plan.retrieval.mode === "web_search",
      hasFiles: plan.files.length > 0,
      featureEnabled: plan.retrieval.mode === "web_search",
      retrievalRequired: plan.retrieval.required,
    });
    const webSearchDecision = toolPolicy.decisions.find((decision) => decision.toolId === "web_search");
    if (plan.retrieval.mode === "web_search" && webSearchDecision && !webSearchDecision.allowed && plan.retrieval.required) {
      await recordCapabilityDenied(env, {
        requestId,
        plan,
        capability: "web_search",
        reason: webSearchDecision.reason,
      });
      throw new CapabilityDeniedError("web_search", webSearchDecision.reason);
    }
    const toolConfig = buildResponsesToolConfig(toolPolicy.allowed, "auto");
    const input = accumulatedText
      ? buildContinuationResponsesInput(prepared.baseInput, accumulatedText, plan.compactedTranscript.resumeInstruction)
      : prepared.baseInput;
    return {
      mode: "responses",
      model: plan.modelId,
      input,
      instructions: prepared.instructions,
      ...toolConfig,
      max_output_tokens: ANSWER_MAX_OUTPUT_TOKENS,
    };
  }

  return {
    mode: "chat_completions",
    model: plan.modelId,
    messages: accumulatedText
      ? buildContinuationMessages(prepared.baseMessages, accumulatedText, plan.compactedTranscript.resumeInstruction)
      : prepared.baseMessages,
    max_completion_tokens: ANSWER_MAX_OUTPUT_TOKENS,
  };
}

async function runContinuationLoop(
  env: Env,
  prepared: PreparedExecution,
  requestId: string,
  provider = createChatProvider(env),
  initialText = "",
): Promise<GeneratedTextResult> {
  const attemptsLimit = Math.max(1, ANSWER_MAX_CONTINUATIONS + 1);
  let accumulated = initialText || "";
  const initialStop = trimAtUserInputRequiredBoundary(accumulated);
  if (initialStop.stopReason) {
    accumulated = initialStop.text;
    return {
      text: "",
      fullText: accumulated,
      truncated: false,
      attempts: 0,
    };
  }
  const baseLength = accumulated.length;
  let attempts = 0;
  let truncated = false;
  let finishReason: string | undefined;
  let status: string | undefined;
  let incompleteReason: string | undefined;
  let usage: GeneratedTextResult["usage"] = null;

  while (attempts < attemptsLimit) {
    attempts += 1;
    const request = await buildProviderRequest(prepared, env, requestId, attempts === 1 ? accumulated : accumulated);
    const result = await provider.sendMessage(request);
    finishReason = result.finishReason || finishReason;
    status = result.status || status;
    incompleteReason = result.incompleteReason || incompleteReason;
    usage = accumulateUsage(usage, result.usage);
    let segment = (result.text || "").trim();
    if (segment) {
      if (attempts > 1 || accumulated) {
        const preparedSegment = prepareContinuationSegment(segment, accumulated);
        segment = preparedSegment.text;
      }
      accumulated = combineSegments([accumulated, segment]);
      const userInputStop = trimAtUserInputRequiredBoundary(accumulated);
      if (userInputStop.stopReason) {
        accumulated = userInputStop.text;
        truncated = false;
        break;
      }
    }
    if (!shouldContinueAnswer(result, ANSWER_MAX_OUTPUT_TOKENS, segment, accumulated)) {
      truncated = false;
      break;
    }
    if (attempts >= attemptsLimit) {
      truncated = true;
    }
  }

  return {
    text: accumulated.slice(baseLength),
    fullText: accumulated,
    truncated,
    attempts,
    finishReason,
    status,
    incompleteReason,
    usage,
  };
}

function buildJsonPayload(
  outcome: ExecutionOutcome,
  plan: ExecutionPlan,
): Record<string, unknown> {
  return {
    ok: true,
    content: outcome.content,
    answerSegments: outcome.answerSegments,
    sources: Array.isArray(outcome.sources) ? outcome.sources : [],
    responseV2: outcome.responseV2,
    consultedSources: outcome.consultedSources,
    warnings: outcome.warnings,
    renderHints: outcome.renderHints,
    finishReason: outcome.finishReason,
    incompleteReason: outcome.incompleteReason,
    truncated: outcome.truncated,
    resolvedResponseMode: plan.resolvedResponseMode,
  };
}

function persistSemanticState(
  env: Env,
  plan: ExecutionPlan,
  outcome: ExecutionOutcome,
): Promise<void> {
  const nextState = deriveConversationState({
    priorState: plan.conversationState,
    messages: [...plan.messages, { role: "assistant", content: outcome.content }],
    lastUserPrompt: plan.lastUserPrompt,
    intent: plan.classification.intent,
    topic: plan.conversationState?.topic || plan.lastUserPrompt.slice(0, 140),
    activeDocIds: plan.files.map((file) => file.key),
    responseModeBias: plan.resolvedResponseMode,
  });
  return saveConversationState(env, plan.conversationScope, plan.conversationId, nextState);
}

async function executeNonStreaming(plan: ExecutionPlan, env: Env, requestId: string): Promise<ExecutionOutcome> {
  const provider = createChatProvider(env);
  const telemetry = new ChatTurnTelemetry(plan.modelId);
  telemetry.setCompactionTriggered(plan.compactedTranscript.triggered);
  const retrievalStart = Date.now();
  const prepared = await prepareExecution(plan, env, requestId);
  telemetry.setRetrievalMs(Date.now() - retrievalStart);

  let content = "";
  let continuation: string | undefined;
  let answerSegments: AnswerSegment[] = [];
  let sources: CitationSource[] = [];
  let responseV2: ChatResponseV2 | undefined;
  let rawResponseText = "";
  let consultedSources: unknown[] | undefined;
  let warnings: ExecutionOutcome["warnings"];
  let finishReason: string | undefined;
  let incompleteReason: string | undefined;
  let truncated = false;
  let usage: ExecutionOutcome["usage"] = null;
  const renderStats = { charCount: 0, sourceCount: 0 };

  if (plan.requestKind === "continuation") {
    const result = await runContinuationLoop(env, prepared, requestId, provider, plan.continuationText || "");
    content = result.fullText;
    rawResponseText = content;
    continuation = result.text;
    finishReason = result.finishReason;
    incompleteReason = detectIncompleteReason(result.fullText) || result.incompleteReason;
    truncated = result.truncated;
    usage = result.usage;
    telemetry.setContinuationAttempts(result.attempts);
    answerSegments = [{ type: "text", text: content }];
    renderStats.charCount = content.trim().length;
  } else {
    const result = await provider.sendMessage(await buildProviderRequest(prepared, env, requestId));
    content = result.text;
    rawResponseText = content;
    finishReason = result.finishReason;
    incompleteReason = detectIncompleteReason(content) || result.incompleteReason;
    usage = result.usage;
    if (plan.retrieval.mode === "web_search" && result.raw) {
      const accumulator = new CitationAccumulator();
      const cited = finalizeRetrievalAnswerPayload(result.raw, env, accumulator);
      content = cited.answerText || content;
      answerSegments = cited.answerSegments;
      sources = cited.sources;
      consultedSources = cited.consultedSources;
      warnings = cited.warnings;
      renderStats.sourceCount = cited.sources.length;
    } else {
      answerSegments = content ? [{ type: "text", text: content }] : [];
    }
  }

  const sanitized = sanitizeFinalChatPayload({
    answerSegments,
    answerText: content,
    sources,
  });
  content = sanitized.answerText || content;
  answerSegments = sanitized.answerSegments;
  sources = sanitized.sources;
  renderStats.charCount = content.trim().length;
  renderStats.sourceCount = sources.length;

  const qaStart = Date.now();
  const qa = applyOutputQa({
    answerText: content,
    answerSegments,
    sources,
    resolvedResponseMode: plan.resolvedResponseMode,
    longAnswerChars: resolveLongAnswerThreshold(env),
    typewriterSpeedMs: resolveTypewriterSpeedMs(env),
    markdownSafe: true,
    renderStats,
  });
  telemetry.setQaMs(Date.now() - qaStart);
  telemetry.setSourceCount(qa.sources.length);
  if (qa.renderHints.stopReason === USER_INPUT_REQUIRED_STOP_REASON) {
    truncated = false;
  }
  telemetry.setTruncated(Boolean(truncated));
  responseV2 = buildDerivedResponsePayload({
    plan,
    answerText: qa.answerText,
    sources: qa.sources,
    truncated,
    stopReason: qa.renderHints.stopReason,
  });
  const renderHints = forceInstantRenderHintsIfStructured(qa.renderHints, responseV2);

  return {
    ok: true,
    content: qa.answerText,
    continuation,
    answerSegments: qa.answerSegments,
    sources: qa.sources,
    responseV2,
    consultedSources,
    warnings,
    renderHints,
    finishReason,
    incompleteReason,
    truncated,
    usage,
  };
}

async function handleInstant(
  plan: ExecutionPlan,
  env: Env,
  requestId: string,
): Promise<{ response: Response; usage: ExecutionOutcome["usage"]; content: string | null }> {
  const hasVisionInputs = plan.hasInlineImages || plan.visionFiles.length > 0;
  if (!hasVisionInputs) {
    const arithmetic = tryComputeArithmetic(plan.lastUserPrompt);
    if (arithmetic) {
      const content = ensureInstantSentenceClosure(arithmetic.answer);
      return {
        response: jsonNoStore({
          ok: true,
          answer: content,
          resolvedResponseMode: plan.resolvedResponseMode,
        }),
        usage: null,
        content,
      };
    }
    const greeting = resolveInstantGreeting(plan.lastUserPrompt);
    if (greeting) {
      const content = ensureInstantSentenceClosure(greeting);
      return {
        response: jsonNoStore({
          ok: true,
          answer: content,
          resolvedResponseMode: plan.resolvedResponseMode,
        }),
        usage: null,
        content,
      };
    }
  }

  const provider = createChatProvider(env);
  const prepared = hasVisionInputs ? await prepareExecution(plan, env, requestId) : null;
  const result = await provider.sendMessage({
    mode: "responses",
    model: plan.modelId,
    input: prepared?.baseInput || [{ role: "user", content: [{ type: "input_text", text: plan.lastUserPrompt }] }],
    instructions: prepared?.instructions || INSTANT_SYSTEM_PROMPT,
    max_output_tokens: INSTANT_MAX_OUTPUT_TOKENS,
    temperature: INSTANT_TEMPERATURE,
  });
  const content = ensureInstantSentenceClosure(result.text || "(empty response)");
  return {
    response: jsonNoStore({
      ok: true,
      answer: content,
      resolvedResponseMode: plan.resolvedResponseMode,
    }),
    usage: result.usage,
    content,
  };
}

async function handleImage(plan: ExecutionPlan, env: Env): Promise<Response> {
  const upstream = await fetch(`${env.OPENAI_API_BASE.replace(/\/$/, "")}/images/generations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: plan.modelId,
      prompt: plan.lastUserPrompt,
      size: "1024x1024",
      n: 1,
      response_format: "b64_json",
    }),
  });

  const data: any = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    return json({ error: data?.error?.message || "Image generation failed." }, upstream.status || 502);
  }
  const first = Array.isArray(data?.data) ? data.data[0] : null;
  const base64 = typeof first?.b64_json === "string" ? first.b64_json : typeof first?.base64_data === "string" ? first.base64_data : "";
  const url = typeof first?.url === "string" ? first.url : "";
  return jsonNoStore({
    ok: true,
    model: plan.modelId,
    prompt: plan.lastUserPrompt,
    revised_prompt: typeof first?.revised_prompt === "string" ? first.revised_prompt : undefined,
    image_base64: base64 || undefined,
    image_url: url || undefined,
  });
}

async function streamExecution(
  plan: ExecutionPlan,
  env: Env,
  context: ConversationContext,
  requestPath: string,
  requestId: string,
  startedAt: number,
): Promise<Response> {
  const provider = createChatProvider(env);
  const telemetry = new ChatTurnTelemetry(plan.modelId);
  telemetry.setCompactionTriggered(plan.compactedTranscript.triggered);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: Parameters<typeof encodeChatEvent>[0]) => {
        encodeChatEvent(event).forEach((frame) => controller.enqueue(frame));
      };
      let streamClosed = false;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;

      const clearFlushTimer = () => {
        if (!flushTimer) return;
        clearTimeout(flushTimer);
        flushTimer = null;
      };

      emit({
        event: "message_start",
        conversationId: plan.conversationId,
        resolvedResponseMode: plan.resolvedResponseMode,
        model: plan.modelId,
      });

      (async () => {
        try {
          const retrievalStart = Date.now();
          const prepared = await prepareExecution(plan, env, requestId);
          telemetry.setRetrievalMs(Date.now() - retrievalStart);
          emit({
            event: "context_ready",
            attachmentCount: prepared.fileContexts.length,
            estimatedContextChars: prepared.fileContexts.reduce((total, context) => total + context.text.length, 0),
            compacted: plan.compactedTranscript.triggered,
          });
          emit({ event: "retrieval_plan", retrieval: plan.retrieval });

          const streamBuffer = new StreamBuffer();
          const semanticStreamBuffer = new SemanticStreamBuffer();
          const citationAccumulator = new CitationAccumulator();
          const renderStats = { charCount: 0, sourceCount: 0 };
          const derivedStructuredState = {
            enabled: getRuntimeFeatures(env).structuredChat.derivedStreamEnabled,
            decisionMade: !getRuntimeFeatures(env).structuredChat.derivedStreamEnabled,
            structured: false,
            firstTokenAt: 0,
            bufferedFlushes: [] as StreamBufferFlushResult[],
            bufferedSemanticBlocks: [] as SemanticStreamBlock[],
            section: {
              id: "section-1",
              title: getDerivedSectionTitle(plan),
              order: 1,
            },
            nextSegmentIndex: 1,
            sourceCandidates: [] as CitationSource[],
            pendingSources: [] as CitationSource[],
            emittedSourceKeys: new Set<string>(),
          };
          let accumulated = "";
          let finishReason: string | undefined;
          let incompleteReason: string | undefined;
          let truncated = false;
          let usage: ExecutionOutcome["usage"] = null;
          let stopReason: ChatResponseStopReason | undefined;
          let firstTokenSeen = false;
          let lastFormatStateKey = "";

          const emitLegacySources = (sources: CitationSource[]) => {
            sources.forEach((source) => emit({ event: "citation", citation: source }));
          };

          const emitStructuredSources = () => {
            const refs = buildStructuredSourceRefs(derivedStructuredState.sourceCandidates);
            refs.forEach((source) => {
              const sourceKey = normalizeSourceKey(source.url);
              if (!sourceKey || derivedStructuredState.emittedSourceKeys.has(sourceKey)) return;
              derivedStructuredState.emittedSourceKeys.add(sourceKey);
              emit({ event: "source.add", ...source });
            });
            derivedStructuredState.pendingSources = [];
          };

          const ingestNewSources = (sources: CitationSource[]) => {
            if (sources.length) {
              derivedStructuredState.sourceCandidates.push(...sources);
              derivedStructuredState.pendingSources.push(...sources);
            }
            if (derivedStructuredState.structured) {
              emitStructuredSources();
            } else if (derivedStructuredState.decisionMade) {
              emitLegacySources(derivedStructuredState.pendingSources);
              derivedStructuredState.pendingSources = [];
            }
            renderStats.sourceCount = citationAccumulator.getSourceCount();
          };

          const emitFormatState = () => {
            if (derivedStructuredState.enabled && (!derivedStructuredState.decisionMade || derivedStructuredState.structured)) {
              return;
            }
            const state = streamBuffer.getFormatState();
            const nextKey = `${state.blockType}:${state.inCodeFence}:${state.rawOffset}`;
            if (nextKey === lastFormatStateKey) return;
            lastFormatStateKey = nextKey;
            emit({ event: "format_state", state });
          };

          const commitRawFlushes = (flushes: StreamBufferFlushResult[]) => {
            flushes.forEach((flush) => {
              if (!flush.text) return;
              citationAccumulator.appendStableText(flush.text);
              renderStats.charCount = citationAccumulator.getStableTextLength();
            });
          };

          const emitLegacyFlushes = (flushes: StreamBufferFlushResult[]) => {
            flushes.forEach((flush) => {
              if (!flush.text) return;
              if (stopReason === USER_INPUT_REQUIRED_STOP_REASON) return;
              const nextAccumulated = accumulated + flush.text;
              const userInputBoundary = findUserInputRequiredBoundary(nextAccumulated);
              let text = flush.text;
              if (userInputBoundary !== null) {
                const allowed = Math.max(0, userInputBoundary - accumulated.length);
                text = flush.text.slice(0, allowed);
                stopReason = USER_INPUT_REQUIRED_STOP_REASON;
                truncated = false;
              }
              if (!text) return;
              accumulated += text;
              citationAccumulator.appendStableText(text);
              renderStats.charCount = citationAccumulator.getStableTextLength();
              emit({
                event: "message_delta",
                delta: {
                  text,
                  blockType: flush.blockType,
                  isStable: flush.isStable,
                  rawOffsetStart: flush.rawOffsetStart,
                  rawOffsetEnd: flush.rawOffsetStart + text.length,
                },
              });
            });
          };

          const emitStructuredBlocks = (blocks: SemanticStreamBlock[]) => {
            blocks.forEach((block) => {
              if (!block.text) return;
              if (stopReason === USER_INPUT_REQUIRED_STOP_REASON) return;
              const nextAccumulated = accumulated + block.text;
              const userInputBoundary = findUserInputRequiredBoundary(nextAccumulated);
              let text = block.text;
              if (userInputBoundary !== null) {
                const allowed = Math.max(0, userInputBoundary - accumulated.length);
                text = block.text.slice(0, allowed);
                stopReason = USER_INPUT_REQUIRED_STOP_REASON;
                truncated = false;
              }
              if (!text) return;
              accumulated += text;
              const derived = deriveResponseSegmentsFromText({
                text,
                sectionId: derivedStructuredState.section.id,
                startIndex: derivedStructuredState.nextSegmentIndex,
              });
              derived.segments.forEach((segment) => emit({ event: "segment.add", ...segment }));
              derivedStructuredState.nextSegmentIndex = derived.nextSegmentIndex;
            });
          };

          const fallbackToLegacyStreaming = () => {
            if (!derivedStructuredState.enabled || derivedStructuredState.decisionMade) return;
            derivedStructuredState.decisionMade = true;
            derivedStructuredState.structured = false;
            if (derivedStructuredState.pendingSources.length) {
              emitLegacySources(derivedStructuredState.pendingSources);
              derivedStructuredState.pendingSources = [];
            }
            derivedStructuredState.bufferedSemanticBlocks = [];
            if (derivedStructuredState.bufferedFlushes.length) {
              emitLegacyFlushes(derivedStructuredState.bufferedFlushes);
              derivedStructuredState.bufferedFlushes = [];
            }
          };

          const startDerivedStructuredStreaming = () => {
            if (!derivedStructuredState.enabled || derivedStructuredState.decisionMade) return;
            derivedStructuredState.decisionMade = true;
            derivedStructuredState.structured = true;
            emit({
              event: "response.start",
              plan: {
                sectionPlan: [
                  {
                    id: derivedStructuredState.section.id,
                    title: derivedStructuredState.section.title,
                    allowedTypes: ["header", "paragraph", "list", "table", "code"],
                  },
                ],
              },
              conversationId: plan.conversationId,
              resolvedResponseMode: plan.resolvedResponseMode,
              model: plan.modelId,
            });
            emit({ event: "section.add", ...derivedStructuredState.section });
            emitStructuredSources();
            if (derivedStructuredState.bufferedFlushes.length) {
              commitRawFlushes(derivedStructuredState.bufferedFlushes);
              derivedStructuredState.bufferedFlushes = [];
            }
            if (derivedStructuredState.bufferedSemanticBlocks.length) {
              emitStructuredBlocks(derivedStructuredState.bufferedSemanticBlocks);
              derivedStructuredState.bufferedSemanticBlocks = [];
            }
          };

          const maybeDecideDerivedStreaming = (now: number) => {
            if (!derivedStructuredState.enabled || derivedStructuredState.decisionMade) return;
            const firstBlock = derivedStructuredState.bufferedSemanticBlocks[0];
            if (firstBlock) {
              const derived = deriveResponseSegmentsFromText({
                text: firstBlock.text,
                sectionId: derivedStructuredState.section.id,
                startIndex: derivedStructuredState.nextSegmentIndex,
              });
              if (derived.segments.length && derived.streamSafe) {
                startDerivedStructuredStreaming();
              } else {
                fallbackToLegacyStreaming();
              }
              return;
            }
            if (semanticStreamBuffer.getPendingLength() >= SEMANTIC_STREAM_PENDING_CHAR_LIMIT) {
              fallbackToLegacyStreaming();
              return;
            }
            if (derivedStructuredState.firstTokenAt && now - derivedStructuredState.firstTokenAt >= DERIVED_STRUCTURED_STREAM_DECISION_MS) {
              fallbackToLegacyStreaming();
            }
          };

          const flushBuffered = (mode: "timer" | "final") => {
            const flushes = mode === "final" ? streamBuffer.flushFinal() : streamBuffer.flushPending();
            if (derivedStructuredState.enabled && !derivedStructuredState.decisionMade) {
              if (flushes.length) {
                derivedStructuredState.bufferedFlushes.push(...flushes);
                derivedStructuredState.bufferedSemanticBlocks.push(...semanticStreamBuffer.push(flushes));
              }
              if (mode === "final") {
                derivedStructuredState.bufferedSemanticBlocks.push(...semanticStreamBuffer.flushFinal());
              }
              maybeDecideDerivedStreaming(Date.now());
              if (mode === "final" && !derivedStructuredState.decisionMade) {
                fallbackToLegacyStreaming();
              }
              if (derivedStructuredState.decisionMade && !derivedStructuredState.structured) {
                emitFormatState();
              }
              return;
            }
            if (flushes.length) {
              if (derivedStructuredState.structured) {
                commitRawFlushes(flushes);
                emitStructuredBlocks(semanticStreamBuffer.push(flushes));
              } else {
                emitLegacyFlushes(flushes);
              }
            }
            if (mode === "final" && derivedStructuredState.structured) {
              emitStructuredBlocks(semanticStreamBuffer.flushFinal());
            }
            if (!derivedStructuredState.structured) {
              emitFormatState();
            }
          };

          const scheduleFlushTimer = () => {
            if (derivedStructuredState.enabled && !derivedStructuredState.decisionMade) return;
            if (derivedStructuredState.structured) return;
            clearFlushTimer();
            flushTimer = setTimeout(() => {
              flushTimer = null;
              if (streamClosed) return;
              try {
                flushBuffered("timer");
              } catch (error) {
                emit({ event: "error", error: error instanceof Error ? error.message : String(error) });
              }
            }, 100);
          };

          emitFormatState();

          for await (const chunk of provider.streamMessage(await buildProviderRequest(prepared, env, requestId))) {
            if (chunk.type === "delta") {
              if (!firstTokenSeen) {
                firstTokenSeen = true;
                telemetry.markFirstToken();
              }
              if (!derivedStructuredState.firstTokenAt) {
                derivedStructuredState.firstTokenAt = Date.now();
              }
              ingestNewSources(citationAccumulator.mergeProviderPayload(chunk.raw));
              const flushes = streamBuffer.pushDelta(chunk.text);
              if (derivedStructuredState.enabled && !derivedStructuredState.decisionMade) {
                if (flushes.length) {
                  derivedStructuredState.bufferedFlushes.push(...flushes);
                  derivedStructuredState.bufferedSemanticBlocks.push(...semanticStreamBuffer.push(flushes));
                  maybeDecideDerivedStreaming(Date.now());
                }
                if (!derivedStructuredState.decisionMade &&
                    Date.now() - derivedStructuredState.firstTokenAt >= DERIVED_STRUCTURED_STREAM_DECISION_MS) {
                  fallbackToLegacyStreaming();
                  const timerFlushes = streamBuffer.flushPending();
                  if (timerFlushes.length) {
                    emitLegacyFlushes(timerFlushes);
                  }
                  emitFormatState();
                  scheduleFlushTimer();
                }
                if (derivedStructuredState.decisionMade && !derivedStructuredState.structured) {
                  emitFormatState();
                  scheduleFlushTimer();
                }
                if (stopReason === USER_INPUT_REQUIRED_STOP_REASON) {
                  break;
                }
                continue;
              }
              if (derivedStructuredState.structured) {
                if (flushes.length) {
                  commitRawFlushes(flushes);
                  emitStructuredBlocks(semanticStreamBuffer.push(flushes));
                }
                if (stopReason === USER_INPUT_REQUIRED_STOP_REASON) {
                  break;
                }
                continue;
              }
              emitLegacyFlushes(flushes);
              emitFormatState();
              scheduleFlushTimer();
              if (stopReason === USER_INPUT_REQUIRED_STOP_REASON) {
                break;
              }
              continue;
            }
            clearFlushTimer();
            ingestNewSources(citationAccumulator.mergeProviderPayload(chunk.raw));
            finishReason = chunk.finishReason;
            incompleteReason = detectIncompleteReason(chunk.text) || chunk.incompleteReason;
            usage = accumulateUsage(usage, chunk.usage);
            truncated = Boolean(
              (chunk.incompleteReason && /max|length/i.test(chunk.incompleteReason)) ||
                (chunk.finishReason && /length|max_tokens/i.test(chunk.finishReason)),
            );
            if (stopReason === USER_INPUT_REQUIRED_STOP_REASON) {
              break;
            }
          }

          if (stopReason !== USER_INPUT_REQUIRED_STOP_REASON) {
            flushBuffered("final");
          }

          let answerSegments: AnswerSegment[] = accumulated ? [{ type: "text", text: accumulated }] : [];
          let sources: CitationSource[] = [];
          let responseV2: ChatResponseV2 | undefined;
          let consultedSources: unknown[] | undefined;
          let warnings: ExecutionOutcome["warnings"];

          if (plan.retrieval.mode === "web_search") {
            const cited = finalizeRetrievalAnswerPayload(null, env, citationAccumulator);
            accumulated = cited.answerText || accumulated;
            answerSegments = cited.answerSegments;
            sources = cited.sources;
            consultedSources = cited.consultedSources;
            warnings = cited.warnings;
            renderStats.sourceCount = sources.length;
          } else {
            const finalized = citationAccumulator.finalize();
            if (getSegmentTextLength(finalized.answerSegments) > 0) {
              accumulated = finalized.answerText || accumulated;
              answerSegments = finalized.answerSegments;
            }
          }
          const sanitized = sanitizeFinalChatPayload({
            answerSegments,
            answerText: accumulated,
            sources,
          });
          accumulated = sanitized.answerText || accumulated;
          answerSegments = sanitized.answerSegments;
          sources = sanitized.sources;
          renderStats.charCount = accumulated.trim().length;
          renderStats.sourceCount = sources.length;
          ingestNewSources(citationAccumulator.drainNewSources());

          const qaStart = Date.now();
          const qa = applyOutputQa({
            answerText: accumulated,
            answerSegments,
            sources,
            resolvedResponseMode: plan.resolvedResponseMode,
            longAnswerChars: resolveLongAnswerThreshold(env),
            typewriterSpeedMs: resolveTypewriterSpeedMs(env),
            markdownSafe: true,
            renderStats,
          });
          telemetry.setQaMs(Date.now() - qaStart);
          telemetry.setSourceCount(qa.sources.length);
          if (qa.renderHints.stopReason === USER_INPUT_REQUIRED_STOP_REASON) {
            stopReason = USER_INPUT_REQUIRED_STOP_REASON;
            truncated = false;
          }
          telemetry.setTruncated(truncated);
          responseV2 = buildDerivedResponsePayload({
            plan,
            answerText: qa.answerText,
            sources: qa.sources,
            truncated,
            stopReason: qa.renderHints.stopReason,
          });
          const renderHints = forceInstantRenderHintsIfStructured(qa.renderHints, responseV2);

          if (derivedStructuredState.structured) {
            emit({
              event: "response.complete",
              stopReason: resolveStructuredStopReason(truncated, qa.renderHints.stopReason),
              truncated,
            });
          } else {
            emit({
              event: "final",
              content: qa.answerText,
              answerSegments: qa.answerSegments,
              sources: qa.sources,
              responseV2,
              consultedSources,
              renderHints,
              finishReason,
              incompleteReason,
              truncated,
              resolvedResponseMode: plan.resolvedResponseMode,
            });
            emit({ event: "message_stop", finishReason, incompleteReason, truncated });
          }

          const outcome: ExecutionOutcome = {
            ok: true,
            content: qa.answerText,
            answerSegments: qa.answerSegments,
            sources: qa.sources,
            responseV2,
            consultedSources,
            warnings,
            renderHints,
            finishReason,
            incompleteReason,
            truncated,
            usage,
          };
          await persistSemanticState(env, plan, outcome);
          await persistRuntimeCompletionSession(env, plan, qa.answerText, requestId);
          await recordChatUsage(env, context, plan, requestPath, requestId, startedAt, true, usage);
          console.log("[chat.runtime.stream]", telemetry.finalize());
        } catch (error) {
          emit({ event: "error", error: error instanceof Error ? error.message : String(error) });
          const errorCode =
            error instanceof CapabilityDeniedError
              ? error.reason
              : error instanceof Error
                ? error.message
                : "stream_error";
          await recordChatUsage(env, context, plan, requestPath, requestId, startedAt, false, null, errorCode);
        } finally {
          streamClosed = true;
          clearFlushTimer();
          emit({ event: "done" });
          controller.close();
        }
      })();
    },
  });

  return new Response(stream, { headers: buildSseHeaders() });
}

async function handleChatRequestInternal(request: Request, env: Env, defaults: { forceJson?: boolean } = {}): Promise<Response> {
  const startedAt = Date.now();
  const requestId = getRequestId(request);
  const requestPath = new URL(request.url).pathname;
  const context = await resolveConversationContext(request, env);
  const body = await parseRequestBody(request);
  if (!body) {
    return appendSetCookie(json({ error: "Send JSON body with messages." }, 400), context.setCookie);
  }
  if (defaults.forceJson && body.stream === undefined) {
    body.stream = false;
  }

  const conversationId = typeof body.conversation_id === "string" && body.conversation_id.trim()
    ? body.conversation_id.trim()
    : undefined;
  await saveConversationTags(env, context.scope, conversationId ?? "", body.meta_tags);

  const metaTags = Array.isArray(body.meta_tags)
    ? body.meta_tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
    : [];
  if (metaTags.length) {
    await appendMetaTags(env, metaTags);
    if (conversationId) {
      await storeConversationTags(env, context.scope, conversationId, metaTags);
    }
  }

  let plan: ExecutionPlan;
  try {
    plan = await buildExecutionPlan(request, env, body, context.scope);
  } catch (error) {
    return appendSetCookie(json({ error: error instanceof Error ? error.message : String(error) }, 400), context.setCookie);
  }

  if (!plan.messages.length) {
    return appendSetCookie(json({ error: "messages must include at least one non-empty entry." }, 400), context.setCookie);
  }

  try {
    await assertPlanCapabilitiesAllowed(env, plan, requestId);
  } catch (error) {
    if (error instanceof CapabilityDeniedError) {
      await writeAuditEvent(env, request, requestId, {
        event: "runtime.capability.denied",
        outcome: "denied",
        actor: buildAuditActor(context.authSession),
        metadata: {
          capability: error.capability,
          reason: error.reason,
          requestedBucket: error.requestedBucket,
          agentId: plan.agentId,
        },
      }).catch(() => undefined);
      return appendSetCookie(jsonNoStore({
        error: "capability_denied",
        capability: error.capability,
        reason: error.reason,
        requestedBucket: error.requestedBucket,
      }, error.status), context.setCookie);
    }
    throw error;
  }

  let response: Response;
  try {
    if (isImageModel(plan.modelKey) || plan.requestKind === "image") {
      response = await handleImage(plan, env);
      await recordChatUsage(env, context, plan, requestPath, requestId, startedAt, true, null);
    } else if (plan.requestKind === "instant") {
      const instant = await handleInstant(plan, env, requestId);
      response = instant.response;
      if (instant.content) {
        await persistRuntimeCompletionSession(env, plan, instant.content, requestId);
      }
      await recordChatUsage(env, context, plan, requestPath, requestId, startedAt, true, instant.usage);
    } else if (isStructuredChatEligible(plan, env)) {
      response = await streamStructuredChat(plan, env, {
        onComplete: async ({ content, usage }) => {
          await persistSemanticState(env, plan, {
            ok: true,
            content,
            answerSegments: [],
            sources: [],
            renderHints: buildRenderHints(content, [], {
              longAnswerChars: resolveLongAnswerThreshold(env),
              typewriterSpeedMs: resolveTypewriterSpeedMs(env),
            }),
          });
          await persistRuntimeCompletionSession(env, plan, content, requestId);
          await recordChatUsage(env, context, plan, requestPath, requestId, startedAt, true, usage);
        },
        onError: async (error) => {
          const errorCode = error instanceof CapabilityDeniedError ? error.reason : error.message;
          await recordChatUsage(env, context, plan, requestPath, requestId, startedAt, false, null, errorCode);
        },
      });
    } else if (plan.stream && !plan.explicitJson) {
      response = await streamExecution(plan, env, context, requestPath, requestId, startedAt);
    } else {
      const outcome = await executeNonStreaming(plan, env, requestId);
      await persistSemanticState(env, plan, outcome);
      await persistRuntimeCompletionSession(env, plan, outcome.content, requestId);
      await recordChatUsage(env, context, plan, requestPath, requestId, startedAt, true, outcome.usage);

      if (plan.requestKind === "continuation") {
        response = jsonNoStore({
          ok: true,
          content: outcome.content,
          continuation: outcome.continuation || outcome.content,
          finishReason: outcome.finishReason,
          truncated: outcome.truncated,
          incompleteReason: outcome.incompleteReason,
          responseMode: plan.responseMode,
          resolvedResponseMode: plan.resolvedResponseMode,
        });
      } else if (plan.resolvedResponseMode === "instant" && !outcome.sources.length && !outcome.consultedSources?.length) {
        response = jsonNoStore({
          ok: true,
          answer: ensureInstantSentenceClosure(outcome.content || "(empty response)"),
          resolvedResponseMode: plan.resolvedResponseMode,
        });
      } else {
        response = jsonNoStore(buildJsonPayload(outcome, plan));
      }
    }
  } catch (error) {
    if (error instanceof CapabilityDeniedError) {
      await writeAuditEvent(env, request, requestId, {
        event: "runtime.capability.denied",
        outcome: "denied",
        actor: buildAuditActor(context.authSession),
        metadata: {
          capability: error.capability,
          reason: error.reason,
          requestedBucket: error.requestedBucket,
          agentId: plan.agentId,
        },
      }).catch(() => undefined);
      await recordChatUsage(env, context, plan, requestPath, requestId, startedAt, false, null, error.reason);
      return appendSetCookie(jsonNoStore({
        error: "capability_denied",
        capability: error.capability,
        reason: error.reason,
        requestedBucket: error.requestedBucket,
      }, error.status), context.setCookie);
    }
    throw error;
  }

  return appendSetCookie(response, context.setCookie);
}

export function handleChatRoute(request: Request, env: Env): Promise<Response> {
  return handleChatRequestInternal(request, env);
}

export function handleChatContinueRoute(request: Request, env: Env): Promise<Response> {
  return handleChatRequestInternal(request, env, { forceJson: true });
}
