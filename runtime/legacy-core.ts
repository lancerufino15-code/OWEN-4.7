/**
 * Cloudflare Worker entry point for the OWEN chat + study guide service.
 *
 * Responsibilities:
 * - Route API requests (chat, uploads, study guides, analytics) and serve assets.
 * - Orchestrate OpenAI/Workers AI calls, PDF extraction, and R2/KV persistence.
 *
 * Used by: Wrangler `main` (`wrangler.jsonc`) and tests importing helpers from this module.
 *
 * Key exports:
 * - Default `fetch` handler for Worker runtime.
 * - Study guide utilities (parsing, chunking, payload builders).
 * - OpenAI payload helpers and Anki/PDF helpers.
 *
 * Assumptions:
 * - Cloudflare Workers runtime with R2 + KV bindings configured via Env.
 * - OpenAI-compatible API base and key provided in environment variables.
 */
import { AGENTS } from "../chat/agents";
import type { OwenAgent } from "../chat/agents";
import { handleChatContinueRoute as handleNewChatContinueRoute, handleChatRoute as handleNewChatRoute } from "../chat/agent-chat";
import { normalizeResolvedResponseMode, normalizeResponseMode } from "../chat/response-mode";
import { findUserInputRequiredBoundary } from "../../universal_answer_orchestrator";
import { getAppConfig } from "../../app/config";
import { AuthorizationPolicy, type PolicyAction } from "../../auth/policy";
import { beginOidcLogin, completeOidcLogin, listPublicAuthProviders, loginWithDevProvider } from "../../auth/provider";
import {
  buildAuthLogoutCookie,
  ensureBrowserSession,
  getAuthSession,
  getBrowserConversationScope,
  parseCookieHeader,
  readAuthToken,
  revokeAuthSession,
  type AuthSessionRecord,
  type UserRole,
} from "../../auth/session";
import { applySecurityHeaders, buildCorsHeaders as buildRequestCorsHeaders, NO_STORE_HEADERS } from "../../http/security";
import { SseFrameParser } from "../../lib/streaming/sse";
import { buildAuditActor, getRequestId, writeAuditEvent } from "../../observability/audit";
import { recordMetricEvent } from "../../observability/metrics";
import type { Env } from "../../types";
import * as pdfjs from "../pdf/pdfjs-dist-legacy-build-pdf";
import { normalizePages, normalizePlainText, type PageText } from "../../pdf/normalize";
import {
  buildExtractedKeyForHash,
  loadCachedExtraction,
  readManifest,
  writeManifest,
  type PdfManifest,
} from "../../pdf/cache";
import { chunkText, rankChunks, type RetrievalChunk } from "../../pdf/retrieval";
import {
  LIBRARY_CATEGORIES_KEY,
  LIBRARY_COURSES_KEY,
  LIBRARY_INDEX_KEY,
  LIBRARY_QUEUE_PREFIX,
  buildExtractedPath,
  buildIndexKeyForDoc,
  buildManifestPath,
  buildStoredQbankQuestionsPath,
  buildStoredQbankSourcePath,
  computeDocId,
  isPdfKey,
  sha256,
  STORED_QBANK_PREFIX,
  type LibraryCategory,
  type LibraryCourse,
  type LibraryExamId,
  type LibraryIndexRecord,
  type LibraryYearId,
  normalizePreview,
  readIndex as readLibraryIndex,
  scoreRecords as scoreLibraryRecords,
  titleFromKey,
  tokensFromTitle,
  writeIndex as writeLibraryIndex,
} from "../library";
import { sanitizeDocText } from "../../machine/text_hygiene";
import {
  renderStudyGuideHtml,
  type StepAOutput,
  type StepBOutput,
  type StepCOutput,
} from "../../machine/render_study_guide_html";
import {
  ANKI_PROMPT_TEMPLATE,
  buildGeminiQuizPrompt,
  buildLectureQuizPrompt,
  STUDY_GUIDE_CANONICAL_PROMPT,
  STUDY_GUIDE_MAXIMAL_FACT_REWRITE_PROMPT,
  STUDY_GUIDE_STEP_A_DERIVE_PROMPT,
  STUDY_GUIDE_STEP_A_EXTRACT_PROMPT,
  STUDY_GUIDE_STEP_B_ENHANCED_PROMPT,
  STUDY_GUIDE_STEP_B_PLAN_PROMPT,
  STUDY_GUIDE_STEP_B1_OUTLINE_PROMPT,
  STUDY_GUIDE_STEP_B2_PACK_JSON_PROMPT,
  STUDY_GUIDE_STEP_B2_REWRITE_JSON_PROMPT,
  STUDY_GUIDE_STEP_B_DRAFT_PROMPT,
  STUDY_GUIDE_STEP_B_QC_REWRITE_PROMPT,
  STUDY_GUIDE_STEP_B_SYNTHESIS_REWRITE_PROMPT,
  STUDY_GUIDE_STEP_C_QA_PROMPT,
} from "../../registry/prompts";
import {
  ANKI_ABSOLUTE_CARD_MAX,
  ANKI_ABSOLUTE_CARD_MIN,
  ANKI_DEFAULT_CARD_MAX,
  ANKI_DEFAULT_CARD_MIN,
  ANKI_DEFAULT_COVERAGE_MODE,
  ANKI_CARDS_SCHEMA_V2,
  buildAnkiLectureTagRoot,
  buildAnkiTsv,
  buildNumberedTranscript,
  buildSlideLedger,
  clampCardTargetToRange,
  computeAnkiCoverageStats,
  isAnkiParseError,
  lintAnkiNotes,
  normalizeAnkiNotes,
  parseAnkiOutput,
  resolveNoTextFallbackTarget,
  type AnkiCoverageMode,
  type AnkiStructuredCard,
  type AnkiHouseStyleContext,
  type AnkiLintReport,
} from "../../anki_house_style";
import { coerceQuizBatchCandidate, inspectQuizPipelineOutput } from "../../quiz-engine/hidden_pipeline";
import { extractTopicInventoryFromSlides, isGarbageTopicLabel, type TopicInventory } from "../../study_guides/inventory";
import {
  buildFactRegistryFromStepA,
  coerceFactRegistryRewrite,
  countTopicFacts,
  filterMh7Topics,
  type FactRegistry,
} from "../../study_guides/fact_registry";
import { renderMaximalStudyGuideHtml } from "../../study_guides/render_maximal_html";
import {
  ensureMaximalCoverage,
  ensureMaximalDiscriminatorColumns,
  ensureMaximalDrugCoverage,
  ensureMaximalPlaceholderQuality,
  ensureMaximalTopicDensity,
  ensureMaximalTopicClassification,
  validateMaximalStructure,
  validateStyleContract,
} from "../../study_guides/validate";
import {
  validateStepB,
  validateSynthesis,
  type StepBValidationFailure,
  type StepBSynthesisFailure,
} from "../../machine/study_guide_stepB_validator";
import {
  aggregateLectureAnalytics,
  buildAnalyticsEvent,
  loadTopQuestionsForLecture,
  writeAnalyticsEvent,
} from "../analytics/analytics";
import type { TrafficSnapshot } from "../../durable/presence-room";
import { DEFAULT_TEXT_MODEL } from "../../model_defaults";
import {
  compactConversationRecord,
  normalizeConversationSummary,
  type ConversationSummary,
} from "./conversation/compaction";
import { getRuntimeFeatures } from "./config/runtime-features";
import { runRuntimeHooks } from "./hooks/runtime-hooks";
import { resolveModelAdapter } from "./model/adapter";
import { extractOpenAIUsage } from "./openai/usage";
import { trackUsageEvent } from "./usage/tracker";
import { messageContentToPlainText, normalizeChatMessagesPreservingImages } from "./vision/messages";
export { PresenceRoom } from "../../durable/presence-room";
export {
  buildAnkiLectureTagRoot,
  buildNumberedTranscript,
  extractAnkiTsv,
  lintAnkiNotes,
  parseAnkiOutput,
} from "../../anki_house_style";

// Cloudflare Workers cannot spawn PDF.js workers; force single-threaded parsing.
if (pdfjs?.GlobalWorkerOptions) {
  pdfjs.GlobalWorkerOptions.workerSrc = undefined;
}
const PDFJS_AVAILABLE = Boolean(pdfjs?.getDocument) && !(pdfjs as any).__isStub;

type AnkiEmbeddedPageExtraction = {
  pages: PageText[];
  pageCount: number;
  sampleTextLength: number;
  sampledPagesWithText: number;
  scanned: boolean;
};

type AnkiEmbeddedPageExtractor = (
  pdfBytes: Uint8Array,
  opts?: { sampleOnly?: boolean; allowEarlyStop?: boolean; maxPages?: number; sampleCount?: number },
) => Promise<AnkiEmbeddedPageExtraction>;

let ankiEmbeddedPagesExtractorOverride: AnkiEmbeddedPageExtractor | null = null;

export function __setAnkiEmbeddedPagesExtractorForTests(extractor: AnkiEmbeddedPageExtractor | null) {
  ankiEmbeddedPagesExtractorOverride = extractor;
}

async function extractEmbeddedPagesForAnkiRequest(
  pdfBytes: Uint8Array,
  opts: Parameters<AnkiEmbeddedPageExtractor>[1] = {},
): Promise<AnkiEmbeddedPageExtraction> {
  if (ankiEmbeddedPagesExtractorOverride) {
    return ankiEmbeddedPagesExtractorOverride(pdfBytes, opts);
  }
  return extractEmbeddedPagesFromPdf(pdfBytes, opts);
}

type ConversationTags = {
  conversation_id: string;
  tags: string[];
  updated_at: string;
};

type LectureAnalytics = {
  docId: string;
  strings: Array<{ text: string; count: number }>;
  updated_at: string;
  topics?: Array<{ text: string; count: number; aliases?: string[]; key?: string; lastSeenAt?: string }>;
  last_question?: string;
  last_cleaned_question?: string;
  questions?: Array<{ question: string; count: number }>;
  lastUpdated?: string;
};

type ChatRole = "system" | "user" | "assistant";

type ChatContentPart = { type: "text"; text: string };

/**
 * Minimal chat message shape used for OpenAI-style chat payloads.
 */
export type ChatMessage = { role: ChatRole; content: string | ChatContentPart[] };

type QuizChoice = { id: string; text: string };

type QuizQuestion = {
  id: string;
  stem: string;
  choices: QuizChoice[];
  answer: string;
  rationale: string;
  tags: string[];
  difficulty: "easy" | "medium" | "hard";
  references: string[];
};

type QuizBatch = {
  lectureId?: string;
  lectureTitle: string;
  setSize: number;
  questions: QuizQuestion[];
};

type QuizCoverage = {
  cursor: number;
  windowSize: number;
  totalChunks: number;
  exhausted: boolean;
};

type QuizContinuationState = {
  v: 1;
  docId: string;
  cursor: number;
  usedChunkWindows: number[];
  usedQuestionFingerprints: string[];
  count: number;
};

type StoredQbankDocument = {
  version: 1;
  docId: string;
  lectureTitle: string;
  questionCount: number;
  uploadedAt: string;
  questions: QuizQuestion[];
};

type ConversationMessageMetadata = {
  model?: string;
  attachments?: unknown[];
  imageUrl?: string;
  imageAlt?: string;
  docId?: string;
  docTitle?: string;
  lectureId?: string;
  extractedKey?: string;
  requestId?: string;
  references?: unknown[];
  evidence?: unknown[];
  renderedMarkdown?: string;
  sources?: unknown[];
  citations?: unknown[];
  answerSegments?: unknown[];
  responseV2?: unknown;
  rawPrompt?: string;
  cleanedPrompt?: string;
  topics?: string[];
  responseMode?: ResponseMode;
  resolvedResponseMode?: ResolvedResponseMode;
};

type ConversationMessageRecord = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  metadata?: ConversationMessageMetadata;
};

type ConversationRecord = {
  id: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  selectedDocId?: string | null;
  selectedDocTitle?: string;
  truncated?: boolean;
  summary?: ConversationSummary;
  messages: ConversationMessageRecord[];
};

type ConversationIndexEntry = {
  id: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  selectedDocId?: string | null;
  selectedDocTitle?: string;
  messageCount?: number;
};

type UrlCitationAnnotation = {
  start_index: number;
  end_index: number;
  url: string;
  title?: string;
};

type AnswerSegment =
  | { type: "text"; text: string }
  | { type: "citation"; id: number; url: string; title?: string };

type CitationSource = {
  id: number;
  url: string;
  title?: string;
  domain?: string;
  snippet?: string;
  retrievedAt?: number;
};

type InputImageDetail = "low" | "high" | "auto";
type ResponsesInputContent =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url?: string; file_id?: string; detail?: InputImageDetail }
  | { type: "input_file"; file_id: string };

type ResponsesInputMessage = { role: ChatRole; content: ResponsesInputContent[] };

type ResponseMode = "auto" | "instant" | "thinking";
type ResolvedResponseMode = "instant" | "thinking";

type ChatContinuation = {
  text: string;
  reason?: string;
  attempt?: number;
};

interface FileReference {
  bucket: string;
  key: string;
  textKey?: string;
  displayName?: string;
  fileId?: string;
  visionFileId?: string;
}

type FileContextRecord = {
  displayName: string;
  source: "ocr" | "original";
  text: string;
  bucket: string;
  resolvedBucket: string;
  originalKey: string;
  resolvedKey: string;
  textKey?: string;
};

interface ChatRequestBody {
  messages: ChatMessage[];
  agentId?: string;
  model?: string;
  files?: FileReference[];
  attachments?: FileReference[];
  fileRefs?: FileReference[];
  responseMode?: ResponseMode;
  conversation_id?: string;
  meta_tags?: string[];
  continuation?: ChatContinuation;
}

interface GenerateFileRequest {
  messages: ChatMessage[];
  agentId?: string;
  desiredFileType: string;
}

function conversationIndexKey(scope: string): string {
  return `${CONVERSATION_INDEX_KEY}:${scope}`;
}

async function saveConversationTags(env: Env, scope: string, conversation_id: string, rawTags: unknown): Promise<void> {
  if (!conversation_id || !env.DOCS_KV) return;

  const tags: string[] = Array.isArray(rawTags)
    ? [...new Set(
        rawTags
          .map((t) => String(t).trim())
          .filter(Boolean)
          .map((t) => (t.startsWith("#") ? t.toLowerCase() : `#${t.toLowerCase()}`))
      )]
    : [];

  if (tags.length === 0) return;

  const kvKey = `conv:${scope}:${conversation_id}:tags`;

  const existing = await env.DOCS_KV.get(kvKey, { type: "json" }) as ConversationTags | null;

  const mergedTags = existing
    ? [...new Set([...(existing.tags || []), ...tags])]
    : tags;

  const record: ConversationTags = {
    conversation_id,
    tags: mergedTags,
    updated_at: new Date().toISOString(),
  };

  await env.DOCS_KV.put(kvKey, JSON.stringify(record));
}

async function loadConversationTags(env: Env, scope: string, conversation_id: string): Promise<ConversationTags> {
  if (!env.DOCS_KV) {
    return { conversation_id, tags: [], updated_at: new Date().toISOString() };
  }
  const kvKey = `conv:${scope}:${conversation_id}:tags`;
  const stored = await env.DOCS_KV.get(kvKey, { type: "json" }) as ConversationTags | null;

  if (!stored) {
    return { conversation_id, tags: [], updated_at: new Date().toISOString() };
  }

  return {
    conversation_id: stored.conversation_id || conversation_id,
    tags: Array.isArray(stored.tags) ? stored.tags : [],
    updated_at: stored.updated_at || new Date().toISOString(),
  };
}

function conversationRecordKey(scope: string, id: string): string {
  return `${CONVERSATION_RECORD_PREFIX}${scope}:${id}`;
}

function generateConversationMessageId(): string {
  return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clampConversationMessageContent(text: string): string {
  if (typeof text !== "string") return "";
  if (text.length <= MAX_CONVERSATION_MESSAGE_CHARS) return text;
  return `${text.slice(0, MAX_CONVERSATION_MESSAGE_CHARS)} ... (truncated for storage)`;
}

function limitArray<T>(value: unknown, limit: number): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return (value as T[]).slice(0, limit);
}

function normalizeConversationMetadata(raw: Record<string, unknown>): ConversationMessageMetadata | undefined {
  const metaSource = isPlainObject(raw.metadata) ? (raw.metadata as Record<string, unknown>) : {};
  const merged = { ...metaSource, ...raw };
  const metadata: ConversationMessageMetadata = {};
  if (typeof merged.model === "string") metadata.model = merged.model;
  if (Array.isArray(merged.attachments)) metadata.attachments = limitArray(merged.attachments, MAX_CONVERSATION_META_LIST);
  if (typeof merged.imageUrl === "string") metadata.imageUrl = merged.imageUrl;
  if (typeof merged.imageAlt === "string") metadata.imageAlt = merged.imageAlt;
  if (typeof merged.docId === "string") metadata.docId = merged.docId;
  if (typeof merged.docTitle === "string") metadata.docTitle = merged.docTitle;
  if (typeof merged.lectureId === "string") metadata.lectureId = merged.lectureId;
  if (typeof merged.extractedKey === "string") metadata.extractedKey = merged.extractedKey;
  if (typeof merged.requestId === "string") metadata.requestId = merged.requestId;
  if (Array.isArray(merged.references)) metadata.references = limitArray(merged.references, MAX_CONVERSATION_META_LIST);
  if (Array.isArray(merged.evidence)) metadata.evidence = limitArray(merged.evidence, MAX_CONVERSATION_META_LIST);
  if (typeof merged.renderedMarkdown === "string") metadata.renderedMarkdown = merged.renderedMarkdown;
  if (Array.isArray(merged.sources)) metadata.sources = limitArray(merged.sources, MAX_CONVERSATION_META_LIST);
  if (Array.isArray(merged.citations)) metadata.citations = limitArray(merged.citations, MAX_CONVERSATION_META_LIST);
  if (Array.isArray(merged.answerSegments)) metadata.answerSegments = limitArray(merged.answerSegments, MAX_CONVERSATION_META_LIST);
  if (isPlainObject(merged.responseV2)) metadata.responseV2 = merged.responseV2;
  if (typeof merged.rawPrompt === "string") metadata.rawPrompt = merged.rawPrompt;
  if (typeof merged.cleanedPrompt === "string") metadata.cleanedPrompt = merged.cleanedPrompt;
  if (Array.isArray(merged.topics)) {
    metadata.topics = merged.topics
      .filter((topic: unknown) => typeof topic === "string")
      .slice(0, MAX_CONVERSATION_TOPICS);
  }
  if (typeof merged.responseMode === "string") {
    const normalized = normalizeResponseMode(merged.responseMode);
    if (normalized) metadata.responseMode = normalized;
  }
  if (typeof merged.resolvedResponseMode === "string") {
    const normalized = normalizeResolvedResponseMode(merged.resolvedResponseMode);
    if (normalized) metadata.resolvedResponseMode = normalized;
  }
  return Object.keys(metadata).length ? metadata : undefined;
}

function normalizeConversationMessage(raw: unknown): ConversationMessageRecord | null {
  if (!isPlainObject(raw)) return null;
  const role = raw.role === "assistant" ? "assistant" : raw.role === "system" ? "system" : "user";
  const contentRaw = typeof raw.content === "string"
    ? raw.content
    : typeof raw.text === "string"
      ? raw.text
      : "";
  const content = clampConversationMessageContent(contentRaw);
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : generateConversationMessageId();
  const createdAt = typeof raw.createdAt === "number" ? raw.createdAt : Date.now();
  const metadata = normalizeConversationMetadata(raw);
  return {
    id,
    role,
    content,
    createdAt,
    metadata,
  };
}

function dedupeConversationMessages(messages: ConversationMessageRecord[]): ConversationMessageRecord[] {
  const byId = new Map<string, ConversationMessageRecord>();
  const ordered: ConversationMessageRecord[] = [];
  messages.forEach(msg => {
    if (!msg || !msg.id) return;
    if (byId.has(msg.id)) {
      const idx = ordered.findIndex(entry => entry.id === msg.id);
      if (idx >= 0) ordered[idx] = msg;
      byId.set(msg.id, msg);
      return;
    }
    byId.set(msg.id, msg);
    ordered.push(msg);
  });
  return ordered;
}

function pruneConversationMessages(messages: ConversationMessageRecord[]): { messages: ConversationMessageRecord[]; truncated: boolean } {
  const sanitized: ConversationMessageRecord[] = [];
  let totalChars = 0;
  let truncated = false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (sanitized.length >= MAX_CONVERSATION_MESSAGES) {
      truncated = true;
      break;
    }
    const msg = messages[i];
    if (!msg) continue;
    const textLen = typeof msg.content === "string" ? msg.content.length : 0;
    if (sanitized.length && totalChars + textLen > MAX_CONVERSATION_CHARS) {
      truncated = true;
      break;
    }
    totalChars += textLen;
    sanitized.push(msg);
  }
  return { messages: dedupeConversationMessages(sanitized.reverse()), truncated };
}

async function loadConversationRecord(env: Env, scope: string, conversationId: string): Promise<ConversationRecord | null> {
  if (!conversationId || !env.DOCS_KV) return null;
  const raw = await env.DOCS_KV.get(conversationRecordKey(scope, conversationId), { type: "json" });
  if (!raw || typeof raw !== "object") return null;
  const record = normalizeConversationRecord(raw, null, { preserveUpdatedAt: true });
  return record;
}

async function loadConversationIndex(env: Env, scope: string): Promise<ConversationIndexEntry[]> {
  if (!env.DOCS_KV) return [];
  const raw = await env.DOCS_KV.get(conversationIndexKey(scope), { type: "json" });
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(entry => entry && typeof entry === "object")
    .map(entry => normalizeConversationIndexEntry(entry as Record<string, unknown>))
    .filter((entry): entry is ConversationIndexEntry => Boolean(entry));
}

async function saveConversationIndex(env: Env, scope: string, entries: ConversationIndexEntry[]): Promise<void> {
  if (!env.DOCS_KV) return;
  const payload = (entries || []).slice(0, 200);
  await env.DOCS_KV.put(conversationIndexKey(scope), JSON.stringify(payload));
}

function normalizeConversationIndexEntry(raw: Record<string, unknown>): ConversationIndexEntry | null {
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;
  const createdAt = typeof raw.createdAt === "number" ? raw.createdAt : Date.now();
  const updatedAt = typeof raw.updatedAt === "number" ? raw.updatedAt : createdAt;
  return {
    id,
    title: typeof raw.title === "string" ? raw.title : "Conversation",
    createdAt,
    updatedAt,
    selectedDocId: typeof raw.selectedDocId === "string" ? raw.selectedDocId : null,
    selectedDocTitle: typeof raw.selectedDocTitle === "string" ? raw.selectedDocTitle : "",
    messageCount: typeof raw.messageCount === "number" ? raw.messageCount : undefined,
  };
}

function normalizeConversationRecord(
  raw: unknown,
  existing?: ConversationRecord | null,
  opts: { preserveUpdatedAt?: boolean } = {},
): ConversationRecord | null {
  if (!isPlainObject(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;
  const rawMessages = Array.isArray(raw.messages) ? raw.messages : [];
  const normalizedMessages = rawMessages
    .map(normalizeConversationMessage)
    .filter((entry): entry is ConversationMessageRecord => Boolean(entry));
  const pruned = pruneConversationMessages(normalizedMessages);
  const hasExistingMessages = Boolean(existing?.messages && existing.messages.length);
  const resolvedMessages = pruned.messages.length ? pruned.messages : hasExistingMessages ? existing!.messages : pruned.messages;
  const resolvedTruncated = pruned.truncated || (hasExistingMessages ? existing?.truncated : false);
  const createdAt =
    typeof raw.createdAt === "number"
      ? raw.createdAt
      : existing?.createdAt ?? Date.now();
  const updatedAt = opts.preserveUpdatedAt
    ? (typeof raw.updatedAt === "number" ? raw.updatedAt : createdAt)
    : Date.now();
  return {
    id,
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title : existing?.title || "Conversation",
    createdAt,
    updatedAt,
    selectedDocId:
      raw.selectedDocId === null
        ? null
        : typeof raw.selectedDocId === "string"
          ? raw.selectedDocId
          : existing?.selectedDocId ?? null,
    selectedDocTitle:
      typeof raw.selectedDocTitle === "string"
        ? raw.selectedDocTitle
        : existing?.selectedDocTitle || "",
    truncated: resolvedTruncated || Boolean(raw.truncated),
    summary: normalizeConversationSummary(raw.summary) || existing?.summary,
    messages: resolvedMessages,
  };
}

async function upsertConversationRecord(
  env: Env,
  scope: string,
  raw: unknown,
): Promise<{ record: ConversationRecord; index: ConversationIndexEntry } | null> {
  if (!env.DOCS_KV) return null;
  const candidate = isPlainObject(raw) ? raw : null;
  if (!candidate) return null;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  if (!id) return null;
  const existing = await loadConversationRecord(env, scope, id);
  const normalized = normalizeConversationRecord(candidate, existing);
  if (!normalized) return null;
  const features = getRuntimeFeatures(env);
  let record = normalized;
  const beforeCompactionHooks = await runRuntimeHooks(
    "before_conversation_compaction",
    { scope, conversationId: normalized.id, messageCount: normalized.messages.length },
    { enabled: features.hooks.enabled },
  );
  if (beforeCompactionHooks.denied) {
    console.warn("[runtime.hooks] skipping conversation compaction", {
      scope,
      conversationId: normalized.id,
      reasons: beforeCompactionHooks.reasons,
    });
  } else {
    record = compactConversationRecord(normalized, features.conversationCompaction);
  }
  await runRuntimeHooks(
    "after_conversation_compaction",
    {
      scope,
      conversationId: record.id,
      messageCount: record.messages.length,
      summaryUpdated: Boolean(record.summary),
    },
    { enabled: features.hooks.enabled },
  );
  await env.DOCS_KV.put(conversationRecordKey(scope, record.id), JSON.stringify(record));
  const indexEntry: ConversationIndexEntry = {
    id: record.id,
    title: record.title || "Conversation",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    selectedDocId: record.selectedDocId ?? null,
    selectedDocTitle: record.selectedDocTitle || "",
    messageCount: record.messages.length,
  };
  const index = await loadConversationIndex(env, scope);
  const nextIndex = index.filter(entry => entry.id !== record.id);
  nextIndex.unshift(indexEntry);
  await saveConversationIndex(env, scope, nextIndex);
  return { record, index: indexEntry };
}


const CORS_HEADERS: Record<string, string> = {};
const OWEN_CLIENT_BUILD = "20260309-1";
const OWEN_CLIENT_ASSET_PATH = `/chat.${OWEN_CLIENT_BUILD}.js`;
const TRAFFIC_ID_SALT = "owen-traffic-v1";

type TrafficRole = "student" | "faculty";

function isTrafficRole(value: unknown): value is TrafficRole {
  return value === "student" || value === "faculty";
}

function sanitizeTrafficUserId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-f0-9]{5}$/.test(raw) ? raw : "";
}

function sanitizeTrafficTabId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9_-]{6,48}$/.test(raw) ? raw : "";
}

function getTrafficRequestIp(req: Request): string {
  const direct = (req.headers.get("cf-connecting-ip") || "").trim();
  if (direct) return direct;
  const forwarded = (req.headers.get("x-forwarded-for") || "").split(",")[0]?.trim() || "";
  if (forwarded) return forwarded;
  return "0.0.0.0";
}

async function buildTrafficAnonId(req: Request): Promise<string> {
  const ip = getTrafficRequestIp(req);
  const userAgent = (req.headers.get("user-agent") || "").trim();
  const hash = await sha256(`${ip}${userAgent}${TRAFFIC_ID_SALT}`);
  return hash.slice(0, 5).toLowerCase();
}

function shouldLogTrafficDev(req: Request): boolean {
  const hostname = new URL(req.url).hostname.trim().toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".local");
}

function getPresenceStub(env: Env) {
  const id = env.PRESENCE_ROOM.idFromName("global-presence");
  return env.PRESENCE_ROOM.get(id);
}

function isTrafficSnapshot(value: unknown): value is TrafficSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.activeStudents === "number" &&
    Number.isFinite(candidate.activeStudents) &&
    typeof candidate.activeFaculty === "number" &&
    Number.isFinite(candidate.activeFaculty) &&
    typeof candidate.activeTotal === "number" &&
    Number.isFinite(candidate.activeTotal) &&
    Array.isArray(candidate.users) &&
    Array.isArray(candidate.series) &&
    typeof candidate.updatedAt === "string"
  );
}

async function fetchPresenceSnapshot(
  env: Env,
  path: "/ping" | "/snapshot",
  init?: RequestInit,
): Promise<TrafficSnapshot | null> {
  const stub = getPresenceStub(env);
  const resp = await stub.fetch(`https://presence${path}`, init);
  if (!resp.ok) return null;
  const payload = await resp.json().catch(() => null);
  if (!isTrafficSnapshot(payload)) return null;
  return payload;
}

async function resolveTrafficUserId(req: Request, provided: unknown): Promise<string> {
  const normalized = sanitizeTrafficUserId(provided);
  if (normalized) return normalized;
  return buildTrafficAnonId(req);
}

function logFacultyAuthAttempt(details: {
  req: Request;
  label: string;
  source: "cookie" | "header" | "none";
  hasCookie: boolean;
  hasHeader: boolean;
  ok: boolean;
  reason?: string;
}) {
  const { req, label, source, hasCookie, hasHeader, ok, reason } = details;
  const url = new URL(req.url);
  const payload = {
    label,
    path: url.pathname,
    method: req.method,
    source,
    cookie: hasCookie,
    header: hasHeader,
    ok,
    reason: ok ? undefined : reason || "unauthorized",
  };
  if (ok) {
    console.info("[FACULTY_AUTH]", payload);
  } else {
    console.warn("[FACULTY_AUTH]", payload);
  }
}

function appendSetCookie(resp: Response, cookie: string | undefined): Response {
  if (!cookie) return resp;
  const headers = new Headers(resp.headers);
  headers.append("Set-Cookie", cookie);
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

function mapLegacyFacultyAction(label: string): PolicyAction {
  switch (label) {
    case "library_category_create":
      return "library.category.create";
    case "library_course_create":
      return "library.course.create";
    case "library_course_rename":
      return "library.course.rename";
    case "library_course_delete":
      return "library.course.delete";
    case "library_lecture_update":
      return "library.lecture.update";
    case "library_txt_upload":
      return "library.txt.upload";
    case "library_qbank_upload":
      return "library.qbank.upload";
    case "library_delete":
      return "library.delete";
    case "study_guide_publish":
      return "study-guide.publish";
    case "anki_publish":
      return "anki.publish";
    case "anki_generate":
      return "anki.generate";
    default:
      return "library.download.internal";
  }
}

async function requireFaculty(
  req: Request,
  env: Env,
  label: string,
): Promise<{ ok: true; context: { isFaculty: true; session: AuthSessionRecord } } | { ok: false; response: Response }> {
  const config = getAppConfig(env, req);
  const { source, hasCookie, hasHeader } = readAuthToken(req);
  const session = await getAuthSession(req, env, config);
  const decision = AuthorizationPolicy.canAccess(session, mapLegacyFacultyAction(label));
  if (!decision.allowed || !session) {
    logFacultyAuthAttempt({
      req,
      label,
      source,
      hasCookie,
      hasHeader,
      ok: false,
      reason: decision.reason || "unauthorized",
    });
    await writeAuditEvent(env, req, getRequestId(req), {
      event: "authz.denied",
      outcome: "denied",
      actor: buildAuditActor(session),
      metadata: { label, reason: decision.reason || "unauthorized" },
    });
    return { ok: false, response: jsonNoStore({ error: "unauthorized" }, 401) };
  }
  logFacultyAuthAttempt({
    req,
    label,
    source,
    hasCookie,
    hasHeader,
    ok: true,
  });
  return { ok: true, context: { isFaculty: true, session } };
}

async function requireLectureAnalyticsRead(
  req: Request,
  env: Env,
  label: string,
): Promise<{ ok: true; session: AuthSessionRecord } | { ok: false; response: Response }> {
  const config = getAppConfig(env, req);
  const { source, hasCookie, hasHeader } = readAuthToken(req);
  const session = await getAuthSession(req, env, config);
  const decision = AuthorizationPolicy.canAccess(session, "lecture.analytics.read");
  if (!decision.allowed || !session) {
    logFacultyAuthAttempt({
      req,
      label,
      source,
      hasCookie,
      hasHeader,
      ok: false,
      reason: decision.reason || "unauthorized",
    });
    await writeAuditEvent(env, req, getRequestId(req), {
      event: "authz.denied",
      outcome: "denied",
      actor: buildAuditActor(session),
      metadata: { label, reason: decision.reason || "unauthorized" },
    });
    return { ok: false, response: jsonNoStore({ error: "unauthorized" }, 401) };
  }
  logFacultyAuthAttempt({
    req,
    label,
    source,
    hasCookie,
    hasHeader,
    ok: true,
  });
  return { ok: true, session };
}

async function getConversationRequestContext(req: Request, env: Env): Promise<{
  scope: string;
  setCookie?: string;
}> {
  const config = getAppConfig(env, req);
  const browserSession = await ensureBrowserSession(req, env, config);
  return {
    scope: getBrowserConversationScope(browserSession.token),
    setCookie: browserSession.cookie,
  };
}

async function requireAdmin(
  req: Request,
  env: Env,
  label: string,
): Promise<{ ok: true; session: AuthSessionRecord } | { ok: false; response: Response }> {
  const config = getAppConfig(env, req);
  const session = await getAuthSession(req, env, config);
  const action: PolicyAction = req.method === "POST" ? "admin.analytics.write" : "admin.analytics.read";
  const decision = AuthorizationPolicy.canAccess(session, action);
  if (!session || !decision.allowed) {
    await writeAuditEvent(env, req, getRequestId(req), {
      event: "authz.denied",
      outcome: "denied",
      actor: buildAuditActor(session),
      metadata: { label, reason: decision.reason || "admin_required" },
    });
    return { ok: false, response: jsonNoStore({ error: "unauthorized" }, 401) };
  }
  return { ok: true, session };
}

async function handleTrafficPing(req: Request, env: Env): Promise<Response> {
  const body = await readRequestJsonBody(req);
  if (!body || typeof body !== "object") {
    return jsonNoStore({ error: "Send JSON { userId?, role, timestamp?, tabId? }." }, 400);
  }
  const roleRaw = typeof body.role === "string" ? body.role.trim().toLowerCase() : "";
  if (!isTrafficRole(roleRaw)) {
    return jsonNoStore({ error: "role must be student or faculty." }, 400);
  }
  const userId = await resolveTrafficUserId(req, body.userId);
  const tabId = sanitizeTrafficTabId(body.tabId);
  const snapshot = await fetchPresenceSnapshot(env, "/ping", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userId,
      role: roleRaw,
      tabId: tabId || undefined,
      ts: Date.now(),
    }),
  });
  if (!snapshot) {
    return jsonNoStore({ error: "presence_unavailable" }, 503);
  }
  if (shouldLogTrafficDev(req)) {
    console.log("Active users:", snapshot.activeTotal);
  }
  return jsonNoStore({
    ok: true,
    userId,
    tabId: tabId || undefined,
    role: roleRaw,
    activeStudents: snapshot.activeStudents,
    activeFaculty: snapshot.activeFaculty,
    users: snapshot.users.map(user => ({ id: user.id, role: user.role })),
    updatedAt: snapshot.updatedAt,
    snapshot,
  });
}

async function handleTrafficSnapshot(req: Request, env: Env): Promise<Response> {
  const snapshot = await fetchPresenceSnapshot(env, "/snapshot");
  if (!snapshot) {
    return jsonNoStore({ error: "presence_unavailable" }, 503);
  }
  if (shouldLogTrafficDev(req)) {
    console.log("Active users:", snapshot.activeTotal);
  }
  return jsonNoStore({
    activeStudents: snapshot.activeStudents,
    activeFaculty: snapshot.activeFaculty,
    users: snapshot.users.map(user => ({ id: user.id, role: user.role })),
    series: snapshot.series,
    updatedAt: snapshot.updatedAt,
  });
}

function rewriteLegacyClientAssetRequest(req: Request, assetUrl: URL): Request {
  if (assetUrl.pathname !== "/chat.js") return req;
  const versionedUrl = new URL(OWEN_CLIENT_ASSET_PATH, assetUrl.origin);
  return new Request(versionedUrl.toString(), req);
}

async function prepareAssetResponse(resp: Response, _env: Env): Promise<Response> {
  if (resp.headers.get("content-type")?.includes("text/html")) {
    const newResp = new Response(resp.body, resp);
    newResp.headers.set("Cache-Control", "no-cache");
    return newResp;
  }
  return resp;
}

const ALLOWED_MODELS = [
  DEFAULT_TEXT_MODEL,
  "gpt-image-1",
  "gpt-image-1-mini",
  "dall-e-3",
  "dall-e-2",
] as const;
type AllowedModel = (typeof ALLOWED_MODELS)[number];

const BUCKET_BINDINGS = {
  "owen-bucket": "OWEN_BUCKET",
  "owen-ingest": "OWEN_INGEST",
  "owen-notes": "OWEN_NOTES",
  "owen-test": "OWEN_TEST",
  "owen-uploads": "OWEN_UPLOADS",
  "own-ingest": "OWN_INGEST",
} as const;

const DEFAULT_BUCKET = "owen-uploads" as const;
const CANONICAL_CACHE_BUCKET_NAME = "owen-ingest" as const;
const EXTRACTION_BUCKET = CANONICAL_CACHE_BUCKET_NAME;
const LIBRARY_BUCKET = CANONICAL_CACHE_BUCKET_NAME;
const enc = new TextEncoder();
const dec = new TextDecoder();
const ANSWER_MAX_OUTPUT_TOKENS = 2600;
const ANSWER_MAX_CONTINUATIONS = 6;
const INSTANT_MAX_OUTPUT_TOKENS = 650;
const INSTANT_TEMPERATURE = 0.2;
const CONTINUATION_TAIL_CHARS = 2000;
const LIBRARY_NOTES_CONTEXT_CHARS = 12_000;
const LIBRARY_NOTES_MAX_OUTPUT_TOKENS = 600;
const LIBRARY_TOTAL_CONTINUATIONS = 24;
const TRUNCATION_NOTICE = "(Response truncated due to server time limits -- click 'Continue' to fetch the rest.)";
const CONTINUATION_INSTRUCTION =
  "You are continuing a partially generated answer only if the previous answer was cut off mid-thought. " +
  "If the previous answer already ended with a short tailoring follow-up that asks the user for more context, stop immediately and return no additional content. " +
  "Do not repeat earlier content or add a '(Continuing...)' label.";
const VECTOR_POLL_INTERVAL_MS = 1500;
const VECTOR_POLL_TIMEOUT_MS = 45_000;
const VECTOR_STORE_CACHE_KEY = "owen.vector_store_id";
let inMemoryVectorStoreId: string | null = null;
const ankiRateLimitState = new Map<string, { count: number; expiresAt: number }>();
const FILE_CONTEXT_CHAR_LIMIT = 60_000;
const MAX_OCR_TEXT_LENGTH = 900_000;
const MAX_STORED_TEXT_LENGTH = 900_000;
const DEFAULT_MAX_OCR_PAGES = 200;
const CLIENT_OCR_PAGE_CAP = 15;
const MIN_EMBEDDED_PDF_CHARS = 800;
const PDF_SAMPLE_PAGE_TARGET = 5;
const ONE_SHOT_PREVIEW_LIMIT = 1200;
const MAX_EXTRACT_CHARS = 120_000;
const MAX_EXTRACT_PAGES = 200;
const OCR_MAX_OUTPUT_TOKENS = 1800;
const OCR_PAGE_OUTPUT_TOKENS = 1200;
const RETRIEVAL_CHUNK_SIZE = 2200;
const RETRIEVAL_CHUNK_OVERLAP = 200;
const RETRIEVAL_TOP_K = 6;
const LIBRARY_BROAD_TOP_K = 32;
const LIBRARY_BROAD_MIN_CHUNKS = 12;
const LIBRARY_BROAD_MIN_CHARS = 12_000;
const LIBRARY_BROAD_MAX_CONTEXT_CHARS = 36_000;
const DEFAULT_LIBRARY_YEAR: LibraryYearId = "M2";
const DEFAULT_LIBRARY_EXAM: LibraryExamId = 1;
const DEFAULT_LIBRARY_CATEGORIES: LibraryCategory[] = [
  { id: "M2", label: "M2", sortOrder: 1 },
  { id: "M1", label: "M1", sortOrder: 2 },
];
const LIBRARY_YEAR_ORDER: LibraryYearId[] = DEFAULT_LIBRARY_CATEGORIES.map(entry => entry.id);
const DEFAULT_LIBRARY_COURSES: Array<{ yearId: LibraryYearId; name: string; sortOrder?: number }> = [
  { yearId: "M2", name: "CPR", sortOrder: 1 },
  { yearId: "M2", name: "GI", sortOrder: 2 },
  { yearId: "M2", name: "SBL", sortOrder: 3 },
  { yearId: "M2", name: "ECOS III", sortOrder: 4 },
  { yearId: "M1", name: "M1", sortOrder: 1 },
  { yearId: "M1", name: "SFM", sortOrder: 2 },
  { yearId: "M1", name: "MSK", sortOrder: 3 },
  { yearId: "M1", name: "Neuroendocrine", sortOrder: 4 },
];
const QUIZ_BATCH_SIZE = 5;
const QUIZ_CONTEXT_CHUNK_SIZE = 1800;
const QUIZ_CONTEXT_CHUNK_OVERLAP = 200;
const QUIZ_CONTEXT_CHUNK_COUNT = 6;
const QUIZ_MIN_TEXT_CHARS = 300;
const QUIZ_MIN_OUTPUT_TOKENS = 1600;
const QUIZ_MAX_OUTPUT_TOKENS = 4200;
const QUIZ_AI_TIMEOUT_MS = 25_000;
const QUIZ_OUTPUT_SNIPPET_MAX_CHARS = 900;
const QUIZ_DUPLICATE_SIMILARITY_THRESHOLD = 0.8;
const QUIZ_TOKEN_MAX_WINDOWS = 32;
const QUIZ_TOKEN_MAX_FINGERPRINTS = 80;
const QUIZ_FINGERPRINT_MAX_CHARS = 160;
const STORED_QBANK_SOURCE_TYPE = "stored_qbank";
const GEMINI_QUIZ_DEFAULT_MODEL = "gemini-3.1-pro-preview";
const GEMINI_QUIZ_FALLBACK_MODEL = "gemini-2.5-pro";
const GEMINI_QUIZ_HIGH_AVAILABILITY_MODEL = "gemini-2.5-flash";
const GEMINI_API_BASE_DEFAULT = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_QUIZ_TIMEOUT_MS = 180_000;
const GEMINI_QUIZ_DEFAULT_MAX_OUTPUT_TOKENS = 12_000;
const QUIZ_CHOICE_ID_LIST = ["A", "B", "C", "D", "E"] as const;
const QUIZ_DIFFICULTY_LIST = ["easy", "medium", "hard"] as const;
const QUIZ_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["lectureTitle", "setSize", "questions"],
  properties: {
    lectureId: { type: "string", minLength: 1 },
    lectureTitle: { type: "string", minLength: 1 },
    setSize: { type: "integer", const: QUIZ_BATCH_SIZE },
    questions: {
      type: "array",
      minItems: QUIZ_BATCH_SIZE,
      maxItems: QUIZ_BATCH_SIZE,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "stem", "choices", "answer", "rationale", "tags", "difficulty", "references"],
        properties: {
          id: { type: "string", minLength: 1 },
          stem: { type: "string", minLength: 1 },
          choices: {
            type: "array",
            minItems: 5,
            maxItems: 5,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "text"],
              properties: {
                id: { type: "string", enum: [...QUIZ_CHOICE_ID_LIST] },
                text: { type: "string", minLength: 1 },
              },
            },
          },
          answer: { type: "string", enum: [...QUIZ_CHOICE_ID_LIST] },
          rationale: { type: "string", minLength: 1 },
          tags: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: { type: "string", minLength: 1 },
          },
          difficulty: { type: "string", enum: [...QUIZ_DIFFICULTY_LIST] },
          references: {
            type: "array",
            maxItems: 2,
            items: { type: "string", minLength: 1 },
          },
        },
      },
    },
  },
} as const;

function buildQuizJsonSchema(count: number): JsonSchema {
  const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : QUIZ_BATCH_SIZE;
  if (safeCount === QUIZ_BATCH_SIZE) return QUIZ_JSON_SCHEMA as JsonSchema;
  return {
    type: "object",
    additionalProperties: false,
    required: ["lectureTitle", "setSize", "questions"],
    properties: {
      lectureId: { type: "string", minLength: 1 },
      lectureTitle: { type: "string", minLength: 1 },
      setSize: { type: "integer", const: safeCount },
      questions: {
        type: "array",
        minItems: safeCount,
        maxItems: safeCount,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "stem", "choices", "answer", "rationale", "tags", "difficulty", "references"],
          properties: {
            id: { type: "string", minLength: 1 },
            stem: { type: "string", minLength: 1 },
            choices: {
              type: "array",
              minItems: 5,
              maxItems: 5,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "text"],
                properties: {
                  id: { type: "string", enum: [...QUIZ_CHOICE_ID_LIST] },
                  text: { type: "string", minLength: 1 },
                },
              },
            },
            answer: { type: "string", enum: [...QUIZ_CHOICE_ID_LIST] },
            rationale: { type: "string", minLength: 1 },
            tags: {
              type: "array",
              minItems: 1,
              maxItems: 3,
              items: { type: "string", minLength: 1 },
            },
            difficulty: { type: "string", enum: [...QUIZ_DIFFICULTY_LIST] },
            references: {
              type: "array",
              maxItems: 2,
              items: { type: "string", minLength: 1 },
            },
          },
        },
      },
    },
  } as JsonSchema;
}

function buildGeminiQuizJsonSchema(count: number): Record<string, unknown> {
  const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : QUIZ_BATCH_SIZE;
  return {
    type: "object",
    additionalProperties: false,
    required: ["lectureId", "lectureTitle", "setSize", "questions"],
    properties: {
      lectureId: { type: "string" },
      lectureTitle: { type: "string" },
      setSize: { type: "integer", minimum: safeCount, maximum: safeCount },
      questions: {
        type: "array",
        minItems: safeCount,
        maxItems: safeCount,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "stem", "choices", "answer", "rationale", "tags", "difficulty", "references"],
          properties: {
            id: { type: "string" },
            stem: { type: "string" },
            choices: {
              type: "array",
              minItems: 5,
              maxItems: 5,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "text"],
                properties: {
                  id: { type: "string", enum: [...QUIZ_CHOICE_ID_LIST] },
                  text: { type: "string" },
                },
              },
            },
            answer: { type: "string", enum: [...QUIZ_CHOICE_ID_LIST] },
            rationale: { type: "string" },
            tags: {
              type: "array",
              minItems: 1,
              maxItems: 3,
              items: { type: "string" },
            },
            difficulty: { type: "string", enum: [...QUIZ_DIFFICULTY_LIST] },
            references: {
              type: "array",
              maxItems: 2,
              items: { type: "string" },
            },
          },
        },
      },
    },
  };
}
const DEBUG_FORMATTING = false;
const RETRY_DELAYS_MS = [0, 500, 1500];
const DEFAULT_OCR_MAX_PAGES = 15;
const LIBRARY_SEARCH_LIMIT = 12;
const LIBRARY_BATCH_PAGE_LIMIT = 5;
const LIBRARY_QUEUE_MAX = 200;
const MACHINE_TXT_PREFIX = "machine/txt";
const MACHINE_STUDY_GUIDE_PREFIX = "machine/study-guides";
const FACULTY_UPLOADED_TXT_FILENAME = "faculty-upload.txt";
const NO_TEXT_PLACEHOLDER = "[NO TEXT]";
const STUDY_GUIDE_PUBLISH_PREFIX = "Study Guides";
const STUDY_GUIDE_MANIFEST_FILENAME = "manifest.json";
const STUDY_GUIDE_PUBLISH_INDEX_PREFIX = `${STUDY_GUIDE_PUBLISH_PREFIX}/index`;
const STUDY_GUIDE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const STUDY_GUIDE_CODE_LENGTH = 8;
const STUDY_GUIDE_CODE_MAX_ATTEMPTS = 12;
const ANKI_DECKS_PREFIX = "Anki Decks";
const ANKI_PUBLISH_INDEX_PREFIX = `${ANKI_DECKS_PREFIX}/index`;
const ANKI_CARDS_FILENAME = "cards.tsv";
const ANKI_MANIFEST_FILENAME = "manifest.json";
const ANKI_MEDIA_PREFIX = "media";
const ANKI_CODE_ALPHABET = STUDY_GUIDE_CODE_ALPHABET;
const ANKI_CODE_LENGTH = STUDY_GUIDE_CODE_LENGTH;
const ANKI_CODE_MAX_ATTEMPTS = STUDY_GUIDE_CODE_MAX_ATTEMPTS;
const ANKI_MAX_PAGES = 80;
const ANKI_MAX_IMAGES = 80;
const ANKI_PDF_RENDER_MAX_DIMENSION = 2000;
const ANKI_IMAGE_MAX_DIMENSION = 2200;
const ANKI_JPEG_QUALITY = 0.8;
const ANKI_IMAGE_UPLOAD_CONCURRENCY = 3;
const ANKI_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const ANKI_IMAGE_UPLOAD_MAX_ATTEMPTS = 3;
const ANKI_IMAGE_UPLOAD_BASE_DELAY_MS = 500;
const ANKI_IMAGE_UPLOAD_MAX_DELAY_MS = 2500;
const ANKI_IMAGE_UPLOAD_JITTER_MS = 250;
const ANKI_IMAGE_BATCH_SIZE = 10;
const ANKI_MODEL = DEFAULT_TEXT_MODEL;
const ANKI_MAX_OUTPUT_TOKENS = 12000;
const ANKI_SAFE_SINGLE_PASS_TARGET = 50;
const ANKI_NO_TEXT_SAFE_BATCH_TARGET = 30;
const ANKI_NO_TEXT_MAX_BATCHES = 6;
const ANKI_RATE_LIMIT_MAX = 20;
const ANKI_RATE_LIMIT_WINDOW_SECONDS = 10 * 60;
const ANKI_UPLOAD_MAX_BYTES = 40 * 1024 * 1024;
const ANKI_SNIFF_HEADER_BYTES = 16;
const ANKI_TEXT_SNIFF_BYTES = 64 * 1024;
const ANKI_TEXT_PRINTABLE_THRESHOLD = 0.85;
const LECTURE_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
const LECTURE_INLINE_PARSE_MAX_BYTES = 20 * 1024 * 1024;
const LECTURE_UPLOAD_TOO_LARGE_ERROR = "File exceeds 100MB limit.";
const LECTURE_UPLOAD_DEFERRED_WARNING = "Large lecture file stored in R2. Conversion deferred.";
const LECTURE_TXT_UPLOAD_MAX_BYTES = LECTURE_UPLOAD_MAX_BYTES;
const LECTURE_DOC_UPLOAD_MAX_BYTES = LECTURE_UPLOAD_MAX_BYTES;
const MACHINE_STUDY_GUIDE_MAX_BYTES = 12 * 1024 * 1024;
const MACHINE_STUDY_GUIDE_MAX_OUTPUT_TOKENS = 20000;
const MACHINE_STUDY_GUIDE_STEP_A_MAX_OUTPUT_TOKENS = 8000;
const MACHINE_STUDY_GUIDE_STEP_B_MAX_OUTPUT_TOKENS = 5000;
const MACHINE_STUDY_GUIDE_STEP_B_PLAN_MAX_OUTPUT_TOKENS = 1200;
const MACHINE_STUDY_GUIDE_STEP_B_PLAN_RETRY_MAX_OUTPUT_TOKENS = 800;
const MACHINE_STUDY_GUIDE_STEP_B1_OUTLINE_MAX_OUTPUT_TOKENS = 2000;
const MACHINE_STUDY_GUIDE_STEP_B_QC_REWRITE_MAX_OUTPUT_TOKENS = 3500;
const MACHINE_STUDY_GUIDE_STEP_C_MAX_OUTPUT_TOKENS = 1200;
const MACHINE_STUDY_GUIDE_STEP_A_MAX_SLIDES = 6;
const MACHINE_STUDY_GUIDE_STEP_A_MAX_CHARS = 12_000;
const MACHINE_STUDY_GUIDE_STEP_A_ADAPTIVE_CHARS = 10_000;
const MACHINE_STUDY_GUIDE_STEP_A_ADAPTIVE_TOKENS = 2_400;
const MACHINE_STUDY_GUIDE_STEP_A_TRUNCATION_MAX_RETRIES = 2;
const MACHINE_STUDY_GUIDE_STEP_A_MIN_CHARS = 800;
const MACHINE_STUDY_GUIDE_STEP_A_TIME_BUDGET_MS = 22_000;
const MACHINE_STUDY_GUIDE_STEP_A_SPLIT_MAX_DEPTH = 6;
const MACHINE_STUDY_GUIDE_STEP_A_MIN_SLIDES = 1;
const MACHINE_STUDY_GUIDE_STEP_A_PIPELINE_VERSION = "v1";
const MACHINE_STUDY_GUIDE_STEP_B_INPUT_MAX_CHARS = 120_000;
const MACHINE_STUDY_GUIDE_STEP_A_SUMMARY_CHUNK_CHARS = 12_000;
const MACHINE_STUDY_GUIDE_STEP_A_SUMMARY_MAX_OUTPUT_TOKENS = 700;
const MACHINE_STUDY_GUIDE_STEP_B_REPAIR_MAX_OUTPUT_TOKENS = 2000;
const MACHINE_STUDY_GUIDE_STEP_C_REPAIR_MAX_OUTPUT_TOKENS = 1200;
const MACHINE_TEXT_JSON_LIMIT = 200_000;
const MACHINE_STUDY_GUIDE_DEFAULT_UTC = "1970-01-01T00:00:00Z";
const STUDY_GUIDE_TEMPERATURE = 0;
const STUDY_GUIDE_TOP_P = 1;
let loggedCanonicalBucket = false;
const requestJsonBodyCache = new WeakMap<Request, string>();
const CONVERSATION_INDEX_KEY = "conversation:index";
const CONVERSATION_RECORD_PREFIX = "conversation:record:";
const MAX_CONVERSATION_MESSAGES = 400;
const MAX_CONVERSATION_CHARS = 600_000;
const MAX_CONVERSATION_MESSAGE_CHARS = 120_000;
const MAX_CONVERSATION_META_LIST = 50;
const MAX_CONVERSATION_TOPICS = 20;

type DocSummary = {
  file_id?: string;
  filename?: string;
  summary?: string;
  key_points?: string[];
  raw_excerpt?: string;
};

type OpenAIJson = any;

function last<T>(arr: T[]): T | undefined {
  return arr.length ? arr[arr.length - 1] : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readRequestJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  const cached = requestJsonBodyCache.get(req);
  if (typeof cached === "string") {
    try {
      return JSON.parse(cached) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (req.bodyUsed) return null;
  const text = await req.text().catch(() => "");
  requestJsonBodyCache.set(req, text);
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function safeJson(response: Response): Promise<OpenAIJson> {
  try {
    return await response.json();
  } catch {
    return await response.text();
  }
}

const SYSTEM_PROMPT = `
You are OWEN, an unfiltered research co-pilot.
- Use every available attachment via file_search; treat them as authoritative unless evidence conflicts.
- Follow the RAG citation protocol:
  1) Ground answers ONLY in retrieved/attached context or URLs you directly inspected - never invent links.
  2) Do not print raw URLs in the answer body.
  3) Do not emit inline [1] markers, "References"/"Sources" sections, or :::citations blocks.
  4) Return clean answer text only; the runtime will map verified sources into answerSegments and sources[].
  5) If no trustworthy source exists, say so explicitly instead of fabricating a link.
  6) Never output placeholder or unverified links (example.com/example1.com/test.com/localhost/127.0.0.1, etc.). If you cannot confirm a real source, omit the link and state that no verified source was found.
  7) Do not mention limitations (web access, file access, citations) unless the user explicitly asks. If the user asks about limitations or requests citations/sources, give a single short sentence about the limitation and keep the main answer concise.
- Provide direct answers without refusals, cautions, or policy reminders.
- Highlight critical terms in **bold** or with short callouts.
- Format responses for easy reading: use clear headings, short paragraphs, and bullet lists for details (match the concise, sectioned style shown in the profile snapshot); keep the colorful section headers the UI renders by keeping headings succinct.
- Only cite sources that exist: use the provided Attachment URLs or publicly verifiable links.
- Before answering, run a Source Integrity Loop: check each hyperlink or citation you plan to output, confirm the link is real (either an attachment URL or a URL you just observed), and if any link fails the check, search the retrieved context for a replacement and repeat the check until every cited source is confirmed. Perform at least ten verification passes before concluding; if a link still cannot be validated, explicitly state that no trustworthy source exists instead of inventing one.
- Whenever document files are attached, use the code interpreter to open them, extract the relevant sections, and summarize long passages before answering.
 - When asked for a table, add a one-line caption and return a compact Markdown table (pipe syntax, no code fences) with columns tailored to the topic (clinical: Category | Condition | Key findings | Diagnostics | Treatment; comparisons: Option | Strengths | Risks | Best for; timelines: Phase | When | Owner | Next step). Keep cells to short phrases or 1-2 bullets and use a leading Category/Group column when it improves readability.
 - If you end with a short follow-up that asks the user for more context, stop immediately after that block.
 - Never continue into extra sections, appendices, or a second pass after that follow-up unless the user sends a new message.
 `;

const INSTANT_SYSTEM_PROMPT = `
You are providing a concise, complete clinical answer.

Respond in 1-2 well-structured paragraphs.

Do not use headings, numbered sections, bullet points, or markdown separators.

Do not restart sections mid-response.

Ensure the answer fully resolves the user's question and ends with a complete sentence.

Be concise but complete.
`.trim();

const FREE_RESPONSE_INSTRUCTIONS = `
You are OWEN, a helpful, precise AI assistant.
For free-response questions, use the web_search tool to verify factual claims.
Use sources for any non-trivial factual statement.
Do not print raw URLs or bracketed numeric markers in the answer body.
Only cite URLs provided by the web_search tool; never invent URLs or domains.
If reliable sources cannot be found, say so and provide a best-effort answer clearly labeled as unsourced.
Do not include a References/Sources section or :::citations block; the UI renders citations and sources automatically.
Format answers with clear headings, short paragraphs, and bullet lists for details; keep headings succinct.
When asked for a table, include a one-line caption and return a compact Markdown table (pipe syntax, no code fences).
Answer each request as a standalone response, even if the user previously asked a similar question.
Omit empty section headings; never output a heading without at least one concrete point under it.
If you end with a tailoring follow-up, stop immediately after that block.
`.trim();

const MODEL_FALLBACKS: Partial<Record<AllowedModel, AllowedModel[]>> = {
  [DEFAULT_TEXT_MODEL]: [],
  "gpt-image-1": ["gpt-image-1-mini", "dall-e-3", "dall-e-2"],
  "gpt-image-1-mini": ["dall-e-3", "dall-e-2"],
  "dall-e-3": ["dall-e-2"],
  "dall-e-2": [],
};

const MODEL_ALIAS_RESOLVERS: Partial<Record<AllowedModel, (env: Env) => string>> = {
  [DEFAULT_TEXT_MODEL]: getConfiguredDefaultTextModel,
  "gpt-image-1": (env) => env.GPT_IMAGE_1_MODEL_ID?.trim() || "gpt-image-1",
  "gpt-image-1-mini": (env) => env.GPT_IMAGE_1_MINI_MODEL_ID?.trim() || "gpt-image-1-mini",
  "dall-e-3": (env) => env.DALLE3_MODEL_ID?.trim() || "dall-e-3",
  "dall-e-2": (env) => env.DALLE2_MODEL_ID?.trim() || "dall-e-2",
};

function isAllowedModel(model: string | undefined | null): model is AllowedModel {
  return typeof model === "string" && (ALLOWED_MODELS as readonly string[]).includes(model);
}

const IMAGE_MODELS = new Set<string>(["gpt-image-1", "gpt-image-1-mini", "dall-e-3", "dall-e-2"]);

function isImageModel(model: string | undefined | null): boolean {
  if (!model) return false;
  return IMAGE_MODELS.has(model.toLowerCase());
}

function getConfiguredDefaultTextModel(env: Env): string {
  const configured = env.DEFAULT_TEXT_MODEL?.trim();
  if (!configured) {
    throw new Error("DEFAULT_TEXT_MODEL missing from env. Check .dev.vars");
  }
  return configured;
}

function getDefaultModel(env: Env): AllowedModel {
  getConfiguredDefaultTextModel(env);
  return DEFAULT_TEXT_MODEL;
}

function resolveModelId(model: AllowedModel, env: Env) {
  const resolver = MODEL_ALIAS_RESOLVERS[model];
  const resolved = resolver ? resolver(env) : model;
  return resolved || model;
}

function modelSupportsFileSearch(model: string) {
  if (isImageModel(model)) return false;
  return true;
}

let runtimeEnvValidated = false;

export function validateRuntimeEnv(env: Env): void {
  if (runtimeEnvValidated) return;
  if (!env.DEFAULT_TEXT_MODEL?.trim()) {
    throw new Error("DEFAULT_TEXT_MODEL missing from env. Check .dev.vars");
  }
  runtimeEnvValidated = true;
}

type OpenAIEndpoint = "responses" | "chat_completions";

type SamplingEnv = { OWEN_STRIP_SAMPLING_PARAMS?: string; DEFAULT_TEXT_MODEL?: string };

type ModelSamplingSupport = {
  supportsTemperature: boolean;
  supportsTopP: boolean;
};

const DEFAULT_MODEL_SAMPLING_SUPPORT: ModelSamplingSupport = {
  supportsTemperature: true,
  supportsTopP: true,
};

const MODEL_SAMPLING_CAPABILITIES: Record<
  string,
  Partial<Record<OpenAIEndpoint, ModelSamplingSupport>> & { default?: ModelSamplingSupport }
> = {
  [DEFAULT_TEXT_MODEL]: { responses: { supportsTemperature: false, supportsTopP: false } },
};

function normalizeModelKey(model?: string | null): string {
  return (model || "").trim().toLowerCase();
}

function resolveSamplingSupport(
  model: string,
  endpoint: OpenAIEndpoint,
  env?: SamplingEnv,
  forceStripSampling?: boolean,
): ModelSamplingSupport {
  if (forceStripSampling || env?.OWEN_STRIP_SAMPLING_PARAMS === "1") {
    return { supportsTemperature: false, supportsTopP: false };
  }
  const normalized = normalizeModelKey(model);
  if (!normalized) return DEFAULT_MODEL_SAMPLING_SUPPORT;
  const configuredDefaultModel = normalizeModelKey(env?.DEFAULT_TEXT_MODEL);
  if (configuredDefaultModel && normalized === configuredDefaultModel) {
    const entry = MODEL_SAMPLING_CAPABILITIES[DEFAULT_TEXT_MODEL];
    return entry?.[endpoint] || entry?.default || DEFAULT_MODEL_SAMPLING_SUPPORT;
  }
  if (MODEL_SAMPLING_CAPABILITIES[normalized]) {
    const entry = MODEL_SAMPLING_CAPABILITIES[normalized];
    return entry?.[endpoint] || entry?.default || DEFAULT_MODEL_SAMPLING_SUPPORT;
  }
  for (const [key, entry] of Object.entries(MODEL_SAMPLING_CAPABILITIES)) {
    if (normalized.startsWith(key)) {
      return entry?.[endpoint] || entry?.default || DEFAULT_MODEL_SAMPLING_SUPPORT;
    }
  }
  return DEFAULT_MODEL_SAMPLING_SUPPORT;
}

/**
 * Remove unsupported parameters from an OpenAI request payload.
 *
 * @param payload - Original request payload.
 * @param opts - Endpoint/model context used to decide which fields to strip.
 * @returns Sanitized payload plus list of removed keys.
 */
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

function shouldRetryUnsupportedParams(message: string): boolean {
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

type SendOpenAIResult<T> = { ok: true; value: T } | { ok: false; errorText: string; status?: number };

/**
 * Send an OpenAI request and retry once if unsupported parameters are detected.
 *
 * @param opts - Payload + endpoint info and a `send` callback to perform the request.
 * @returns Result object with attempts and the sanitized payload used.
 * @remarks Side effects: calls `send` (network) and logs warnings; rethrows if `send` throws.
 */
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
  const additionalRemovals = retryAttempt.removedKeys.filter(key => !firstAttempt.removedKeys.includes(key));
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

export async function handleAssetRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const compatAssetPath = url.pathname === "/public"
    ? "/index.html"
    : url.pathname.startsWith("/public/")
      ? url.pathname.slice("/public".length)
      : "";
  if (compatAssetPath) {
    const compatUrl = new URL(compatAssetPath, url.origin);
    compatUrl.search = url.search;
    const compatReq = new Request(compatUrl.toString(), request);
    const compatResp = await env.ASSETS.fetch(rewriteLegacyClientAssetRequest(compatReq, compatUrl));
    if (compatResp.status !== 404) {
      return prepareAssetResponse(compatResp, env);
    }
  }
  const assetResp = await env.ASSETS.fetch(rewriteLegacyClientAssetRequest(request, url));
  if (assetResp.status !== 404) {
    return prepareAssetResponse(assetResp, env);
  }
  const fallbackUrl = new URL("/index.html", url.origin);
  const fallbackReq = new Request(fallbackUrl.toString(), request);
  const fallbackResp = await env.ASSETS.fetch(fallbackReq);
  return prepareAssetResponse(fallbackResp, env);
}

export async function handleApiRequest(req: Request, env: Env): Promise<Response> {
  const request = req;
  const url = new URL(request.url);

  if (url.pathname === "/api/models" && request.method === "GET") {
    return json({ models: ALLOWED_MODELS });
  }

  if (url.pathname === "/api/meta-tags") {
    return handleMetaTagsRequest(req, env);
  }

  if (url.pathname === "/api/conversations") {
    if (req.method === "GET") {
      const conversationId = url.searchParams.get("conversation_id") || "";
      if (conversationId) {
        return handleConversationGet(req, conversationId, env);
      }
      return handleConversationList(req, env);
    }
    if (req.method === "POST") {
      return handleConversationUpsert(req, env);
    }
    if (req.method === "DELETE") {
      const conversationId = url.searchParams.get("conversation_id") || "";
      return handleConversationDelete(req, conversationId, env);
    }
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }

  if (url.pathname.startsWith("/api/conversations/")) {
    const conversationId = decodeURIComponent(url.pathname.split("/").pop() || "");
    if (req.method === "GET") {
      return handleConversationGet(req, conversationId, env);
    }
    if (req.method === "DELETE") {
      return handleConversationDelete(req, conversationId, env);
    }
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }

  if (url.pathname === "/api/faculty/analytics" && req.method === "GET") {
    return handleLectureAnalyticsRead(req, env);
  }

  if (url.pathname === "/api/admin/analytics") {
    if (req.method === "GET") {
      return handleLectureAnalyticsRead(req, env);
    }
    const admin = await requireAdmin(req, env, "admin_analytics");
    if (!admin.ok) return admin.response;
    if (req.method === "POST") {
      const body = await req.json().catch(() => null);
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
      const record = await appendLectureAnalytics(env, docId);
      return jsonNoStore(record);
    }
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }

  if (url.pathname === "/api/presence" && req.method === "POST") {
    return handleTrafficPing(req, env);
  }

  if ((url.pathname === "/api/presence" || url.pathname === "/api/presence/snapshot") && req.method === "GET") {
    return handleTrafficSnapshot(req, env);
  }

  if (url.pathname === "/api/traffic/ping" && req.method === "POST") {
    return handleTrafficPing(req, env);
  }

  if (url.pathname === "/api/traffic/snapshot" && req.method === "GET") {
    return handleTrafficSnapshot(req, env);
  }

  if (url.pathname === "/api/auth/providers" && req.method === "GET") {
    return handleAuthProviders(req, env);
  }

  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    return handleAuthLogin(req, env);
  }

  if (url.pathname === "/api/auth/session" && req.method === "GET") {
    return handleAuthSession(req, env);
  }

  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    return handleAuthLogout(req, env);
  }

  if (url.pathname === "/api/auth/oidc/start" && req.method === "GET") {
    return handleAuthOidcStart(req, env);
  }

  if (url.pathname === "/api/auth/oidc/callback" && req.method === "GET") {
    return handleAuthOidcCallback(req, env);
  }

  if (url.pathname === "/api/faculty/login" && req.method === "POST") {
    return handleFacultyLogin(req, env);
  }

  if (url.pathname === "/api/faculty/session" && req.method === "GET") {
    return handleFacultySession(req, env);
  }

  if (url.pathname === "/api/faculty/logout" && req.method === "POST") {
    return handleFacultyLogout(req, env);
  }

  if (url.pathname === "/api/library/search" && req.method === "GET") {
    return handleLibrarySearch(req, env);
  }

  if (url.pathname === "/api/library/courses" && req.method === "GET") {
    return handleLibraryCourses(req, env);
  }

  if (url.pathname === "/api/library/categories" && req.method === "GET") {
    return handleLibraryCategories(req, env);
  }

  if (url.pathname === "/api/library/categories" && req.method === "POST") {
    return handleLibraryCategoryCreate(req, env);
  }

  if (url.pathname === "/api/library/courses" && req.method === "POST") {
    return handleLibraryCourseCreate(req, env);
  }

  if (url.pathname === "/api/library/course" && req.method === "PATCH") {
    return handleLibraryCourseRename(req, env);
  }

  if (url.pathname === "/api/library/course" && req.method === "DELETE") {
    return handleLibraryCourseDelete(req, env);
  }

  if (url.pathname === "/api/library/ingest" && req.method === "POST") {
    return handleLibraryIngest(req, env);
  }

  if (url.pathname === "/api/library/ask" && req.method === "POST") {
    return handleLibraryAsk(req, env);
  }

  if (url.pathname === "/api/library/ask-continue" && req.method === "POST") {
    return handleLibraryAskContinue(req, env);
  }

  if (url.pathname === "/api/library/gemini-quiz" && req.method === "POST") {
    return handleLibraryGeminiQuiz(req, env);
  }

  if (url.pathname === "/api/library/quiz" && req.method === "POST") {
    return handleLibraryQuiz(req, env);
  }

  if (url.pathname === "/api/library/quiz/interrupt" && req.method === "POST") {
    return handleLibraryQuizInterrupt(req, env);
  }

  if (url.pathname === "/api/library/qbank/save-from-quiz" && req.method === "POST") {
    return handleLibraryQbankSaveFromQuiz(req, env);
  }

  if (url.pathname === "/api/library/qbank/upload" && req.method === "POST") {
    return handleLibraryQbankUpload(req, env);
  }

  if (url.pathname === "/api/library/txt/upload" && req.method === "POST") {
    return handleLibraryTxtUpload(req, env);
  }

  if (url.pathname === "/api/library/list" && req.method === "GET") {
    return handleLibraryList(req, env);
  }

  if (url.pathname === "/api/library/lecture" && req.method === "PATCH") {
    return handleLibraryLectureUpdate(req, env);
  }

  if (url.pathname === "/api/library/download" && req.method === "GET") {
    return handleLibraryDownload(req, env);
  }

  if (url.pathname === "/api/library/lecture" && req.method === "DELETE") {
    return handleLibraryDelete(req, env);
  }

  if (url.pathname === "/api/library/batch-index" && req.method === "POST") {
    return handleLibraryBatchIndex(req, env);
  }

  if (url.pathname === "/api/library/batch-ingest" && req.method === "POST") {
    return handleLibraryBatchIngest(req, env);
  }

  if (url.pathname === "/api/machine/lecture-to-txt" && req.method === "POST") {
    return handleMachineLectureToTxt(req, env);
  }

  if (url.pathname === "/api/machine/generate-study-guide" && req.method === "POST") {
    return handleMachineGenerateStudyGuide(req, env);
  }

  if (url.pathname === "/api/machine/download" && req.method === "GET") {
    return handleMachineDownload(req, env);
  }

  if (url.pathname === "/api/study-guides/publish" && req.method === "POST") {
    return handlePublishStudyGuide(req, env);
  }

  if (url.pathname === "/api/publish/study-guide" && req.method === "POST") {
    return handlePublishStudyGuide(req, env);
  }

  if (url.pathname === "/api/retrieve/study-guide" && req.method === "GET") {
    return handleRetrieveStudyGuide(req, env);
  }

  if (url.pathname === "/api/study-guides/asset" && req.method === "GET") {
    return handleStudyGuideAssetDownload(req, env);
  }

  if (url.pathname === "/api/anki/generate" && req.method === "POST") {
    return handleAnkiGenerate(req, env);
  }

  if (url.pathname === "/api/anki/publish" && req.method === "POST") {
    return handlePublishAnki(req, env);
  }

  if (url.pathname === "/api/publish/anki" && req.method === "POST") {
    return handlePublishAnki(req, env);
  }

  if (url.pathname === "/api/anki/download" && req.method === "GET") {
    return handleAnkiDownload(req, env);
  }

  if (url.pathname === "/api/r2/signed-url" && req.method === "GET") {
    return handleSignedUrl(req, env);
  }

  if (url.pathname === "/api/upload" && req.method === "POST") {
    return handleUpload(req, env);
  }

  if (url.pathname === "/api/chat/continue" && req.method === "POST") {
    return handleNewChatContinueRoute(req, env);
  }

  if (url.pathname === "/api/chat" && req.method === "POST") {
    return handleNewChatRoute(req, env);
  }

  if (url.pathname === "/api/pdf-ingest" && req.method === "POST") {
    return handlePdfIngest(req, env);
  }

  if (url.pathname === "/api/ask-file" && req.method === "POST") {
    return handleAskFile(req, env);
  }

  if (url.pathname === "/api/ask-doc" && req.method === "POST") {
    return handleAskDoc(req, env);
  }

  if (url.pathname === "/api/ocr-page" && req.method === "POST") {
    return handleOcrPage(req, env);
  }

  if (url.pathname === "/api/ocr-finalize" && req.method === "POST") {
    return handleOcrFinalize(req, env);
  }

  if (url.pathname === "/api/generate-file" && req.method === "POST") {
    return handleGenerateFile(req, env);
  }

  if (url.pathname === "/api/download" && req.method === "GET") {
    return handleDownload(req, env);
  }

  if (url.pathname === "/api/extract" && req.method === "POST") {
    return handleExtract(req, env);
  }

  if (url.pathname === "/api/file" && req.method === "GET") {
    return handleFile(req, env);
  }

  return new Response("Not found", { status: 404, headers: CORS_HEADERS });
}

async function handleChat(req: Request, env: Env): Promise<Response> {
  // `/api/chat` is owned by the active chat runtime; keep this wrapper so
  // legacy callers that still reach legacy-core follow the same path.
  return handleNewChatRoute(req, env);
}

async function handleChatContinue(req: Request, env: Env): Promise<Response> {
  return handleNewChatContinueRoute(req, env);
}

function resolveAgent(agentId?: string | null): OwenAgent {
  const fallback = AGENTS.default;
  if (!fallback) {
    throw new Error("Default agent configuration missing.");
  }
  if (!agentId) {
    return fallback;
  }
  return AGENTS[agentId] ?? fallback;
}

function gatherFileReferencesFromBody(body: ChatRequestBody): FileReference[] {
  const filesField = Array.isArray(body.files) ? body.files : [];
  const attachmentsField = Array.isArray(body.attachments) ? body.attachments : [];
  const fileRefsField = Array.isArray(body.fileRefs) ? body.fileRefs : [];
  const aggregated = [...filesField, ...attachmentsField, ...fileRefsField];
  if (!aggregated.length) {
    console.warn("No attachment references provided in chat body.", {
      hasFiles: filesField.length > 0,
      hasAttachments: attachmentsField.length > 0,
      hasFileRefs: fileRefsField.length > 0,
    });
    return [];
  }
  console.log("Aggregated attachment references", {
    counts: {
      files: filesField.length,
      attachments: attachmentsField.length,
      fileRefs: fileRefsField.length,
    },
    total: aggregated.length,
  });
  return normalizeFileReferences(aggregated);
}

function chunkTextForRetrieval(text: string, chunkSize = 1800, overlap = 200): string[] {
  const clean = (text || "").replace(/\r\n/g, "\n");
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    const end = Math.min(clean.length, start + chunkSize);
    const slice = clean.slice(start, end).trim();
    if (slice) chunks.push(slice);
    if (end >= clean.length) break;
    start = end - overlap;
    if (start < 0) start = 0;
  }
  return chunks;
}

function scoreChunk(query: string, chunk: string): number {
  if (!chunk) return 0;
  const words = new Set(
    (query || "")
      .toLowerCase()
      .match(/\b[a-z0-9]{3,}\b/g) || [],
  );
  if (!words.size) return 1;
  const text = chunk.toLowerCase();
  let score = 0;
  words.forEach(word => {
    if (text.includes(word)) score += 2;
  });
  score += Math.min(chunk.length / 500, 3); // prefer richer chunks lightly
  return score;
}

function selectContextChunks(question: string, contexts: FileContextRecord[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  contexts.forEach(ctx => {
    const cleanedText = cleanRetrievedChunkText(ctx.text);
    const chunks = chunkTextForRetrieval(cleanedText);
    const scored = chunks
      .map((chunk, idx) => ({ chunk, score: scoreChunk(question, chunk), idx }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map(entry => entry.chunk);
    map.set(ctx.resolvedKey, scored.length ? scored : chunks.slice(0, 2));
    console.log("[PDF] Retrieval chunks selected", {
      key: ctx.resolvedKey,
      totalChunks: chunks.length,
      returned: map.get(ctx.resolvedKey)?.length,
    });
  });
  return map;
}

function normalizeFileReferences(input: unknown): FileReference[] {
  if (!Array.isArray(input)) return [];
  return input
    .map(item => {
      if (!item || typeof item !== "object") return null;
      const bucket = typeof (item as any).bucket === "string" ? (item as any).bucket.trim() : "";
      const key = typeof (item as any).key === "string" ? (item as any).key.trim() : "";
      if (!bucket || !key) return null;
      const textKey = typeof (item as any).textKey === "string" ? (item as any).textKey.trim() : undefined;
      const displayName = typeof (item as any).displayName === "string" ? (item as any).displayName.trim() : undefined;
      const fileId = typeof (item as any).fileId === "string"
        ? (item as any).fileId.trim()
        : typeof (item as any).file_id === "string"
          ? (item as any).file_id.trim()
          : undefined;
      const visionFileId = typeof (item as any).visionFileId === "string"
        ? (item as any).visionFileId.trim()
        : typeof (item as any).vision_file_id === "string"
          ? (item as any).vision_file_id.trim()
          : undefined;
      const record: FileReference = { bucket, key };
      if (textKey) record.textKey = textKey;
      if (displayName) record.displayName = displayName;
      if (fileId) record.fileId = fileId;
      if (visionFileId) record.visionFileId = visionFileId;
      return record;
    })
    .filter((ref): ref is FileReference => Boolean(ref));
}

async function collectFileContext(files: FileReference[], env: Env): Promise<FileContextRecord[]> {
  const contexts: FileContextRecord[] = [];
  let consumedChars = 0;
  for (const file of files) {
    const lookup = lookupBucket(env, file.bucket);
    if (!lookup) {
      console.warn("Skipping attachment with unknown bucket binding.", { bucket: file.bucket, key: file.key });
      continue;
    }
    let textRecord = await loadFileTextFromBucket(lookup.bucket, file);
    const label = file.displayName || file.key;

    // Prefer deterministic, Worker-local ingestion for PDFs/images via raw bytes from R2.
    if (!textRecord) {
      try {
        const original = await lookup.bucket.get(file.key);
        if (original && original.body) {
          const mimeType = original.httpMetadata?.contentType || "";
          const bytes = new Uint8Array(await original.arrayBuffer());
          const ingest = await ingestBinaryForTranscript(env, { bytes, filename: label, mimeType, sourceKey: file.key });
          const extracted = ingest?.text?.trim() || "";
          if (extracted) {
            const transcriptKey = buildOcrKey(file);
            await lookup.bucket.put(transcriptKey, extracted, {
              httpMetadata: { contentType: "text/plain; charset=utf-8" },
            });
            textRecord = { text: extracted, source: ingest!.source, key: transcriptKey };
            console.log("Local transcript extraction succeeded and saved", {
              key: transcriptKey,
              length: extracted.length,
              source: ingest!.source,
            });
          }
        }
      } catch (err) {
        console.warn("Local transcript extraction failed", {
          bucket: file.bucket,
          key: file.key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Fallback: Try vision OCR directly when a vision file id exists.
    if (!textRecord && file.visionFileId) {
      try {
        console.log("Vision OCR attempt for attachment", {
          bucket: file.bucket,
          key: file.key,
          visionFileId: file.visionFileId,
        });
        const extracted = await requestVisionOcrFromFileId(env, file.visionFileId, label);
        if (extracted) {
          const ocrKey = buildOcrKey(file);
          await lookup.bucket.put(ocrKey, extracted.slice(0, MAX_STORED_TEXT_LENGTH), {
            httpMetadata: { contentType: "text/plain; charset=utf-8" },
          });
          textRecord = { text: extracted, source: "ocr" as const, key: ocrKey };
          console.log("Vision OCR succeeded and saved", { key: ocrKey, length: extracted.length });
        }
      } catch (err) {
        console.warn("Vision OCR failed", {
          bucket: file.bucket,
          key: file.key,
          visionFileId: file.visionFileId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Fallback: If we already have an OpenAI file id (Office docs, etc.), keep the legacy Code Interpreter path.
    if (!textRecord && file.fileId) {
      try {
        console.log("On-demand OCR attempt for attachment (OpenAI fallback)", {
          bucket: file.bucket,
          key: file.key,
          fileId: file.fileId,
        });
        const regenerated = await performDocumentTextExtraction(env, {
          fileId: file.fileId,
          visionFileId: file.visionFileId,
          filename: label,
        });
        if (regenerated) {
          const ocrKey = buildOcrKey(file);
          await lookup.bucket.put(ocrKey, regenerated.slice(0, MAX_STORED_TEXT_LENGTH), {
            httpMetadata: { contentType: "text/plain; charset=utf-8" },
          });
          textRecord = { text: regenerated, source: "ocr" as const, key: ocrKey };
          console.log("On-demand OCR succeeded and saved", { key: ocrKey, length: regenerated.length });
        }
      } catch (err) {
        console.warn("On-demand OCR failed", {
          bucket: file.bucket,
          key: file.key,
          fileId: file.fileId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Final fallback: mirror the R2 object to OpenAI (when the client did not send a file id).
    if (!textRecord) {
      try {
        console.log("Missing transcript; mirroring R2 object for OCR", { bucket: file.bucket, key: file.key });
        const mirror = await mirrorBucketObjectToOpenAI(lookup.bucket, file.key, env);
        if (mirror?.fileId) {
          // Prefer vision OCR if we obtained a vision file id during mirroring.
          if (mirror.visionFileId) {
            try {
              const vtext = await requestVisionOcrFromFileId(env, mirror.visionFileId, label || mirror.filename);
              if (vtext) {
                const ocrKey = buildOcrKey(file);
                await lookup.bucket.put(ocrKey, vtext.slice(0, MAX_STORED_TEXT_LENGTH), {
                  httpMetadata: { contentType: "text/plain; charset=utf-8" },
                });
                textRecord = { text: vtext, source: "ocr" as const, key: ocrKey };
                console.log("Vision OCR via mirror succeeded", { key: ocrKey, length: vtext.length });
              }
            } catch (err) {
              console.warn("Vision OCR via mirror failed; falling back to CI", {
                bucket: file.bucket,
                key: file.key,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          if (!textRecord) {
            const regenerated = await performDocumentTextExtraction(env, {
              fileId: mirror.fileId,
              visionFileId: mirror.visionFileId,
              filename: label || mirror.filename,
            });
            if (regenerated) {
              const ocrKey = buildOcrKey(file);
              await lookup.bucket.put(ocrKey, regenerated.slice(0, MAX_STORED_TEXT_LENGTH), {
                httpMetadata: { contentType: "text/plain; charset=utf-8" },
              });
              textRecord = { text: regenerated, source: "ocr" as const, key: ocrKey };
              console.log("Fallback OCR via mirrored file succeeded", { key: ocrKey, length: regenerated.length });
            }
          }
        }
      } catch (err) {
        console.warn("OCR fallback after mirroring failed", {
          bucket: file.bucket,
          key: file.key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (!textRecord) {
      console.warn("No OCR transcript found for attachment", {
        bucket: file.bucket,
        key: file.key,
        textKey: file.textKey,
      });
      continue;
    }
    if (consumedChars >= FILE_CONTEXT_CHAR_LIMIT) {
      console.log("File context character limit reached; skipping remaining attachments.", {
        limit: FILE_CONTEXT_CHAR_LIMIT,
        skippedKey: file.key,
      });
      break;
    }
    let text = textRecord.text;
    const remaining = FILE_CONTEXT_CHAR_LIMIT - consumedChars;
    if (text.length > remaining) {
      text = text.slice(0, remaining) + "\n[Attachment truncated due to context limit]";
    }
    consumedChars += text.length;
    contexts.push({
      displayName: label,
      source: textRecord.source,
      text,
      bucket: file.bucket,
      resolvedBucket: lookup.name,
      originalKey: file.key,
      resolvedKey: textRecord.key,
      textKey: file.textKey,
    });
    console.log("Attachment text hydrated", {
      label,
      originalKey: file.key,
      resolvedKey: textRecord.key,
      bucket: lookup.name,
      textLength: text.length,
      source: textRecord.source,
    });
  }
  return contexts;
}

async function streamChatCompletions(
  messages: ChatMessage[],
  model: string,
  env: Env,
  opts: { resolvedResponseMode?: ResolvedResponseMode } = {},
): Promise<Response> {
  logFinalMessagesPreview(messages);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const startTime = Date.now();
      let accumulatedText = "";
      let firstTokenMs: number | null = null;
      let lastTokenMs: number | null = null;
      let receivedFinal = false;
      console.log("[chat.stream] opened", {
        model,
        resolvedResponseMode: opts.resolvedResponseMode || null,
      });
      if (opts.resolvedResponseMode) {
        controller.enqueue(
          encodeSSE({ event: "message", data: JSON.stringify({ resolvedResponseMode: opts.resolvedResponseMode }) }),
        );
      }
      (async () => {
        try {
          const result = await runChatCompletionsWithContinuation(env, {
            model,
            label: "chat",
            maxOutputTokens: ANSWER_MAX_OUTPUT_TOKENS,
            onSegment: async (segment, state) => {
              accumulatedText = state.accumulatedText;
              const now = Date.now();
              if (firstTokenMs === null) firstTokenMs = now - startTime;
              lastTokenMs = now - startTime;
              controller.enqueue(encodeSSE({ event: "message", data: JSON.stringify({ delta: { text: segment } }) }));
            },
            buildMessages: ({ attempt, accumulatedText }) => {
              if (attempt === 1 && !accumulatedText) return messages;
              const tail = clipAnswerTail(accumulatedText);
              const continuationPrompt =
                "Continue only if the previous answer was cut off mid-thought. If it already ended with a short tailoring follow-up, return no additional content. Do not repeat earlier sentences or add a continuation label.";
              return [
                ...messages,
                { role: "assistant", content: tail || "(previous answer abbreviated for continuation)" },
                { role: "user", content: continuationPrompt },
              ];
            },
          });
          const finalText = result.fullText || accumulatedText;
          const incompleteReason = detectIncompleteReason(finalText);
          const finalPayload = {
            ok: true,
            content: finalText,
            answerSegments: finalText ? [{ type: "text", text: finalText }] : [],
            finishReason: result.finishReason,
            truncated: result.truncated,
            incompleteReason: incompleteReason || undefined,
          };
          controller.enqueue(encodeSSE({ event: "final", data: JSON.stringify(finalPayload) }));
          receivedFinal = true;
          console.log("[chat.stream] completed", {
            finishReason: result.finishReason,
            truncated: result.truncated,
            incompleteReason: incompleteReason || null,
            firstTokenMs,
            lastTokenMs,
            totalMs: Date.now() - startTime,
            answerChars: finalText.length,
          });
        } catch (err) {
          controller.enqueue(encodeSSE({ event: "error", data: JSON.stringify({ error: String(err) }) }));
        } finally {
          if (!receivedFinal) {
            console.log("[chat.stream] incomplete", {
              receivedFinal,
              firstTokenMs,
              lastTokenMs,
              totalMs: Date.now() - startTime,
              answerChars: accumulatedText.length,
            });
          }
          controller.enqueue(encodeSSE({ event: "done", data: "{}" }));
          controller.close();
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      ...CORS_HEADERS,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, max-age=0, no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

function logFinalMessagesPreview(messages: ChatMessage[]) {
  console.log("FINAL MESSAGES PRE-SEND:", messages.map(msg => ({
    role: msg.role,
    contentPreview: typeof msg.content === "string"
      ? msg.content.slice(0, 300)
      : msg.content.map(part => (part?.text || "").slice(0, 200)).join(" || "),
  })));
}

function extractStreamDeltaText(evt: any): string {
  if (!evt) return "";
  if (Array.isArray(evt.choices)) {
    const collected = evt.choices
      .map((choice: any) => {
        const content = choice?.delta?.content ?? choice?.delta?.text;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          return content
            .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
            .filter(Boolean)
            .join("");
        }
        return "";
      })
      .filter(Boolean)
      .join("");
    if (collected) return collected;
  }
  if (typeof evt.output_text_delta === "string") return evt.output_text_delta;
  if (typeof evt.delta === "string") return evt.delta;
  if (typeof evt.delta?.text === "string") return evt.delta.text;
  if (typeof evt.delta?.content === "string") return evt.delta.content;
  const deltaParts = Array.isArray(evt.delta?.content) ? evt.delta.content : null;
  if (deltaParts) {
    const joined = deltaParts
      .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("");
    if (joined) return joined;
  }
  return "";
}

function extractStreamFinalText(evt: any, eventName?: string): string {
  if (!evt) return "";
  const type = typeof evt?.type === "string" ? evt.type : "";
  if (eventName === "response.completed" || type === "response.completed") {
    return extractOutputText(evt).trim();
  }
  if (typeof evt.output_text === "string") return evt.output_text;
  if (typeof evt.response?.output_text === "string") return evt.response.output_text;
  return "";
}

function buildModelChain(requested: AllowedModel) {
  const chain: AllowedModel[] = [];
  const enqueue = (model: string) => {
    if (isAllowedModel(model) && !chain.includes(model)) chain.push(model);
  };
  enqueue(requested);
  (MODEL_FALLBACKS[requested] || []).forEach(enqueue);
  return chain;
}

type ForwardResult =
  | { response: Response }
  | { status: number; error: string };

async function forwardOpenAIResponse(
  payload: Record<string, unknown>,
  env: Env,
  opts: { resolvedResponseMode?: ResolvedResponseMode } = {},
): Promise<ForwardResult> {
  const result = await sendOpenAIWithUnsupportedParamRetry<Response>({
    payload,
    endpoint: "responses",
    env,
    label: "responses-stream",
    send: async (attemptPayload) => {
      const upstream = await fetch(`${env.OPENAI_API_BASE}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "content-type": "application/json",
          "OpenAI-Beta": "assistants=v2",
        },
        body: JSON.stringify(attemptPayload),
      });
      if (!upstream.ok || !upstream.body) {
        const errText = await upstream.text().catch(() => "Unable to contact OpenAI.");
        return { ok: false, errorText: errText, status: upstream.status || 502 };
      }
      return { ok: true, value: upstream };
    },
  });

  if (!result.ok) {
    return { status: result.status || 502, error: result.errorText };
  }

  const upstream = result.value;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      const parser = new SseFrameParser();
      const startTime = Date.now();
      let accumulatedText = "";
      let completedText = "";
      let finishReason: string | undefined;
      let status: string | undefined;
      let firstTokenMs: number | null = null;
      let lastTokenMs: number | null = null;
      let bytes = 0;
      let receivedFinal = false;
      let recoveryAttempts = 0;
      let incompleteReason: string | null = null;
      console.log("[responses.stream] opened", {
        model: typeof (payload as any)?.model === "string" ? (payload as any).model : undefined,
        resolvedResponseMode: opts.resolvedResponseMode || null,
      });
      if (opts.resolvedResponseMode) {
        controller.enqueue(
          encodeSSE({ event: "message", data: JSON.stringify({ resolvedResponseMode: opts.resolvedResponseMode }) }),
        );
      }
      const handleEvent = (eventName: string | undefined, data: string) => {
        if (!data) return;
        let payloadJson: any = null;
        try {
          payloadJson = JSON.parse(data);
        } catch {
          return;
        }
        if (payloadJson?.error || payloadJson?.type === "response.error") {
          throw new Error(payloadJson.error?.message || payloadJson.error || "Chat error");
        }
        const delta = extractStreamDeltaText(payloadJson);
        if (delta) {
          const now = Date.now();
          if (firstTokenMs === null) firstTokenMs = now - startTime;
          lastTokenMs = now - startTime;
          accumulatedText += delta;
        }
        const finalCandidate = extractStreamFinalText(payloadJson, eventName);
        if (finalCandidate && finalCandidate.length >= completedText.length) {
          completedText = finalCandidate;
        }
        const finishCandidate = extractFinishReason(payloadJson);
        if (finishCandidate) finishReason = finishCandidate;
        const statusCandidate = extractResponseStatus(payloadJson);
        if (statusCandidate) status = statusCandidate;
      };
      (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              bytes += value.byteLength;
              controller.enqueue(value);
              const frames = parser.push(decoder.decode(value, { stream: true }));
              for (const frame of frames) {
                handleEvent(frame.eventName, frame.data);
              }
            }
          }
          const trailingFrames = parser.push(decoder.decode(new Uint8Array(), { stream: false }));
          for (const frame of trailingFrames) {
            handleEvent(frame.eventName, frame.data);
          }
          for (const frame of parser.finish()) {
            handleEvent(frame.eventName, frame.data);
          }

          let finalText = completedText || accumulatedText;
          incompleteReason = detectIncompleteReason(finalText);
          const finishLower = (finishReason || "").toLowerCase();
          const shouldRecover =
            finishLower === "length" ||
            finishLower === "max_tokens" ||
            (status && status !== "completed" && status !== "finished") ||
            Boolean(incompleteReason);

          if (shouldRecover) {
            recoveryAttempts += 1;
            const baseInput = Array.isArray((payload as any)?.input) ? (payload as any).input : [];
            const result = await runResponsesWithContinuation(env, {
              label: "responses-stream-recovery",
              maxOutputTokens: typeof (payload as any)?.max_output_tokens === "number"
                ? (payload as any).max_output_tokens
                : ANSWER_MAX_OUTPUT_TOKENS,
              initialText: finalText,
              continuationPrefix: false,
              buildPayload: ({ accumulatedText: accumulated }) => ({
                ...payload,
                stream: false,
                input: buildContinuationResponsesInput(baseInput, accumulated),
                max_output_tokens: typeof (payload as any)?.max_output_tokens === "number"
                  ? (payload as any).max_output_tokens
                  : ANSWER_MAX_OUTPUT_TOKENS,
              }),
              onSegment: (segment, state) => {
                accumulatedText = state.accumulatedText;
                const now = Date.now();
                if (firstTokenMs === null) firstTokenMs = now - startTime;
                lastTokenMs = now - startTime;
                controller.enqueue(encodeSSE({ event: "message", data: JSON.stringify({ delta: { text: segment }, recovery: true }) }));
              },
            });
            finalText = result.fullText;
            finishReason = result.finishReason || finishReason;
            incompleteReason = detectIncompleteReason(finalText);
          }

          const finalPayload = {
            ok: true,
            content: finalText,
            answerSegments: finalText ? [{ type: "text", text: finalText }] : [],
            finishReason,
            incompleteReason: incompleteReason || undefined,
            recoveryAttempts: recoveryAttempts || undefined,
          };
          controller.enqueue(encodeSSE({ event: "final", data: JSON.stringify(finalPayload) }));
          receivedFinal = true;
          console.log("[responses.stream] completed", {
            finishReason,
            status,
            incompleteReason: incompleteReason || null,
            recoveryAttempts,
            firstTokenMs,
            lastTokenMs,
            totalMs: Date.now() - startTime,
            bytes,
            answerChars: finalText.length,
          });
        } catch (err) {
          controller.enqueue(encodeSSE({ event: "error", data: JSON.stringify({ error: String(err) }) }));
        } finally {
          if (!receivedFinal) {
            console.log("[responses.stream] incomplete", {
              receivedFinal,
              finishReason,
              status,
              incompleteReason: incompleteReason || null,
              recoveryAttempts,
              firstTokenMs,
              lastTokenMs,
              totalMs: Date.now() - startTime,
              bytes,
              answerChars: (completedText || accumulatedText).length,
            });
          }
          controller.enqueue(encodeSSE({ event: "done", data: "{}" }));
          controller.close();
        }
      })();
    },
  });

  return {
    response: new Response(stream, {
      headers: {
        ...CORS_HEADERS,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, max-age=0, no-cache, no-transform",
        connection: "keep-alive",
      },
    }),
  };
}

async function handleImageGeneration(prompt: string, model: string, env: Env): Promise<Response> {
  const upstream = await fetch(`${env.OPENAI_API_BASE}/images/generations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      prompt,
      size: "1024x1024",
      n: 1,
      response_format: "b64_json",
    }),
  });

  const data = await safeJson(upstream);
  if (!upstream.ok) {
    const message = (data as any)?.error?.message || "Image generation failed.";
    return json({ error: message }, upstream.status || 502);
  }

  const first = Array.isArray((data as any)?.data) ? (data as any).data[0] : null;
  const base64 = typeof first?.b64_json === "string"
    ? first.b64_json
    : typeof first?.base64_data === "string"
      ? first.base64_data
      : "";
  const url = typeof first?.url === "string" ? first.url : "";
  const revisedPrompt = typeof first?.revised_prompt === "string" ? first.revised_prompt : undefined;

  if (!base64 && !url) {
    return json({ error: "Image generation returned no image." }, 502);
  }

  return json({
    ok: true,
    model,
    prompt,
    revised_prompt: revisedPrompt,
    image_base64: base64 || undefined,
    image_url: url || undefined,
  });
}

function shouldAttemptFallback(status: number, message: string) {
  const lowered = message.toLowerCase();
  if (status === 404 || status === 403 || status === 429) return true;
  if (status >= 500) return true;
  if (status === 400) {
    if (
      lowered.includes("model") ||
      lowered.includes("unsupported") ||
      lowered.includes("not available") ||
      lowered.includes("overloaded") ||
      lowered.includes("quota") ||
      lowered.includes("rate limit")
    ) {
      return true;
    }
  }
  return lowered.includes("model_not_found") || lowered.includes("does not have access to model") || lowered.includes("not available");
}

async function handleUpload(req: Request, env: Env): Promise<Response> {
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return json({ error: "Send multipart/form-data with a 'file' field." }, 400);
  }

  const form = await req.formData();
  const lectureIdRaw = form.get("lectureId") || form.get("docId");
  const lectureId = typeof lectureIdRaw === "string" ? lectureIdRaw.trim() : "";
  if (lectureId) {
    try {
      const { bucket: libraryBucket } = getLibraryBucket(env);
      const indexRecords = await readLibraryIndex(libraryBucket);
      const record = indexRecords.find(rec => rec.docId === lectureId);
      if (record?.bucket && record?.key) {
        const sourceBucket = getBucketByName(env, record.bucket);
        const head = await resolveObjectHead(sourceBucket, record.key);
        if (head.exists) {
          return json({
            ok: true,
            status: "skipped",
            reason: "already_uploaded",
            lectureId,
            bucket: record.bucket,
            key: record.key,
            filename: record.key.split("/").pop() || undefined,
          });
        }
      }
    } catch (err) {
      console.warn("[UPLOAD] skip check failed", {
        lectureId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "Missing file" }, 400);

  const bucketChoice = form.get("bucket");
  const destinationChoice = form.get("destination");
  const { bucket, name: bucketName } = resolveBucket(env, bucketChoice);
  const nameField = form.get("name");
  const subjectName = typeof nameField === "string" ? nameField : undefined;

  const filename = file.name || "upload.bin";
  const baseKey = sanitizeKey(form.get("key") as string | null, `${Date.now()}_${filename}`);
  const prefix = resolveUploadPrefix(destinationChoice || bucketChoice);
  const key = prefix ? `${prefix}${baseKey}` : baseKey;
  const needsTextExtraction = shouldAttemptTextExtraction(filename, file.type || "");
  const isLibraryUpload = key.startsWith("library/");
  const isLibraryPdfUpload = isLibraryUpload && isPdfKey(key);
  const isLibraryWordUpload = isLibraryUpload && isSupportedLectureWordUpload(filename, file.type || "");
  console.log("[OWEN_UPLOAD_SIZE]", {
    key,
    filename,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    maxBytes: LECTURE_UPLOAD_MAX_BYTES,
    libraryUpload: isLibraryUpload,
  });
  if (file.size > LECTURE_UPLOAD_MAX_BYTES) {
    console.warn("[OWEN_UPLOAD_REJECT_TOO_LARGE]", {
      key,
      filename,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      maxBytes: LECTURE_UPLOAD_MAX_BYTES,
    });
    return json({ error: LECTURE_UPLOAD_TOO_LARGE_ERROR }, 413);
  }

  await putUploadedFileStream(bucket, key, file, {
    bucket: bucketName,
    destination: typeof destinationChoice === "string" ? destinationChoice : undefined,
  });

  let libraryDocContext:
    | {
        canonicalBucket: string;
        docId: string;
        basis: string;
        fieldsUsed: string[];
        uploaded?: string;
        title: string;
        etag?: string | null;
        size: number;
      }
    | null = null;
  if (isLibraryPdfUpload || isLibraryWordUpload) {
    try {
      const head = typeof bucket.head === "function"
        ? await bucket.head(key)
        : await bucket.get(key, { range: { offset: 0, length: 0 } as any });
      const canonicalBucket = resolveBucketKey(bucketName);
      const { docId, basis, fieldsUsed, uploaded } = await computeDocId(canonicalBucket, key, {
        etag: (head as any)?.etag,
        size: (head as any)?.size ?? file.size,
        uploaded: (head as any)?.uploaded || new Date().toISOString(),
      });
      libraryDocContext = {
        canonicalBucket,
        docId,
        basis,
        fieldsUsed,
        uploaded: uploaded || (head as any)?.uploaded?.toISOString?.(),
        title: titleFromKey(key),
        etag: (head as any)?.etag,
        size: (head as any)?.size ?? file.size,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[UPLOAD] library doc context failed", { key, error: message });
      if (isLibraryWordUpload) {
        return json({ error: "Unable to prepare the lecture upload." }, 500);
      }
    }
  }

  let fileId: string | null = null;
  let visionFileId: string | null = null;
  let warning: string | undefined;
  let visionWarning: string | undefined;
  let vectorStoreId: string | null = null;
  let vectorStatus: string | undefined;
  let vectorWarning: string | undefined;
  let ocrTextKey: string | null = null;
  let ocrStatus: "pending" | "ready" | "error" | "empty" | undefined;
  let ocrWarning: string | undefined;
  let ocrText: string | undefined;
  let ocrError: string | undefined;
  let machineTxtKey: string | null = null;
  let machineTxtStatus: "ready" | "error" | "deferred" | undefined;
  let machineTxtWarning: string | undefined;
  let lectureStatus: "ready" | "missing" | "needs_browser_ocr" | undefined;
  let uploadIngestionType: "doc_upload" | undefined;

  if (isLibraryPdfUpload && libraryDocContext) {
    try {
      await upsertLibraryIndexRecord(env, {
        docId: libraryDocContext.docId,
        bucket: libraryDocContext.canonicalBucket,
        key,
        title: libraryDocContext.title,
        normalizedTokens: tokensFromTitle(libraryDocContext.title),
        hashBasis: libraryDocContext.basis,
        hashFieldsUsed: libraryDocContext.fieldsUsed,
        etag: libraryDocContext.etag,
        size: libraryDocContext.size,
        uploaded: libraryDocContext.uploaded,
        status: "missing",
        extractedKey: buildExtractedPath(libraryDocContext.docId),
        manifestKey: buildManifestPath(libraryDocContext.docId),
      });
    } catch (err) {
      console.warn("[UPLOAD] library index update failed", { key, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (isLibraryWordUpload && libraryDocContext) {
    try {
      await upsertLibraryIndexRecord(env, {
        docId: libraryDocContext.docId,
        bucket: libraryDocContext.canonicalBucket,
        key,
        title: libraryDocContext.title,
        normalizedTokens: tokensFromTitle(libraryDocContext.title),
        hashBasis: libraryDocContext.basis,
        hashFieldsUsed: libraryDocContext.fieldsUsed,
        etag: libraryDocContext.etag,
        size: libraryDocContext.size,
        uploaded: libraryDocContext.uploaded,
        status: "missing",
        ingestionType: "doc_upload",
        extractedKey: buildExtractedPath(libraryDocContext.docId),
        manifestKey: buildManifestPath(libraryDocContext.docId),
      });
    } catch (err) {
      console.warn("[UPLOAD] library word index update failed", { key, error: err instanceof Error ? err.message : String(err) });
    }

    console.log("[OWEN_DOC_UPLOAD_START]", {
      docId: libraryDocContext.docId,
      key,
      filename,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
    });
    try {
      if (shouldDeferLectureTextProcessing(filename, file.type || "", file.size)) {
        machineTxtStatus = "deferred";
        machineTxtWarning = LECTURE_UPLOAD_DEFERRED_WARNING;
        lectureStatus = "missing";
        uploadIngestionType = "doc_upload";
        console.log("[OWEN_UPLOAD_STREAM]", {
          docId: libraryDocContext.docId,
          key,
          filename,
          size: file.size,
          deferred: true,
          parseMaxBytes: LECTURE_INLINE_PARSE_MAX_BYTES,
        });
      } else {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const extracted = await extractLectureUploadTextFromBytes(bytes, filename, file.type || "");
        const stored = await storeLectureMachineTxtArtifact(env, libraryDocContext.docId, extracted, "doc_upload");
        machineTxtKey = stored.storedKey;
        machineTxtStatus = "ready";
        lectureStatus = "ready";
        uploadIngestionType = "doc_upload";
        await upsertLibraryIndexRecord(env, {
          docId: libraryDocContext.docId,
          bucket: libraryDocContext.canonicalBucket,
          key,
          title: libraryDocContext.title,
          normalizedTokens: tokensFromTitle(libraryDocContext.title),
          hashBasis: libraryDocContext.basis,
          hashFieldsUsed: libraryDocContext.fieldsUsed,
          etag: libraryDocContext.etag,
          size: libraryDocContext.size,
          uploaded: libraryDocContext.uploaded,
          status: "ready",
          ingestionType: "doc_upload",
          extractedKey: buildExtractedPath(libraryDocContext.docId),
          manifestKey: buildManifestPath(libraryDocContext.docId),
          preview: stored.preview,
        });
        console.log("[OWEN_DOC_CONVERT_SUCCESS]", {
          docId: libraryDocContext.docId,
          key,
          machineTxtKey,
          textLength: stored.normalizedText.length,
        });
      }
    } catch (err) {
      machineTxtStatus = "error";
      machineTxtWarning = err instanceof Error ? err.message : String(err);
      console.warn("[OWEN_DOC_CONVERT_FAIL]", {
        docId: libraryDocContext.docId,
        key,
        filename,
        error: machineTxtWarning,
      });
      return json({ error: machineTxtWarning || "Document conversion failed." }, 422);
    }
  }

  try {
    const mirrorForm = new FormData();
    mirrorForm.append("purpose", "assistants");
    mirrorForm.append("file", file, filename);
    const resp = await fetch(`${env.OPENAI_API_BASE}/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: mirrorForm,
    });
    const data = await safeJson(resp);
    if (!resp.ok) throw new Error(data?.error?.message || "OpenAI Files upload failed");
    const uploadedId = typeof data?.id === "string" ? data.id : "";
    if (!uploadedId) throw new Error("OpenAI Files upload returned no file id.");
    fileId = uploadedId;
  } catch (err) {
    warning = err instanceof Error ? err.message : String(err);
  }

  try {
    const visionForm = new FormData();
    visionForm.append("purpose", "vision");
    visionForm.append("file", file, filename);
    const resp = await fetch(`${env.OPENAI_API_BASE}/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: visionForm,
    });
    const data = await safeJson(resp);
    if (!resp.ok) throw new Error(data?.error?.message || "OpenAI vision file upload failed");
    const uploadedVisionId = typeof data?.id === "string" ? data.id : "";
    if (uploadedVisionId) {
      visionFileId = uploadedVisionId;
    }
  } catch (err) {
    visionWarning = err instanceof Error ? err.message : String(err);
  }

  if (fileId) {
    try {
      const vectorLabel = subjectName || filename || "uploaded.pdf";
      vectorStoreId = await getOrCreateVectorStoreId(env, vectorLabel);
      if (!vectorStoreId) throw new Error("Vector store id is missing. Upload files again.");
      vectorStatus = await attachFileToVectorStore(env, vectorStoreId, fileId);
    } catch (err) {
      vectorWarning = err instanceof Error ? err.message : String(err);
      console.warn("Vector store indexing failed", err);
    }
  }

  if (!isLibraryWordUpload && needsTextExtraction) {
    console.log("[OCR] Upload OCR path triggered", { filename, mimeType: file.type });
    try {
      const mimeType = file.type || "application/octet-stream";
      let ingest: { text: string; source: "ocr" | "original" } | null = null;

      // First try direct vision OCR if we have a vision file id (images or scanned PDFs).
      if (visionFileId) {
        try {
          const vtext = await requestVisionOcrFromFileId(env, visionFileId, filename);
          if (vtext && vtext.trim()) {
            ingest = { text: `[OCR]\n${vtext.trim()}`, source: "ocr" };
          }
        } catch (err) {
          console.warn("Vision OCR during upload failed; will fallback", {
            filename,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Next try Worker-local parsing for smaller files only.
      if (!ingest && file.size <= LECTURE_INLINE_PARSE_MAX_BYTES) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        ingest = await ingestBinaryForTranscript(env, { bytes, filename, mimeType, sourceKey: key });
      } else if (!ingest) {
        console.log("[OWEN_UPLOAD_STREAM]", {
          key,
          filename,
          size: file.size,
          skippedInlineTranscriptIngest: true,
          parseMaxBytes: LECTURE_INLINE_PARSE_MAX_BYTES,
        });
      }

      // Final fallback: legacy code-interpreter extraction via OpenAI Files.
      if (!ingest && fileId) {
        const extracted = await performDocumentTextExtraction(env, {
          fileId,
          visionFileId,
          filename,
          mimeType: file.type,
        });
        if (extracted) {
          ingest = { text: extracted, source: "ocr" as const };
        }
      }

      const extracted = ingest?.text?.trim() || "";
      if (extracted) {
        ocrText = extracted.slice(0, MAX_STORED_TEXT_LENGTH);
        ocrTextKey = `${key}.ocr.txt`;
        await bucket.put(ocrTextKey, ocrText, {
          httpMetadata: { contentType: "text/plain; charset=utf-8" },
        });
        ocrStatus = "ready";
        console.log("[PDF] Stored OCR text", { key: ocrTextKey, length: ocrText.length });
      } else {
        ocrStatus = "empty";
      }
    } catch (err) {
      ocrStatus = "error";
      ocrWarning = err instanceof Error ? err.message : String(err);
      ocrError = ocrWarning;
      console.warn("Text extraction failed", err);
    }
  }

  return json({
    ok: true,
    bucket: bucketName,
    key,
    filename,
    size: file.size,
    doc_id: libraryDocContext?.docId || null,
    lecture_status: lectureStatus || (isLibraryPdfUpload ? "missing" : undefined),
    ingestion_type: uploadIngestionType,
    file_id: fileId,
    vision_file_id: visionFileId,
    vector_store_id: vectorStoreId,
    vector_store_status: vectorStatus,
    url: fileId ? `openai:file:${fileId}` : null,
    warning,
    vision_warning: visionWarning,
    vector_warning: vectorWarning,
    ocr_text_key: ocrTextKey,
    ocr_status: ocrStatus,
    ocr_warning: ocrWarning,
    ocrText,
    ocrError,
    machine_txt_key: machineTxtKey,
    machine_txt_status: machineTxtStatus,
    machine_txt_warning: machineTxtWarning,
  });
}

/**
 * Upload raw bytes as a file to the OpenAI Files API.
 *
 * @param env - Worker environment with API base and key.
 * @param bytes - File content as bytes.
 * @param filename - Name to send to OpenAI.
 * @param purpose - OpenAI file purpose (e.g., "assistants").
 * @param mimeType - Optional MIME type override.
 * @returns Uploaded file id or null if not returned.
 * @throws When the OpenAI API responds with an error.
 * @remarks Side effects: network call to OpenAI.
 */
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

function generateFileId(seed?: string) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const suffix = Math.random().toString(16).slice(2, 10);
  const prefix = seed && seed.trim() ? seed.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12) : "file";
  return `${prefix}-${Date.now().toString(36)}-${suffix}`;
}

function buildExtractedKey(fileId: string) {
  const base = sanitizeKey(fileId || "file", `file-${Date.now()}`);
  return `extracted/${base}.txt`;
}

function getExtractionBucket(env: Env) {
  return getCanonicalCacheBucket(env);
}

function getLibraryBucket(env: Env) {
  return getCanonicalCacheBucket(env);
}

function getCanonicalCacheBucket(env: Env) {
  const lookup =
    lookupBucket(env, CANONICAL_CACHE_BUCKET_NAME) ||
    lookupBucket(env, BUCKET_BINDINGS[CANONICAL_CACHE_BUCKET_NAME as keyof typeof BUCKET_BINDINGS]);
  if (!lookup) {
    throw new Error("No canonical cache bucket configured.");
  }
  if (!loggedCanonicalBucket) {
    loggedCanonicalBucket = true;
    const available = Object.keys(BUCKET_BINDINGS).map(name => ({
      name,
      binding: BUCKET_BINDINGS[name as keyof typeof BUCKET_BINDINGS],
      present: Boolean((env as any)[BUCKET_BINDINGS[name as keyof typeof BUCKET_BINDINGS]]),
    }));
    console.log("[LIBRARY] canonical cache bucket resolved", { canonical: lookup.name, available });
  }
  return lookup;
}

async function persistExtractedText(env: Env, fileId: string, text: string) {
  const normalized = normalizeExtractedText(text).slice(0, MAX_OCR_TEXT_LENGTH);
  const { bucket, name } = getExtractionBucket(env);
  const extractedKey = buildExtractedKey(fileId);
  await bucket.put(extractedKey, normalized, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });
  return { extractedKey, bucket: name, preview: normalized.slice(0, ONE_SHOT_PREVIEW_LIMIT) };
}

async function loadExtractedText(env: Env, { fileId, extractedKey }: { fileId?: string; extractedKey?: string; }) {
  const key = extractedKey?.trim() || (fileId ? buildExtractedKey(fileId) : "");
  if (!key) return null;
  try {
    const { bucket } = getExtractionBucket(env);
    const object = await bucket.get(key);
    if (!object || !object.body) return null;
    const text = await object.text();
    const normalized = normalizeExtractedText(text);
    if (!normalized) return null;
    return { text: normalized.slice(0, MAX_OCR_TEXT_LENGTH), key };
  } catch (err) {
    console.warn("[ASK-FILE] Failed to load extracted text", { key, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

async function extractPdfForAsk(env: Env, fileId: string, filename: string): Promise<string> {
  const prompt = [
    `You are a document ingestion (text extraction + OCR) service helping OWEN answer questions.`,
    `Open the attached file (${filename || "Document"}). The file may be text-based or scanned.`,
    `Extract full text in reading order. Preserve headings, bullet points, and table cell contents.`,
    `If the document has pages or slides, prepend each section with markers like [Page 1] or [Slide 2].`,
    `Do NOT summarize. Do NOT fabricate text. Use ? for uncertain characters.`,
  ].join(" ");

  const payload = {
    model: resolveModelId(DEFAULT_TEXT_MODEL, env),
    input: [
      {
        role: "user" as const,
        content: [
          { type: "input_text" as const, text: prompt },
          { type: "input_file" as const, file_id: fileId },
        ],
      },
    ],
    max_output_tokens: OCR_MAX_OUTPUT_TOKENS,
  };

  const result = await callResponsesOnce(env, payload, `ask-file:extract:${filename}`);
  return (result.text || "").trim().slice(0, MAX_EXTRACT_CHARS);
}

async function handlePdfIngest(req: Request, env: Env): Promise<Response> {
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return json({ error: "Send multipart/form-data with fields: file, fileHash." }, 400);
  }
  const form = await req.formData();
  const file = form.get("file");
  const fileHash = typeof form.get("fileHash") === "string" ? (form.get("fileHash") as string).trim() : "";
  const requestedMaxPages = Number(form.get("maxPages"));
  const maxPages = Number.isFinite(requestedMaxPages) && requestedMaxPages > 0 ? Math.min(requestedMaxPages, DEFAULT_OCR_MAX_PAGES) : DEFAULT_OCR_MAX_PAGES;

  if (!(file instanceof File)) return json({ error: "Missing file upload." }, 400);
  if (!fileHash) return json({ error: "Missing fileHash." }, 400);
  const filename = sanitizeFilename(file.name || "upload.pdf");
  const mimeType = file.type || "application/pdf";
  if (!isLikelyPdfFilename(filename) && !isPdfMimeType(mimeType)) {
    return json({ error: "Only PDF ingestion is supported here." }, 400);
  }

  const { bucket } = getExtractionBucket(env);
  const cache = await loadCachedExtraction(bucket, fileHash);
  if (cache.text) {
    console.log("[PDF-INGEST] cache hit", { fileHash, method: cache.manifest?.method || "cache" });
    return json({
      extractionStatus: "ok",
      method: "cache",
      extractedKey: cache.extractedKey,
      preview: cache.text.slice(0, ONE_SHOT_PREVIEW_LIMIT),
      pageCount: cache.manifest?.pageCount,
      manifest: cache.manifest,
    });
  }
  if (cache.manifest && !cache.text) {
    console.log("[PDF-INGEST] cached manifest without text, requiring OCR", {
      fileHash,
      pageCount: cache.manifest.pageCount,
    });
    return json({
      extractionStatus: "needs_ocr_images",
      method: "ocr",
      fileHash,
      extractedKey: cache.extractedKey,
      pageCount: cache.manifest.pageCount,
      maxPages,
      manifest: cache.manifest,
    });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const extraction = await extractEmbeddedPagesFromPdf(bytes, { sampleCount: PDF_SAMPLE_PAGE_TARGET, maxPages: MAX_EXTRACT_PAGES, allowEarlyStop: true });
  if (extraction.scanned || !extraction.pages.length) {
    const manifest: PdfManifest = {
      fileHash,
      filename,
      method: "ocr",
      pagesProcessed: 0,
      pageCount: extraction.pageCount,
      createdAt: new Date().toISOString(),
    };
    await writeManifest(bucket, manifest);
    console.log("[PDF-INGEST] scanned PDF detected, browser OCR required", {
      fileHash,
      pageCount: extraction.pageCount,
      sampledPagesWithText: extraction.sampledPagesWithText,
    });
    return json({
      extractionStatus: "needs_ocr_images",
      method: "ocr",
      fileHash,
      extractedKey: cache.extractedKey,
      pageCount: extraction.pageCount,
      maxPages,
      manifest,
    });
  }

  const normalized = normalizePages(extraction.pages);
  const finalText = normalized.text.slice(0, MAX_OCR_TEXT_LENGTH);
  const preview = finalText.slice(0, ONE_SHOT_PREVIEW_LIMIT);
  await bucket.put(cache.extractedKey, finalText, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });
  const manifest: PdfManifest = {
    fileHash,
    filename,
    method: "embedded",
    pagesProcessed: normalized.pagesProcessed,
    pageCount: extraction.pageCount,
    createdAt: new Date().toISOString(),
    preview,
  };
  await writeManifest(bucket, manifest);
  console.log("[PDF-INGEST] embedded text stored", {
    fileHash,
    method: "embedded",
    length: finalText.length,
    pageCount: extraction.pageCount,
  });

  return json({
    extractionStatus: "ok",
    method: "embedded",
    extractedKey: cache.extractedKey,
    preview,
    pageCount: extraction.pageCount,
    manifest,
  });
}

async function handleAskFile(req: Request, env: Env): Promise<Response> {
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonNoStore({ error: "Send JSON { fileId, message, extractedKey? }." }, 400);
    }
    const message = typeof (body as any).message === "string" ? (body as any).message.trim() : "";
    const fileId = typeof (body as any).fileId === "string" ? (body as any).fileId.trim() : "";
    const extractedKey = typeof (body as any).extractedKey === "string" ? (body as any).extractedKey.trim() : "";
    if (!message) return jsonNoStore({ error: "Missing 'message'." }, 400);
    if (!fileId && !extractedKey) return jsonNoStore({ error: "Missing fileId or extractedKey." }, 400);

    const loaded = await loadExtractedText(env, { fileId, extractedKey });
    if (!loaded) {
      return jsonNoStore({ error: "extracted_text_not_found", details: "Extraction not ready or missing for this fileId." }, 404);
    }
    const preview = loaded.text.slice(0, ONE_SHOT_PREVIEW_LIMIT);
    try {
      const answerResult = await answerWithContext(env, loaded.text, message);
      const answer = answerResult.truncated ? appendTruncationNotice(answerResult.fullText) : answerResult.fullText;
      return jsonNoStore({
        answer,
        extractionStatus: "ok",
        method: "stored",
        extractedKey: loaded.key,
        extractedTextPreview: preview,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[ASK-FILE] Answering from stored text failed", err);
      return jsonNoStore({ error: "answer_failed", details: msg }, 502);
    }
  }

  if (!contentType.includes("multipart/form-data")) {
    return jsonNoStore({ error: "Send multipart/form-data with fields: message, file" }, 400);
  }
  const form = await req.formData();
  const message = typeof form.get("message") === "string" ? String(form.get("message")).trim() : "";
  const file = form.get("file");
  if (!message) return json({ error: "Missing 'message'." }, 400);
  if (!(file instanceof File)) return json({ error: "Missing 'file'." }, 400);

  const filename = file.name || "upload.bin";
  const mimeType = file.type || "application/octet-stream";
  const bytes = new Uint8Array(await file.arrayBuffer());
  const startTime = Date.now();
  const fileId = generateFileId(filename);
  console.log("[ASK-FILE] start", { filename, mimeType, size: bytes.length, fileId });

  const isPdf = isLikelyPdfFilename(filename) || isPdfMimeType(mimeType);
  const isImage = isLikelyImageFilename(filename) || isImageMimeType(mimeType);
  const preparedImage = isImage ? prepareOcrImageInput(bytes, mimeType || "image/png") : null;

  let extracted = "";
  let extractionStatus: "ok" | "needs_ocr_images" | "error" = "ok";
  let method: "embedded" | "ocr" | "original" = "embedded";

  if (isPdf) {
    try {
      let embedded = "";
      if (PDFJS_AVAILABLE) {
        embedded = await extractEmbeddedTextFromPdf(bytes);
      } else {
        console.log("[ASK-FILE] PDF.js unavailable in Worker; skipping embedded text path.");
      }
      embedded = normalizeExtractedText(embedded);
      if (embedded && embedded.length >= MIN_EMBEDDED_PDF_CHARS) {
        extracted = embedded.slice(0, MAX_EXTRACT_CHARS);
        method = "embedded";
        console.log("[ASK-FILE] Embedded PDF text extracted", { length: extracted.length });
      } else {
        extractionStatus = "needs_ocr_images";
        method = "ocr";
        console.warn("[ASK-FILE] Embedded text too short, requesting browser OCR", {
          length: embedded.length,
          threshold: MIN_EMBEDDED_PDF_CHARS,
        });
      }
    } catch (err) {
      extractionStatus = "needs_ocr_images";
      method = "ocr";
      console.warn("[ASK-FILE] Embedded extraction failed; falling back to OCR images", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    try {
      const ingest = await ingestBinaryForTranscript(env, { bytes, filename, mimeType, sourceKey: filename });
      if (ingest?.text) {
        extracted = ingest.text.trim();
        method = ingest.source === "ocr" ? "ocr" : "embedded";
      }
      if (!extracted && isImage) {
        const imageForOcr = preparedImage || prepareOcrImageInput(bytes, mimeType || "image/png");
        if (!imageForOcr.ok) {
          extractionStatus = "error";
          method = "ocr";
          console.warn("[ASK-FILE] Image bytes failed validation for OCR", {
            filename,
            head: imageForOcr.head,
            mimeType: imageForOcr.mimeType,
          });
          return jsonNoStore(invalidImagePayload({ extractionStatus, method, fileId }), 422);
        }
        try {
          extracted = await requestVisionOcrFromImages(
            env,
            [
              {
                label: "Image",
                dataUrl: imageForOcr.dataUrl,
                sourceKey: filename,
                mimeType: imageForOcr.mimeType,
                signature: imageForOcr.signature,
                byteLength: imageForOcr.byteLength,
                head: imageForOcr.head,
              },
            ],
            filename,
          );
          method = "ocr";
        } catch (err) {
          console.warn("[ASK-FILE] Image OCR failed", err);
        }
        if (!extracted) {
          try {
            const visionFileId = await uploadBytesToOpenAI(env, bytes, filename, "vision", mimeType);
            if (visionFileId) {
              console.log("[ASK-FILE] uploaded image for OCR", { file_id: visionFileId });
              extracted = await requestVisionTextExtraction(env, visionFileId, filename);
              method = "ocr";
            }
          } catch (err) {
            console.warn("[ASK-FILE] Vision fallback failed", err);
          }
        }
      }
    } catch (err) {
      extractionStatus = "error";
      console.error("[ASK-FILE] Extraction error", err);
      return jsonNoStore(
        {
          extractionStatus,
          extractionError: err instanceof Error ? err.message : "Extraction failed.",
          extractedTextPreview: "",
          answer: "",
        },
        422,
      );
    }
  }

  if (extractionStatus === "needs_ocr_images") {
    return jsonNoStore({
      extractionStatus,
      method,
      fileId,
      pageCap: CLIENT_OCR_PAGE_CAP,
      message: "Browser OCR required; render pages to images and retry.",
    });
  }

  const refusalPhrases = [
    "unable to extract",
    "unable to extract text",
    "unable to read the pdf",
    "can't read the pdf",
    "can't read",
    "cannot read the pdf",
    "cannot read",
    "cannot process documents",
    "cannot access the pdf",
    "don't have the document",
    "process documents directly",
    "paste the text",
    "provide the text",
  ];
  const normalized = normalizeExtractedText(extracted).slice(0, MAX_EXTRACT_CHARS);
  const lower = normalized.toLowerCase();
  const isRefusal = refusalPhrases.some(p => lower.includes(p));
  const tooShort = normalized.length < 50;
  if (!normalized || isRefusal || tooShort) {
    console.warn("[ASK-FILE] extraction invalid, aborting answer", {
      length: normalized.length,
      isRefusal,
      tooShort,
      method,
    });
    return jsonNoStore(
      {
        extractionStatus: "error",
        extractionError: "Extraction returned no usable text. Try OCR images.",
        extractedTextPreview: "",
        answer: "",
      },
      422,
    );
  }

  let persisted: { extractedKey: string; bucket: string; preview: string };
  try {
    persisted = await persistExtractedText(env, fileId, normalized);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[ASK-FILE] Failed to persist extracted text", err);
    return jsonNoStore({ error: "persist_failed", details: msg }, 500);
  }

  try {
    console.log("[ASK-FILE] extraction valid, answering");
    const tableIntent = isTableIntent(message);
    const excerptsAllowed = tableIntent ? false : allowExcerpts(message);
    const tableHeaders = tableIntent ? deriveTableHeaders(message) : undefined;
    debugFormatLog("ask-file format route", {
      tableIntent,
      tableHeaders,
      allowExcerpts: excerptsAllowed,
      textLength: normalized.length,
    });
    const rawAnswerResult = await answerWithContextWithOpts(env, normalized, message, {
      tableOnly: tableIntent,
      tableSchema: tableIntent ? undefined : undefined,
      tableHeaders,
      allowExcerpts: excerptsAllowed,
    });
    const rawAnswer = rawAnswerResult.fullText;
    const preferTable = tableIntent || isInherentlyTabularQuestion(message);
    const formatted = preferTable ? trimAfterFirstTable(rawAnswer) : rawAnswer;
    const repaired = preferTable ? ensureTablePresence(formatted, tableHeaders || deriveTableHeaders(message)) : formatted;
    const sanitized = sanitizeAnswer(repaired, { allowExcerpts: excerptsAllowed });
    const answerCore = finalizeAssistantText(rawAnswer, sanitized, persisted.preview);
    const answer = rawAnswerResult.truncated ? appendTruncationNotice(answerCore) : answerCore;
    debugFormatLog("ask-file format result", {
      preferTable,
      rawLength: rawAnswer.length,
      formattedLength: formatted.length,
      sanitizedLength: sanitized.length,
      finalLength: answer.length,
    });
    return jsonNoStore({
      answer,
      extractedTextPreview: persisted.preview,
      extractionStatus,
      method,
      extractedKey: persisted.extractedKey,
      fileId,
      elapsed_ms: Date.now() - startTime,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[ASK-FILE] Answering failed", err);
    return jsonNoStore(
      {
        answer: "",
        extractedTextPreview: persisted.preview,
        extractionStatus: "error",
        extractionError: msg,
        method,
        fileId,
        elapsed_ms: Date.now() - startTime,
      },
      502,
    );
  }
}

type GeneratedTextResult = {
  text: string;
  fullText: string;
  truncated: boolean;
  attempts: number;
  finishReason?: string;
  status?: string;
};

async function answerWithContext(env: Env, context: string, question: string): Promise<GeneratedTextResult> {
  return answerWithContextWithOpts(env, context, question, {});
}

async function answerWithContextWithOpts(
  env: Env,
  context: string,
  question: string,
  opts: RetrievedAnswerOptions,
): Promise<GeneratedTextResult> {
  const cleanedContext = cleanRetrievedChunkText(context);
  const system = opts.tableOnly
    ? [
        "You are OWEN. Return ONLY the requested table (plus at most two short sentences of intro).",
        "Do not add headings, extra sections, bullets, or slide text. Do not mention chunks or pages.",
        "Do NOT output internal chunk IDs (C#) or page markers.",
        "Answer in complete sentences and finish cleanly—no dangling fragments.",
        "If a value is not stated in the provided context, write 'Not stated in lecture'.",
        "Table columns: Condition / Disease | Defining labs | Key treatment | Notes (1 line max).",
      ].join(" ")
    : [
        "You are OWEN answering questions about a provided document.",
        "Answer using ONLY the provided document context.",
        "If the context is insufficient, say you don't know.",
        "Answer the user's question directly. Do NOT output slide dumps, page markers, chunk ids, or unrelated headings.",
        "Do NOT output internal chunk IDs (C#) or page markers to the user.",
        "Do NOT copy raw slide text unless explicitly requested.",
        "Answer in complete sentences and end the response cleanly—no dangling words.",
        "If you cite context, use 'Slide X – Title' or 'Page X' style references instead of chunk ids.",
        "Only include information relevant to the question. Stop after the answer; do not append extra sections.",
        opts.allowExcerpts
          ? "If quoting slides is requested, include brief verbatim snippets with citations."
          : "Do not include raw excerpt blocks or a 'From the lecture excerpts' section unless explicitly requested.",
      ].join(" ");

  const userBase: ResponsesInputContent[] = [
    { type: "input_text", text: `Document context:\n${cleanedContext}` },
    { type: "input_text", text: `Question:\n${question}` },
  ];

  const result = await runResponsesWithContinuation(env, {
    label: "ask-context",
    maxOutputTokens: opts.maxOutputTokens ?? ANSWER_MAX_OUTPUT_TOKENS,
    buildPayload: ({ attempt, accumulatedText }) => {
      const continuationParts: ResponsesInputContent[] = [];
      const isContinuation = attempt > 1 || Boolean(accumulatedText);
      if (isContinuation && accumulatedText) {
        continuationParts.push({
          type: "input_text",
          text: `Partial answer so far:\n${clipAnswerTail(accumulatedText)}`,
        });
      }
      continuationParts.push({
        type: "input_text",
        text: "Continue only if the previous answer was cut off mid-thought. If it already ended with a short tailoring follow-up, return no additional content. Do not repeat earlier lines or headings, restart tables, or add a continuation label.",
      });

      return {
        model: resolveModelId(DEFAULT_TEXT_MODEL, env),
        max_output_tokens: opts.maxOutputTokens ?? ANSWER_MAX_OUTPUT_TOKENS,
        input: [
          { role: "system" as const, content: [{ type: "input_text" as const, text: system }] },
          { role: "user" as const, content: [...userBase, ...continuationParts] },
        ],
      };
    },
  });

  return result;
}

type ResponseCallResult = {
  text: string;
  finishReason?: string;
  status?: string;
  outputTokens?: number;
  incompleteReason?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    totalTokens: number;
  } | null;
  raw?: OpenAIJson;
};

async function runResponsesWithContinuation(
  env: Env,
  opts: {
    buildPayload: (state: { attempt: number; accumulatedText: string }) => Record<string, unknown>;
    label: string;
    maxAttempts?: number;
    maxOutputTokens?: number;
    initialText?: string;
    continuationPrefix?: boolean;
    onSegment?: (segment: string, state: { attempt: number; accumulatedText: string }) => Promise<void> | void;
  },
): Promise<GeneratedTextResult> {
  const attemptsLimit = Math.max(1, opts.maxAttempts ?? ANSWER_MAX_CONTINUATIONS + 1);
  const maxTokens = Math.min(ANSWER_MAX_OUTPUT_TOKENS, Math.max(800, opts.maxOutputTokens ?? ANSWER_MAX_OUTPUT_TOKENS));
  let accumulated = opts.initialText || "";
  const initialStop = trimAtUserInputRequiredBoundary(accumulated);
  if (initialStop.trimmed || findUserInputRequiredBoundary(accumulated) !== null) {
    accumulated = initialStop.text;
    return {
      text: "",
      fullText: accumulated,
      truncated: false,
      attempts: 0,
      finishReason: undefined,
      status: undefined,
    };
  }
  const baseLength = accumulated.length;
  let attempts = 0;
  let truncated = false;
  let lastFinish: string | undefined;
  let lastStatus: string | undefined;
  let continuationPrefixed = false;

  while (attempts < attemptsLimit) {
    attempts += 1;
    const payload = opts.buildPayload({ attempt: attempts, accumulatedText: accumulated }) || {};
    const resolvedMaxOutputTokens = (payload as any)?.max_output_tokens ?? maxTokens;
    const payloadWithMax = {
      ...payload,
      max_output_tokens: resolvedMaxOutputTokens,
    };
    const result = await callResponsesOnce(env, payloadWithMax, `${opts.label || "ask"}#${attempts}`);
    lastFinish = result.finishReason || lastFinish;
    lastStatus = result.status || lastStatus;
    let segment = (result.text || "").trim();
    if (segment) {
      if (attempts > 1 || accumulated) {
        const prepared = prepareContinuationSegment(
          segment,
          accumulated,
          continuationPrefixed,
          opts.continuationPrefix !== false,
        );
        segment = prepared.text;
        continuationPrefixed = prepared.prefixed;
      }
      accumulated = combineSegments([accumulated, segment]);
      const userInputStop = trimAtUserInputRequiredBoundary(accumulated);
      if (findUserInputRequiredBoundary(accumulated) !== null) {
        accumulated = userInputStop.text;
        truncated = false;
        break;
      }
      if (opts.onSegment) {
        await opts.onSegment(segment, { attempt: attempts, accumulatedText: accumulated });
      }
    }
    const needsMore = shouldContinueAnswer(result, maxTokens, segment, accumulated);
    if (!needsMore) {
      truncated = false;
      break;
    }
    if (attempts >= attemptsLimit) {
      truncated = true;
    }
  }

  const fullText = accumulated;
  const text = fullText.slice(baseLength);

  return {
    text,
    fullText,
    truncated,
    attempts,
    finishReason: lastFinish,
    status: lastStatus,
  };
}

function shouldLogUsage(env: Env): boolean {
  const features = getRuntimeFeatures(env);
  return features.usageTracking.enabled || isOwenDebug(env);
}

function logHookDenial(stage: string, label: string, reasons: string[]) {
  if (!reasons.length) return;
  console.warn("[runtime.hooks] deny ignored", { stage, label, reasons });
}

function logNormalizedUsage(env: Env, label: string, mode: "responses" | "chat_completions", payload: any) {
  if (!shouldLogUsage(env)) return;
  const usage = extractOpenAIUsage(payload, mode);
  if (!usage.totalTokens) return;
  console.info("[OWEN_USAGE]", { label, mode, usage });
}

function inferLegacyUsageWorkflow(label: string): {
  route: string;
  workflow: string;
  artifactType?: "study_guide" | "anki" | "artifact" | null;
  artifactCode?: string | null;
  lectureId?: string | null;
} {
  const normalized = (label || "").trim().toLowerCase();
  if (normalized.startsWith("machine-study-guide:")) {
    return {
      route: "/api/machine/generate-study-guide",
      workflow: "study-guide.compile",
      artifactType: "study_guide",
      artifactCode: label.split(":").slice(1).join(":") || null,
    };
  }
  if (normalized.startsWith("anki")) {
    return {
      route: "/api/anki/generate",
      workflow: "anki.generate",
      artifactType: "anki",
      lectureId: label.split(":").slice(1).join(":") || null,
      artifactCode: label.split(":").slice(1).join(":") || null,
    };
  }
  if (normalized.startsWith("library-notes:") || normalized.startsWith("ask")) {
    return {
      route: "/api/library/ask",
      workflow: "library.ask",
    };
  }
  return {
    route: "/api/runtime/legacy",
    workflow: "runtime.legacy",
  };
}

async function recordLegacyUsageEvent(
  env: Env,
  endpoint: "responses" | "chat_completions",
  label: string,
  payload: Record<string, unknown>,
  result: { usage?: { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number; totalTokens: number } | null; raw?: any },
  success: boolean,
  errorCode?: string,
): Promise<void> {
  if (!getRuntimeFeatures(env).usageTracking.enabled) return;
  const inferred = inferLegacyUsageWorkflow(label);
  const usage = result.usage || (result.raw ? extractOpenAIUsage(result.raw, endpoint) : null);
  await trackUsageEvent(env, {
    requestId: `legacy:${label}:${Date.now().toString(36)}`,
    route: inferred.route,
    workflow: inferred.workflow,
    lectureId: inferred.lectureId || null,
    artifactType: inferred.artifactType ?? null,
    artifactCode: inferred.artifactCode ?? null,
    modelId: typeof payload.model === "string" ? payload.model : DEFAULT_TEXT_MODEL,
    provider: "openai",
    success,
    errorCode: errorCode || null,
    toolSet: [],
    usage,
    metadata: { label, endpoint },
  }).catch(() => undefined);
}

async function callResponsesOnce(env: Env, payload: Record<string, unknown>, label: string): Promise<ResponseCallResult> {
  const features = getRuntimeFeatures(env);
  const beforeHooks = await runRuntimeHooks(
    "before_responses_call",
    { endpoint: "responses", label, payload },
    { enabled: features.hooks.enabled },
  );
  logHookDenial("before_responses_call", label, beforeHooks.reasons);
  const adapter = resolveModelAdapter(env);
  let result;
  try {
    result = await adapter.send({ endpoint: "responses", payload, label });
  } catch (error) {
    await recordLegacyUsageEvent(env, "responses", label, payload, {}, false, error instanceof Error ? error.message : String(error));
    await runRuntimeHooks(
      "after_responses_call",
      {
        endpoint: "responses",
        label,
        payload,
        status: typeof (error as any)?.status === "number" ? (error as any).status : undefined,
        error: error instanceof Error ? error.message : String(error),
      },
      { enabled: features.hooks.enabled },
    );
    throw error;
  }

  const data = result.raw;
  logNormalizedUsage(env, label, "responses", data);
  await runRuntimeHooks(
    "after_responses_call",
    {
      endpoint: "responses",
      label,
      payload,
      status: result.status || extractResponseStatus(data),
      usage: result.usage || extractOpenAIUsage(data, "responses"),
    },
    { enabled: features.hooks.enabled },
  );
  await recordLegacyUsageEvent(env, "responses", label, payload, { usage: result.usage, raw: data }, true);
  return {
    text: result.text || extractOutputText(data).trim(),
    finishReason: result.finishReason || extractFinishReason(data),
    status: result.status || extractResponseStatus(data),
    outputTokens: result.outputTokens || extractOutputTokens(data),
    incompleteReason: result.incompleteReason || extractIncompleteReason(data),
    usage: result.usage,
    raw: data,
  };
}

async function callResponsesJson(env: Env, payload: Record<string, unknown>, label: string): Promise<OpenAIJson> {
  const features = getRuntimeFeatures(env);
  const beforeHooks = await runRuntimeHooks(
    "before_responses_call",
    { endpoint: "responses", label, payload },
    { enabled: features.hooks.enabled },
  );
  logHookDenial("before_responses_call", label, beforeHooks.reasons);
  const adapter = resolveModelAdapter(env);
  let result;
  try {
    result = await adapter.send({ endpoint: "responses", payload, label });
  } catch (error) {
    await recordLegacyUsageEvent(env, "responses", label, payload, {}, false, error instanceof Error ? error.message : String(error));
    await runRuntimeHooks(
      "after_responses_call",
      {
        endpoint: "responses",
        label,
        payload,
        status: typeof (error as any)?.status === "number" ? (error as any).status : undefined,
        error: error instanceof Error ? error.message : String(error),
      },
      { enabled: features.hooks.enabled },
    );
    throw error;
  }

  logNormalizedUsage(env, label, "responses", result.raw);
  await runRuntimeHooks(
    "after_responses_call",
    {
      endpoint: "responses",
      label,
      payload,
      status: result.status,
      usage: result.usage || extractOpenAIUsage(result.raw, "responses"),
    },
    { enabled: features.hooks.enabled },
  );
  await recordLegacyUsageEvent(env, "responses", label, payload, { usage: result.usage, raw: result.raw }, true);
  return result.raw;
}

async function runChatCompletionsWithContinuation(
  env: Env,
  opts: {
    buildMessages: (state: { attempt: number; accumulatedText: string }) => ChatMessage[];
    model: string;
    label: string;
    maxAttempts?: number;
    maxOutputTokens?: number;
    initialText?: string;
    onSegment?: (segment: string, state: { attempt: number; accumulatedText: string }) => Promise<void> | void;
  },
): Promise<GeneratedTextResult> {
  const attemptsLimit = Math.max(1, opts.maxAttempts ?? ANSWER_MAX_CONTINUATIONS + 1);
  const maxTokens = Math.min(ANSWER_MAX_OUTPUT_TOKENS, Math.max(800, opts.maxOutputTokens ?? ANSWER_MAX_OUTPUT_TOKENS));
  const baseLength = (opts.initialText || "").length;
  let accumulated = opts.initialText || "";
  const initialStop = trimAtUserInputRequiredBoundary(accumulated);
  if (initialStop.trimmed || findUserInputRequiredBoundary(accumulated) !== null) {
    accumulated = initialStop.text;
    return {
      text: "",
      fullText: accumulated,
      truncated: false,
      attempts: 0,
      finishReason: undefined,
    };
  }
  let attempts = 0;
  let truncated = false;
  let lastFinish: string | undefined;

  while (attempts < attemptsLimit) {
    attempts += 1;
    const messages = opts.buildMessages({ attempt: attempts, accumulatedText: accumulated }) || [];
    const result = await callChatCompletionOnce(env, {
      messages,
      model: opts.model,
      maxTokens,
      label: `${opts.label}#${attempts}`,
    });
    lastFinish = result.finishReason || lastFinish;
    const segment = (result.text || "").trim();
    if (segment) {
      accumulated = combineSegments([accumulated, segment]);
      const userInputStop = trimAtUserInputRequiredBoundary(accumulated);
      if (findUserInputRequiredBoundary(accumulated) !== null) {
        accumulated = userInputStop.text;
        truncated = false;
        break;
      }
      if (opts.onSegment) {
        await opts.onSegment(segment, { attempt: attempts, accumulatedText: accumulated });
      }
    }
    const needsMore = shouldContinueAnswer(result, maxTokens, segment, accumulated);
    if (!needsMore) {
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
    finishReason: lastFinish,
  };
}

async function callChatCompletionOnce(
  env: Env,
  input: { messages: ChatMessage[]; model: string; maxTokens: number; label: string },
): Promise<ResponseCallResult> {
  const features = getRuntimeFeatures(env);
  const payload = {
    model: input.model,
    messages: input.messages,
    max_completion_tokens: input.maxTokens,
    stream: false,
  };
  const beforeHooks = await runRuntimeHooks(
    "before_responses_call",
    { endpoint: "chat_completions", label: input.label, payload },
    { enabled: features.hooks.enabled },
  );
  logHookDenial("before_responses_call", input.label, beforeHooks.reasons);
  const adapter = resolveModelAdapter(env);
  let result;
  try {
    result = await adapter.send({ endpoint: "chat_completions", payload, label: input.label });
  } catch (error) {
    await recordLegacyUsageEvent(env, "chat_completions", input.label, payload, {}, false, error instanceof Error ? error.message : String(error));
    await runRuntimeHooks(
      "after_responses_call",
      {
        endpoint: "chat_completions",
        label: input.label,
        payload,
        status: typeof (error as any)?.status === "number" ? (error as any).status : undefined,
        error: error instanceof Error ? error.message : String(error),
      },
      { enabled: features.hooks.enabled },
    );
    throw error;
  }
  const data = result.raw;
  logNormalizedUsage(env, input.label, "chat_completions", data);
  await runRuntimeHooks(
    "after_responses_call",
    {
      endpoint: "chat_completions",
      label: input.label,
      payload,
      status: result.status,
      usage: result.usage || extractOpenAIUsage(data, "chat_completions"),
    },
    { enabled: features.hooks.enabled },
  );
  await recordLegacyUsageEvent(env, "chat_completions", input.label, payload, { usage: result.usage, raw: data }, true);
  return {
    text: result.text || extractChatCompletionContent(data).trim(),
    finishReason: result.finishReason || data?.choices?.[0]?.finish_reason,
    status: result.status || "completed",
    outputTokens: result.outputTokens || extractOpenAIUsage(data, "chat_completions").outputTokens || undefined,
    usage: result.usage,
    raw: data,
  };
}

function extractFinishReason(payload: any): string | undefined {
  return (
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

function shouldContinueAnswer(
  result: ResponseCallResult,
  maxOutputTokens: number,
  segmentText: string,
  accumulatedText: string = segmentText,
): boolean {
  if (findUserInputRequiredBoundary(accumulatedText) !== null) return false;
  const finish = (result.finishReason || "").toLowerCase();
  const incomplete = (result.incompleteReason || "").toLowerCase();
  if (finish === "length" || finish === "max_tokens") return true;
  if (incomplete.includes("max") || incomplete.includes("length")) return true;
  if (result.status && result.status !== "completed" && result.status !== "finished") return true;
  const incompleteReason = detectIncompleteReason(accumulatedText);
  if (incompleteReason) return true;
  const nearCap = typeof result.outputTokens === "number" && result.outputTokens >= maxOutputTokens - 20;
  if (nearCap) return true;
  if (looksTruncatedText(segmentText) && (nearCap || segmentText.length >= 1200)) return true;
  return false;
}

function looksTruncatedText(text: string): boolean {
  const trimmed = (text || "").trim();
  if (!trimmed) return false;
  if (trimmed.endsWith("</table>")) return false;
  if (/[.!?…)]$/.test(trimmed)) return false;
  if (trimmed.endsWith("...")) return true;
  const lastLine = trimmed.split(/\r?\n/).pop()?.trim() || "";
  if (/[,;:/-]\s*$/.test(lastLine)) return true;
  if (trimmed.length > 500 && !/[.!?…)]$/.test(lastLine)) return true;
  return false;
}

const COMMON_FINAL_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "so",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "without",
  "yes",
  "no",
  "ok",
  "okay",
]);

function hasUnbalancedDelimiters(text: string): boolean {
  const stack: string[] = [];
  const openers: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const closers = new Set(Object.values(openers));
  for (const char of text) {
    if (openers[char]) {
      stack.push(openers[char]);
      continue;
    }
    if (closers.has(char)) {
      if (stack.length === 0) return true;
      const expected = stack.pop();
      if (char !== expected) return true;
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
  if (!trimmed) return false;
  if (/[.!?…)]$/.test(trimmed)) return false;
  const tokens = trimmed.split(/\s+/);
  const lastToken = tokens[tokens.length - 1] || "";
  const lower = lastToken.toLowerCase();
  if (!/^[a-z]{3,}$/.test(lower)) return false;
  if (COMMON_FINAL_WORDS.has(lower)) return false;
  const longEnough = trimmed.length > 80 || tokens.length > 12;
  if (!longEnough) return false;
  return true;
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

function trimAtUserInputRequiredBoundary(text: string): { text: string; trimmed: boolean } {
  const boundary = findUserInputRequiredBoundary(text);
  if (boundary === null) return { text, trimmed: false };
  return {
    text: boundary < text.length ? text.slice(0, boundary).trim() : text.trim(),
    trimmed: boundary < text.length,
  };
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
    const words = trimmed.split(/\s+/);
    if (words.length <= 10) return true;
  }
  return false;
}

function findTrailingHeading(text: string): string | null {
  const lines = (text || "").split(/\r?\n/).slice(-8).reverse();
  for (const line of lines) {
    if (isLikelyHeading(line)) {
      return normalizeHeadingText(line);
    }
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
  alreadyPrefixed: boolean,
  allowPrefix = true,
): { text: string; prefixed: boolean } {
  let cleaned = stripDuplicateLeadingHeaders(segment, prior);
  let prefixed = alreadyPrefixed;
  if (cleaned.trim() && allowPrefix) {
    const hasPrefix = /^\(continuing/i.test(cleaned.trimStart());
    if (!prefixed && !hasPrefix) {
      prefixed = true;
    }
  }
  return { text: cleaned, prefixed };
}

function clipAnswerTail(answer: string, limit = CONTINUATION_TAIL_CHARS): string {
  const trimmed = (answer || "").trim();
  if (trimmed.length <= limit) return trimmed;
  return trimmed.slice(-limit);
}

function buildContinuationMessages(baseMessages: ChatMessage[], accumulatedText: string): ChatMessage[] {
  const tail = clipAnswerTail(accumulatedText);
  return [
    ...baseMessages,
    { role: "assistant", content: tail || "(previous answer abbreviated for continuation)" },
    { role: "user", content: CONTINUATION_INSTRUCTION },
  ];
}

function buildContinuationResponsesInput(
  baseInput: ResponsesInputMessage[],
  accumulatedText: string,
): ResponsesInputMessage[] {
  const continuationParts: ResponsesInputContent[] = [];
  if (accumulatedText) {
    continuationParts.push({
      type: "input_text",
      text: `Partial answer so far:\n${clipAnswerTail(accumulatedText)}`,
    });
  }
  continuationParts.push({ type: "input_text", text: CONTINUATION_INSTRUCTION });
  return [
    ...baseInput,
    { role: "user", content: continuationParts },
  ];
}

function appendTruncationNotice(answer: string): string {
  const trimmed = (answer || "").trim();
  if (!trimmed) return TRUNCATION_NOTICE;
  if (trimmed.includes(TRUNCATION_NOTICE)) return trimmed;
  const separator = /\n\s*$/.test(trimmed) ? "" : (/[.!?]$/.test(trimmed) ? " " : "\n\n");
  return `${trimmed}${separator}${TRUNCATION_NOTICE}`;
}

type LibraryIntent = {
  isBroad: boolean;
  wantsTable: boolean;
  wantsConditionLabsTable: boolean;
  listIntent: boolean;
};

function isTableIntent(prompt: string): boolean {
  const lower = (prompt || "").toLowerCase();
  if (!lower) return false;
  if (/\b(table|tabulate|columns|make a table|create a table|put in a table|table of)\b/.test(lower)) return true;
  return false;
}

function isInherentlyTabularQuestion(prompt: string): boolean {
  const lower = (prompt || "").toLowerCase();
  if (!lower) return false;
  const phrases = ["reference range", "ref range", "cut-off", "cut off"];
  if (phrases.some(phrase => lower.includes(phrase))) return true;
  const keywords = [
    "lab",
    "labs",
    "laboratory",
    "threshold",
    "cutoff",
    "dose",
    "dosing",
    "dosage",
    "sensitivity",
    "specificity",
    "value",
    "values",
  ];
  return keywords.some(keyword => lower.includes(keyword));
}

function allowExcerpts(prompt: string): boolean {
  const lower = (prompt || "").toLowerCase();
  if (!lower) return false;
  const triggers = [
    "quote",
    "show slide",
    "show the slide",
    "show excerpt",
    "show the excerpt",
    "show evidence",
    "excerpts",
    "verbatim",
    "evidence",
    "proof",
    "cite page",
  ];
  return triggers.some(trigger => lower.includes(trigger));
}

function looksLikeAttributeList(answer: string): boolean {
  if (!answer) return false;
  const lines = (answer || "").split(/\r?\n/);
  let hits = 0;
  lines.forEach(line => {
    const trimmed = line.trim();
    if (!/^[-*•]/.test(trimmed)) return;
    const body = trimmed.replace(/^[-*•]\s*/, "");
    if (/^([A-Za-z0-9 ()./+%~-]{2,})\s*[:–-]\s+.+/.test(body)) {
      hits += 1;
    }
  });
  return hits >= 3;
}

function deriveTableHeaders(prompt: string): string[] {
  const lower = (prompt || "").toLowerCase();
  if (/\bdisease/.test(lower) && /\bgenetic/.test(lower)) {
    return ["Disease", "Defining features", "Genetic marker(s) (if relevant)"];
  }
  if (/\bdisease/.test(lower) && /\bfeature/.test(lower)) {
    return ["Disease", "Key features", "Notes"];
  }
  if (/\bdrug/.test(lower) && /\bdose|dosing|dosage/.test(lower)) {
    return ["Drug", "Indication", "Dose", "Notes"];
  }
  return ["Item", "Details"];
}

const LIBRARY_HEADER_KEYWORDS = [
  "WORKUP",
  "CAUSES",
  "ETIOLOGY",
  "ETIOLOGIES",
  "DIFFERENTIAL",
  "DIAGNOSIS",
  "TABLE",
  "ALGORITHM",
  "APPROACH",
  "SUMMARY",
  "OVERVIEW",
];

function detectLibraryIntent(question: string): LibraryIntent {
  const lower = (question || "").toLowerCase();
  const listIntent = /\b(list|all|table|catalog|enumerat|differential|compare|versus|vs|outline|overview|summary)\b/i.test(
    lower,
  );
  const broadTriggers = [
    "table of",
    "list all",
    "list the",
    "all causes",
    "all etiolog",
    "all of the",
    "compare",
    "versus",
    "vs",
    "algorithm",
    "workup",
    "approach",
    "differential",
    "overview",
    "summary",
    "outline",
    "causes",
    "etiology",
    "etiologies",
    "etiologic",
  ];
  const isBroad = broadTriggers.some(trigger => lower.includes(trigger)) || /\btable\b/.test(lower);
  const wantsTable = isTableIntent(question);
  const wantsConditionLabsTable =
    wantsTable &&
    (/\blab\b|\blabs\b|laboratory|electrolyte|osm|sodium|potassium|urine|serum/.test(lower) ||
      /\bvalues?\b/.test(lower));
  return { isBroad, wantsTable, wantsConditionLabsTable, listIntent };
}

function isHeaderChunk(text: string): boolean {
  if (!text) return false;
  const upper = text.toUpperCase();
  const headerHit = LIBRARY_HEADER_KEYWORDS.some(keyword => upper.includes(keyword));
  const uppercaseWords = text.match(/\b[A-Z]{3,}\b/g) || [];
  return headerHit || uppercaseWords.length >= 6;
}

function isTableLikeChunk(text: string): boolean {
  if (!text) return false;
  const pipeCount = (text.match(/\|/g) || []).length;
  const tabCount = (text.match(/\t/g) || []).length;
  const multiSpaceLines = (text.match(/\n[^\n]{0,80} {3,}[^\n]{0,80}/g) || []).length;
  return pipeCount >= 2 || tabCount >= 2 || multiSpaceLines >= 3;
}

function hasDenseAcronyms(text: string): boolean {
  if (!text) return false;
  const acronyms = text.match(/\b[A-Z]{2,5}\b/g) || [];
  const unique = new Set(acronyms);
  return unique.size >= 4;
}

function selectLibraryChunks(question: string, chunks: RetrievalChunk[], intent: LibraryIntent): RetrievalChunk[] {
  if (!Array.isArray(chunks) || !chunks.length) return [];

  if (!intent.isBroad) {
    const ranked = rankChunks(question, chunks, RETRIEVAL_TOP_K);
    return ranked.length ? ranked : chunks.slice(0, Math.min(RETRIEVAL_TOP_K, chunks.length));
  }

  const selected = new Map<number, RetrievalChunk>();
  let contextCharCount = 0;
  const addChunk = (chunk: RetrievalChunk) => {
    if (!chunk || selected.has(chunk.index)) return;
    if (contextCharCount + chunk.text.length > LIBRARY_BROAD_MAX_CONTEXT_CHARS) return;
    selected.set(chunk.index, chunk);
    contextCharCount += chunk.text.length;
  };

  const broadTopK = Math.min(chunks.length, LIBRARY_BROAD_TOP_K);
  const ranked = rankChunks(question, chunks, broadTopK);
  const baseCandidates = ranked.length ? ranked : chunks.slice(0, broadTopK);
  baseCandidates.forEach(addChunk);

  const headerCandidates = chunks.filter(chunk => isHeaderChunk(chunk.text)).slice(0, broadTopK);
  headerCandidates.forEach(addChunk);

  const tableCandidates = chunks.filter(chunk => isTableLikeChunk(chunk.text)).slice(0, broadTopK);
  tableCandidates.forEach(addChunk);

  const acronymCandidates = chunks.filter(chunk => hasDenseAcronyms(chunk.text)).slice(0, broadTopK);
  acronymCandidates.forEach(addChunk);

  const needsCoverage =
    selected.size < LIBRARY_BROAD_MIN_CHUNKS || contextCharCount < LIBRARY_BROAD_MIN_CHARS;
  if (needsCoverage && contextCharCount < LIBRARY_BROAD_MAX_CONTEXT_CHARS) {
    for (const chunk of chunks) {
      addChunk(chunk);
      if (
        selected.size >= LIBRARY_BROAD_MIN_CHUNKS &&
        contextCharCount >= LIBRARY_BROAD_MIN_CHARS
      ) {
        break;
      }
    }
  }

  return Array.from(selected.values()).sort((a, b) => a.index - b.index);
}

function selectQuizChunks(chunks: RetrievalChunk[], count: number): RetrievalChunk[] {
  if (!Array.isArray(chunks) || !chunks.length) return [];
  if (chunks.length <= count) return chunks;
  const selected: RetrievalChunk[] = [];
  const seen = new Set<number>();
  const step = (chunks.length - 1) / Math.max(1, count - 1);
  for (let i = 0; i < count; i += 1) {
    const index = Math.min(chunks.length - 1, Math.round(i * step));
    const chunk = chunks[index];
    if (chunk && !seen.has(chunk.index)) {
      selected.push(chunk);
      seen.add(chunk.index);
    }
  }
  if (selected.length < count) {
    for (const chunk of chunks) {
      if (selected.length >= count) break;
      if (!seen.has(chunk.index)) {
        selected.push(chunk);
        seen.add(chunk.index);
      }
    }
  }
  return selected;
}

const QUIZ_SIMILARITY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "may",
  "might",
  "must",
  "of",
  "on",
  "or",
  "over",
  "per",
  "should",
  "that",
  "the",
  "their",
  "then",
  "these",
  "this",
  "those",
  "to",
  "under",
  "via",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "why",
  "will",
  "with",
  "without",
  "would",
]);

const QUIZ_STEM_BOILERPLATE = [
  /\baccording to (the )?lecture\b/gi,
  /\baccording to (the )?slides\b/gi,
  /\bbased on (the )?lecture\b/gi,
  /\bfrom (the )?lecture\b/gi,
  /\bfrom (the )?slides\b/gi,
  /\bas discussed in (the )?lecture\b/gi,
  /\bas described in (the )?lecture\b/gi,
  /\bas noted in (the )?lecture\b/gi,
  /\bin (the )?lecture\b/gi,
];

function normalizeQuizStem(stem: string): string {
  let text = String(stem || "").toLowerCase();
  for (const pattern of QUIZ_STEM_BOILERPLATE) {
    text = text.replace(pattern, " ");
  }
  text = text.replace(/[^\p{L}\p{N}\s]/gu, " ");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

function tokenizeQuizStem(text: string): Set<string> {
  if (!text) return new Set();
  const tokens = text
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length > 2 && !QUIZ_SIMILARITY_STOPWORDS.has(token));
  return new Set(tokens);
}

function buildQuizFingerprint(stem: string): { fingerprint: string; tokens: Set<string> } | null {
  const normalized = normalizeQuizStem(stem);
  const base = normalized || String(stem || "").toLowerCase().trim();
  if (!base) return null;
  const fingerprint = base.length > QUIZ_FINGERPRINT_MAX_CHARS ? base.slice(0, QUIZ_FINGERPRINT_MAX_CHARS) : base;
  return { fingerprint, tokens: tokenizeQuizStem(base) };
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const token of small) {
    if (large.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union ? intersection / union : 0;
}

function isNearDuplicate(tokens: Set<string>, existing: Set<string>[]): boolean {
  if (!tokens.size) return false;
  for (const candidate of existing) {
    if (jaccardSimilarity(tokens, candidate) >= QUIZ_DUPLICATE_SIMILARITY_THRESHOLD) return true;
  }
  return false;
}

function buildQuizPromptExclusions(priorQuestions: string[]): { list: string[]; fingerprints: Set<string> } {
  const list: string[] = [];
  const fingerprints = new Set<string>();
  for (const raw of priorQuestions) {
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (!trimmed) continue;
    const fingerprint = buildQuizFingerprint(trimmed)?.fingerprint || trimmed.toLowerCase();
    if (fingerprints.has(fingerprint)) continue;
    fingerprints.add(fingerprint);
    list.push(trimmed);
  }
  return { list, fingerprints };
}

function addQuizPromptExclusion(
  state: { list: string[]; fingerprints: Set<string> },
  stem: string,
): void {
  const trimmed = String(stem || "").trim();
  if (!trimmed) return;
  const fingerprint = buildQuizFingerprint(trimmed)?.fingerprint || trimmed.toLowerCase();
  if (state.fingerprints.has(fingerprint)) return;
  state.fingerprints.add(fingerprint);
  state.list.push(trimmed);
}

function buildQuizExclusionIndex(priorQuestions: string[], priorFingerprints: string[]) {
  const fingerprintSet = new Set<string>();
  const tokenSets: Set<string>[] = [];
  const ordered: string[] = [];
  const addFingerprint = (raw: string) => {
    const trimmed = String(raw || "").trim();
    if (!trimmed) return;
    const normalized = normalizeQuizStem(trimmed) || trimmed.toLowerCase();
    const fingerprint =
      normalized.length > QUIZ_FINGERPRINT_MAX_CHARS ? normalized.slice(0, QUIZ_FINGERPRINT_MAX_CHARS) : normalized;
    if (fingerprintSet.has(fingerprint)) return;
    fingerprintSet.add(fingerprint);
    ordered.push(fingerprint);
    tokenSets.push(tokenizeQuizStem(normalized));
  };
  priorQuestions.forEach(question => addFingerprint(question));
  priorFingerprints.forEach(fp => addFingerprint(fp));
  return { fingerprintSet, tokenSets, ordered, excludedCount: fingerprintSet.size };
}

function ensureUniqueQuizId(idInput: string, used: Set<string>): string {
  const base = (idInput || "").trim() || "q";
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  let candidate = `${base}-${suffix}`;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

function normalizeQuizChoiceId(value: unknown): string {
  const id = typeof value === "string" ? value.trim().toUpperCase() : "";
  return QUIZ_CHOICE_ID_LIST.includes(id as (typeof QUIZ_CHOICE_ID_LIST)[number]) ? id : "";
}

function cloneQuizQuestionWithId(question: QuizQuestion, id: string): QuizQuestion {
  const choiceById = new Map<string, QuizChoice>();
  if (Array.isArray(question.choices)) {
    for (const choice of question.choices) {
      const choiceId = normalizeQuizChoiceId((choice as QuizChoice | undefined)?.id);
      if (!choiceId || choiceById.has(choiceId)) continue;
      choiceById.set(choiceId, {
        id: choiceId,
        text: typeof (choice as QuizChoice | undefined)?.text === "string" ? (choice as QuizChoice).text : "",
      });
    }
  }
  const choices = QUIZ_CHOICE_ID_LIST
    .map(choiceId => choiceById.get(choiceId))
    .filter((choice): choice is QuizChoice => Boolean(choice));
  const tags = Array.isArray(question.tags)
    ? question.tags
      .map(tag => (typeof tag === "string" ? tag.trim() : ""))
      .filter(Boolean)
      .slice(0, 3)
    : [];
  const references = Array.isArray(question.references)
    ? question.references
      .map(reference => (typeof reference === "string" ? reference.trim() : ""))
      .filter(Boolean)
      .slice(0, 2)
    : [];
  return {
    ...question,
    id,
    choices,
    tags,
    references,
  };
}

function normalizeQuizQuestionForOutput(question: QuizQuestion, usedIds: Set<string>): QuizQuestion {
  const id = ensureUniqueQuizId(typeof question.id === "string" ? question.id : "", usedIds);
  return cloneQuizQuestionWithId(question, id);
}

function fillQuizQuestionsWithDuplicates(
  accepted: QuizQuestion[],
  candidates: QuizQuestion[],
  count: number,
  usedIds: Set<string>,
): QuizQuestion[] {
  const finalQuestions = accepted.slice();
  const fallback = candidates.length ? candidates : accepted;
  let idx = 0;
  while (finalQuestions.length < count && fallback.length) {
    const source = fallback[idx % fallback.length];
    finalQuestions.push(normalizeQuizQuestionForOutput(source, usedIds));
    idx += 1;
  }
  return finalQuestions;
}

function clampQuizCursor(cursor: number, totalChunks: number): number {
  if (!Number.isFinite(cursor) || totalChunks <= 0) return 0;
  const mod = Math.floor(cursor) % totalChunks;
  return mod < 0 ? mod + totalChunks : mod;
}

function sliceChunksWithWrap(chunks: RetrievalChunk[], start: number, windowSize: number): RetrievalChunk[] {
  if (!chunks.length || windowSize <= 0) return [];
  if (windowSize >= chunks.length) return chunks;
  const end = start + windowSize;
  if (end <= chunks.length) return chunks.slice(start, end);
  return chunks.slice(start).concat(chunks.slice(0, end % chunks.length));
}

function buildQuizWindowHistory(setIndex: number, windowSize: number, totalChunks: number): number[] {
  if (!Number.isFinite(setIndex) || setIndex <= 0 || totalChunks <= 0) return [];
  const used: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < setIndex; i += 1) {
    const start = clampQuizCursor(i * windowSize, totalChunks);
    if (seen.has(start)) continue;
    seen.add(start);
    used.push(start);
    if (seen.size >= totalChunks) break;
  }
  return used.slice(-QUIZ_TOKEN_MAX_WINDOWS);
}

function updateQuizWindowStarts(existing: number[], start: number, totalChunks: number): number[] {
  if (totalChunks <= 0) return [];
  const next: number[] = [];
  const seen = new Set<number>();
  for (const entry of existing || []) {
    if (!Number.isFinite(entry)) continue;
    const normalized = clampQuizCursor(entry, totalChunks);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    next.push(normalized);
  }
  if (!seen.has(start)) {
    next.push(start);
    seen.add(start);
  }
  return next.length > QUIZ_TOKEN_MAX_WINDOWS ? next.slice(-QUIZ_TOKEN_MAX_WINDOWS) : next;
}

function selectQuizChunkWindow(
  chunks: RetrievalChunk[],
  opts: { cursor: number; windowSize: number; usedWindowStarts: number[] },
): {
  selected: RetrievalChunk[];
  start: number;
  nextCursor: number;
  usedWindowStarts: number[];
  windowSize: number;
  totalChunks: number;
  exhausted: boolean;
} {
  const totalChunks = chunks.length;
  const windowSize = Math.min(Math.max(1, opts.windowSize), totalChunks || opts.windowSize);
  if (!totalChunks) {
    return {
      selected: [],
      start: 0,
      nextCursor: 0,
      usedWindowStarts: [],
      windowSize: 0,
      totalChunks: 0,
      exhausted: true,
    };
  }
  const cursor = clampQuizCursor(opts.cursor, totalChunks);
  const usedSet = new Set(
    (opts.usedWindowStarts || []).filter(entry => Number.isFinite(entry)).map(entry => clampQuizCursor(entry, totalChunks)),
  );
  let start = cursor;
  let exhausted = false;
  if (usedSet.has(start) && usedSet.size < totalChunks) {
    let found = false;
    for (let i = 0; i < totalChunks; i += 1) {
      const candidate = clampQuizCursor(cursor + i, totalChunks);
      if (!usedSet.has(candidate)) {
        start = candidate;
        found = true;
        break;
      }
    }
    if (!found) exhausted = true;
  } else if (usedSet.size >= totalChunks) {
    exhausted = true;
  }
  const selected = sliceChunksWithWrap(chunks, start, windowSize);
  const nextCursor = clampQuizCursor(start + windowSize, totalChunks);
  const usedWindowStarts = updateQuizWindowStarts(opts.usedWindowStarts, start, totalChunks);
  const windowExhausted = exhausted || usedWindowStarts.length >= totalChunks;
  return { selected, start, nextCursor, usedWindowStarts, windowSize, totalChunks, exhausted: windowExhausted };
}

function buildQuizContext(chunks: RetrievalChunk[]): { context: string; referenceLabels: string[] } {
  const entries = chunks.map(chunk => {
    const ref = mapChunkToSlideRef(chunk);
    const label = ref.title ? `${ref.label} - ${ref.title}` : ref.label;
    const text = cleanRetrievedChunkText(chunk.text || "");
    return { label, text };
  });
  const context = entries
    .map((entry, index) => `[Section ${index + 1}] ${entry.label}\n${entry.text}`)
    .join("\n\n");
  const referenceLabels = entries.map(entry => entry.label);
  return { context, referenceLabels };
}

function buildQuizContinuationToken(state: QuizContinuationState): string {
  const safeState: QuizContinuationState = {
    v: 1,
    docId: String(state.docId || "").trim(),
    cursor: Number.isFinite(state.cursor) ? Math.floor(state.cursor) : 0,
    usedChunkWindows: (state.usedChunkWindows || [])
      .filter(entry => Number.isFinite(entry))
      .map(entry => Math.floor(entry))
      .slice(-QUIZ_TOKEN_MAX_WINDOWS),
    usedQuestionFingerprints: (state.usedQuestionFingerprints || [])
      .map(entry => String(entry || "").trim())
      .filter(Boolean)
      .map(entry => (entry.length > QUIZ_FINGERPRINT_MAX_CHARS ? entry.slice(0, QUIZ_FINGERPRINT_MAX_CHARS) : entry))
      .slice(-QUIZ_TOKEN_MAX_FINGERPRINTS),
    count: Number.isFinite(state.count) && state.count > 0 ? Math.floor(state.count) : QUIZ_BATCH_SIZE,
  };
  const payload = JSON.stringify(safeState);
  const bytes = enc.encode(payload);
  let binary = "";
  bytes.forEach(b => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
}

function parseQuizContinuationToken(token: string): QuizContinuationState | null {
  try {
    const binary = atob(token);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    const decoded = dec.decode(bytes);
    const parsed = JSON.parse(decoded);
    if (!parsed || parsed.v !== 1 || typeof parsed.docId !== "string") {
      return null;
    }
    return {
      v: 1,
      docId: parsed.docId,
      cursor: typeof parsed.cursor === "number" ? parsed.cursor : 0,
      usedChunkWindows: isNumberArray(parsed.usedChunkWindows) ? parsed.usedChunkWindows : [],
      usedQuestionFingerprints: isStringArray(parsed.usedQuestionFingerprints) ? parsed.usedQuestionFingerprints : [],
      count: typeof parsed.count === "number" ? parsed.count : QUIZ_BATCH_SIZE,
    };
  } catch {
    return null;
  }
}

function trimAfterFirstTable(answer: string): string {
  if (!answer) return answer;
  const htmlClose = answer.indexOf("</table>");
  if (htmlClose !== -1) {
    return answer.slice(0, htmlClose + "</table>".length);
  }

  const lines = answer.split("\n");
  let tableStart = -1;
  let tableEnd = lines.length;
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    const next = lines[i + 1] || "";
    const looksLikeRow = /\|/.test(line) && !/^```/.test(line);
    const looksLikeDivider = /^\s*\|?\s*:?-{2,}/.test(next);
    if (looksLikeRow && looksLikeDivider) {
      tableStart = i;
      break;
    }
  }
  if (tableStart === -1) return answer;
  for (let j = tableStart + 2; j < lines.length; j++) {
    if (!lines[j].trim()) {
      tableEnd = j;
      break;
    }
  }
  return lines.slice(0, tableEnd).join("\n").trim();
}

const SECTION_LABEL_WHITELIST = new Set([
  "response",
  "summary",
  "diagnosis",
  "labs",
  "treatment",
  "warnings",
  "plan",
  "next steps",
]);

function sanitizeAnswer(answer: string, opts: { allowExcerpts?: boolean } = {}): string {
  if (!answer) return answer;
  const { allowExcerpts = false } = opts;
  const cleanedLines: string[] = [];
  const lines = answer.replace(/\[?\bC\d+\b\]?:?/gi, " ").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!allowExcerpts) {
      if (/from the lecture excerpts:/i.test(trimmed)) break;
      if (/^(?:-|\*|•)?\s*(slide|page)\s*\d+/i.test(trimmed)) break;
    }
    if (!trimmed) {
      if (cleanedLines.length && cleanedLines[cleanedLines.length - 1] !== "") {
        cleanedLines.push("");
      }
      continue;
    }
    if (/^---\s*page\s*\d+\s*---/i.test(trimmed)) continue;
    if (/^c\d+\s*:?\s*-{2,}/i.test(trimmed)) continue;
    if (/^c\d+\s*:?\s*$/i.test(trimmed)) continue;

    const isTiny = trimmed.length <= 3 && !/^[-•*]\s+\S/.test(trimmed);
    const looksCourseHeader =
      /^kcu[-\s]?com/i.test(trimmed) ||
      /^dr\./i.test(trimmed) ||
      (/^[A-Z0-9 .,'/-]+$/.test(trimmed) && trimmed === trimmed.toUpperCase() && trimmed.length > 8);
    const headingMatch = /^([A-Za-z][A-Za-z ]{0,50})[:.]?$/.exec(trimmed);
    const normalizedHeading = headingMatch ? headingMatch[1].trim().toLowerCase() : "";
    const isHeadingOnly = headingMatch && headingMatch[0].length === trimmed.length;
    const allowedHeading = normalizedHeading && SECTION_LABEL_WHITELIST.has(normalizedHeading);

    if (isTiny) continue;
    if (looksCourseHeader) continue;
    if (isHeadingOnly && !allowedHeading) continue;

    cleanedLines.push(line);
  }

  let text = cleanedLines.join("\n");
  text = text
    .replace(/\[?\bC\d+\b\]?:?/gi, "")
    .replace(/^\s*---\s*page\s*\d+\s*---\s*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  const hasTable = /\|/.test(text) && /\n/.test(text);
  text = text.replace(/\s*(or seiz)\w*$/i, "").trim();

  if (!/[.!?…]\s*$/.test(text) && !hasTable) {
    const lastStop = Math.max(text.lastIndexOf("."), text.lastIndexOf("?"), text.lastIndexOf("!"), text.lastIndexOf("…"));
    if (lastStop !== -1) {
      text = text.slice(0, lastStop + 1).trim();
    }
  }

  if (!/[.!?…]\s*$/.test(text) && !hasTable) {
    const trailingWord = text.match(/[A-Za-z]+$/);
    if (trailingWord) {
      const boundary = Math.max(
        text.lastIndexOf("."),
        text.lastIndexOf("?"),
        text.lastIndexOf("!"),
        text.lastIndexOf("…"),
      );
      if (boundary > -1 && boundary < text.length - 1) {
        text = text.slice(0, boundary + 1).trim();
      } else if (text.split(/\s+/).length > 6) {
        text = text.split(/\s+/).slice(0, -1).join(" ").trim();
      }
    }
  }

  if (text && !/[.!?…]\s*$/.test(text) && !hasTable) {
    text = text.replace(/\s+\n/g, "\n").trimEnd();
    text += ".";
  }

  return text || answer.trim();
}

function sanitizeJunkTail(answer: string, allowExcerpts = false): string {
  return sanitizeAnswer(answer, { allowExcerpts });
}

function cleanRetrievedChunkText(text: string): string {
  const lines = (text || "").split(/\r?\n/);
  const cleaned: string[] = [];
  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) {
      cleaned.push("");
      return;
    }
    if (/^c\d+:/i.test(trimmed)) return;
    if (/^[A-Za-z]{1,3}$/.test(trimmed)) return;
    if (/^kcu[-\s]?com/i.test(trimmed)) return;
    if (/^dr\./i.test(trimmed) && trimmed === trimmed.toUpperCase()) return;
    if (/^---\s*page\s*\d+\s*---/i.test(trimmed)) return;
    cleaned.push(line);
  });
  const result = cleaned.join("\n").trim();
  return result || text;
}

type ChunkReference = {
  label: string;
  title: string;
  type: "slide" | "page";
  number?: number;
  slide?: number;
  page?: number;
};

function mapChunkToSlideRef(chunk: { index: number; text: string }): ChunkReference {
  const raw = chunk.text || "";
  const lines = raw.split(/\n/).map(l => l.trim()).filter(Boolean);
  const pageMatch = raw.match(/---\s*page\s*(\d+)\s*---/i) || raw.match(/\bpage\s+(\d+)\b/i);
  const slideMatch = raw.match(/\bslide\s+(\d+)\b/i);
  const number = slideMatch ? Number(slideMatch[1]) : pageMatch ? Number(pageMatch[1]) : chunk.index + 1;
  const type: "slide" | "page" = slideMatch ? "slide" : pageMatch ? "page" : "slide";
  const label = `${type === "slide" ? "Slide" : "Page"} ${Number.isFinite(number) ? number : chunk.index + 1}`;
  const title = lines.find(l => l.length > 8 && !/^---\s*page/i.test(l) && !/^slide\s+\d+/i.test(l)) || "";
  const slide = type === "slide" ? (Number.isFinite(number) ? number : undefined) : undefined;
  const page = type === "page" ? (Number.isFinite(number) ? number : undefined) : undefined;
  return { label, title, type, number: Number.isFinite(number) ? number : undefined, slide, page };
}

function replaceChunkMarkers(answer: string, chunks: Array<{ index: number; text: string }>) {
  if (!answer) return answer;
  const chunkMap = new Map<number, ChunkReference>();
  chunks.forEach(chunk => {
    const ref = mapChunkToSlideRef(chunk);
    chunkMap.set(chunk.index + 1, ref);
  });
  return answer.replace(/\[?C(\d+)\]?:?/gi, (_m, numStr) => {
    const num = Number(numStr);
    const ref = chunkMap.get(num);
    if (!ref) return "";
    const title = ref.title ? ` – ${ref.title.slice(0, 80)}` : "";
    return `(${ref.label}${title})`;
  });
}

function buildReferencesFromChunks(chunks: Array<{ index: number; text: string }>, docId?: string) {
  const seen = new Set<string>();
  const refs: Array<{ slide?: number; page?: number; title?: string; docId?: string }> = [];
  chunks.forEach(chunk => {
    const ref = mapChunkToSlideRef(chunk);
    const key = `${ref.type}:${ref.number || ref.label.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({
      slide: ref.slide,
      page: ref.page,
      title: ref.title || undefined,
      docId,
    });
  });
  return refs;
}

function buildEvidenceFromChunks(chunks: Array<{ index: number; text: string }>, docId?: string) {
  return chunks
    .map(chunk => {
      const ref = mapChunkToSlideRef(chunk);
      const cleaned = cleanRetrievedChunkText(chunk.text || "")
        .replace(/^\s*---\s*page\s*\d+\s*---\s*$/gim, "")
        .trim();
      const text = cleaned.length > 480 ? `${cleaned.slice(0, 480).trim()}…` : cleaned;
      if (!text) return null;
      return {
        slide: ref.slide,
        page: ref.page,
        title: ref.title || undefined,
        docId,
        excerpt: text,
      };
    })
    .filter((entry): entry is { slide?: number; page?: number; title?: string; excerpt: string } => Boolean(entry));
}

function hasMarkdownTable(answer: string): boolean {
  const lines = (answer || "").split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (/^\s*\|.+\|\s*$/.test(lines[i]) && /^\s*\|\s*:?-{2,}/.test(lines[i + 1])) {
      return true;
    }
  }
  return false;
}

function buildFallbackTable(headers?: string[]): string {
  const cols = (headers && headers.length ? headers : ["Item", "Details"]).map(h => h.trim()).filter(Boolean);
  if (!cols.length) cols.push("Item", "Details");
  const headerRow = `| ${cols.join(" | ")} |`;
  const divider = `| ${cols.map(() => "---").join(" | ")} |`;
  const emptyRow = `| No data found in lecture | ${cols.length > 1 ? cols.slice(1).map(() => "—").join(" | ") : "—"} |`;
  return [headerRow, divider, emptyRow].join("\n");
}

function ensureTablePresence(answer: string, headers?: string[]): string {
  if (hasMarkdownTable(answer)) return answer.trim();
  const lines = (answer || "")
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => l.replace(/^[-*•]\s*/, ""));

  const rows: string[][] = [];
  const cols = (headers && headers.length ? headers : ["Item", "Details"]).map(h => h.trim()).filter(Boolean);
  if (!cols.length) cols.push("Item", "Details");
  lines.forEach(line => {
    const match = /^([^:–-]+)\s*[:–-]\s*(.+)$/.exec(line);
    if (match) {
      const key = match[1].trim();
      const val = match[2].trim();
      if (key && val) {
        rows.push([key, val]);
      }
    }
  });

  if (!rows.length) {
    return buildFallbackTable(headers);
  }
  const headerRow = `| ${cols.join(" | ")} |`;
  const divider = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows
    .slice(0, 30)
    .map(row => {
      const filled = [...row];
      while (filled.length < cols.length) filled.push("—");
      return `| ${filled.slice(0, cols.length).join(" | ")} |`;
    })
    .join("\n");
  const table = [headerRow, divider, body].join("\n");
  if (!hasMarkdownTable(table)) {
    return buildFallbackTable(headers);
  }
  return table;
}

type RetrievedAnswerOptions = {
  mode?: "default" | "library";
  broad?: boolean;
  tableSchema?: "conditionLabs" | "lectureTable";
  tableOnly?: boolean;
  allowExcerpts?: boolean;
  tableHeaders?: string[];
  listIntent?: boolean;
  requestId?: string;
  contextNotes?: string;
  maxOutputTokens?: number;
  initialAnswerText?: string;
};

function buildLibrarySystemPrompt(opts: RetrievedAnswerOptions = {}): string {
  const parts = [
    "You are a medical educator synthesizing lecture material into clinically meaningful explanations.",
    "Treat the provided excerpts as the full lecture; synthesize across all of them without adding outside facts.",
    "Prioritize clear reasoning and human-readable flow. Use explicit language such as 'The lecture states…' or 'Genetic markers are not specified in the lecture' when details are missing.",
    "If a requested detail is missing from the excerpts, state 'not stated in lecture' instead of speculating.",
    "Do not mention retrieval, chunks, or limitations; never expose chunk IDs (C#) or page markers.",
    "Do NOT copy raw slide text unless explicitly requested.",
    "Answer in complete sentences and finish cleanly—no dangling fragments.",
    "Default format: a 1–2 sentence summary followed by clinically grouped bullets (diagnosis/features/management as relevant) written in clinician voice.",
    "Use tables only when the user explicitly asks for one or when the data are inherently tabular (e.g., labs, thresholds, dosing). Otherwise prefer narrative + bullets.",
    "If age distinctions matter, group under Pediatric, Adult, and Not age-specific when helpful; skip headings that are irrelevant and state when the lecture does not specify an age group.",
    "Keep only information relevant to the question and stop after the answer.",
    "Treat any context notes as internal scaffolding—do not quote or paraphrase them; compose the final answer fresh from the lecture content.",
    "If you include structure, use only the following labels when they naturally fit: Response, Summary, Plan, Diagnosis, Labs, Treatment, Warnings, Next steps.",
    "If you use references, present them as 'Slide X – Title' when known, otherwise 'Page X'. Never show chunk ids.",
  ];
  if (!opts.allowExcerpts) {
    parts.push("Do not include excerpt blocks or a 'From the lecture excerpts' section unless the user explicitly asked.");
  }
  if (opts.broad) {
    parts.push(
      "For broad synthesis tasks, compile a comprehensive list across the lecture rather than a narrow sample, but keep the narrative flow.",
    );
  }
  if (opts.listIntent) {
    parts.push(
      "User intent hints at listing/categorizing entities. Use the default summary + clinically grouped bullets, and group Pediatric vs Adult vs Not age-specific only if the lecture distinguishes them.",
      "Tables are optional here—use them only if the content is inherently tabular or the user asked. Otherwise, stay with prose and bullets.",
      "Always note when genetics, age group, or other details are not specified in the lecture.",
      "Do not force headers that do not fit the content.",
    );
  }
  if (opts.tableOnly && Array.isArray(opts.tableHeaders) && opts.tableHeaders.length) {
    const columns = opts.tableHeaders.join(" | ");
    parts.push(
      `Output ONLY one Markdown table (pipe syntax, no code fences). Columns: ${columns}.`,
      "Do not include any extra text before or after the table. If a value is missing, write 'Not stated'.",
    );
  } else if (opts.tableSchema === "lectureTable") {
    parts.push(
      "Output ONLY one Markdown table (pipe syntax, no code fences). You may include at most a single, short introductory sentence before the table.",
      "After the table, output nothing else—no extra sections, slides, or bullets.",
      "Table columns: Condition/Disease | Defining labs | Key treatment | Notes (1 line max).",
      "Use lecture wording; if a lab or treatment is absent, write 'Not stated in lecture'. Do not invent numbers or slide labels.",
    );
  } else if (opts.tableSchema === "conditionLabs") {
    parts.push(
      "Output a single Markdown table (pipe syntax, no code fences) with columns: Condition / Etiology | Volume status | Serum Osm | Urine Osm | Urine Na | Key additional labs | Notes.",
      "Use qualitative descriptors from the lecture (e.g., high/low/inappropriately high); do not invent numeric ranges or reference intervals.",
      "If a value is not specified in the lecture, write 'not stated in lecture'. Keep the table tidy and avoid preambles.",
    );
  }
  parts.push(
    "Match the requested format exactly and keep any notes concise.",
    "When citing the lecture, use slide or page references with short titles, e.g., 'Slide 11 – Diagnosis of Hyperkalemia'.",
    "Do NOT use internal chunk ids like C1, C2, etc., in the final answer.",
  );
  return parts.join(" ");
}

function buildDefaultSystemPrompt(opts: RetrievedAnswerOptions = {}): string {
  if (opts.tableOnly) {
    const columns = Array.isArray(opts.tableHeaders) && opts.tableHeaders.length
      ? opts.tableHeaders
      : ["Condition / Disease", "Defining labs", "Key treatment", "Notes (1 line max)"];
    return [
      "You are OWEN. Return ONLY the requested table (plus at most two short sentences of intro).",
      "Do not add headings, extra sections, bullets, or slide text. Do not mention chunks or pages.",
      "Do NOT output internal chunk IDs (C#) or page markers.",
      "Answer in complete sentences and finish cleanly—no dangling fragments.",
      "If a value is not stated in the provided context, write 'Not stated in lecture'.",
      `Table columns: ${columns.join(" | ")}.`,
      "After the table, output nothing else.",
    ].join(" ");
  }
  return [
    "You are OWEN answering questions grounded in retrieved document chunks.",
    "Use ONLY the provided chunks; do not add outside facts.",
    "If the chunks lack the answer, say you don't know briefly.",
    "Answer the user's question directly. Do NOT output slide dumps, page markers, chunk ids, or unrelated headings.",
    "Do NOT output internal chunk IDs (C#) or page markers to the user.",
    "Do NOT copy raw slide text unless explicitly requested.",
    "Answer in complete sentences and end the response cleanly—no dangling words.",
    "If you include references, format them as 'Slide X – Title' when known, otherwise 'Page X'.",
    "Only include information relevant to the question. Stop after the answer; do not append extra sections.",
    "Organize answers with: Summary (1–2 sentences); Key points (3–6 bullets); Clinical thresholds/steps (bulleted when applicable); Pitfalls / practical notes (1–3 bullets).",
    "Do not add a 'Response' heading.",
    "Use tables only when the user explicitly asks for one or when the content is inherently tabular (labs, ranges, dosing). Otherwise keep the main structure as prose + bullets.",
    "If you include structure, use only these labels: Response, Summary, Plan, Diagnosis, Labs, Treatment, Warnings, Next steps.",
    opts.allowExcerpts
      ? "If quoting slides is requested, include brief verbatim snippets with citations."
      : "Do not include raw excerpt blocks or a 'From the lecture excerpts' section unless explicitly requested.",
  ].join(" ");
}

async function answerWithRetrievedChunks(
  env: Env,
  chunks: Array<{ index: number; text: string }>,
  question: string,
  opts: RetrievedAnswerOptions = {},
): Promise<GeneratedTextResult> {
  const isLibrary = opts.mode === "library";
  const system = isLibrary
    ? buildLibrarySystemPrompt(opts)
    : buildDefaultSystemPrompt(opts);

  const ordered = isLibrary ? [...chunks].sort((a, b) => a.index - b.index) : chunks;
  const cleanedChunks = ordered.map(chunk => ({ ...chunk, text: cleanRetrievedChunkText(chunk.text) }));
  const contextLabel = isLibrary ? "Section" : "Chunk";
  const contextHeader = isLibrary ? "Lecture excerpts" : "Context chunks";
  const contextBody = cleanedChunks.map(chunk => `[${contextLabel} ${chunk.index + 1}]\n${chunk.text}`).join("\n\n");
  const contextBlock = opts.allowExcerpts
    ? `${contextHeader}:\n${contextBody}`
    : `${contextHeader} (REFERENCE — do not quote verbatim unless asked):\n${contextBody}`;
  const continuationNotes = isLibrary
    ? opts.contextNotes || (await buildLibraryContextNotes(env, question, cleanedChunks, { requestId: opts.requestId }))
    : contextBlock;
  const continuationContext = isLibrary
    ? `${contextBlock}\n\n(Internal context notes — do not quote or mimic; keep clinician-style synthesis):\n${continuationNotes || "None"}`
    : contextBlock;

  const result = await runResponsesWithContinuation(env, {
    label: isLibrary ? `library-${opts.requestId || "ask"}` : "ask-retrieved",
    maxOutputTokens: opts.maxOutputTokens ?? ANSWER_MAX_OUTPUT_TOKENS,
    initialText: opts.initialAnswerText || "",
    buildPayload: ({ attempt, accumulatedText }) => {
      const isContinuation = attempt > 1 || Boolean(accumulatedText);
      const contextForAttempt = isContinuation ? continuationContext : contextBlock;
      const userParts: ResponsesInputContent[] = [
        { type: "input_text", text: contextForAttempt },
        { type: "input_text", text: `Question:\n${question}` },
      ];
      if (isContinuation && accumulatedText) {
        userParts.push({ type: "input_text", text: `Partial answer so far:\n${clipAnswerTail(accumulatedText)}` });
      }
      if (isContinuation) {
        userParts.push({
          type: "input_text",
          text: "Continue only if the previous answer was cut off mid-thought. If it already ended with a short tailoring follow-up, return no additional content. Do not repeat previous sentences or headings, restart tables, or add a continuation label.",
        });
      }

      return {
        model: resolveModelId(DEFAULT_TEXT_MODEL, env),
        input: [
          { role: "system" as const, content: [{ type: "input_text" as const, text: system }] },
          { role: "user" as const, content: userParts },
        ],
      };
    },
  });

  return {
    ...result,
    text: replaceChunkMarkers(result.text, cleanedChunks),
    fullText: replaceChunkMarkers(result.fullText, cleanedChunks),
  };
}

async function buildLibraryContextNotes(
  env: Env,
  question: string,
  chunks: Array<{ index: number; text: string }>,
  opts: { requestId?: string } = {},
): Promise<string> {
  const compactBody = chunks
    .map(chunk => `[Section ${chunk.index + 1}]\n${cleanRetrievedChunkText(chunk.text)}`)
    .join("\n\n")
    .slice(0, LIBRARY_NOTES_CONTEXT_CHARS);
  if (!compactBody) return "";

  const system = [
    "You are summarizing lecture excerpts into compact context notes for downstream Q&A.",
    "Return concise bullet points or short sentences focused on facts relevant to the question.",
    "Preserve terminology, numeric values, and structural cues (tables/headings) when present.",
    "Do not answer the user's question directly; produce reusable notes only.",
    "These notes are internal scaffolding. Keep them neutral, avoid heavy templating, and do not restate them verbatim in any final answer.",
  ].join(" ");

  const payload = {
    model: resolveModelId(DEFAULT_TEXT_MODEL, env),
    max_output_tokens: LIBRARY_NOTES_MAX_OUTPUT_TOKENS,
    input: [
      { role: "system" as const, content: [{ type: "input_text" as const, text: system }] },
      {
        role: "user" as const,
        content: [
          { type: "input_text" as const, text: `Lecture excerpts (trimmed):\n${compactBody}` },
          { type: "input_text" as const, text: `Question: ${question}` },
          {
            type: "input_text" as const,
            text: "Return only the condensed notes (bullet list or short paragraphs). Do not add prefaces.",
          },
        ],
      },
    ],
  };

  try {
    const notes = await callResponsesOnce(env, payload, `library-notes:${opts.requestId || "notes"}`);
    const text = (notes.text || "").trim();
    if (text) return text;
  } catch (err) {
    console.warn("[LIBRARY_NOTES] failed", {
      requestId: opts.requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return compactBody;
}

type LibraryContinuationState = {
  v: 1;
  docId: string;
  requestId: string;
  question: string;
  contextNotes: string;
  extractedKey?: string;
  options?: {
    allowExcerpts?: boolean;
    tableHeaders?: string[];
    tableOnly?: boolean;
    broad?: boolean;
    listIntent?: boolean;
  };
  answerTail: string;
  segments: number;
  maxOutputTokens: number;
  model: string;
};

function buildLibraryContinuationToken(state: LibraryContinuationState): string {
  const safeState: LibraryContinuationState = {
    ...state,
    contextNotes: (state.contextNotes || "").slice(0, LIBRARY_NOTES_CONTEXT_CHARS),
    answerTail: clipAnswerTail(state.answerTail || ""),
    segments: Math.max(0, state.segments || 0),
    maxOutputTokens: state.maxOutputTokens || ANSWER_MAX_OUTPUT_TOKENS,
    model: state.model || DEFAULT_TEXT_MODEL,
    v: 1 as const,
  };
  const payload = JSON.stringify(safeState);
  const bytes = enc.encode(payload);
  let binary = "";
  bytes.forEach(b => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
}

function parseLibraryContinuationToken(token: string): LibraryContinuationState | null {
  try {
    const binary = atob(token);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    const decoded = dec.decode(bytes);
    const parsed = JSON.parse(decoded);
    if (
      parsed &&
      parsed.v === 1 &&
      typeof parsed.docId === "string" &&
      typeof parsed.question === "string"
    ) {
      return {
        ...parsed,
        contextNotes: typeof parsed.contextNotes === "string" ? parsed.contextNotes : "",
      } as LibraryContinuationState;
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeLibraryCategoryLabel(value?: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function normalizeLibraryYear(value?: unknown): LibraryYearId | null {
  const normalized = normalizeLibraryCategoryLabel(value);
  if (!normalized) return null;
  return normalized.toUpperCase() as LibraryYearId;
}

function resolveLibraryYear(value?: string | null): LibraryYearId {
  return normalizeLibraryYear(value) || DEFAULT_LIBRARY_YEAR;
}

function formatLibraryCategoryLabel(categoryId?: string | null): string {
  const normalizedId = normalizeLibraryYear(categoryId);
  if (!normalizedId) return "";
  const fallback = DEFAULT_LIBRARY_CATEGORIES.find(entry => entry.id === normalizedId)?.label;
  if (fallback) return fallback;
  return normalizeLibraryCategoryLabel(categoryId) || normalizedId;
}

function normalizeLibraryExam(value?: unknown): LibraryExamId | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value === 1 || value === 2 || value === 3) return value as LibraryExamId;
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const match = trimmed.match(/\d+/);
    const parsed = match ? Number.parseInt(match[0], 10) : Number.parseInt(trimmed, 10);
    if (parsed === 1 || parsed === 2 || parsed === 3) return parsed as LibraryExamId;
  }
  return null;
}

function resolveLibraryExam(value?: unknown): LibraryExamId {
  return normalizeLibraryExam(value) || DEFAULT_LIBRARY_EXAM;
}

function normalizeCourseName(value?: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function normalizeCourseNameKey(value: string): string {
  return (value || "").trim().toLowerCase();
}

function buildCourseIdSlug(yearId: LibraryYearId, name: string) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return `${yearId.toLowerCase()}-${slug || "course"}`;
}

function buildDefaultLibraryCategories(): LibraryCategory[] {
  const now = new Date().toISOString();
  return DEFAULT_LIBRARY_CATEGORIES.map((entry, index) => ({
    id: entry.id,
    label: entry.label,
    sortOrder: entry.sortOrder ?? index + 1,
    createdAt: now,
    updatedAt: now,
  }));
}

function buildDefaultLibraryCourses(): LibraryCourse[] {
  const now = new Date().toISOString();
  return DEFAULT_LIBRARY_COURSES.map((entry, index) => ({
    id: buildCourseIdSlug(entry.yearId, entry.name),
    yearId: entry.yearId,
    categoryId: entry.yearId,
    categoryLabel: formatLibraryCategoryLabel(entry.yearId),
    name: entry.name,
    sortOrder: entry.sortOrder ?? index + 1,
    createdAt: now,
    updatedAt: now,
  }));
}

function coerceLibraryCategory(raw: unknown): LibraryCategory | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const label = normalizeLibraryCategoryLabel(
    source.label ?? source.categoryLabel ?? source.yearLabel ?? source.name,
  );
  const id = normalizeLibraryYear(source.id ?? source.categoryId ?? source.yearId ?? label);
  if (!id) return null;
  const sortOrderRaw = Number(source.sortOrder);
  const sortOrder = Number.isFinite(sortOrderRaw) ? sortOrderRaw : undefined;
  const createdAt = typeof source.createdAt === "string" ? source.createdAt : undefined;
  const updatedAt = typeof source.updatedAt === "string" ? source.updatedAt : undefined;
  return {
    id,
    label: label || formatLibraryCategoryLabel(id),
    sortOrder,
    createdAt,
    updatedAt,
  };
}

function coerceLibraryCourse(raw: unknown): LibraryCourse | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const id = typeof source.id === "string" ? source.id.trim() : "";
  const yearId = normalizeLibraryYear(source.yearId ?? source.categoryId);
  const name = normalizeCourseName(source.name);
  if (!id || !yearId || !name) return null;
  const categoryLabel = normalizeLibraryCategoryLabel(
    source.categoryLabel ?? source.yearLabel,
  );
  const sortOrderRaw = Number(source.sortOrder);
  const sortOrder = Number.isFinite(sortOrderRaw) ? sortOrderRaw : undefined;
  const createdAt = typeof source.createdAt === "string" ? source.createdAt : undefined;
  const updatedAt = typeof source.updatedAt === "string" ? source.updatedAt : undefined;
  return {
    id,
    yearId,
    categoryId: yearId,
    categoryLabel: categoryLabel || undefined,
    name,
    sortOrder,
    createdAt,
    updatedAt,
  };
}

function sortLibraryCategories(categories: LibraryCategory[]) {
  const defaultRank = new Map(DEFAULT_LIBRARY_CATEGORIES.map((entry, index) => [entry.id, index]));
  return categories.slice().sort((a, b) => {
    const aRank = defaultRank.get(a.id);
    const bRank = defaultRank.get(b.id);
    if (aRank !== undefined || bRank !== undefined) {
      return (aRank ?? Number.POSITIVE_INFINITY) - (bRank ?? Number.POSITIVE_INFINITY);
    }
    const orderDelta = (a.sortOrder ?? Number.POSITIVE_INFINITY) - (b.sortOrder ?? Number.POSITIVE_INFINITY);
    if (orderDelta !== 0) return orderDelta;
    return a.label.localeCompare(b.label);
  });
}

function mergeLibraryCategories(
  categories: LibraryCategory[],
  extraIds: Array<LibraryYearId | string | null | undefined> = [],
) {
  const byId = new Map<string, LibraryCategory>();
  const upsert = (category: LibraryCategory | null) => {
    if (!category) return;
    const existing = byId.get(category.id);
    if (!existing) {
      byId.set(category.id, category);
      return;
    }
    byId.set(category.id, {
      ...existing,
      ...category,
      label: category.label || existing.label,
      sortOrder: category.sortOrder ?? existing.sortOrder,
      createdAt: existing.createdAt || category.createdAt,
      updatedAt: category.updatedAt || existing.updatedAt,
    });
  };

  buildDefaultLibraryCategories().forEach(upsert);
  categories.forEach(upsert);
  extraIds.forEach((rawId) => {
    const id = normalizeLibraryYear(rawId);
    if (!id) return;
    upsert({
      id,
      label: formatLibraryCategoryLabel(rawId),
    });
  });

  return sortLibraryCategories(Array.from(byId.values()));
}

function libraryCategoriesEqual(a: LibraryCategory[], b: LibraryCategory[]) {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    if (!other) return false;
    return entry.id === other.id
      && entry.label === other.label
      && (entry.sortOrder ?? null) === (other.sortOrder ?? null)
      && (entry.createdAt ?? null) === (other.createdAt ?? null)
      && (entry.updatedAt ?? null) === (other.updatedAt ?? null);
  });
}

function sortLibraryCourses(courses: LibraryCourse[], categories: LibraryCategory[] = DEFAULT_LIBRARY_CATEGORIES) {
  const yearRank = new Map(sortLibraryCategories(categories).map((category, index) => [category.id, index]));
  return courses.slice().sort((a, b) => {
    const yearDelta = (yearRank.get(a.yearId) ?? 99) - (yearRank.get(b.yearId) ?? 99);
    if (yearDelta !== 0) return yearDelta;
    const orderDelta = (a.sortOrder ?? Number.POSITIVE_INFINITY) - (b.sortOrder ?? Number.POSITIVE_INFINITY);
    if (orderDelta !== 0) return orderDelta;
    return a.name.localeCompare(b.name);
  });
}

async function readLibraryCategories(bucket: R2Bucket): Promise<{ categories: LibraryCategory[]; found: boolean }> {
  try {
    const object = await bucket.get(LIBRARY_CATEGORIES_KEY);
    if (!object || !object.body) return { categories: [], found: false };
    const text = await object.text();
    const parsed = JSON.parse(text);
    const rawCategories: unknown[] = Array.isArray(parsed?.categories)
      ? parsed.categories
      : Array.isArray(parsed)
        ? parsed
        : [];
    const categories = rawCategories
      .map(coerceLibraryCategory)
      .filter((category): category is LibraryCategory => Boolean(category));
    return { categories, found: true };
  } catch {
    return { categories: [], found: false };
  }
}

async function writeLibraryCategories(bucket: R2Bucket, categories: LibraryCategory[]) {
  const payload = JSON.stringify({ categories: sortLibraryCategories(categories) });
  await bucket.put(LIBRARY_CATEGORIES_KEY, payload, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

async function loadLibraryCategories(
  bucket: R2Bucket,
  extraIds: Array<LibraryYearId | string | null | undefined> = [],
): Promise<LibraryCategory[]> {
  const { categories, found } = await readLibraryCategories(bucket);
  const merged = mergeLibraryCategories(categories, extraIds);
  if (!found || !libraryCategoriesEqual(sortLibraryCategories(categories), merged)) {
    await writeLibraryCategories(bucket, merged);
  }
  return merged;
}

async function ensureLibraryCategory(
  bucket: R2Bucket,
  categories: LibraryCategory[],
  categoryId: LibraryYearId,
  label?: string,
) {
  if (categories.some(entry => entry.id === categoryId)) {
    return sortLibraryCategories(categories);
  }
  const now = new Date().toISOString();
  const nextSortOrder = categories.reduce((max, entry) => Math.max(max, entry.sortOrder ?? 0), 0) + 1;
  const nextCategory: LibraryCategory = {
    id: categoryId,
    label: normalizeLibraryCategoryLabel(label) || formatLibraryCategoryLabel(categoryId),
    sortOrder: nextSortOrder,
    createdAt: now,
    updatedAt: now,
  };
  const nextCategories = sortLibraryCategories([...categories, nextCategory]);
  await writeLibraryCategories(bucket, nextCategories);
  return nextCategories;
}

function decorateLibraryCourse(course: LibraryCourse, categories: LibraryCategory[]) {
  const category = categories.find(entry => entry.id === course.yearId);
  const categoryLabel = category?.label || course.categoryLabel || formatLibraryCategoryLabel(course.yearId);
  return {
    ...course,
    categoryId: course.yearId,
    categoryLabel,
  };
}

async function readLibraryCourses(bucket: R2Bucket): Promise<{ courses: LibraryCourse[]; found: boolean }> {
  try {
    const object = await bucket.get(LIBRARY_COURSES_KEY);
    if (!object || !object.body) return { courses: [], found: false };
    const text = await object.text();
    const parsed = JSON.parse(text);
    const rawCourses: unknown[] = Array.isArray(parsed?.courses)
      ? parsed.courses
      : Array.isArray(parsed)
        ? parsed
        : [];
    const courses = rawCourses
      .map(coerceLibraryCourse)
      .filter((course): course is LibraryCourse => Boolean(course));
    return { courses, found: true };
  } catch {
    return { courses: [], found: false };
  }
}

async function writeLibraryCourses(
  bucket: R2Bucket,
  courses: LibraryCourse[],
  categories: LibraryCategory[] = DEFAULT_LIBRARY_CATEGORIES,
) {
  const payload = JSON.stringify({ courses: sortLibraryCourses(courses, categories) });
  await bucket.put(LIBRARY_COURSES_KEY, payload, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

async function loadLibraryCourses(bucket: R2Bucket): Promise<LibraryCourse[]> {
  const { courses, found } = await readLibraryCourses(bucket);
  if (found) {
    const categories = await loadLibraryCategories(bucket, courses.map(course => course.yearId));
    return sortLibraryCourses(courses, categories);
  }
  const defaults = buildDefaultLibraryCourses();
  const categories = await loadLibraryCategories(bucket, defaults.map(course => course.yearId));
  await writeLibraryCourses(bucket, defaults, categories);
  return defaults;
}

async function handleLibrarySearch(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() || "";
  const yearFilter = normalizeLibraryYear(url.searchParams.get("category") ?? url.searchParams.get("year"));
  const courseFilterRaw = url.searchParams.get("courseId")?.trim() || "";
  const examFilter = normalizeLibraryExam(
    url.searchParams.get("exam") ?? url.searchParams.get("examId") ?? url.searchParams.get("examNumber"),
  );
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 50) : LIBRARY_SEARCH_LIMIT;
  const { bucket } = getLibraryBucket(env);
  const indexRecords = await readLibraryIndex(bucket);
  let candidates = indexRecords;
  if (yearFilter) {
    candidates = candidates.filter(rec => resolveLibraryYear(rec.yearId ?? rec.categoryId) === yearFilter);
  }
  if (courseFilterRaw) {
    if (courseFilterRaw === "unassigned") {
      candidates = candidates.filter(rec => !rec.courseId);
    } else {
      candidates = candidates.filter(rec => rec.courseId === courseFilterRaw);
    }
  }
  if (examFilter) {
    candidates = candidates.filter(rec => resolveLibraryExam(rec.examId) === examFilter);
  }
  const ranked = q ? scoreLibraryRecords(q, candidates, limit * 2) : candidates.slice(0, limit);
  const selected = ranked.slice(0, limit);
  const categories = await loadLibraryCategories(bucket, selected.map(rec => rec.yearId ?? rec.categoryId));
  const categoryLabelById = new Map(categories.map(category => [category.id, category.label]));

  const results: Array<{
    docId: string;
    title: string;
    bucket: string;
    key: string;
    status: "ready" | "missing" | "needs_browser_ocr";
    txtKey?: string;
    sourceType?: "machine_txt";
    ingestionType?: "doc_upload";
    preview?: string;
    extractedKey: string;
    courseId?: string | null;
    yearId?: LibraryYearId;
    categoryId?: LibraryYearId;
    categoryLabel?: string;
    examId?: LibraryExamId;
  }> = [];
  for (const rec of selected) {
    const extractedKey = rec.extractedKey || buildExtractedPath(rec.docId);
    const isDocUpload = rec.ingestionType === "doc_upload" || isLibraryWordKey(rec.key || "");
    let status: "ready" | "missing" | "needs_browser_ocr" = rec.status || "missing";
    const preferredTxtKey = isDocUpload ? await resolvePreferredMachineTxtKey(bucket, rec.docId, resolveLectureTitle(rec)) : "";
    if (isDocUpload) {
      const txtHead = await resolveObjectHead(bucket, preferredTxtKey);
      status = txtHead.exists ? "ready" : status === "needs_browser_ocr" ? "needs_browser_ocr" : "missing";
    } else {
      try {
        const head = typeof bucket.head === "function"
          ? await bucket.head(extractedKey)
          : await bucket.get(extractedKey, { range: { offset: 0, length: 0 } as any });
        if (head) status = "ready";
      } catch {
        status = status === "needs_browser_ocr" ? "needs_browser_ocr" : "missing";
      }
    }
    const resolvedYearId = resolveLibraryYear(rec.yearId ?? rec.categoryId);
    results.push({
      docId: rec.docId,
      title: resolveLectureTitle(rec),
      bucket: rec.bucket,
      key: rec.key,
      txtKey: preferredTxtKey || undefined,
      sourceType: preferredTxtKey ? "machine_txt" : undefined,
      ingestionType: isDocUpload ? "doc_upload" : undefined,
      courseId: rec.courseId ?? null,
      yearId: resolvedYearId,
      categoryId: resolvedYearId,
      categoryLabel: categoryLabelById.get(resolvedYearId) || formatLibraryCategoryLabel(resolvedYearId),
      examId: resolveLibraryExam(rec.examId),
      status,
      preview: normalizePreview(rec.preview),
      extractedKey,
    });
  }

  return json({ results });
}

async function handleLibraryCategories(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const yearFilter = normalizeLibraryYear(url.searchParams.get("category") ?? url.searchParams.get("year"));
  const { bucket } = getLibraryBucket(env);
  const courses = await loadLibraryCourses(bucket);
  const indexRecords = await readLibraryIndex(bucket);
  const categories = await loadLibraryCategories(bucket, [
    ...courses.map(course => course.yearId),
    ...indexRecords.map(record => record.yearId),
  ]);
  const filtered = yearFilter ? categories.filter(category => category.id === yearFilter) : categories;
  return json({ categories: filtered });
}

async function handleLibraryCourses(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const yearFilter = normalizeLibraryYear(url.searchParams.get("category") ?? url.searchParams.get("year"));
  const { bucket } = getLibraryBucket(env);
  const courses = await loadLibraryCourses(bucket);
  const categories = await loadLibraryCategories(bucket, courses.map(course => course.yearId));
  const filtered = yearFilter ? courses.filter(course => course.yearId === yearFilter) : courses;
  return json({
    courses: filtered.map(course => decorateLibraryCourse(course, categories)),
    categories,
  });
}

async function handleLibraryCategoryCreate(req: Request, env: Env): Promise<Response> {
  const auth = await requireFaculty(req, env, "library_category_create");
  if (!auth.ok) return auth.response;
  const body = await req.json().catch(() => null);
  if (!body) return jsonNoStore({ error: "Send JSON { label }." }, 400);
  const label = normalizeLibraryCategoryLabel(
    body.label ?? body.categoryLabel ?? body.name ?? body.title ?? body.year,
  );
  const categoryId = normalizeLibraryYear(body.categoryId ?? body.id ?? label);
  if (!label) return jsonNoStore({ error: "Missing category name." }, 400);
  if (!categoryId) return jsonNoStore({ error: "Missing or invalid categoryId." }, 400);
  const { bucket } = getLibraryBucket(env);
  const categories = await loadLibraryCategories(bucket);
  if (categories.some(category => category.id === categoryId)) {
    return jsonNoStore({ error: "A category with that name already exists." }, 409);
  }
  const now = new Date().toISOString();
  const nextSortOrder = categories.reduce((max, category) => Math.max(max, category.sortOrder ?? 0), 0) + 1;
  const category: LibraryCategory = {
    id: categoryId,
    label,
    sortOrder: nextSortOrder,
    createdAt: now,
    updatedAt: now,
  };
  const nextCategories = sortLibraryCategories([...categories, category]);
  await writeLibraryCategories(bucket, nextCategories);
  return jsonNoStore({ category, categories: nextCategories });
}

async function handleLibraryCourseCreate(req: Request, env: Env): Promise<Response> {
  const auth = await requireFaculty(req, env, "library_course_create");
  if (!auth.ok) return auth.response;
  const body = await req.json().catch(() => null);
  if (!body) return jsonNoStore({ error: "Send JSON { name, yearId }." }, 400);
  const name = normalizeCourseName(body.name ?? body.title);
  const categoryLabel = normalizeLibraryCategoryLabel(
    body.categoryLabel ?? body.category ?? body.yearLabel ?? body.year,
  );
  const yearId = normalizeLibraryYear(body.categoryId ?? body.yearId ?? body.year ?? categoryLabel);
  if (!name) return jsonNoStore({ error: "Missing course name." }, 400);
  if (!yearId) return jsonNoStore({ error: "Missing or invalid yearId." }, 400);
  const { bucket } = getLibraryBucket(env);
  const courses = await loadLibraryCourses(bucket);
  let categories = await loadLibraryCategories(bucket, courses.map(course => course.yearId));
  categories = await ensureLibraryCategory(bucket, categories, yearId, categoryLabel);
  const nameKey = normalizeCourseNameKey(name);
  if (courses.some(course => course.yearId === yearId && normalizeCourseNameKey(course.name) === nameKey)) {
    return jsonNoStore({ error: "A course with that name already exists." }, 409);
  }
  const nextSortOrder = courses
    .filter(course => course.yearId === yearId)
    .reduce((max, course) => Math.max(max, course.sortOrder ?? 0), 0) + 1;
  const now = new Date().toISOString();
  const course: LibraryCourse = {
    id: crypto.randomUUID(),
    yearId,
    categoryId: yearId,
    categoryLabel: categories.find(category => category.id === yearId)?.label || formatLibraryCategoryLabel(yearId),
    name,
    sortOrder: nextSortOrder,
    createdAt: now,
    updatedAt: now,
  };
  courses.push(course);
  await writeLibraryCourses(bucket, courses, categories);
  return jsonNoStore({ course: decorateLibraryCourse(course, categories), categories });
}

async function handleLibraryCourseRename(req: Request, env: Env): Promise<Response> {
  const auth = await requireFaculty(req, env, "library_course_rename");
  if (!auth.ok) return auth.response;
  const body = await req.json().catch(() => null);
  if (!body) return jsonNoStore({ error: "Send JSON { courseId, name }." }, 400);
  const courseId = typeof body.courseId === "string" ? body.courseId.trim() : "";
  const name = normalizeCourseName(body.name ?? body.title);
  if (!courseId) return jsonNoStore({ error: "Missing courseId." }, 400);
  if (!name) return jsonNoStore({ error: "Missing course name." }, 400);
  const { bucket } = getLibraryBucket(env);
  const courses = await loadLibraryCourses(bucket);
  const categories = await loadLibraryCategories(bucket, courses.map(course => course.yearId));
  const course = courses.find(entry => entry.id === courseId);
  if (!course) return jsonNoStore({ error: "Course not found." }, 404);
  const nameKey = normalizeCourseNameKey(name);
  if (courses.some(entry => entry.id !== courseId && entry.yearId === course.yearId && normalizeCourseNameKey(entry.name) === nameKey)) {
    return jsonNoStore({ error: "A course with that name already exists." }, 409);
  }
  course.name = name;
  course.updatedAt = new Date().toISOString();
  await writeLibraryCourses(bucket, courses, categories);
  return jsonNoStore({ course: decorateLibraryCourse(course, categories), categories });
}

async function handleLibraryCourseDelete(req: Request, env: Env): Promise<Response> {
  const auth = await requireFaculty(req, env, "library_course_delete");
  if (!auth.ok) return auth.response;
  const body = await readRequestJsonBody(req);
  if (!body) return jsonNoStore({ error: "Send JSON { courseId, moveToCourseId?, moveToYearId? }." }, 400);
  const courseId = typeof body.courseId === "string" ? body.courseId.trim() : "";
  const moveToCourseId = typeof body.moveToCourseId === "string" ? body.moveToCourseId.trim() : "";
  const moveToYearId = normalizeLibraryYear(
    body.moveToCategoryId ?? body.categoryId ?? body.moveToYearId ?? body.yearId ?? body.year,
  );
  if (!courseId) return jsonNoStore({ error: "Missing courseId." }, 400);
  const { bucket } = getLibraryBucket(env);
  const courses = await loadLibraryCourses(bucket);
  let categories = await loadLibraryCategories(bucket, courses.map(entry => entry.yearId));
  const course = courses.find(entry => entry.id === courseId);
  if (!course) return jsonNoStore({ error: "Course not found." }, 404);
  if (moveToCourseId && moveToCourseId === courseId) {
    return jsonNoStore({ error: "Destination course must be different." }, 400);
  }

  const indexRecords = await readLibraryIndex(bucket);
  const affected = indexRecords.filter(rec => rec.courseId === courseId);
  let destination: { courseId?: string | null; yearId?: LibraryYearId } | null = null;

  if (affected.length) {
    if (moveToCourseId) {
      const target = courses.find(entry => entry.id === moveToCourseId);
      if (!target) return jsonNoStore({ error: "Destination course not found." }, 404);
      destination = { courseId: target.id, yearId: target.yearId };
    } else if (moveToYearId) {
      categories = await ensureLibraryCategory(bucket, categories, moveToYearId);
      destination = { courseId: null, yearId: moveToYearId };
    } else {
      return jsonNoStore({ error: "Course has lectures; choose a destination." }, 409);
    }
  }

  if (destination) {
    const movedDocIds = new Set(affected.map(rec => rec.docId));
    const destinationLabel = destination.yearId
      ? categories.find(entry => entry.id === destination.yearId)?.label || formatLibraryCategoryLabel(destination.yearId)
      : undefined;
    const nextRecords = indexRecords.map(rec => {
      if (!movedDocIds.has(rec.docId)) return rec;
      return {
        ...rec,
        courseId: destination.courseId ?? null,
        yearId: destination.yearId,
        categoryId: destination.yearId,
        categoryLabel: destinationLabel,
      };
    });
    await writeLibraryIndex(bucket, nextRecords);
    const movedRecords = nextRecords.filter(rec => movedDocIds.has(rec.docId));
    await Promise.all(
      movedRecords.map(rec =>
        bucket.put(buildIndexKeyForDoc(rec.docId), JSON.stringify(rec), {
          httpMetadata: { contentType: "application/json; charset=utf-8" },
        }),
      ),
    );
  }

  const remaining = courses.filter(entry => entry.id !== courseId);
  await writeLibraryCourses(bucket, remaining, categories);
  return jsonNoStore({
    ok: true,
    deleted: decorateLibraryCourse(course, categories),
    moved: affected.length,
    destination,
    categories,
  });
}

async function handleLibraryLectureUpdate(req: Request, env: Env): Promise<Response> {
  const auth = await requireFaculty(req, env, "library_lecture_update");
  if (!auth.ok) return auth.response;
  const body = await readRequestJsonBody(req);
  if (!body) return jsonNoStore({ error: "Send JSON { docId, courseId?, yearId?, examId?, title? }." }, 400);
  const docId =
    typeof body.docId === "string"
      ? body.docId.trim()
      : typeof body.lectureId === "string"
        ? body.lectureId.trim()
        : "";
  if (!docId) return jsonNoStore({ error: "Missing docId." }, 400);
  const hasCourseField = Object.prototype.hasOwnProperty.call(body, "courseId");
  const hasYearField =
    Object.prototype.hasOwnProperty.call(body, "categoryId")
    || Object.prototype.hasOwnProperty.call(body, "category")
    || Object.prototype.hasOwnProperty.call(body, "yearId")
    || Object.prototype.hasOwnProperty.call(body, "year");
  const hasExamField = Object.prototype.hasOwnProperty.call(body, "examId")
    || Object.prototype.hasOwnProperty.call(body, "exam")
    || Object.prototype.hasOwnProperty.call(body, "examNumber");
  const hasTitleField = Object.prototype.hasOwnProperty.call(body, "title")
    || Object.prototype.hasOwnProperty.call(body, "name")
    || Object.prototype.hasOwnProperty.call(body, "displayName");
  const courseIdInput = typeof body.courseId === "string" ? body.courseId.trim() : "";
  const categoryLabelInput = normalizeLibraryCategoryLabel(
    body.categoryLabel ?? body.category ?? body.yearLabel ?? body.year,
  );
  const yearInput = normalizeLibraryYear(body.categoryId ?? body.yearId ?? body.year ?? categoryLabelInput);
  const examInput = normalizeLibraryExam(body.examId ?? body.exam ?? body.examNumber);
  const titleRaw =
    typeof body.title === "string"
      ? body.title
      : typeof body.name === "string"
        ? body.name
        : typeof body.displayName === "string"
          ? body.displayName
          : "";
  const titleInput = cleanLectureDisplayLabel(titleRaw);
  const hasMoveIntent = hasCourseField || hasYearField || hasExamField;
  if (!hasMoveIntent && !hasTitleField) {
    return jsonNoStore({ error: "Provide at least one update field (title/courseId/yearId/examId)." }, 400);
  }
  if (hasTitleField && !titleInput) {
    return jsonNoStore({ error: "Lecture title cannot be empty." }, 400);
  }
  if (hasExamField && examInput === null) {
    return jsonNoStore({ error: "Missing or invalid examId." }, 400);
  }

  const { bucket } = getLibraryBucket(env);
  const indexRecords = await readLibraryIndex(bucket);
  const recordIndex = indexRecords.findIndex(rec => rec.docId === docId);
  if (recordIndex === -1) return jsonNoStore({ error: "Lecture not found." }, 404);

  const current = indexRecords[recordIndex]!;
  const currentCourseId = Object.prototype.hasOwnProperty.call(current, "courseId") ? current.courseId ?? null : null;
  const currentYearId = resolveLibraryYear(current.yearId);
  const currentExamId = normalizeLibraryExam(current.examId);
  let categories = await loadLibraryCategories(bucket, [current.yearId]);
  let nextCourseId: string | null = currentCourseId;
  let nextYearId: LibraryYearId = currentYearId;
  let nextExamId: LibraryExamId | null = currentExamId;

  if (hasMoveIntent) {
    if (hasCourseField) {
      if (courseIdInput) {
        const courses = await loadLibraryCourses(bucket);
        const target = courses.find(entry => entry.id === courseIdInput);
        if (!target) return jsonNoStore({ error: "Course not found." }, 404);
        nextCourseId = target.id;
        nextYearId = target.yearId;
      } else {
        if (!yearInput) return jsonNoStore({ error: "Missing or invalid yearId for unassigned move." }, 400);
        categories = await ensureLibraryCategory(bucket, categories, yearInput, categoryLabelInput);
        nextCourseId = null;
        nextYearId = yearInput;
      }
    } else if (hasYearField) {
      if (!yearInput) return jsonNoStore({ error: "Missing or invalid yearId for unassigned move." }, 400);
      categories = await ensureLibraryCategory(bucket, categories, yearInput, categoryLabelInput);
      nextCourseId = null;
      nextYearId = yearInput;
    }
    if (hasExamField && examInput !== null) {
      nextExamId = examInput;
    }
  }

  const updated: LibraryIndexRecord = {
    ...current,
    title: current.title,
    normalizedTokens: Array.isArray(current.normalizedTokens)
      ? current.normalizedTokens
      : tokensFromTitle(current.title || resolveLectureTitle(current)),
    categoryId: current.categoryId ?? current.yearId,
    categoryLabel: current.categoryLabel,
  };
  let changed = false;
  if (hasMoveIntent) {
    if (currentCourseId !== nextCourseId) {
      changed = true;
      updated.courseId = nextCourseId;
    }
    if (currentYearId !== nextYearId) {
      changed = true;
      updated.yearId = nextYearId;
    }
    const nextCategoryLabel = categories.find(entry => entry.id === nextYearId)?.label || formatLibraryCategoryLabel(nextYearId);
    if (updated.categoryId !== nextYearId || updated.categoryLabel !== nextCategoryLabel) {
      changed = true;
      updated.categoryId = nextYearId;
      updated.categoryLabel = nextCategoryLabel;
    }
    if (hasExamField || currentExamId !== null || nextExamId !== null) {
      if ((currentExamId ?? null) !== (nextExamId ?? null)) {
        changed = true;
      }
      updated.examId = nextExamId ?? null;
    }
  }
  if (hasTitleField && titleInput && current.title !== titleInput) {
    changed = true;
    updated.title = titleInput;
    updated.normalizedTokens = tokensFromTitle(titleInput);
  }
  if (!changed) {
    return jsonNoStore({ ok: true, record: current });
  }
  indexRecords[recordIndex] = updated;
  await writeLibraryIndex(bucket, indexRecords);
  await bucket.put(buildIndexKeyForDoc(updated.docId), JSON.stringify(updated), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  return jsonNoStore({ ok: true, record: updated });
}

type LibraryArtifactSummary = {
  exists: boolean;
  updatedAt?: string;
  size?: number;
};

type ObjectHeadInfo = {
  exists: boolean;
  uploaded?: Date;
  size?: number;
  contentType?: string;
};

function coerceDate(value?: string | Date | null): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) ? parsed : null;
}

function pickLatestIso(...values: Array<string | Date | null | undefined>) {
  const dates = values.map(coerceDate).filter((val): val is Date => Boolean(val));
  if (!dates.length) return undefined;
  const latest = new Date(Math.max(...dates.map(date => date.valueOf())));
  return latest.toISOString();
}

const STORED_QBANK_REQUIRED_COLUMNS = {
  stem: ["stem", "question"],
  choiceA: ["choice_a", "a", "option_a", "optiona", "optionA", "option1"],
  choiceB: ["choice_b", "b", "option_b", "optionb", "optionB", "option2"],
  choiceC: ["choice_c", "c", "option_c", "optionc", "optionC", "option3"],
  choiceD: ["choice_d", "d", "option_d", "optiond", "optionD", "option4"],
  answer: ["answer", "correct_answer", "correct_option", "correctoption", "correctOption", "correct"],
} as const;

const STORED_QBANK_OPTIONAL_COLUMNS = {
  choiceE: ["choice_e", "e", "option_e", "optione", "optionE", "option5"],
  rationale: ["rationale", "explanation"],
  rationaleA: ["rationale_a", "rationalea", "rationaleA"],
  rationaleB: ["rationale_b", "rationaleb", "rationaleB"],
  rationaleC: ["rationale_c", "rationalec", "rationaleC"],
  rationaleD: ["rationale_d", "rationaled", "rationaleD"],
  rationaleE: ["rationale_e", "rationalee", "rationaleE"],
  tags: ["tags", "tag"],
  difficulty: ["difficulty"],
  references: ["references", "reference", "source"],
} as const;

const STORED_QBANK_REQUIRED_CHOICE_IDS = ["A", "B", "C", "D"] as const;
const STORED_QBANK_ALL_CHOICE_IDS = ["A", "B", "C", "D", "E"] as const;
type StoredQbankChoiceId = (typeof STORED_QBANK_ALL_CHOICE_IDS)[number];

const STORED_QBANK_CHOICE_COLUMNS: Record<StoredQbankChoiceId, readonly string[]> = {
  A: STORED_QBANK_REQUIRED_COLUMNS.choiceA,
  B: STORED_QBANK_REQUIRED_COLUMNS.choiceB,
  C: STORED_QBANK_REQUIRED_COLUMNS.choiceC,
  D: STORED_QBANK_REQUIRED_COLUMNS.choiceD,
  E: STORED_QBANK_OPTIONAL_COLUMNS.choiceE,
};

const STORED_QBANK_CHOICE_LABELS: Record<StoredQbankChoiceId, string> = {
  A: "choice_a/a",
  B: "choice_b/b",
  C: "choice_c/c",
  D: "choice_d/d",
  E: "choice_e/e",
};

const STORED_QBANK_RATIONALE_COLUMNS: Record<StoredQbankChoiceId, readonly string[]> = {
  A: STORED_QBANK_OPTIONAL_COLUMNS.rationaleA,
  B: STORED_QBANK_OPTIONAL_COLUMNS.rationaleB,
  C: STORED_QBANK_OPTIONAL_COLUMNS.rationaleC,
  D: STORED_QBANK_OPTIONAL_COLUMNS.rationaleD,
  E: STORED_QBANK_OPTIONAL_COLUMNS.rationaleE,
};

const STORED_QBANK_DEFAULT_COLUMNS = [
  "stem",
  "choice_a",
  "choice_b",
  "choice_c",
  "choice_d",
  "choice_e",
  "answer",
  "rationale",
  "tags",
  "difficulty",
  "references",
] as const;

function normalizeStoredQbankHeaderCell(value: string) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeStoredQbankAliases(aliases: readonly string[]) {
  return aliases
    .map(alias => normalizeStoredQbankHeaderCell(alias))
    .filter(Boolean);
}

function parseStoredQbankTsvRows(input: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === "\"") {
        if (input[i + 1] === "\"") {
          cell += "\"";
          i += 1;
        } else {
          inQuotes = false;
        }
        continue;
      }
      cell += ch;
      continue;
    }
    if (ch === "\"") {
      inQuotes = true;
      continue;
    }
    if (ch === "\t") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += ch;
  }
  if (inQuotes) {
    throw new Error("Stored qbank TSV has an unmatched quote.");
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function isBlankStoredQbankRow(row: string[]) {
  return row.every(cell => !String(cell || "").trim());
}

function buildStoredQbankColumnIndex(firstRow: string[]) {
  const normalized = firstRow.map(cell => normalizeStoredQbankHeaderCell(cell));
  const present = new Set(normalized.filter(Boolean));
  const requiredMatches = Object.values(STORED_QBANK_REQUIRED_COLUMNS).reduce((count, aliases) => {
    return count + (normalizeStoredQbankAliases(aliases).some(alias => present.has(alias)) ? 1 : 0);
  }, 0);
  const hasHeader = requiredMatches >= Object.keys(STORED_QBANK_REQUIRED_COLUMNS).length;
  const index = new Map<string, number>();
  const source = hasHeader ? normalized : [...STORED_QBANK_DEFAULT_COLUMNS];
  source.forEach((name, idx) => {
    if (!name || index.has(name)) return;
    index.set(name, idx);
  });
  return { hasHeader, index };
}

function readStoredQbankCell(row: string[], index: Map<string, number>, aliases: readonly string[]) {
  for (const alias of normalizeStoredQbankAliases(aliases)) {
    const column = index.get(alias);
    if (!Number.isFinite(column)) continue;
    const value = row[column as number];
    return typeof value === "string"
      ? value.replace(/^\uFEFF/, "").trim()
      : String(value ?? "").replace(/^\uFEFF/, "").trim();
  }
  return "";
}

function splitStoredQbankTags(raw: string) {
  const items = raw
    .split(/[|,]/g)
    .map(item => item.trim())
    .filter(Boolean);
  return items.length ? Array.from(new Set(items)) : ["stored-qbank"];
}

function splitStoredQbankReferences(raw: string) {
  return raw
    .split(/[|;]/g)
    .map(item => item.trim())
    .filter(Boolean);
}

function normalizeStoredQbankDifficulty(raw: string) {
  const normalized = String(raw || "").trim().toLowerCase();
  if (!normalized) return "medium" as const;
  if (normalized === "easy" || normalized === "medium" || normalized === "hard") return normalized;
  throw new Error(`invalid difficulty "${raw}"`);
}

function buildStoredQbankChoices(row: string[], index: Map<string, number>) {
  const missing: string[] = [];
  const choices: QuizChoice[] = [];

  STORED_QBANK_REQUIRED_CHOICE_IDS.forEach(choiceId => {
    const text = readStoredQbankCell(row, index, STORED_QBANK_CHOICE_COLUMNS[choiceId]);
    if (!text) {
      missing.push(STORED_QBANK_CHOICE_LABELS[choiceId]);
      return;
    }
    choices.push({ id: choiceId, text });
  });

  const optionalChoiceE = readStoredQbankCell(row, index, STORED_QBANK_CHOICE_COLUMNS.E);
  if (optionalChoiceE) {
    choices.push({ id: "E", text: optionalChoiceE });
  }

  return { choices, missing };
}

function normalizeStoredQbankAnswer(raw: string, choices: QuizChoice[]) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    throw new Error("missing answer");
  }
  const availableChoiceIdList = STORED_QBANK_ALL_CHOICE_IDS.filter(choiceId => {
    return choices.some(choice => choice.id === choiceId);
  });
  const availableChoiceIds = new Set(availableChoiceIdList);
  const availableChoicePattern = availableChoiceIdList.length
    ? new RegExp(`^([${availableChoiceIdList.join("")}])(?:[\\).:\\-\\s]*)?$`, "i")
    : null;
  const anyChoicePattern = new RegExp(`^([${STORED_QBANK_ALL_CHOICE_IDS.join("")}])(?:[\\).:\\-\\s]*)?$`, "i");
  const choiceIdMatch = availableChoicePattern ? trimmed.match(availableChoicePattern) : null;
  if (choiceIdMatch) {
    const matchedId = choiceIdMatch[1].toUpperCase();
    if (availableChoiceIds.has(matchedId)) {
      return matchedId;
    }
    throw new Error(`answer "${matchedId}" does not match an available choice`);
  }
  const unavailableChoiceMatch = trimmed.match(anyChoicePattern);
  if (unavailableChoiceMatch) {
    throw new Error(`answer "${unavailableChoiceMatch[1].toUpperCase()}" does not match an available choice`);
  }
  const normalizedText = trimmed.toLowerCase();
  const matchedChoice = choices.find(choice => choice.text.trim().toLowerCase() === normalizedText);
  if (matchedChoice) return matchedChoice.id;
  throw new Error(`answer "${trimmed}" does not match a choice label or choice text`);
}

function resolveStoredQbankRationale(row: string[], index: Map<string, number>, choices: QuizChoice[], answer: string) {
  const explicitRationale = readStoredQbankCell(row, index, STORED_QBANK_OPTIONAL_COLUMNS.rationale);
  if (explicitRationale) return explicitRationale;

  const rationaleByChoice = STORED_QBANK_ALL_CHOICE_IDS.reduce((acc, choiceId) => {
    acc[choiceId] = readStoredQbankCell(row, index, STORED_QBANK_RATIONALE_COLUMNS[choiceId]);
    return acc;
  }, {} as Record<StoredQbankChoiceId, string>);

  const answerRationale = answer in rationaleByChoice
    ? rationaleByChoice[answer as StoredQbankChoiceId]
    : "";
  if (answerRationale) return answerRationale;

  const combined = choices
    .map(choice => [choice.id, rationaleByChoice[choice.id as StoredQbankChoiceId]] as const)
    .filter(([, text]) => Boolean(text))
    .map(([choiceId, text]) => `${choiceId}: ${text}`)
    .join("\n");
  return combined || "No explanation provided in stored qbank.";
}

function parseStoredQbankTsv(rawTsv: string, opts: { docId: string; lectureTitle: string }): StoredQbankDocument {
  const rows = parseStoredQbankTsvRows(rawTsv);
  const firstRow = rows.find(row => !isBlankStoredQbankRow(row));
  if (!firstRow) {
    throw new Error("Stored qbank TSV is empty.");
  }
  const { hasHeader, index } = buildStoredQbankColumnIndex(firstRow);
  const dataRows = hasHeader ? rows.slice(rows.indexOf(firstRow) + 1) : rows;
  const questions: QuizQuestion[] = [];
  const errors: string[] = [];

  dataRows.forEach((row, rowIndex) => {
    const displayRow = hasHeader ? rowIndex + 2 : rowIndex + 1;
    if (isBlankStoredQbankRow(row)) return;
    try {
      const stem = readStoredQbankCell(row, index, STORED_QBANK_REQUIRED_COLUMNS.stem);
      const answerRaw = readStoredQbankCell(row, index, STORED_QBANK_REQUIRED_COLUMNS.answer);
      const { choices, missing: missingChoiceColumns } = buildStoredQbankChoices(row, index);
      const missing: string[] = [];
      if (!stem) missing.push("stem/question");
      missing.push(...missingChoiceColumns);
      if (!answerRaw) missing.push("answer/correct_answer");
      if (missing.length) {
        throw new Error(`missing required column(s): ${missing.join(", ")}`);
      }
      const answer = normalizeStoredQbankAnswer(answerRaw, choices);
      const tagsRaw = readStoredQbankCell(row, index, STORED_QBANK_OPTIONAL_COLUMNS.tags);
      const difficultyRaw = readStoredQbankCell(row, index, STORED_QBANK_OPTIONAL_COLUMNS.difficulty);
      const referencesRaw = readStoredQbankCell(row, index, STORED_QBANK_OPTIONAL_COLUMNS.references);
      questions.push({
        id: `stored-qbank-${opts.docId}-${questions.length + 1}`,
        stem,
        choices,
        answer,
        rationale: resolveStoredQbankRationale(row, index, choices, answer),
        tags: splitStoredQbankTags(tagsRaw),
        difficulty: normalizeStoredQbankDifficulty(difficultyRaw),
        references: splitStoredQbankReferences(referencesRaw),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid row";
      errors.push(`Row ${displayRow}: ${message}`);
    }
  });

  if (errors.length) {
    throw new Error(errors.length === 1
      ? errors[0]
      : `Stored qbank has malformed rows. ${errors.slice(0, 5).join(" | ")}`);
  }
  if (questions.length < QUIZ_BATCH_SIZE) {
    throw new Error(`Stored qbank must contain at least ${QUIZ_BATCH_SIZE} valid questions.`);
  }
  return {
    version: 1,
    docId: opts.docId,
    lectureTitle: opts.lectureTitle || opts.docId,
    questionCount: questions.length,
    uploadedAt: new Date().toISOString(),
    questions,
  };
}

async function loadStoredQbankDocument(bucket: R2Bucket, docId: string): Promise<StoredQbankDocument | null> {
  return loadStoredQbankDocumentFromKey(bucket, buildStoredQbankQuestionsPath(docId));
}

async function loadStoredQbankDocumentFromKey(bucket: R2Bucket, key: string): Promise<StoredQbankDocument | null> {
  const object = await bucket.get(key);
  if (!object || !object.body) return null;
  try {
    const parsed = JSON.parse(await object.text());
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.questions)) return null;
    return parsed as StoredQbankDocument;
  } catch {
    return null;
  }
}

function normalizeStoredQbankChoiceId(value: unknown) {
  return String(value || "").trim().toUpperCase();
}

function normalizeQuizSaveTags(raw: unknown) {
  const tags = Array.isArray(raw)
    ? raw
      .map(tag => (typeof tag === "string" ? tag.trim() : ""))
      .filter(Boolean)
    : typeof raw === "string"
      ? splitStoredQbankTags(raw)
      : [];
  return tags.length ? Array.from(new Set(tags)) : ["saved-from-quiz"];
}

function normalizeQuizSaveReferences(raw: unknown) {
  if (Array.isArray(raw)) {
    return raw
      .map(ref => (typeof ref === "string" ? ref.trim() : ""))
      .filter(Boolean);
  }
  if (typeof raw === "string") {
    return splitStoredQbankReferences(raw);
  }
  return [];
}

function normalizeQuizSaveChoices(raw: unknown, questionIndex: number) {
  if (!Array.isArray(raw) || !raw.length) {
    throw new Error(`questions[${questionIndex}].choices must be a non-empty array.`);
  }
  const validChoiceIds = new Set<string>(STORED_QBANK_ALL_CHOICE_IDS);
  const choices: QuizChoice[] = [];
  const seenIds = new Set<string>();
  raw.forEach((choice, choiceIndex) => {
    if (!isPlainObject(choice)) {
      throw new Error(`questions[${questionIndex}].choices[${choiceIndex}] is not an object.`);
    }
    const choiceId = normalizeStoredQbankChoiceId(choice.id);
    if (!choiceId || !validChoiceIds.has(choiceId)) {
      throw new Error(`questions[${questionIndex}].choices[${choiceIndex}].id must be A-E.`);
    }
    if (seenIds.has(choiceId)) {
      throw new Error(`questions[${questionIndex}].choices has duplicate id ${choiceId}.`);
    }
    const text = typeof choice.text === "string" ? choice.text.trim() : "";
    if (!text) {
      throw new Error(`questions[${questionIndex}].choices[${choiceIndex}].text is required.`);
    }
    seenIds.add(choiceId);
    choices.push({ id: choiceId, text });
  });
  if (choices.length < 4 || choices.length > 5) {
    throw new Error(`questions[${questionIndex}].choices must have 4 or 5 items.`);
  }
  return choices;
}

function normalizeQuizSaveQuestion(raw: unknown, questionIndex: number, docId: string): QuizQuestion {
  if (!isPlainObject(raw)) {
    throw new Error(`questions[${questionIndex}] is not an object.`);
  }
  const stem = typeof raw.stem === "string" ? raw.stem.trim() : "";
  if (!stem) {
    throw new Error(`questions[${questionIndex}].stem is required.`);
  }
  const choices = normalizeQuizSaveChoices(raw.choices, questionIndex);
  const answerRaw = typeof raw.answer === "string"
    ? raw.answer.trim()
    : typeof raw.correctChoiceId === "string"
      ? raw.correctChoiceId.trim()
      : "";
  if (!answerRaw) {
    throw new Error(`questions[${questionIndex}].answer is required.`);
  }
  const rationale = typeof raw.explanation === "string"
    ? raw.explanation.trim()
    : typeof raw.rationale === "string"
      ? raw.rationale.trim()
      : "";
  if (!rationale) {
    throw new Error(`questions[${questionIndex}].explanation is required.`);
  }
  return {
    id: `stored-qbank-${docId}-incoming-${questionIndex + 1}`,
    stem,
    choices,
    answer: normalizeStoredQbankAnswer(answerRaw, choices),
    rationale,
    tags: normalizeQuizSaveTags(raw.tags),
    difficulty: normalizeStoredQbankDifficulty(typeof raw.difficulty === "string" ? raw.difficulty : ""),
    references: normalizeQuizSaveReferences(raw.references),
  };
}

function mergeStoredQbankQuestions(
  docId: string,
  existingQuestions: QuizQuestion[],
  incomingQuestions: QuizQuestion[],
) {
  const mergedQuestions = Array.isArray(existingQuestions) ? existingQuestions.map(question => ({ ...question })) : [];
  const seenStems = new Set(
    mergedQuestions
      .map(question => String(question?.stem || "").trim())
      .filter(Boolean),
  );
  let addedCount = 0;
  let duplicateCount = 0;

  incomingQuestions.forEach(question => {
    const stem = String(question?.stem || "").trim();
    if (!stem || seenStems.has(stem)) {
      duplicateCount += 1;
      return;
    }
    seenStems.add(stem);
    mergedQuestions.push({
      ...question,
      id: `stored-qbank-${docId}-${mergedQuestions.length + 1}`,
    });
    addedCount += 1;
  });

  return { mergedQuestions, addedCount, duplicateCount };
}

function buildStoredQbankQuizResponse(
  stored: StoredQbankDocument,
  opts: { docId: string; lectureTitle: string; count: number; cursor: number },
) {
  const totalQuestions = Array.isArray(stored.questions) ? stored.questions.length : 0;
  const safeCount = Number.isFinite(opts.count) && opts.count > 0 ? Math.floor(opts.count) : QUIZ_BATCH_SIZE;
  if (!totalQuestions) {
    throw new Error("Stored qbank has no questions.");
  }
  const start = totalQuestions ? ((opts.cursor % totalQuestions) + totalQuestions) % totalQuestions : 0;
  const selected: QuizQuestion[] = [];
  for (let i = 0; i < safeCount; i += 1) {
    const question = stored.questions[(start + i) % totalQuestions];
    selected.push({
      ...question,
      id: `${question.id}-${crypto.randomUUID().slice(0, 8)}`,
    });
  }
  const wrapped = start + safeCount > totalQuestions;
  const exhausted = wrapped || safeCount >= totalQuestions;
  const nextCursor = totalQuestions ? (start + safeCount) % totalQuestions : 0;
  return {
    extractedKey: buildStoredQbankQuestionsPath(opts.docId),
    batch: {
      lectureId: opts.docId,
      lectureTitle: opts.lectureTitle || stored.lectureTitle || opts.docId,
      setSize: safeCount,
      questions: selected,
    },
    continuationToken: buildQuizContinuationToken({
      v: 1,
      docId: opts.docId,
      cursor: nextCursor,
      usedChunkWindows: [],
      usedQuestionFingerprints: [],
      count: safeCount,
    }),
    coverage: {
      cursor: start,
      windowSize: Math.min(safeCount, totalQuestions),
      totalChunks: totalQuestions,
      exhausted,
    } satisfies QuizCoverage,
  };
}

async function resolveObjectHead(bucket: R2Bucket, key: string): Promise<ObjectHeadInfo> {
  if (!key) return { exists: false };
  try {
    const head = typeof bucket.head === "function"
      ? await bucket.head(key)
      : await bucket.get(key, { range: { offset: 0, length: 0 } as any });
    if (!head) return { exists: false };
    const uploaded = (head as any).uploaded instanceof Date ? (head as any).uploaded : undefined;
    return {
      exists: true,
      uploaded,
      size: (head as any).size,
      contentType: (head as any).httpMetadata?.contentType,
    };
  } catch {
    return { exists: false };
  }
}

function summarizeArtifact(head: ObjectHeadInfo | null): LibraryArtifactSummary {
  if (!head || !head.exists) return { exists: false };
  return {
    exists: true,
    updatedAt: head.uploaded ? head.uploaded.toISOString() : undefined,
    size: head.size,
  };
}

function resolveLectureTitle(rec: LibraryIndexRecord) {
  const raw = (rec.title || "").trim();
  if (raw) return raw;
  if (rec.key) return titleFromKey(rec.key);
  return rec.docId;
}

type MachineTxtListItem = {
  docId: string;
  folderId: string;
  txtKey: string;
  displayName: string;
  updatedAt?: string;
  sourceType: "machine_txt";
  status: "ready";
  bucket: string;
  key: string;
  title: string;
  courseId?: string | null;
  yearId?: LibraryYearId;
  categoryId?: LibraryYearId;
  categoryLabel?: string;
  examId?: LibraryExamId;
};

async function handleLibraryQbankUpload(req: Request, env: Env): Promise<Response> {
  const auth = await requireFaculty(req, env, "library_qbank_upload");
  if (!auth.ok) return auth.response;
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return jsonNoStore({ error: "Send multipart/form-data with fields: docId, file." }, 400);
  }

  const form = await req.formData();
  const docId =
    typeof form.get("docId") === "string"
      ? String(form.get("docId")).trim()
      : typeof form.get("lectureId") === "string"
        ? String(form.get("lectureId")).trim()
        : "";
  if (!docId) {
    return jsonNoStore({ error: "Missing docId." }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return jsonNoStore({ error: "Missing TSV file." }, 400);
  }
  if (!file.name || !/\.tsv$/i.test(file.name.trim())) {
    return jsonNoStore({ error: "Stored qbank upload must be a .tsv file." }, 400);
  }

  const { bucket } = getLibraryBucket(env);
  const indexRecords = await readLibraryIndex(bucket);
  const record = indexRecords.find(entry => entry.docId === docId);
  if (!record) {
    return jsonNoStore({ error: "Lecture not found." }, 404);
  }

  const rawTsv = await file.text();
  if (!rawTsv.trim()) {
    return jsonNoStore({ error: "Stored qbank TSV is empty." }, 400);
  }

  let parsed: StoredQbankDocument;
  try {
    parsed = parseStoredQbankTsv(rawTsv, {
      docId,
      lectureTitle: resolveLectureTitle(record),
    });
  } catch (error) {
    return jsonNoStore({ error: error instanceof Error ? error.message : "Stored qbank upload failed." }, 400);
  }

  const sourceKey = buildStoredQbankSourcePath(docId);
  const questionsKey = buildStoredQbankQuestionsPath(docId);
  await bucket.put(sourceKey, rawTsv, {
    httpMetadata: { contentType: "text/tab-separated-values; charset=utf-8" },
  });
  await bucket.put(questionsKey, JSON.stringify(parsed), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  await upsertLibraryIndexRecord(env, {
    ...record,
    hasStoredQbank: true,
    storedQbankCount: parsed.questionCount,
    storedQbankUploadedAt: parsed.uploadedAt,
    storedQbankKey: questionsKey,
  });

  return jsonNoStore({
    ok: true,
    docId,
    questionCount: parsed.questionCount,
    hasStoredQbank: true,
  });
}

async function handleLibraryQbankSaveFromQuiz(req: Request, env: Env): Promise<Response> {
  const auth = await requireFaculty(req, env, "library_qbank_upload");
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    console.warn("[OWEN_QBANK_SAVE_FAIL]", {
      lectureId: "",
      questionCount: 0,
      status: 400,
      error: "bad_request_invalid_json",
    });
    return jsonNoStore({
      ok: false,
      error: "bad_request_invalid_json",
      message: "Invalid JSON request body.",
    }, 400);
  }

  if (!isPlainObject(body)) {
    console.warn("[OWEN_QBANK_SAVE_FAIL]", {
      lectureId: "",
      questionCount: 0,
      status: 400,
      error: "bad_request_invalid_json",
    });
    return jsonNoStore({
      ok: false,
      error: "bad_request_invalid_json",
      message: "Invalid JSON request body.",
    }, 400);
  }

  const docId =
    typeof body.lectureId === "string"
      ? body.lectureId.trim()
      : typeof body.docId === "string"
        ? body.docId.trim()
        : "";
  const rawQuestions = Array.isArray(body.questions) ? body.questions : [];
  const fail = (status: number, error: string, message: string) => {
    console.warn("[OWEN_QBANK_SAVE_FAIL]", {
      lectureId: docId,
      questionCount: rawQuestions.length,
      status,
      error,
    });
    return jsonNoStore({ ok: false, error, message }, status);
  };

  if (!docId) {
    return fail(400, "bad_request_missing_lectureId", "Missing lectureId.");
  }
  if (!rawQuestions.length) {
    return fail(400, "bad_request_missing_questions", "Questions array must be non-empty.");
  }

  console.info("[OWEN_QBANK_SAVE_START]", {
    lectureId: docId,
    questionCount: rawQuestions.length,
  });

  let incomingQuestions: QuizQuestion[];
  try {
    incomingQuestions = rawQuestions.map((question, index) => normalizeQuizSaveQuestion(question, index, docId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Questions payload is invalid.";
    return fail(400, "bad_request_invalid_questions", message);
  }

  try {
    const { bucket } = getLibraryBucket(env);
    const indexRecords = await readLibraryIndex(bucket);
    const record = indexRecords.find(entry => entry.docId === docId);
    if (!record) {
      return fail(404, "lecture_not_found", "Lecture not found.");
    }

    const questionsKey = buildStoredQbankQuestionsPath(docId);
    const existingHead = await resolveObjectHead(bucket, questionsKey);
    const existingStored = await loadStoredQbankDocumentFromKey(bucket, questionsKey);
    if (existingHead.exists && !existingStored) {
      return fail(500, "stored_qbank_unreadable", "Existing stored qbank is unreadable.");
    }

    const merged = mergeStoredQbankQuestions(docId, existingStored?.questions || [], incomingQuestions);
    const uploadedAt = existingStored && merged.addedCount === 0
      ? existingStored.uploadedAt
      : new Date().toISOString();
    const nextStored: StoredQbankDocument = {
      version: 1,
      docId,
      lectureTitle: existingStored?.lectureTitle || resolveLectureTitle(record),
      questionCount: merged.mergedQuestions.length,
      uploadedAt,
      questions: merged.mergedQuestions,
    };

    const shouldPersistStoredDocument = !existingStored || merged.addedCount > 0;
    const shouldUpdateIndex =
      shouldPersistStoredDocument
      || !record.hasStoredQbank
      || record.storedQbankCount !== nextStored.questionCount
      || record.storedQbankKey !== questionsKey;

    if (shouldPersistStoredDocument) {
      await bucket.put(questionsKey, JSON.stringify(nextStored), {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });
    }
    if (shouldUpdateIndex) {
      await upsertLibraryIndexRecord(env, {
        ...record,
        hasStoredQbank: true,
        storedQbankCount: nextStored.questionCount,
        storedQbankUploadedAt: nextStored.uploadedAt,
        storedQbankKey: questionsKey,
      });
    }

    console.info("[OWEN_QBANK_SAVE_SUCCESS]", {
      lectureId: docId,
      incomingQuestionCount: rawQuestions.length,
      addedCount: merged.addedCount,
      duplicateCount: merged.duplicateCount,
      totalCount: nextStored.questionCount,
    });
    return jsonNoStore({
      ok: true,
      lectureId: docId,
      addedCount: merged.addedCount,
      duplicateCount: merged.duplicateCount,
      totalCount: nextStored.questionCount,
      hasStoredQbank: true,
    });
  } catch (error) {
    console.warn("[OWEN_QBANK_SAVE_FAIL]", {
      lectureId: docId,
      questionCount: rawQuestions.length,
      status: 500,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonNoStore({
      ok: false,
      error: "stored_qbank_save_failed",
      message: "Failed to save quiz questions to the stored qbank.",
    }, 500);
  }
}

function isLectureTxtUploadFile(file: File) {
  const name = (file?.name || "").trim().toLowerCase();
  const type = (file?.type || "").trim().toLowerCase();
  if (!name.endsWith(".txt")) return false;
  if (!type) return true;
  return type === "text/plain" || type.startsWith("text/plain") || type === "application/octet-stream";
}

function isLectureTextUploadFile(file: File) {
  if (!file) return false;
  if (isLectureTxtUploadFile(file)) return true;
  return isSupportedLectureWordUpload(file.name || "", file.type || "");
}

function isLectureUploadFile(filename: string, mimeType: string) {
  if (isTextContentType(mimeType) || isTextKeyByExtension(filename)) return true;
  if (isSupportedLectureWordUpload(filename, mimeType)) return true;
  return isPdfKey(filename) || isPdfMimeType(mimeType);
}

function shouldDeferLectureTextProcessing(filename: string, mimeType: string, size: number) {
  if (!Number.isFinite(size) || size <= LECTURE_INLINE_PARSE_MAX_BYTES) return false;
  if (isSupportedLectureWordUpload(filename, mimeType)) return true;
  return isTextContentType(mimeType) || isTextKeyByExtension(filename);
}

async function putUploadedFileStream(
  bucket: R2Bucket,
  key: string,
  file: File,
  logContext?: Record<string, unknown>,
) {
  console.log("[OWEN_UPLOAD_STREAM]", {
    key,
    filename: file.name || "upload.bin",
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    ...(logContext || {}),
  });
  await bucket.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });
}

async function handleLibraryTxtUpload(req: Request, env: Env): Promise<Response> {
  const auth = await requireFaculty(req, env, "library_txt_upload");
  if (!auth.ok) return auth.response;
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return jsonNoStore({ error: "Send multipart/form-data with fields: docId, file." }, 400);
  }

  const form = await req.formData();
  const docId =
    typeof form.get("docId") === "string"
      ? String(form.get("docId")).trim()
      : typeof form.get("lectureId") === "string"
        ? String(form.get("lectureId")).trim()
        : "";
  if (!docId) {
    return jsonNoStore({ error: "Missing docId." }, 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return jsonNoStore({ error: "Missing lecture text file." }, 400);
  }
  if (!isLectureTextUploadFile(file)) {
    return jsonNoStore({ error: "Lecture upload must be a .txt, .doc, or .docx file." }, 400);
  }
  const wordUpload = isSupportedLectureWordUpload(file.name || "", file.type || "");
  console.log("[OWEN_UPLOAD_SIZE]", {
    route: "library_txt_upload",
    docId,
    filename: file.name || "lecture-upload",
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    maxBytes: LECTURE_UPLOAD_MAX_BYTES,
    wordUpload,
  });
  if (file.size > LECTURE_UPLOAD_MAX_BYTES) {
    console.warn("[OWEN_UPLOAD_REJECT_TOO_LARGE]", {
      route: "library_txt_upload",
      docId,
      filename: file.name || "lecture-upload",
      size: file.size,
      maxBytes: LECTURE_UPLOAD_MAX_BYTES,
    });
    return jsonNoStore({ error: LECTURE_UPLOAD_TOO_LARGE_ERROR }, 413);
  }

  const { bucket } = getLibraryBucket(env);
  const indexRecords = await readLibraryIndex(bucket);
  const record = indexRecords.find(entry => entry.docId === docId);
  if (!record) {
    return jsonNoStore({ error: "Lecture not found." }, 404);
  }

  const config = getAppConfig(env, req);
  const access = AuthorizationPolicy.canAccess(auth.context.session, "library.txt.upload", {
    institutionId: record.institutionId || config.institutionId,
    courseId: record.courseId ?? null,
    ownerUserId: record.ownerUserId ?? null,
  });
  if (!access.allowed) {
    return jsonNoStore({ error: "forbidden" }, 403);
  }

  if (shouldDeferLectureTextProcessing(file.name || "", file.type || "", file.size)) {
    const sourceKey = buildDeferredLectureUploadSourceKey(docId, file.name || "lecture-upload");
    await putUploadedFileStream(bucket, sourceKey, file, {
      docId,
      route: "library_txt_upload",
      deferred: true,
      parseMaxBytes: LECTURE_INLINE_PARSE_MAX_BYTES,
    });

    await writeAuditEvent(env, req, getRequestId(req), {
      event: "library.lecture.txt_upload",
      outcome: "success",
      actor: buildAuditActor(auth.context.session),
      metadata: {
        lectureId: record.docId,
        title: resolveLectureTitle(record),
        institutionId: record.institutionId || config.institutionId,
        courseId: record.courseId ?? null,
        key: sourceKey,
        filename: file.name || "lecture.txt",
        size: file.size,
        uploadType: wordUpload ? "doc_upload" : "txt_upload",
        deferred: true,
      },
    });

    return jsonNoStore({
      ok: true,
      docId,
      filename: file.name || buildLectureTxtDisplayName(resolveLectureTitle(record)),
      size: file.size,
      sourceKey,
      machineTxtStatus: "deferred",
      warning: LECTURE_UPLOAD_DEFERRED_WARNING,
    });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  let extractedText = "";
  try {
    extractedText = await extractLectureUploadTextFromBytes(bytes, file.name || "", file.type || "");
  } catch (err) {
    console.warn("[OWEN_DOC_CONVERT_FAIL]", {
      phase: "faculty_library_upload_extract",
      filename: file.name || "lecture-upload",
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonNoStore({ error: err instanceof Error ? err.message : "Lecture conversion failed." }, 400);
  }

  let stored:
    | {
        storedKey: string;
        normalizedText: string;
        preview: string;
      }
    | null = null;
  try {
    console.log("[OWEN_DOC_UPLOAD_START]", {
      docId,
      filename: file.name || "lecture-upload",
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      route: "library_txt_upload",
    });
    stored = await storeLectureMachineTxtArtifact(env, docId, extractedText, "doc_upload");
    console.log("[OWEN_DOC_CONVERT_SUCCESS]", {
      docId,
      filename: file.name || "lecture-upload",
      storedKey: stored.storedKey,
      textLength: stored.normalizedText.length,
      route: "library_txt_upload",
    });
  } catch (err) {
    console.warn("[OWEN_DOC_CONVERT_FAIL]", {
      phase: "faculty_library_upload_store",
      docId,
      filename: file.name || "lecture-upload",
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonNoStore({ error: err instanceof Error ? err.message : "Lecture conversion failed." }, 422);
  }

  if (!stored) {
    return jsonNoStore({ error: "Lecture conversion failed." }, 422);
  }

  await upsertLibraryIndexRecord(env, {
    ...record,
    status: "ready",
    ingestionType: "doc_upload",
    preview: stored.preview,
  });

  await writeAuditEvent(env, req, getRequestId(req), {
    event: "library.lecture.txt_upload",
    outcome: "success",
    actor: buildAuditActor(auth.context.session),
    metadata: {
      lectureId: record.docId,
      title: resolveLectureTitle(record),
      institutionId: record.institutionId || config.institutionId,
      courseId: record.courseId ?? null,
      key: stored.storedKey,
      filename: file.name || "lecture.txt",
      size: file.size,
      uploadType: wordUpload ? "doc_upload" : "txt_upload",
    },
  });

  return jsonNoStore({
    ok: true,
    docId,
    txtKey: stored.storedKey,
    filename: buildLectureTxtDisplayName(resolveLectureTitle(record)),
    size: file.size,
    downloadUrl: `/api/library/download?lectureId=${encodeURIComponent(docId)}&type=txt`,
    machineTxtStatus: "ready",
  });
}

function scrubMachineTxtFilename(filename: string) {
  const leaf = (filename || "").split("/").pop() || "";
  const cleaned = leaf.replace(/^[0-9]+[-_]+/, "").trim();
  const candidate = cleaned || leaf || "lecture";
  const withoutExt = candidate.replace(/\.txt$/i, "");
  const label = cleanLectureDisplayLabel(withoutExt);
  return label || withoutExt || "Lecture";
}

function isMachineTxtListSource(prefix: string, source: string) {
  const normalizedSource = (source || "").toLowerCase();
  if (normalizedSource === "machine_txt" || normalizedSource === "machine-txt") return true;
  return (prefix || "").startsWith(`${MACHINE_TXT_PREFIX}/`);
}

async function listMachineTxtLectures(env: Env, prefixOverride?: string): Promise<MachineTxtListItem[]> {
  const { bucket, name } = getLibraryBucket(env);
  const prefix = prefixOverride || `${MACHINE_TXT_PREFIX}/`;
  const byFolder = new Map<string, MachineTxtObjectInfo>();
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const obj of page.objects ?? []) {
      const key = obj.key || "";
      if (!key.startsWith(prefix)) continue;
      const relative = key.slice(prefix.length);
      const parts = relative.split("/").filter(Boolean);
      if (parts.length < 2) continue;
      const folderId = parts[0];
      const filename = parts.slice(1).join("/");
      if (!folderId || !filename || !/\.txt$/i.test(filename)) continue;
      const existing = byFolder.get(folderId) || null;
      byFolder.set(folderId, pickPreferredMachineTxtObject({
        key,
        uploaded: obj.uploaded instanceof Date ? obj.uploaded : undefined,
        size: obj.size,
      }, existing));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const items: MachineTxtListItem[] = Array.from(byFolder.entries()).map(([folderId, obj]) => {
    const displayName = scrubMachineTxtFilename(obj.key.split("/").pop() || "");
    return {
      docId: folderId,
      folderId,
      txtKey: obj.key,
      displayName,
      updatedAt: obj.uploaded instanceof Date ? obj.uploaded.toISOString() : undefined,
      sourceType: "machine_txt",
      status: "ready",
      bucket: name,
      key: obj.key,
      title: displayName,
    };
  });
  items.sort((a, b) => (a.displayName || a.txtKey).localeCompare(b.displayName || b.txtKey));
  return items;
}

async function handleLibraryList(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const config = getAppConfig(env, req);
  const session = await getAuthSession(req, env, config);
  const privileged = Boolean(session && AuthorizationPolicy.canAccess(session, "library.download.internal").allowed);
  const prefix = url.searchParams.get("prefix") || "library/";
  const source = url.searchParams.get("source") || "";
  const yearFilter = normalizeLibraryYear(url.searchParams.get("category") ?? url.searchParams.get("year"));
  const courseFilterRaw = url.searchParams.get("courseId")?.trim() || "";
  if (isMachineTxtListSource(prefix, source)) {
    const items = await listMachineTxtLectures(env, `${MACHINE_TXT_PREFIX}/`);
    const { bucket } = getLibraryBucket(env);
    const indexRecords = await readLibraryIndex(bucket);
    const categories = await loadLibraryCategories(bucket, indexRecords.map(rec => rec.yearId ?? rec.categoryId));
    const categoryLabelById = new Map(categories.map(category => [category.id, category.label]));
    const byDocId = new Map(indexRecords.map(rec => [rec.docId, rec]));
    const decorated = items.map(item => {
      const rec = byDocId.get(item.docId);
      const renamedTitle = rec ? cleanLectureDisplayLabel(resolveLectureTitle(rec)) : "";
      const displayTitle = renamedTitle || cleanLectureDisplayLabel(item.displayName || item.title || item.docId);
      const resolvedYearId = resolveLibraryYear(rec?.yearId ?? rec?.categoryId);
      return {
        ...item,
        displayName: displayTitle || item.displayName,
        title: displayTitle || item.title,
        courseId: rec?.courseId ?? null,
        yearId: resolvedYearId,
        categoryId: resolvedYearId,
        categoryLabel: categoryLabelById.get(resolvedYearId) || formatLibraryCategoryLabel(resolvedYearId),
        examId: resolveLibraryExam(rec?.examId),
        hasStoredQbank: Boolean(rec?.hasStoredQbank),
        storedQbankCount: typeof rec?.storedQbankCount === "number" ? rec.storedQbankCount : undefined,
        storedQbankUploadedAt: rec?.storedQbankUploadedAt,
      };
    });
    decorated.sort((a, b) => (a.displayName || a.title || a.docId).localeCompare(b.displayName || b.title || b.docId));
    return json({ items: decorated, source: "machine_txt" });
  }
  const detail = privileged && (url.searchParams.get("detail") === "1" || url.searchParams.get("artifacts") === "1");
  const { bucket } = getLibraryBucket(env);
  const indexRecords = await readLibraryIndex(bucket);
  const categories = await loadLibraryCategories(bucket, indexRecords.map(rec => rec.yearId ?? rec.categoryId));
  const categoryLabelById = new Map(categories.map(category => [category.id, category.label]));
  const filtered = indexRecords
    .filter(rec => rec.key?.startsWith(prefix) && isLibrarySourceDocumentKey(rec.key || ""))
    .filter(rec => {
      if (yearFilter && resolveLibraryYear(rec.yearId ?? rec.categoryId) !== yearFilter) return false;
      if (!courseFilterRaw) return true;
      if (courseFilterRaw === "unassigned") return !rec.courseId;
      return rec.courseId === courseFilterRaw;
    })
    .sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  const lectureTitleByDocId = new Map<string, string>();
  filtered.forEach((rec) => {
    const title = resolveLectureTitle(rec);
    lectureTitleByDocId.set(rec.docId, title);
  });
  const [accessCodeIndex, ankiCodeIndex] = await Promise.all([
    resolveStudyGuideAccessCodes(
      env,
      Array.from(lectureTitleByDocId, ([docId, lectureTitle]) => ({ docId, lectureTitle })),
    ),
    resolveAnkiPublishInfo(env, Array.from(lectureTitleByDocId.keys(), docId => ({ docId }))),
  ]);
  const items = await Promise.all(
    filtered.map(async rec => {
      const extractedKey = rec.extractedKey || buildExtractedPath(rec.docId);
      const lectureTitle = lectureTitleByDocId.get(rec.docId) || resolveLectureTitle(rec);
      const isDocUpload = rec.ingestionType === "doc_upload" || isLibraryWordKey(rec.key || "");
      const machineTxtKey = (detail || isDocUpload) ? await resolvePreferredMachineTxtKey(bucket, rec.docId, lectureTitle) : "";
      let status: "ready" | "missing" | "needs_browser_ocr" = rec.status || "missing";
      const extractedHead = isDocUpload ? { exists: false } as ObjectHeadInfo : await resolveObjectHead(bucket, extractedKey);
      const machineTxtHead = (detail || isDocUpload) ? await resolveObjectHead(bucket, machineTxtKey) : null;
      if (isDocUpload) {
        status = machineTxtHead?.exists ? "ready" : status === "needs_browser_ocr" ? "needs_browser_ocr" : "missing";
      } else if (extractedHead.exists) {
        status = "ready";
      } else {
        status = status === "needs_browser_ocr" ? "needs_browser_ocr" : "missing";
      }

      const studyGuideInfo = accessCodeIndex.get(rec.docId) || null;
      const ankiInfo = ankiCodeIndex.get(rec.docId) || null;
      const studyGuideAccessCode = studyGuideInfo?.code || null;
      const ankiDeckAccessCode = ankiInfo?.code || null;
      const studyGuidePublishedAt = studyGuideInfo?.publishedAt || null;
      const ankiDeckPublishedAt = ankiInfo?.publishedAt || null;
      const resolvedYearId = resolveLibraryYear(rec.yearId ?? rec.categoryId);
      const baseItem = {
        title: lectureTitle,
        docId: rec.docId,
        status,
        accessCode: studyGuideAccessCode,
        studyGuideAccessCode,
        studyGuidePublishedAt,
        ankiDeckAccessCode,
        ankiDeckPublishedAt,
        study_guide_access_code: studyGuideAccessCode,
        study_guide_published_at: studyGuidePublishedAt,
        anki_deck_access_code: ankiDeckAccessCode,
        anki_deck_published_at: ankiDeckPublishedAt,
        courseId: rec.courseId ?? null,
        yearId: resolvedYearId,
        categoryId: resolvedYearId,
        categoryLabel: categoryLabelById.get(resolvedYearId) || formatLibraryCategoryLabel(resolvedYearId),
        examId: resolveLibraryExam(rec.examId),
        hasStoredQbank: Boolean(rec.hasStoredQbank),
        storedQbankCount: typeof rec.storedQbankCount === "number" ? rec.storedQbankCount : undefined,
        storedQbankUploadedAt: rec.storedQbankUploadedAt,
        txtKey: isDocUpload && machineTxtKey ? machineTxtKey : undefined,
        sourceType: isDocUpload && machineTxtKey ? "machine_txt" : undefined,
        ingestionType: isDocUpload ? "doc_upload" : undefined,
        institutionId: rec.institutionId || config.institutionId,
        studyGuideStatus: rec.studyGuideStatus || (studyGuideAccessCode ? "published" : "draft"),
        ankiStatus: rec.ankiStatus || (ankiDeckAccessCode ? "published" : "draft"),
      };
      const privilegedItem = privileged
        ? { bucket: rec.bucket, key: rec.key, extractedKey }
        : {};
      if (!detail) return { ...baseItem, ...privilegedItem };

      let sourceHead: ObjectHeadInfo | null = null;
      try {
        const sourceBucket = getBucketByName(env, rec.bucket);
        sourceHead = await resolveObjectHead(sourceBucket, rec.key);
      } catch {
        sourceHead = { exists: false };
      }
      const pdfHead: ObjectHeadInfo | null = isPdfKey(rec.key || "") ? sourceHead : { exists: false };

      const manifestKey = rec.manifestKey || buildManifestPath(rec.docId);
      const indexKey = buildIndexKeyForDoc(rec.docId);
      const studyGuideKey = buildStudyGuideStoredKey(rec.docId, lectureTitle);
      const studyGuideSourceKey = buildStudyGuideSourceKey(rec.docId, lectureTitle);
      const storedQbankSourceKey = buildStoredQbankSourcePath(rec.docId);
      const storedQbankKey = rec.storedQbankKey || buildStoredQbankQuestionsPath(rec.docId);

      const [manifestHead, indexHead, detailMachineTxtHead, guideHead, guideSourceHead, storedQbankHead, storedQbankSourceHead] = await Promise.all([
        resolveObjectHead(bucket, manifestKey),
        resolveObjectHead(bucket, indexKey),
        machineTxtHead ? Promise.resolve(machineTxtHead) : resolveObjectHead(bucket, machineTxtKey),
        resolveObjectHead(bucket, studyGuideKey),
        resolveObjectHead(bucket, studyGuideSourceKey),
        resolveObjectHead(bucket, storedQbankKey),
        resolveObjectHead(bucket, storedQbankSourceKey),
      ]);

      const updatedAt = pickLatestIso(
        rec.uploaded,
        sourceHead?.uploaded,
        extractedHead.uploaded,
        manifestHead.uploaded,
        indexHead.uploaded,
        detailMachineTxtHead.uploaded,
        guideHead.uploaded,
        guideSourceHead.uploaded,
        storedQbankHead.uploaded,
        storedQbankSourceHead.uploaded,
      );

      return {
        ...baseItem,
        ...privilegedItem,
        manifestKey,
        storedQbankKey,
        updatedAt,
        artifacts: {
          pdf: summarizeArtifact(pdfHead),
          ocr: summarizeArtifact(extractedHead),
          txt: summarizeArtifact(detailMachineTxtHead),
          guide: summarizeArtifact(guideHead),
          guideSource: summarizeArtifact(guideSourceHead),
          storedQbank: summarizeArtifact(storedQbankHead),
          storedQbankSource: summarizeArtifact(storedQbankSourceHead),
          manifest: summarizeArtifact(manifestHead),
          index: summarizeArtifact(indexHead),
        },
      };
    }),
  );
  return json({ items });
}

async function handleLibraryDownload(req: Request, env: Env): Promise<Response> {
  const auth = await requireFaculty(req, env, "library_download");
  if (!auth.ok) return auth.response;
  const url = new URL(req.url);
  const lectureId = url.searchParams.get("lectureId") || url.searchParams.get("docId") || "";
  const typeRaw = url.searchParams.get("type") || "";
  const type = typeRaw.toLowerCase();
  if (!lectureId) {
    return jsonNoStore({ error: "Missing lectureId." }, 400);
  }
  const allowed = new Set(["pdf", "txt", "ocr", "guide", "guide_source", "guide-source", "manifest", "index"]);
  if (!allowed.has(type)) {
    return jsonNoStore({ error: "Invalid type." }, 400);
  }

  const { bucket: libraryBucket } = getLibraryBucket(env);
  const indexRecords = await readLibraryIndex(libraryBucket);
  const record = indexRecords.find(rec => rec.docId === lectureId);
  if (!record) {
    return jsonNoStore({ error: "Lecture not found." }, 404);
  }
  const config = getAppConfig(env, req);
  const access = AuthorizationPolicy.canAccess(auth.context.session, "library.download.internal", {
    institutionId: record.institutionId || config.institutionId,
    courseId: record.courseId ?? null,
    ownerUserId: record.ownerUserId ?? null,
  });
  if (!access.allowed) {
    return jsonNoStore({ error: "forbidden" }, 403);
  }
  const lectureTitle = resolveLectureTitle(record);

  let bucket: R2Bucket;
  let key = "";
  let filename = "";

  if (type === "pdf") {
    if (!isPdfKey(record.key || "")) {
      return jsonNoStore({ error: "PDF not found for this lecture." }, 404);
    }
    bucket = getBucketByName(env, record.bucket);
    key = record.key;
    filename = key.split("/").pop() || `${lectureTitle}.pdf`;
  } else if (type === "ocr") {
    bucket = libraryBucket;
    key = record.extractedKey || buildExtractedPath(record.docId);
    filename = `${buildLectureTxtDisplayName(lectureTitle).replace(/\.txt$/i, "")}_ocr.txt`;
  } else if (type === "txt") {
    bucket = libraryBucket;
    key = await resolvePreferredMachineTxtKey(libraryBucket, record.docId, lectureTitle);
    filename = buildLectureTxtDisplayName(lectureTitle);
  } else if (type === "guide") {
    bucket = libraryBucket;
    key = buildStudyGuideStoredKey(record.docId, lectureTitle);
    filename = buildStudyGuideFilename(lectureTitle);
  } else if (type === "guide_source" || type === "guide-source") {
    bucket = libraryBucket;
    key = buildStudyGuideSourceKey(record.docId, lectureTitle);
    filename = buildStudyGuideSourceFilename(lectureTitle);
  } else if (type === "manifest") {
    bucket = libraryBucket;
    key = record.manifestKey || buildManifestPath(record.docId);
    filename = `manifest_${lectureTitle}.json`;
  } else {
    bucket = libraryBucket;
    key = buildIndexKeyForDoc(record.docId);
    filename = `index_${record.docId}.json`;
  }

  if (!key) {
    return jsonNoStore({ error: "Missing artifact key." }, 404);
  }

  const object = await bucket.get(key);
  if (!object || !object.body) {
    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  }
  await writeAuditEvent(env, req, getRequestId(req), {
    event: "library.asset.download",
    outcome: "success",
    actor: buildAuditActor(auth.context.session),
    metadata: { lectureId, type, bucket: record.bucket, key },
  });
  const safeFilename = sanitizeFilename(filename || key.split("/").pop() || "download");
  return new Response(object.body, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${safeFilename}"`,
    },
  });
}

async function handleAuthProviders(req: Request, env: Env): Promise<Response> {
  const config = getAppConfig(env, req);
  return jsonNoStore({
    appEnv: config.appEnv,
    institutionId: config.institutionId,
    institutionName: config.institutionName,
    providers: listPublicAuthProviders(config),
  });
}

async function handleAuthLogin(req: Request, env: Env): Promise<Response> {
  const config = getAppConfig(env, req);
  const body = await readRequestJsonBody(req);
  if (!body || typeof body !== "object") {
    return jsonNoStore({ error: "Send JSON { provider, email, sharedSecret? }." }, 400);
  }
  const provider =
    typeof (body as any).provider === "string" && (body as any).provider.trim()
      ? (body as any).provider.trim().toLowerCase()
      : "dev";
  try {
    if (provider !== "dev") {
      return jsonNoStore({ error: "Interactive SSO must start from /api/auth/oidc/start." }, 400);
    }
    const login = await loginWithDevProvider(req, env, config, body as Record<string, unknown>);
    await writeAuditEvent(env, req, getRequestId(req), {
      event: "auth.login",
      outcome: "success",
      actor: buildAuditActor(login.record),
      metadata: { provider: "dev" },
    });
    const headers = new Headers({
      "content-type": "application/json; charset=utf-8",
      ...NO_STORE_HEADERS,
    });
    headers.append("Set-Cookie", login.cookie);
    return new Response(JSON.stringify({ ok: true, user: login.record }), { status: 200, headers });
  } catch (error) {
    await writeAuditEvent(env, req, getRequestId(req), {
      event: "auth.login",
      outcome: "failure",
      metadata: {
        provider,
        reason: error instanceof Error ? error.message : "login_failed",
      },
    });
    return jsonNoStore({ error: error instanceof Error ? error.message : "Login failed." }, 401);
  }
}

async function handleAuthSession(req: Request, env: Env): Promise<Response> {
  const config = getAppConfig(env, req);
  const session = await getAuthSession(req, env, config);
  if (!session) {
    return jsonNoStore({ ok: false, error: "unauthorized" }, 401);
  }
  return jsonNoStore({ ok: true, user: session });
}

async function handleAuthLogout(req: Request, env: Env): Promise<Response> {
  const config = getAppConfig(env, req);
  const session = await getAuthSession(req, env, config);
  await revokeAuthSession(req, env);
  await writeAuditEvent(env, req, getRequestId(req), {
    event: "auth.logout",
    outcome: "success",
    actor: buildAuditActor(session),
  });
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    ...NO_STORE_HEADERS,
  });
  headers.append("Set-Cookie", buildAuthLogoutCookie(req));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

async function handleAuthOidcStart(req: Request, env: Env): Promise<Response> {
  try {
    const config = getAppConfig(env, req);
    const redirectUrl = await beginOidcLogin(req, env, config);
    return Response.redirect(redirectUrl, 302);
  } catch (error) {
    return jsonNoStore({ error: error instanceof Error ? error.message : "Unable to start OIDC login." }, 400);
  }
}

async function handleAuthOidcCallback(req: Request, env: Env): Promise<Response> {
  try {
    const config = getAppConfig(env, req);
    const result = await completeOidcLogin(req, env, config);
    await writeAuditEvent(env, req, getRequestId(req), {
      event: "auth.login",
      outcome: "success",
      actor: buildAuditActor(result.record),
      metadata: { provider: "oidc" },
    });
    const redirectTo = new URL(result.returnTo || "/faculty/pipeline", config.baseUrl);
    const resp = Response.redirect(redirectTo.toString(), 302);
    resp.headers.append("Set-Cookie", result.cookie);
    return resp;
  } catch (error) {
    await writeAuditEvent(env, req, getRequestId(req), {
      event: "auth.login",
      outcome: "failure",
      metadata: {
        provider: "oidc",
        reason: error instanceof Error ? error.message : "oidc_callback_failed",
      },
    });
    return jsonNoStore({ error: error instanceof Error ? error.message : "OIDC callback failed." }, 401);
  }
}

async function handleFacultyLogin(req: Request, env: Env): Promise<Response> {
  return handleAuthLogin(req, env);
}

async function handleFacultySession(req: Request, env: Env): Promise<Response> {
  const config = getAppConfig(env, req);
  const { source, hasCookie, hasHeader } = readAuthToken(req);
  const session = await getAuthSession(req, env, config);
  const allowed = AuthorizationPolicy.canAccess(session, "library.download.internal");
  logFacultyAuthAttempt({
    req,
    label: "faculty_session",
    source,
    hasCookie,
    hasHeader,
    ok: allowed.allowed && Boolean(session),
    reason: allowed.allowed ? undefined : allowed.reason,
  });
  if (!session || !allowed.allowed) {
    return jsonNoStore({ error: "unauthorized" }, 401);
  }
  return jsonNoStore({ ok: true, user: session });
}

async function handleFacultyLogout(req: Request, env: Env): Promise<Response> {
  return handleAuthLogout(req, env);
}

async function handleLibraryDelete(req: Request, env: Env): Promise<Response> {
  const auth = await requireFaculty(req, env, "library_delete");
  if (!auth.ok) return auth.response;
  const url = new URL(req.url);
  const lectureId = url.searchParams.get("lectureId") || url.searchParams.get("docId") || "";
  if (!lectureId) {
    return jsonNoStore({ error: "Missing lectureId." }, 400);
  }
  const { bucket: libraryBucket } = getLibraryBucket(env);
  const indexRecords = await readLibraryIndex(libraryBucket);
  const record = indexRecords.find(rec => rec.docId === lectureId);
  if (!record) {
    return jsonNoStore({ error: "Lecture not found." }, 404);
  }
  const config = getAppConfig(env, req);
  const access = AuthorizationPolicy.canAccess(auth.context.session, "library.delete", {
    institutionId: record.institutionId || config.institutionId,
    courseId: record.courseId ?? null,
    ownerUserId: record.ownerUserId ?? null,
  });
  if (!access.allowed) {
    return jsonNoStore({ error: "forbidden" }, 403);
  }

  const lectureTitle = resolveLectureTitle(record);
  const failures: Array<{ bucket: string; key: string; action: string; error: string }> = [];

  const registerFailure = (bucket: string, key: string, action: string, err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    failures.push({ bucket, key, action, error: message });
  };

  const deleteKey = async (bucket: R2Bucket, bucketLabel: string, key: string, action = "delete") => {
    if (!key) return;
    try {
      await bucket.delete(key);
    } catch (err) {
      registerFailure(bucketLabel, key, action, err);
    }
  };

  const deletePrefix = async (bucket: R2Bucket, bucketLabel: string, prefix: string) => {
    if (!prefix) return;
    let cursor: string | undefined;
    do {
      try {
        const page = await bucket.list({ prefix, cursor, limit: 1000 });
        const keys = (page.objects || []).map(obj => obj.key).filter(Boolean);
        await Promise.all(keys.map(key => deleteKey(bucket, bucketLabel, key, "delete")));
        cursor = page.truncated ? page.cursor : undefined;
      } catch (err) {
      registerFailure(bucketLabel, prefix, "list", err);
      return;
    }
  } while (cursor);
  };

  const deleteKvKey = async (key: string) => {
    if (!key || !env.DOCS_KV) return;
    try {
      await env.DOCS_KV.delete(key);
    } catch (err) {
      registerFailure("DOCS_KV", key, "delete", err);
    }
  };

  const deleteDocCacheKey = async (key: string) => {
    if (!key || !env.OWEN_DOC_CACHE) return;
    try {
      await env.OWEN_DOC_CACHE.delete(key);
    } catch (err) {
      registerFailure("OWEN_DOC_CACHE", key, "delete", err);
    }
  };

  const [studyGuidePublishRecord, ankiPublishRecord] = await Promise.all([
    loadStudyGuidePublishRecord(env, record.docId),
    loadAnkiPublishRecord(env, record.docId),
  ]);

  try {
    const sourceBucket = getBucketByName(env, record.bucket);
    await deleteKey(sourceBucket, record.bucket, record.key, "delete");
    await deleteKey(sourceBucket, record.bucket, `${record.key}.ocr.txt`, "delete");
  } catch (err) {
    registerFailure(record.bucket, record.key, "bucket_lookup", err);
  }

  const extractedKey = record.extractedKey || buildExtractedPath(record.docId);
  const manifestKey = record.manifestKey || buildManifestPath(record.docId);
  await deleteKey(libraryBucket, LIBRARY_BUCKET, extractedKey, "delete");
  await deleteKey(libraryBucket, LIBRARY_BUCKET, manifestKey, "delete");

  const safeDocId = sanitizeMachineSlug(record.docId, "doc");
  const safeTitle = sanitizeMachineSlug(lectureTitle, "lecture");
  const studyGuideStoredKey = buildStudyGuideStoredKey(record.docId, lectureTitle);
  const legacyStudyGuideStoredKey = `${MACHINE_STUDY_GUIDE_PREFIX}/${safeTitle}/Study_Guide_${safeTitle}.html`;
  const studyGuideSourceKeys = new Set<string>([
    studyGuideStoredKey,
    legacyStudyGuideStoredKey,
  ]);
  if (typeof studyGuidePublishRecord?.storedKey === "string" && studyGuidePublishRecord.storedKey.trim()) {
    studyGuideSourceKeys.add(studyGuidePublishRecord.storedKey.trim());
  }

  await deletePrefix(libraryBucket, LIBRARY_BUCKET, `${MACHINE_TXT_PREFIX}/${safeDocId}/`);
  await deletePrefix(libraryBucket, LIBRARY_BUCKET, `${MACHINE_STUDY_GUIDE_PREFIX}/${safeDocId}/${safeTitle}/`);
  await deletePrefix(libraryBucket, LIBRARY_BUCKET, `${MACHINE_STUDY_GUIDE_PREFIX}/${safeTitle}/`);
  await deletePrefix(libraryBucket, LIBRARY_BUCKET, `${STORED_QBANK_PREFIX}${record.docId.replace(/[^a-z0-9]/gi, "")}/`);

  let publishBucket: R2Bucket | null = null;
  try {
    publishBucket = getPublishBucket(env).bucket;
  } catch (err) {
    registerFailure("publish", "bucket", "bucket_lookup", err);
  }
  if (publishBucket) {
    await deleteKey(publishBucket, STUDY_GUIDE_PUBLISH_PREFIX, buildStudyGuidePublishRecordKey(record.docId), "delete");
    await deleteKey(publishBucket, ANKI_DECKS_PREFIX, buildAnkiPublishRecordKey(record.docId), "delete");
  }

  await deleteKvKey(`studyguide:lecture:${record.docId}`);
  await deleteKvKey(`anki:lecture:${record.docId}`);
  await deleteKvKey(buildLectureMachineTxtMetadataKey(record.docId));
  await Promise.all([
    ...Array.from(studyGuideSourceKeys, storedKey => deleteKvKey(buildStudyGuideSourceMappingKey(storedKey))),
    typeof ankiPublishRecord?.storedKey === "string" && ankiPublishRecord.storedKey.trim()
      ? deleteKvKey(buildAnkiSourceMappingKey(ankiPublishRecord.storedKey.trim()))
      : Promise.resolve(),
    deleteDocCacheKey(buildLectureMachineTxtMetadataKey(record.docId)),
  ]);

  if (failures.length) {
    return jsonNoStore({ ok: false, error: "delete_failed", failures }, 500);
  }

  const nextIndex = indexRecords.filter(rec => rec.docId !== lectureId);
  try {
    await writeLibraryIndex(libraryBucket, nextIndex);
  } catch (err) {
    return jsonNoStore({
      ok: false,
      error: "index_update_failed",
      failures: [{ bucket: LIBRARY_BUCKET, key: LIBRARY_INDEX_KEY, action: "write", error: err instanceof Error ? err.message : String(err) }],
    }, 500);
  }
  await deleteKey(libraryBucket, LIBRARY_BUCKET, buildIndexKeyForDoc(record.docId), "delete");
  await writeAuditEvent(env, req, getRequestId(req), {
    event: "library.lecture.delete",
    outcome: "success",
    actor: buildAuditActor(auth.context.session),
    metadata: {
      lectureId: record.docId,
      title: lectureTitle,
      institutionId: record.institutionId || config.institutionId,
      courseId: record.courseId ?? null,
    },
  });

  return jsonNoStore({
    ok: true,
    deleted: { docId: record.docId, title: lectureTitle },
    invalidation: { lectures: true },
  });
}

async function handleLibraryIngest(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return json({ error: "Send JSON { bucket, key, force? }." }, 400);
  }
  const bucketName = typeof (body as any).bucket === "string" ? (body as any).bucket.trim() : "";
  const key = typeof (body as any).key === "string" ? (body as any).key.trim() : "";
  const force = Boolean((body as any).force);
  if (!bucketName || !key) return json({ error: "Missing bucket or key." }, 400);

  try {
    const result = await ingestLibraryObject(env, { bucketName, key, skipCache: force });
    return json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = (err as any)?.statusCode && Number.isInteger((err as any).statusCode) ? Number((err as any).statusCode) : 500;
    console.error("[LIBRARY-INGEST] failed", { bucketName, key, error: msg });
    return json({ status: "error", stage: (err as any)?.stage || "unknown", message: msg }, status);
  }
}

async function handleLibraryAsk(req: Request, env: Env): Promise<Response> {
  const requestId = `lib-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const debugLectureAsk = (env as any)?.DEBUG_LECTURE_ASK === "1" || req.headers.get("x-debug-lecture-ask") === "1";
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return jsonNoStore({ error: "Send JSON { docId, question }.", requestId }, 400);
  }
  const docId = typeof (body as any).docId === "string" ? (body as any).docId.trim() : "";
  const question = typeof (body as any).question === "string" ? (body as any).question.trim() : "";
  const clientReqId = typeof (body as any).requestId === "string" ? (body as any).requestId.trim() : "";
  const sourceType = typeof (body as any).sourceType === "string" ? (body as any).sourceType.trim().toLowerCase() : "";
  const txtKeyInput = typeof (body as any).txtKey === "string" ? (body as any).txtKey.trim() : "";
  const lectureTitleInput =
    typeof (body as any).lectureTitle === "string"
      ? (body as any).lectureTitle.trim()
      : typeof (body as any).displayName === "string"
        ? (body as any).displayName.trim()
        : "";
  const effectiveReqId = clientReqId || requestId;
  if (!docId || !question) return jsonNoStore({ error: "Missing docId or question.", requestId: effectiveReqId }, 400);
  const useMachineTxt = sourceType === "machine_txt" || sourceType === "machine-txt" || isMachineTxtKey(txtKeyInput);

  const { bucket } = getLibraryBucket(env);
  let docTitle: string | undefined;
  if (useMachineTxt) {
    docTitle = lectureTitleInput || (txtKeyInput ? scrubMachineTxtFilename(txtKeyInput.split("/").pop() || "") : undefined);
  }
  if (!docTitle) {
    try {
      const indexRecords = await readLibraryIndex(bucket);
      const match = indexRecords.find(rec => rec.docId === docId);
      docTitle = match?.title || undefined;
    } catch {
      docTitle = undefined;
    }
    try {
      const manifest = await readManifest(bucket, docId);
      if (manifest?.title && !docTitle) {
        docTitle = manifest.title;
      }
    } catch {
      // best-effort manifest lookup
    }
  }

  let extractedKey = "";
  let extractedText: string | null = null;
  if (useMachineTxt) {
    if (!txtKeyInput || !isMachineTxtKey(txtKeyInput)) {
      return jsonNoStore({
        v: 1,
        ok: false,
        error: { code: "machine_txt_not_found", message: "Unable to load lecture TXT." },
        details: "Missing or invalid TXT key for this lecture.",
        requestId: effectiveReqId,
        docId,
        answer: "Lecture TXT not found for this selection.",
      }, 404);
    }
    try {
      const rawTxt = await loadMachineTxtFromStorage(env, txtKeyInput);
      extractedKey = txtKeyInput;
      extractedText = rawTxt ? normalizePlainText(rawTxt) : null;
    } catch (err) {
      console.error("[LIBRARY-ASK] machine txt load failed", {
        requestId: effectiveReqId,
        docId,
        txtKey: txtKeyInput,
        error: err instanceof Error ? err.message : String(err),
      });
      extractedText = null;
    }
    if (!extractedText) {
      return jsonNoStore({
        v: 1,
        ok: false,
        error: { code: "machine_txt_not_found", message: "Unable to load lecture TXT." },
        details: "Lecture TXT not found for this selection.",
        requestId: effectiveReqId,
        docId,
        answer: "Lecture TXT not found for this selection.",
      }, 404);
    }
  } else {
    const cache = await loadCachedExtraction(bucket, docId);
    extractedKey = cache.extractedKey;
    extractedText =
      cache.text ||
      (cache as any).extractedText ||
      (cache as any).content ||
      (cache as any).ocrText ||
      (cache as any).textContent ||
      null;
    if (!extractedText) {
      console.error("[LIBRARY-ASK] missing extraction", { requestId: effectiveReqId, docId });
      return jsonNoStore({
        v: 1,
        ok: false,
        error: "extracted_text_not_found",
        details: "No cached extraction for this docId.",
        requestId: effectiveReqId,
        docId,
        answer: "Lecture text not found for this selection.",
      }, 404);
    }
  }

  const text = extractedText.slice(0, MAX_OCR_TEXT_LENGTH);
  if (debugLectureAsk) {
    console.log("[LIBRARY_ASK_START]", { docId, requestId: effectiveReqId, questionLen: question.length });
  }
  console.log("[LIBRARY_CONTEXT]", { requestId: effectiveReqId, docId, extractedKey, contextLen: text.length, sourceType: useMachineTxt ? "machine_txt" : "ocr" });
  console.log("[LIB_ASK_GUARD]", { req: effectiveReqId, docId, hasKey: Boolean(extractedKey), r2TextLen: text.length });
  if (text.length < 300) {
    console.error("[LIBRARY_CONTEXT_MISSING]", { docId, contextLen: text.length, requestId: effectiveReqId });
    return jsonNoStore({
      v: 1,
      ok: false,
      error: { code: useMachineTxt ? "txt_not_ready" : "ocr_not_ready", message: "Extracted text too small or not ready." },
      answer: useMachineTxt
        ? "TXT is still processing or text is not ready yet. Please retry in a moment."
        : "OCR is still processing or extracted text is not ready yet. Please retry in a moment or re-ingest.",
      docId,
      requestId: effectiveReqId,
    });
  }
  const chunks = chunkText(text, { size: RETRIEVAL_CHUNK_SIZE, overlap: RETRIEVAL_CHUNK_OVERLAP });
  const intent = detectLibraryIntent(question);
  const excerptsAllowed = intent.wantsTable ? false : allowExcerpts(question);
  let selected = selectLibraryChunks(question, chunks, intent);
  if (!selected.length) {
    selected = chunks.slice(0, Math.min(RETRIEVAL_TOP_K, chunks.length));
  }
  const selectedCharCount = selected.reduce((sum, chunk) => sum + chunk.text.length, 0);
  console.log("[LIBRARY-ASK] retrieval", {
    requestId: effectiveReqId,
    docId,
    totalChunks: chunks.length,
    selected: selected.map(c => c.index),
    mode: intent.isBroad ? "broad" : "narrow",
    chars: selectedCharCount,
    extractedLen: text.length,
    extractedKey,
  });

  try {
    debugFormatLog("[LIBRARY] format route", {
      docId,
      wantsTable: intent.wantsTable,
      broad: intent.isBroad,
      allowExcerpts: excerptsAllowed,
      selectedChunks: selected.length,
    });
    const contextNotes = await buildLibraryContextNotes(env, question, selected, { requestId: effectiveReqId });
    const rawAnswerResult = await answerWithRetrievedChunks(env, selected, question, {
      mode: "library",
      broad: intent.isBroad,
      listIntent: intent.listIntent,
      tableSchema: intent.wantsTable ? undefined : undefined,
      tableOnly: intent.wantsTable,
      tableHeaders: intent.wantsTable ? deriveTableHeaders(question) : undefined,
      allowExcerpts: excerptsAllowed,
      requestId: effectiveReqId,
      contextNotes,
    });
    const rawAnswer = rawAnswerResult.fullText;
    if (!rawAnswer.trim()) {
      console.error("[LIBRARY_ASK] empty before truncation check", { requestId: effectiveReqId, docId });
      return jsonNoStore({
        v: 1,
        ok: false,
        error: "empty_answer",
        requestId: effectiveReqId,
        docId,
        answer: "Response generation timed out before any content was produced. Please retry.",
      }, 200);
    }
    const inherentlyTabular = isInherentlyTabularQuestion(question) || intent.wantsConditionLabsTable;
    const preferTable = intent.wantsTable || inherentlyTabular;
    const formatted = preferTable ? trimAfterFirstTable(rawAnswer) : rawAnswer;
    const repaired = preferTable ? ensureTablePresence(formatted, deriveTableHeaders(question)) : formatted;
    const sanitized = sanitizeAnswer(repaired, { allowExcerpts: excerptsAllowed });
    const finalCore = finalizeAssistantText(rawAnswer, sanitized);
    const finalAnswer = rawAnswerResult.truncated ? appendTruncationNotice(finalCore) : finalCore;
    const answerLength = (finalAnswer || "").trim().length;
    const evidence = excerptsAllowed ? buildEvidenceFromChunks(selected, docId) : undefined;
    console.log("[LIBRARY_ASK] answerLength", answerLength, "evidenceCount", evidence?.length || 0, "req", effectiveReqId, "docId", docId);
    if (debugLectureAsk) {
      console.log("[LIBRARY_ASK][DEBUG]", {
        requestId: effectiveReqId,
        promptLength: question.length,
        maxOutputTokens: ANSWER_MAX_OUTPUT_TOKENS,
        listIntent: intent.listIntent,
        chunksCount: chunks.length,
        selected: selected.map(c => c.index),
      });
    }
    if (intent.listIntent) {
      console.log("[LIST_INTENT]", { requestId: effectiveReqId, docId, matched: true, templateApplied: false });
    }
    if (!answerLength) {
      console.error("[LIBRARY_ASK] empty answer", { requestId: effectiveReqId, docId, selected: selected.map(c => c.index) });
      return jsonNoStore({
        v: 1,
        ok: false,
        error: "empty_answer",
        requestId: effectiveReqId,
        docId,
        answer: `No answer text was produced for this prompt. Try rephrasing or ask for fewer items. (req: ${effectiveReqId})`,
      }, 200);
    }
    debugFormatLog("[LIBRARY] format result", {
      preferTable,
      rawLength: rawAnswer.length,
      repairedLength: repaired.length,
      finalLength: finalAnswer.length,
    });
    const references = buildReferencesFromChunks(selected, docId);
    const payload: Record<string, unknown> = {
      v: 1,
      ok: true,
      answer: finalAnswer,
      docId,
      extractedKey,
      references,
      meta: docTitle ? { docTitle } : undefined,
      requestId: effectiveReqId,
    };
    if (rawAnswerResult.truncated && answerLength > 0) {
      payload.truncated = true;
      payload.continuationToken = buildLibraryContinuationToken({
        docId,
        requestId: effectiveReqId,
        question,
        contextNotes,
        extractedKey,
        options: {
          allowExcerpts: excerptsAllowed,
          tableHeaders: intent.wantsTable ? deriveTableHeaders(question) : undefined,
          tableOnly: intent.wantsTable,
          broad: intent.isBroad,
          listIntent: intent.listIntent,
        },
        answerTail: clipAnswerTail(finalCore),
        segments: rawAnswerResult.attempts,
        maxOutputTokens: ANSWER_MAX_OUTPUT_TOKENS,
        model: resolveModelId(DEFAULT_TEXT_MODEL, env),
      });
    }
    if (evidence && evidence.length) {
      payload.evidence = evidence;
    }
    const lectureAnchors = references.map(ref => ref.title).filter(Boolean) as string[];
    try {
      const event = buildAnalyticsEvent({
        lectureId: docId,
        lectureTitle: docTitle || null,
        question,
        docId,
        lectureAnchors,
        model: resolveModelId(DEFAULT_TEXT_MODEL, env),
      });
      if (event) {
        await writeAnalyticsEvent(env, event);
      }
    } catch (err) {
      console.error("[ANALYTICS_WRITE_FAILED]", {
        docId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (debugLectureAsk) {
      console.log("[LIB_ASK_OUT]", { req: effectiveReqId, ok: true, answerLen: answerLength, refs: references.length });
    }
    console.log("[ASK_END]", {
      req: effectiveReqId,
      ok: true,
      answerLen: answerLength,
      truncated: Boolean(payload.truncated),
      hasToken: Boolean(payload.continuationToken),
    });
    return jsonNoStore(payload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[LIBRARY-ASK] failed", { docId, error: msg, requestId: effectiveReqId });
    return jsonNoStore({
      v: 1,
      ok: false,
      error: "answer_failed",
      details: msg,
      requestId: effectiveReqId,
      docId,
      answer: `Error generating answer: ${msg}`,
    }, 200);
  }
}

async function handleLibraryAskContinue(req: Request, env: Env): Promise<Response> {
  const requestId = `lib-cont-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return jsonNoStore({ ok: false, error: "invalid_body", message: "Send JSON { docId, continuationToken }.", requestId }, 400);
  }
  const docId = typeof (body as any).docId === "string" ? (body as any).docId.trim() : "";
  const tokenInput = typeof (body as any).continuationToken === "string" ? (body as any).continuationToken.trim() : "";
  const clientReqId = typeof (body as any).requestId === "string" ? (body as any).requestId.trim() : "";
  const effectiveReqId = clientReqId || requestId;
  if (!docId || !tokenInput) {
    return jsonNoStore({
      ok: false,
      error: "missing_params",
      message: "docId and continuationToken are required.",
      requestId: effectiveReqId,
    }, 400);
  }

  const parsed = parseLibraryContinuationToken(tokenInput);
  if (!parsed || parsed.docId !== docId) {
    return jsonNoStore({
      ok: false,
      error: "invalid_continuation_token",
      message: "Continuation token is invalid or does not match the requested docId.",
      requestId: effectiveReqId,
    }, 400);
  }

  if ((parsed.segments || 0) >= LIBRARY_TOTAL_CONTINUATIONS) {
    return jsonNoStore({
      v: 1,
      ok: false,
      error: "continuation_limit",
      message: "Continuation limit reached before more content was produced. Please retry the question.",
      docId,
      requestId: parsed.requestId || effectiveReqId,
    }, 200);
  }

  const continuationKey = typeof parsed.extractedKey === "string" ? parsed.extractedKey.trim() : "";
  const useMachineTxt = continuationKey ? isMachineTxtKey(continuationKey) : false;
  let extractedKey = "";
  let extractedText: string | null = null;

  if (useMachineTxt) {
    try {
      const rawTxt = await loadMachineTxtFromStorage(env, continuationKey);
      extractedKey = continuationKey;
      extractedText = rawTxt ? normalizePlainText(rawTxt) : null;
    } catch (err) {
      console.error("[LIBRARY-ASK-CONTINUE] machine txt load failed", {
        requestId: effectiveReqId,
        docId,
        txtKey: continuationKey,
        error: err instanceof Error ? err.message : String(err),
      });
      extractedText = null;
    }
    if (!extractedText) {
      return jsonNoStore({
        v: 1,
        ok: false,
        error: { code: "machine_txt_not_found", message: "Unable to load lecture TXT." },
        details: "Lecture TXT not found for this selection.",
        requestId: effectiveReqId,
        docId,
        answerSegment: "Lecture TXT not found for this selection.",
      }, 404);
    }
  } else {
    const { bucket } = getLibraryBucket(env);
    const cache = await loadCachedExtraction(bucket, docId);
    extractedKey = cache.extractedKey;
    extractedText =
      cache.text ||
      (cache as any).extractedText ||
      (cache as any).content ||
      (cache as any).ocrText ||
      (cache as any).textContent ||
      null;
    if (!extractedText) {
      return jsonNoStore({
        v: 1,
        ok: false,
        error: "extracted_text_not_found",
        details: "No cached extraction for this docId.",
        requestId: effectiveReqId,
        docId,
        answerSegment: "Lecture text not found for this selection.",
      }, 404);
    }
  }

  const text = extractedText.slice(0, MAX_OCR_TEXT_LENGTH);
  if (text.length < 300) {
    return jsonNoStore({
      v: 1,
      ok: false,
      error: { code: useMachineTxt ? "txt_not_ready" : "ocr_not_ready", message: "Extracted text too small or not ready." },
      answerSegment: useMachineTxt
        ? "TXT is still processing or text is not ready yet. Please retry in a moment."
        : "OCR is still processing or extracted text is not ready yet. Please retry in a moment or re-ingest.",
      docId,
      requestId: effectiveReqId,
    });
  }
  if (parsed.extractedKey && parsed.extractedKey !== extractedKey) {
    return jsonNoStore({
      ok: false,
      error: "stale_continuation_token",
      message: "The lecture was re-processed; please restart the ask.",
      docId,
      requestId: effectiveReqId,
    }, 409);
  }

  const options = parsed.options || {};
  let contextNotes = parsed.contextNotes || "";
  const chunks = chunkText(text, { size: RETRIEVAL_CHUNK_SIZE, overlap: RETRIEVAL_CHUNK_OVERLAP });
  const intent = detectLibraryIntent(parsed.question);
  const selected = selectLibraryChunks(parsed.question, chunks, intent);
  if (!contextNotes) {
    contextNotes = await buildLibraryContextNotes(env, parsed.question, selected, { requestId: parsed.requestId || effectiveReqId });
  }
  if (!contextNotes) {
    contextNotes = "Context notes unavailable; continue the previous answer based on the question and prior text.";
  }

  const contextLabel = "Section";
  const contextHeader = "Lecture excerpts";
  const contextBody = selected
    .map(chunk => `[${contextLabel} ${chunk.index + 1}]\n${cleanRetrievedChunkText(chunk.text)}`)
    .join("\n\n");
  const contextBlock = options.allowExcerpts
    ? `${contextHeader}:\n${contextBody}`
    : `${contextHeader} (REFERENCE — do not quote verbatim unless asked):\n${contextBody}`;
  const continuationContext = `${contextBlock}\n\n(Internal context notes — do not quote or mimic; keep clinician-style synthesis):\n${contextNotes || "None"}`;

  const system = buildLibrarySystemPrompt({
    mode: "library",
    allowExcerpts: options.allowExcerpts,
    tableHeaders: options.tableHeaders,
    tableOnly: options.tableOnly,
    broad: options.broad,
    listIntent: options.listIntent,
  });

  const remainingBudget = Math.max(1, LIBRARY_TOTAL_CONTINUATIONS - (parsed.segments || 0));
  const maxAttempts = Math.min(ANSWER_MAX_CONTINUATIONS + 1, remainingBudget);
  const model = resolveModelId(DEFAULT_TEXT_MODEL, env);

  const result = await runResponsesWithContinuation(env, {
    label: `library-continue-${parsed.requestId || effectiveReqId}`,
    initialText: parsed.answerTail || "",
    maxAttempts,
    maxOutputTokens: parsed.maxOutputTokens || ANSWER_MAX_OUTPUT_TOKENS,
    buildPayload: ({ accumulatedText }) => {
      const userParts: ResponsesInputContent[] = [
        { type: "input_text", text: continuationContext },
        { type: "input_text", text: `Question:\n${parsed.question}` },
      ];
      if (accumulatedText) {
        userParts.push({
          type: "input_text",
          text: `Partial answer so far:\n${clipAnswerTail(accumulatedText)}`,
        });
      }
      userParts.push({
        type: "input_text",
        text: "Continue only if the previous answer was cut off mid-thought. If it already ended with a short tailoring follow-up, return no additional content. Do not repeat earlier sentences or headings, restart tables, or add a continuation label.",
      });
      return {
        model,
        input: [
          { role: "system" as const, content: [{ type: "input_text" as const, text: system }] },
          { role: "user" as const, content: userParts },
        ],
      };
    },
  });

  const updatedSegments = (parsed.segments || 0) + result.attempts;
  const continuationAllowed = updatedSegments < LIBRARY_TOTAL_CONTINUATIONS;
  let continuationToken: string | undefined;
  const segmentText = (result.text || "").trim();
  if (!segmentText) {
    return jsonNoStore({
      v: 1,
      ok: false,
      error: "empty_answer",
      message: "Response generation timed out before any content was produced. Please retry.",
      requestId: parsed.requestId || effectiveReqId,
      docId,
    }, 200);
  }
  if (result.truncated && continuationAllowed) {
    continuationToken = buildLibraryContinuationToken({
      ...parsed,
      requestId: parsed.requestId || effectiveReqId,
      contextNotes,
      answerTail: clipAnswerTail(result.fullText),
      segments: updatedSegments,
      maxOutputTokens: parsed.maxOutputTokens || ANSWER_MAX_OUTPUT_TOKENS,
      model,
    });
  }

  const answerSegment = result.truncated && segmentText ? appendTruncationNotice(segmentText) : segmentText;

  const responsePayload = {
    v: 1,
    ok: true,
    answerSegment,
    docId,
    requestId: parsed.requestId || effectiveReqId,
    continuationToken,
    done: !continuationToken,
    truncated: result.truncated,
    limitReached: result.truncated && !continuationToken,
  };
  console.log("[ASK_END]", {
    req: parsed.requestId || effectiveReqId,
    ok: true,
    answerLen: answerSegment.length,
    truncated: result.truncated,
    hasToken: Boolean(continuationToken),
  });
  return jsonNoStore(responsePayload);
}

function resolveQuizTimeoutMs(env: Env): number {
  const override = Number.parseInt(env.QUIZ_AI_TIMEOUT_MS || "", 10);
  if (Number.isFinite(override) && override > 0) return override;
  return QUIZ_AI_TIMEOUT_MS;
}

function resolveQuizMaxOutputTokens(count: number): number {
  const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : QUIZ_BATCH_SIZE;
  const desired = 350 + safeCount * 320;
  return Math.max(QUIZ_MIN_OUTPUT_TOKENS, Math.min(QUIZ_MAX_OUTPUT_TOKENS, desired));
}

function resolveQuizModelId(env: Env): string {
  return resolveModelId(DEFAULT_TEXT_MODEL, env);
}

function clipQuizOutputSnippet(raw: unknown, maxChars = QUIZ_OUTPUT_SNIPPET_MAX_CHARS): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  let text = "";
  if (typeof raw === "string") {
    text = raw;
  } else {
    try {
      text = JSON.stringify(raw);
    } catch {
      text = String(raw);
    }
  }
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

function createQuizTimeoutPromise(timeoutMs: number): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error("upstream_timeout");
      (err as any).code = "upstream_timeout";
      (err as any).name = "TimeoutError";
      reject(err);
    }, timeoutMs);
  });
  return {
    promise,
    cancel: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

async function runWorkersAiWithTimeout(
  env: Env,
  model: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  const { promise, cancel } = createQuizTimeoutPromise(timeoutMs);
  try {
    return await Promise.race([env.AI!.run(model, payload), promise]);
  } finally {
    cancel();
  }
}

function isQuizTimeoutError(err: unknown): boolean {
  const code = (err as any)?.code;
  const name = (err as any)?.name;
  return code === "upstream_timeout" || name === "TimeoutError" || name === "AbortError";
}

function extractAiQuizPayload(raw: unknown): unknown {
  let candidate: unknown = raw;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!isPlainObject(candidate) || Array.isArray(candidate)) break;
    const obj = candidate as Record<string, unknown>;
    if ("response" in obj) {
      candidate = obj.response;
      continue;
    }
    if ("result" in obj) {
      candidate = obj.result;
      continue;
    }
    if ("output" in obj) {
      candidate = obj.output;
      continue;
    }
    if ("data" in obj) {
      candidate = obj.data;
      continue;
    }
    break;
  }

  const extractTextFromParts = (parts: unknown[]): string | undefined => {
    const chunks: string[] = [];
    for (const part of parts) {
      if (typeof part === "string") {
        if (part.trim()) chunks.push(part);
        continue;
      }
      if (part && typeof part === "object") {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string" && text.trim()) chunks.push(text);
      }
    }
    const joined = chunks.join("").trim();
    return joined || undefined;
  };

  if (Array.isArray(candidate)) {
    for (const entry of candidate) {
      if (!isPlainObject(entry)) continue;
      const obj = entry as Record<string, unknown>;
      if (typeof obj.output_text === "string" && obj.output_text.trim()) return obj.output_text;
      if (Array.isArray(obj.content)) {
        const text = extractTextFromParts(obj.content);
        if (text) return text;
      }
    }
    return candidate;
  }

  if (isPlainObject(candidate)) {
    const obj = candidate as Record<string, unknown>;
    if (typeof obj.output_text === "string" && obj.output_text.trim()) return obj.output_text;
    const candidates = obj.candidates;
    if (Array.isArray(candidates) && candidates.length) {
      const firstCandidate = candidates[0] as Record<string, unknown>;
      const content = firstCandidate?.content;
      if (isPlainObject(content) && Array.isArray(content.parts)) {
        const text = extractTextFromParts(content.parts);
        if (text) return text;
      }
    }
    const choices = obj.choices;
    if (Array.isArray(choices) && choices.length) {
      const first = choices[0] as Record<string, unknown>;
      const message = first?.message as Record<string, unknown> | undefined;
      const content = message?.content ?? first?.text ?? (first?.delta as Record<string, unknown> | undefined)?.content;
      if (Array.isArray(content)) {
        const text = extractTextFromParts(content);
        if (text) return text;
      }
      if (typeof content === "string" && content.trim()) return content;
    }
    if (Array.isArray(obj.content)) {
      const text = extractTextFromParts(obj.content);
      if (text) return text;
    }
  }

  return candidate;
}

type QuizParseResult =
  | {
      ok: true;
      value: QuizBatch;
      pipelineSource: "legacy" | "pipeline";
      internalErrors: string[];
      debugFlag: boolean;
      reportedFailedChecks: string[];
    }
  | { ok: false; reason: "no-json" | "parse" | "validation"; validationErrors?: string[] };
type QuizParseFailureReason = "no-json" | "parse" | "validation";

function parseQuizOutput(raw: unknown, docId: string): QuizParseResult {
  return parseQuizOutputWithCount(raw, docId, QUIZ_BATCH_SIZE, docId);
}

function parseQuizCandidateWithCount(
  candidate: unknown,
  docId: string,
  expectedCount: number,
  lectureTitle: string,
): QuizParseResult {
  const inspected = inspectQuizPipelineOutput(candidate);
  const coercedBatch = coerceQuizBatchCandidate(inspected.batchCandidate, {
    lectureId: docId,
    lectureTitle,
    expectedCount,
  });
  const validationErrors = validateQuizBatchWithCount(coercedBatch, docId, expectedCount);
  if (inspected.source === "pipeline") {
    if (inspected.internalErrors.length) {
      validationErrors.push(...inspected.internalErrors.map(err => `pipeline.${err}`));
    }
    if (inspected.debugFlag) {
      validationErrors.push("pipeline.repair_debug_flag_true");
    }
    if (inspected.reportedFailedChecks.length) {
      validationErrors.push(
        ...inspected.reportedFailedChecks
          .slice(0, 10)
          .map(check => `pipeline.reported_failed_check.${check}`),
      );
    }
  }
  if (validationErrors.length) {
    return { ok: false, reason: "validation", validationErrors };
  }
  return {
    ok: true,
    value: coercedBatch as QuizBatch,
    pipelineSource: inspected.source,
    internalErrors: inspected.internalErrors,
    debugFlag: inspected.debugFlag,
    reportedFailedChecks: inspected.reportedFailedChecks,
  };
}

function parseQuizOutputWithCount(
  raw: unknown,
  docId: string,
  expectedCount: number,
  lectureTitle: string,
): QuizParseResult {
  const candidate = extractAiQuizPayload(raw);
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    return parseQuizCandidateWithCount(candidate, docId, expectedCount, lectureTitle);
  }
  if (typeof candidate === "string") {
    const parsed = parseJsonCandidate<unknown>(candidate, {
      strictExtraction: true,
    });
    if (parsed.ok && parsed.value) {
      return parseQuizCandidateWithCount(parsed.value, docId, expectedCount, lectureTitle);
    }
    return { ok: false, reason: parsed.reason || "no-json", validationErrors: parsed.validationErrors };
  }
  return { ok: false, reason: "no-json" };
}

type QuizBlockGenerationResult =
  | {
      ok: true;
      batch: QuizBatch;
      internalDebug?: {
        source: "legacy" | "pipeline";
        debugFlag: boolean;
        internalErrors: string[];
        reportedFailedChecks: string[];
      };
    }
  | {
      ok: false;
      error: "upstream_timeout" | "upstream_ai_error" | "quiz_invalid_json";
      details?: string;
      validationErrors?: string[];
      rawOutputSnippet?: string;
    };

async function generateQuizBlockSingleCall(args: {
  env: Env;
  model: string;
  questionCount: number;
  lectureTitle: string;
  docId: string;
  referenceLabels: string[];
  context: string;
  promptExclusions: string[];
  timeoutMs: number;
}): Promise<QuizBlockGenerationResult> {
  const {
    env,
    model,
    questionCount,
    lectureTitle,
    docId,
    referenceLabels,
    context,
    promptExclusions,
    timeoutMs,
  } = args;

  const prompt = buildLectureQuizPrompt({
    lectureId: docId,
    lectureTitle,
    context,
    referenceLabels,
    excludeQuestions: promptExclusions,
    count: questionCount,
  });
  const messages: ChatMessage[] = [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ];

  let raw: unknown;
  try {
    raw = await runWorkersAiWithTimeout(
      env,
      model,
      {
        messages,
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_tokens: resolveQuizMaxOutputTokens(questionCount),
      },
      timeoutMs,
    );
  } catch (err) {
    if (isQuizTimeoutError(err)) {
      return { ok: false, error: "upstream_timeout" };
    }
    return {
      ok: false,
      error: "upstream_ai_error",
      details: err instanceof Error ? err.message : String(err),
    };
  }

  const parsed = parseQuizOutputWithCount(raw, docId, questionCount, lectureTitle);
  if (parsed.ok) {
    return {
      ok: true,
      batch: parsed.value,
      internalDebug: {
        source: parsed.pipelineSource,
        debugFlag: parsed.debugFlag,
        internalErrors: parsed.internalErrors,
        reportedFailedChecks: parsed.reportedFailedChecks,
      },
    };
  }
  return {
    ok: false,
    error: "quiz_invalid_json",
    details: mapQuizFailureDetail(parsed.reason),
    validationErrors: parsed.validationErrors,
    rawOutputSnippet: clipQuizOutputSnippet(extractAiQuizPayload(raw)),
  };
}

function mapQuizFailureDetail(reason: QuizParseFailureReason | undefined): "no-json" | "parse" | "schema" {
  if (reason === "parse") return "parse";
  if (reason === "validation") return "schema";
  return "no-json";
}

function logLibraryQuizFailure(payload: {
  requestId: string;
  docId: string;
  model: string;
  stream: boolean;
  durationMs: number;
  lectureLength: number;
  status: number;
  error: string;
  details?: string;
  rawOutputSnippet?: string;
  validationErrors?: string[];
}) {
  const { validationErrors, rawOutputSnippet, ...rest } = payload;
  const trimmedErrors = validationErrors && validationErrors.length ? validationErrors.slice(0, 8) : undefined;
  const logPayload = {
    ...rest,
    validationErrors: trimmedErrors,
    rawOutputSnippet,
  };
  console.warn("[LIBRARY-QUIZ]", logPayload);
}

function resolveGeminiQuizTimeoutMs(env: Env): number {
  const override = Number.parseInt(env.GEMINI_QUIZ_TIMEOUT_MS || "", 10);
  if (Number.isFinite(override) && override > 0) return override;
  return GEMINI_QUIZ_TIMEOUT_MS;
}

function resolveGeminiQuizMaxOutputTokens(env: Env): number {
  const override = Number.parseInt(env.GEMINI_QUIZ_MAX_OUTPUT_TOKENS || "", 10);
  if (Number.isFinite(override) && override > 0) return override;
  return GEMINI_QUIZ_DEFAULT_MAX_OUTPUT_TOKENS;
}

function canonicalizeGeminiQuizModelId(
  rawModel: string | null | undefined,
  opts: { allowFallbackModel?: boolean } = {},
): string {
  const normalized = (rawModel || "").trim().toLowerCase();
  if (!normalized) return GEMINI_QUIZ_DEFAULT_MODEL;
  if (normalized === GEMINI_QUIZ_DEFAULT_MODEL) return GEMINI_QUIZ_DEFAULT_MODEL;
  if (normalized.includes("gemini-3.1-pro")) return GEMINI_QUIZ_DEFAULT_MODEL;
  if (opts.allowFallbackModel) {
    if (normalized === GEMINI_QUIZ_FALLBACK_MODEL || normalized.includes("gemini-2.5-pro")) {
      return GEMINI_QUIZ_FALLBACK_MODEL;
    }
    if (normalized === GEMINI_QUIZ_HIGH_AVAILABILITY_MODEL || normalized.includes("gemini-2.5-flash")) {
      return GEMINI_QUIZ_HIGH_AVAILABILITY_MODEL;
    }
  }
  if (normalized.includes("gemini-2.0-flash")) return GEMINI_QUIZ_DEFAULT_MODEL;
  return GEMINI_QUIZ_DEFAULT_MODEL;
}

function resolveGeminiQuizModelId(env: Env): string {
  return canonicalizeGeminiQuizModelId(env.GEMINI_QUIZ_MODEL);
}

function resolveGeminiApiBase(env: Env): string {
  return (env.GEMINI_API_BASE?.trim() || GEMINI_API_BASE_DEFAULT).replace(/\/+$/g, "");
}

function isRetryableGeminiError(result: {
  ok: false;
  error: "upstream_timeout" | "upstream_ai_error";
  details?: string;
  status?: number;
} | null | undefined): boolean {
  if (!result) return false;
  const msg = (result.details || "").toLowerCase();

  return (
    result.error === "upstream_timeout" ||
    result.status === 429 ||
    result.status === 503 ||
    msg.includes("high demand") ||
    msg.includes("temporarily unavailable") ||
    msg.includes("resource exhausted") ||
    msg.includes("overloaded") ||
    msg.includes("quota exceeded") ||
    msg.includes("try again later")
  );
}

function buildGeminiQuizModelChain(): string[] {
  return [
    "gemini-3.1-pro-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
  ];
}

function normalizeGeminiQuizCandidate(
  candidate: unknown,
  docId: string,
  lectureTitle: string,
  expectedCount: number,
): unknown {
  if (!isPlainObject(candidate)) return candidate;
  const root = isPlainObject(candidate.final_quiz)
    ? candidate.final_quiz as Record<string, unknown>
    : candidate as Record<string, unknown>;
  const questions = Array.isArray(root.questions) ? root.questions : [];
  const seenIds = new Set<string>();
  root.lectureId = typeof root.lectureId === "string" && root.lectureId.trim() ? root.lectureId.trim() : docId;
  root.lectureTitle = typeof root.lectureTitle === "string" && root.lectureTitle.trim()
    ? root.lectureTitle.trim()
    : lectureTitle;
  root.setSize = Number.isFinite(root.setSize) ? Number(root.setSize) : questions.length || expectedCount;
  root.questions = questions.map((question, index) => {
    if (!isPlainObject(question)) return question;
    const normalizedQuestion = { ...question } as Record<string, unknown>;
    const rawId = typeof normalizedQuestion.id === "string" ? normalizedQuestion.id.trim() : "";
    const nextId = rawId && !seenIds.has(rawId) ? rawId : `gq${index + 1}`;
    seenIds.add(nextId);
    normalizedQuestion.id = nextId;
    normalizedQuestion.answer = typeof normalizedQuestion.answer === "string"
      ? normalizedQuestion.answer.trim().toUpperCase()
      : normalizedQuestion.answer;
    if (Array.isArray(normalizedQuestion.choices)) {
      normalizedQuestion.choices = normalizedQuestion.choices.map((choice) => {
        if (!isPlainObject(choice)) return choice;
        return {
          ...choice,
          id: typeof choice.id === "string" ? choice.id.trim().toUpperCase() : choice.id,
        };
      });
    }
    return normalizedQuestion;
  });
  return root;
}

function parseGeminiQuizOutput(raw: unknown, docId: string, lectureTitle: string, expectedCount: number): QuizParseResult {
  const candidate = extractAiQuizPayload(raw);
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    return parseQuizCandidateWithCount(
      normalizeGeminiQuizCandidate(candidate, docId, lectureTitle, expectedCount),
      docId,
      expectedCount,
      lectureTitle,
    );
  }
  if (typeof candidate === "string") {
    const parsed = parseJsonCandidate<unknown>(candidate, {
      strictExtraction: true,
    });
    if (parsed.ok && parsed.value) {
      return parseQuizCandidateWithCount(
        normalizeGeminiQuizCandidate(parsed.value, docId, lectureTitle, expectedCount),
        docId,
        expectedCount,
        lectureTitle,
      );
    }
    return { ok: false, reason: parsed.reason || "no-json", validationErrors: parsed.validationErrors };
  }
  return { ok: false, reason: "no-json" };
}

async function runGeminiQuizRequest(args: {
  requestId: string;
  env: Env;
  model: string;
  lectureId: string;
  lectureTitle: string;
  lectureContext: string;
  priorQuestions: string[];
  referenceLabels: string[];
  questionCount: number;
  timeoutMs: number;
  maxOutputTokens: number;
}): Promise<
  | { ok: true; raw: unknown; model: string }
  | { ok: false; error: "upstream_timeout" | "upstream_ai_error"; details?: string; status?: number; raw?: unknown; model: string }
> {
  const prompt = buildGeminiQuizPrompt({
    lectureId: args.lectureId,
    lectureTitle: args.lectureTitle,
    lectureContext: args.lectureContext,
    priorQuestions: args.priorQuestions,
    referenceLabels: args.referenceLabels,
    questionCount: args.questionCount,
  });
  const runAttempt = async (
    model: string,
    timeoutMs: number,
  ): Promise<
    | { ok: true; raw: unknown; model: string }
    | { ok: false; error: "upstream_timeout" | "upstream_ai_error"; details?: string; status?: number; raw?: unknown; model: string }
  > => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const requestModel = canonicalizeGeminiQuizModelId(model, { allowFallbackModel: true });
    const url = `${resolveGeminiApiBase(args.env)}/models/${encodeURIComponent(requestModel)}:generateContent`;
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": args.env.GEMINI_API_KEY!.trim(),
        },
        body: JSON.stringify({
          systemInstruction: {
            role: "system",
            parts: [{ text: prompt.system }],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: prompt.user }],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            responseJsonSchema: buildGeminiQuizJsonSchema(args.questionCount),
            maxOutputTokens: args.maxOutputTokens,
          },
        }),
        signal: controller.signal,
      });
      const payload = await safeJson(resp);
      if (!resp.ok) {
        const detail = isPlainObject(payload) && isPlainObject(payload.error) && typeof payload.error.message === "string"
          ? payload.error.message
          : clipQuizOutputSnippet(payload) || `Gemini request failed with status ${resp.status}.`;
        return {
          ok: false,
          error: "upstream_ai_error",
          details: detail,
          status: resp.status,
          raw: payload,
          model: requestModel,
        };
      }
      return { ok: true, raw: payload, model: requestModel };
    } catch (err) {
      if (isQuizTimeoutError(err)) {
        return { ok: false, error: "upstream_timeout", model: requestModel };
      }
      return {
        ok: false,
        error: "upstream_ai_error",
        details: err instanceof Error ? err.message : String(err),
        model: requestModel,
      };
    } finally {
      clearTimeout(timeout);
    }
  };

  type GeminiQuizAttemptResult = Awaited<ReturnType<typeof runAttempt>>;

  async function runAttemptWithRetry(
    model: string,
    timeoutMs: number,
  ): Promise<GeminiQuizAttemptResult> {
    let result: GeminiQuizAttemptResult | null = null;

    for (let i = 0; i < 2; i += 1) {
      result = await runAttempt(model, timeoutMs);
      if (result.ok) return result;
    }

    return result!;
  }

  const modelChain = buildGeminiQuizModelChain();
  let lastError: Exclude<GeminiQuizAttemptResult, { ok: true }> | null = null;

  for (const model of modelChain) {
    const result = await runAttemptWithRetry(model, args.timeoutMs);

    if (result.ok) {
      if (model !== modelChain[0]) {
        console.warn("[QUIZ-DEGRADE] model fallback used", {
          selectedModel: model,
          reason: lastError?.details || "unknown",
        });
      }
      return result;
    }

    lastError = result;
    console.warn("[QUIZ-DEGRADE-TRACE]", {
      modelAttempted: model,
      error: result.details,
      status: result.status,
    });

    if (!isRetryableGeminiError(result)) return result;
  }

  return lastError || {
    ok: false,
    error: "upstream_ai_error",
    details: "Gemini quiz generation failed.",
    model: modelChain[modelChain.length - 1] || GEMINI_QUIZ_DEFAULT_MODEL,
  };
}

async function handleLibraryGeminiQuiz(req: Request, env: Env): Promise<Response> {
  const requestId = `lib-gemini-quiz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  const model = resolveGeminiQuizModelId(env);
  const timeoutMs = resolveGeminiQuizTimeoutMs(env);
  const maxOutputTokens = resolveGeminiQuizMaxOutputTokens(env);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonNoStore({
      ok: false,
      error: "bad_request_invalid_json",
      message: "Invalid JSON request body",
      requestId,
    }, 400);
  }
  if (!body || typeof body !== "object") {
    return jsonNoStore({
      ok: false,
      error: "bad_request_invalid_json",
      message: "Invalid JSON request body",
      requestId,
    }, 400);
  }
  const docId = typeof (body as any).docId === "string" ? (body as any).docId.trim() : "";
  if (!docId) {
    return jsonNoStore({
      ok: false,
      error: "bad_request_missing_docId",
      message: "Missing docId.",
      requestId,
    }, 400);
  }
  const txtKey = typeof (body as any).txtKey === "string" ? (body as any).txtKey.trim() : "";
  if (!txtKey || !isMachineTxtKey(txtKey)) {
    return jsonNoStore({
      ok: false,
      error: "machine_txt_not_found",
      message: "Lecture TXT not found for this selection.",
      requestId,
      docId,
    }, 404);
  }
  const lectureTitleInput = typeof (body as any).lectureTitle === "string" ? (body as any).lectureTitle.trim() : "";
  const countInput = Number((body as any).count);
  const count = Number.isFinite(countInput) && countInput > 0 ? Math.floor(countInput) : QUIZ_BATCH_SIZE;
  const priorQuestionsInput = Array.isArray((body as any).priorQuestions) ? (body as any).priorQuestions : [];
  const priorQuestions = priorQuestionsInput
    .map((item: unknown) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  const apiKey = env.GEMINI_API_KEY?.trim() || "";
  if (!apiKey) {
    logLibraryQuizFailure({
      requestId,
      docId,
      model,
      stream: false,
      durationMs: Date.now() - startedAt,
      lectureLength: 0,
      status: 502,
      error: "gemini_api_key_missing",
    });
    return jsonNoStore({
      ok: false,
      error: "gemini_api_key_missing",
      message: "Gemini quiz generation is not configured.",
      requestId,
      docId,
    }, 502);
  }

  let extractedText: string | null = null;
  try {
    const rawTxt = await loadMachineTxtFromStorage(env, txtKey);
    extractedText = rawTxt ? normalizePlainText(rawTxt) : null;
  } catch (err) {
    console.error("[LIBRARY-GEMINI-QUIZ] machine txt load failed", {
      requestId,
      docId,
      txtKey,
      error: err instanceof Error ? err.message : String(err),
    });
    extractedText = null;
  }
  if (!extractedText) {
    return jsonNoStore({
      ok: false,
      error: "machine_txt_not_found",
      message: "Lecture TXT not found for this selection.",
      requestId,
      docId,
    }, 404);
  }

  const text = extractedText.slice(0, MAX_OCR_TEXT_LENGTH);
  if (text.length < QUIZ_MIN_TEXT_CHARS) {
    return jsonNoStore({
      ok: false,
      error: "txt_not_ready",
      message: "Extracted text too small or not ready yet.",
      requestId,
      docId,
    }, 404);
  }

  const lectureTitle = lectureTitleInput || scrubMachineTxtFilename(txtKey.split("/").pop() || "") || docId;
  const setIndex = Math.floor(priorQuestions.length / Math.max(1, count));
  const chunks = chunkText(text, { size: QUIZ_CONTEXT_CHUNK_SIZE, overlap: QUIZ_CONTEXT_CHUNK_OVERLAP });
  const totalChunks = chunks.length;
  const windowSize = Math.min(QUIZ_CONTEXT_CHUNK_COUNT, totalChunks || QUIZ_CONTEXT_CHUNK_COUNT);
  const fallbackCursor = totalChunks ? clampQuizCursor(setIndex * windowSize, totalChunks) : 0;
  const fallbackUsedWindows = totalChunks ? buildQuizWindowHistory(setIndex, windowSize, totalChunks) : [];
  const windowSelection = selectQuizChunkWindow(chunks, {
    cursor: fallbackCursor,
    windowSize,
    usedWindowStarts: fallbackUsedWindows,
  });
  const { context, referenceLabels } = buildQuizContext(windowSelection.selected);
  const promptExclusions = buildQuizPromptExclusions(priorQuestions);
  const exclusionIndex = buildQuizExclusionIndex(priorQuestions, []);
  const excludedCount = exclusionIndex.excludedCount;
  const lectureLength = context.length;
  const upstream = await runGeminiQuizRequest({
    requestId,
    env,
    model,
    lectureId: docId,
    lectureTitle,
    lectureContext: context,
    priorQuestions: promptExclusions.list,
    referenceLabels,
    questionCount: count,
    timeoutMs,
    maxOutputTokens,
  });
  if (!upstream.ok) {
    const durationMs = Date.now() - startedAt;
    logLibraryQuizFailure({
      requestId,
      docId,
      model: upstream.model,
      stream: false,
      durationMs,
      lectureLength,
      status: upstream.status || (upstream.error === "upstream_timeout" ? 504 : 502),
      error: upstream.error,
      details: upstream.details,
      rawOutputSnippet: clipQuizOutputSnippet(upstream.raw),
    });
    return jsonResponse({
      ok: false,
      error: "quiz_generation_failed",
      message: "Temporary generation issue — retrying usually resolves this.",
    }, 200);
  }

  const parsed = parseGeminiQuizOutput(upstream.raw, docId, lectureTitle, count);
  if (!parsed.ok) {
    const durationMs = Date.now() - startedAt;
    const details = mapQuizFailureDetail(parsed.reason);
    logLibraryQuizFailure({
      requestId,
      docId,
      model: upstream.model,
      stream: false,
      durationMs,
      lectureLength,
      status: 502,
      error: "quiz_invalid_json",
      details,
      validationErrors: parsed.validationErrors,
      rawOutputSnippet: clipQuizOutputSnippet(extractAiQuizPayload(upstream.raw)),
    });
    return jsonNoStore({
      ok: false,
      error: "quiz_invalid_json",
      message: "Gemini quiz generation failed JSON validation.",
      requestId,
      docId,
      details,
      validationErrors: parsed.validationErrors ? parsed.validationErrors.slice(0, 8) : undefined,
    }, 502);
  }

  const dedupeFingerprints = new Set(exclusionIndex.fingerprintSet);
  const dedupeTokenSets = exclusionIndex.tokenSets.slice();
  const acceptedQuestions: QuizQuestion[] = [];
  const acceptedFingerprints: string[] = [];
  const allCandidates: QuizQuestion[] = [];
  const usedIds = new Set<string>();
  for (const question of parsed.value.questions) {
    if (acceptedQuestions.length >= count) break;
    allCandidates.push(question);
    const stem = typeof question.stem === "string" ? question.stem : "";
    const fingerprintData = buildQuizFingerprint(stem);
    addQuizPromptExclusion(promptExclusions, stem);
    if (!fingerprintData) continue;
    const { fingerprint, tokens } = fingerprintData;
    if (dedupeFingerprints.has(fingerprint) || isNearDuplicate(tokens, dedupeTokenSets)) {
      continue;
    }
    acceptedQuestions.push(normalizeQuizQuestionForOutput(question, usedIds));
    acceptedFingerprints.push(fingerprint);
    dedupeFingerprints.add(fingerprint);
    dedupeTokenSets.push(tokens);
  }

  let coverageExhausted = windowSelection.exhausted;
  let finalQuestions = acceptedQuestions;
  if (acceptedQuestions.length < count) {
    coverageExhausted = true;
    finalQuestions = fillQuizQuestionsWithDuplicates(acceptedQuestions, allCandidates, count, usedIds);
  }

  const uniqueFingerprintList = [...exclusionIndex.ordered, ...acceptedFingerprints];
  const fingerprintSeen = new Set<string>();
  const mergedFingerprints: string[] = [];
  for (const fingerprint of uniqueFingerprintList) {
    if (!fingerprint || fingerprintSeen.has(fingerprint)) continue;
    fingerprintSeen.add(fingerprint);
    mergedFingerprints.push(fingerprint);
  }

  const batch: QuizBatch = {
    lectureId: docId,
    lectureTitle: parsed.value.lectureTitle || lectureTitle,
    setSize: count,
    questions: finalQuestions,
  };
  const validationErrors = validateQuizBatchWithCount(batch, docId, count);
  if (validationErrors.length) {
    return jsonNoStore({
      ok: false,
      error: "quiz_invalid_json",
      message: "Gemini quiz generation failed JSON validation.",
      requestId,
      docId,
      validationErrors: validationErrors.slice(0, 8),
    }, 502);
  }

  const continuationToken = buildQuizContinuationToken({
    v: 1,
    docId,
    cursor: windowSelection.nextCursor,
    usedChunkWindows: windowSelection.usedWindowStarts,
    usedQuestionFingerprints: mergedFingerprints.slice(-QUIZ_TOKEN_MAX_FINGERPRINTS),
    count,
  });
  const coverage: QuizCoverage = {
    cursor: windowSelection.start,
    windowSize: windowSelection.windowSize,
    totalChunks: windowSelection.totalChunks,
    exhausted: coverageExhausted,
  };

  return jsonNoStore({
    ok: true,
    requestId,
    docId,
    provider: "gemini",
    model: upstream.model,
    batch,
    continuationToken,
    coverage,
    excludedCount,
    prefetchedBatches: [],
  });
}

async function handleLibraryQuiz(req: Request, env: Env): Promise<Response> {
  const requestId = `lib-quiz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  const model = resolveQuizModelId(env);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    logLibraryQuizFailure({
      requestId,
      docId: "",
      model,
      stream: false,
      durationMs: Date.now() - startedAt,
      lectureLength: 0,
      status: 400,
      error: "bad_request_invalid_json",
      details: "invalid_json",
    });
    return jsonNoStore({
      ok: false,
      error: "bad_request_invalid_json",
      message: "Invalid JSON request body",
      requestId,
    }, 400);
  }
  if (!body || typeof body !== "object") {
    logLibraryQuizFailure({
      requestId,
      docId: "",
      model,
      stream: false,
      durationMs: Date.now() - startedAt,
      lectureLength: 0,
      status: 400,
      error: "bad_request_invalid_json",
      details: "empty_body",
    });
    return jsonNoStore({
      ok: false,
      error: "bad_request_invalid_json",
      message: "Invalid JSON request body",
      requestId,
    }, 400);
  }
  const docId =
    typeof (body as any).docId === "string"
      ? (body as any).docId.trim()
      : typeof (body as any).lectureId === "string"
        ? (body as any).lectureId.trim()
        : "";
  if (!docId) {
    logLibraryQuizFailure({
      requestId,
      docId: "",
      model,
      stream: false,
      durationMs: Date.now() - startedAt,
      lectureLength: 0,
      status: 400,
      error: "bad_request_missing_docId",
    });
    return jsonNoStore({ ok: false, error: "bad_request_missing_docId", message: "Missing docId.", requestId }, 400);
  }
  const lectureTitleInput =
    typeof (body as any).lectureTitle === "string"
      ? (body as any).lectureTitle.trim()
      : typeof (body as any).displayName === "string"
        ? (body as any).displayName.trim()
        : "";
  const sourceType = typeof (body as any).sourceType === "string" ? (body as any).sourceType.trim().toLowerCase() : "";
  const txtKeyInput = typeof (body as any).txtKey === "string" ? (body as any).txtKey.trim() : "";
  const useMachineTxt = sourceType === "machine_txt" || sourceType === "machine-txt" || isMachineTxtKey(txtKeyInput);
  const useStoredQbank = sourceType === STORED_QBANK_SOURCE_TYPE;
  const continuationTokenInput =
    typeof (body as any).continuationToken === "string" ? (body as any).continuationToken.trim() : "";
  const priorQuestionsInput = Array.isArray((body as any).priorQuestions) ? (body as any).priorQuestions : [];
  const priorQuestions = priorQuestionsInput
    .map((item: unknown) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  const setIndexInput = Number((body as any).setIndex);
  const setIndex = Number.isFinite(setIndexInput) && setIndexInput >= 0 ? Math.floor(setIndexInput) : 0;
  const countInput = Number((body as any).count);
  const requestedCount = Number.isFinite(countInput) && countInput > 0 ? Math.floor(countInput) : undefined;

  const parsedToken = continuationTokenInput ? parseQuizContinuationToken(continuationTokenInput) : null;
  if (continuationTokenInput && (!parsedToken || parsedToken.docId !== docId)) {
    logLibraryQuizFailure({
      requestId,
      docId,
      model,
      stream: false,
      durationMs: Date.now() - startedAt,
      lectureLength: 0,
      status: 400,
      error: "invalid_continuation_token",
    });
    return jsonNoStore({
      ok: false,
      error: "invalid_continuation_token",
      message: "Continuation token is invalid or does not match the requested docId.",
      requestId,
      docId,
    }, 400);
  }

  const count =
    requestedCount ??
    (parsedToken && Number.isFinite(parsedToken.count) && parsedToken.count > 0
      ? Math.floor(parsedToken.count)
      : QUIZ_BATCH_SIZE);

  let docTitle: string | undefined = lectureTitleInput || undefined;
  if (!docTitle) {
    try {
      const { bucket } = getLibraryBucket(env);
      const indexRecords = await readLibraryIndex(bucket);
      const match = indexRecords.find(rec => rec.docId === docId);
      docTitle = match?.title || undefined;
    } catch {
      docTitle = undefined;
    }
    try {
      const { bucket } = getLibraryBucket(env);
      const manifest = await readManifest(bucket, docId);
      if (manifest?.title && !docTitle) {
        docTitle = manifest.title;
      }
    } catch {
      // best-effort manifest lookup
    }
  }

  if (useStoredQbank) {
    const { bucket } = getLibraryBucket(env);
    const stored = await loadStoredQbankDocument(bucket, docId);
    if (!stored || !Array.isArray(stored.questions) || !stored.questions.length) {
      logLibraryQuizFailure({
        requestId,
        docId,
        model,
        stream: false,
        durationMs: Date.now() - startedAt,
        lectureLength: 0,
        status: 404,
        error: "stored_qbank_not_found",
      });
      return jsonNoStore({
        ok: false,
        error: "stored_qbank_not_found",
        message: "No stored qbank found for this lecture.",
        requestId,
        docId,
      }, 404);
    }
    const result = buildStoredQbankQuizResponse(stored, {
      docId,
      lectureTitle: docTitle || stored.lectureTitle || lectureTitleInput || docId,
      count,
      cursor: parsedToken?.cursor || 0,
    });
    return jsonNoStore({
      ok: true,
      requestId,
      docId,
      extractedKey: result.extractedKey,
      batch: result.batch,
      continuationToken: result.continuationToken,
      coverage: result.coverage,
      excludedCount: 0,
    });
  }

  let extractedKey = "";
  let extractedText: string | null = null;
  if (useMachineTxt) {
    if (!txtKeyInput || !isMachineTxtKey(txtKeyInput)) {
      logLibraryQuizFailure({
        requestId,
        docId,
        model,
        stream: false,
        durationMs: Date.now() - startedAt,
        lectureLength: 0,
        status: 404,
        error: "machine_txt_not_found",
      });
      return jsonNoStore({
        ok: false,
        error: "machine_txt_not_found",
        message: "Unable to load lecture TXT.",
        requestId,
        docId,
      }, 404);
    }
    try {
      const rawTxt = await loadMachineTxtFromStorage(env, txtKeyInput);
      extractedKey = txtKeyInput;
      extractedText = rawTxt ? normalizePlainText(rawTxt) : null;
    } catch (err) {
      console.error("[LIBRARY-QUIZ] machine txt load failed", {
        requestId,
        docId,
        txtKey: txtKeyInput,
        error: err instanceof Error ? err.message : String(err),
      });
      extractedText = null;
    }
    if (!extractedText) {
      logLibraryQuizFailure({
        requestId,
        docId,
        model,
        stream: false,
        durationMs: Date.now() - startedAt,
        lectureLength: 0,
        status: 404,
        error: "machine_txt_not_found",
      });
      return jsonNoStore({
        ok: false,
        error: "machine_txt_not_found",
        message: "Lecture TXT not found for this selection.",
        requestId,
        docId,
      }, 404);
    }
  } else {
    const { bucket } = getLibraryBucket(env);
    const cache = await loadCachedExtraction(bucket, docId);
    extractedKey = cache.extractedKey;
    extractedText =
      cache.text ||
      (cache as any).extractedText ||
      (cache as any).content ||
      (cache as any).ocrText ||
      (cache as any).textContent ||
      null;
    if (!extractedText) {
      logLibraryQuizFailure({
        requestId,
        docId,
        model,
        stream: false,
        durationMs: Date.now() - startedAt,
        lectureLength: 0,
        status: 404,
        error: "extracted_text_not_found",
      });
      return jsonNoStore({
        ok: false,
        error: "extracted_text_not_found",
        message: "Lecture text not found for this selection.",
        requestId,
        docId,
      }, 404);
    }
  }

  const text = extractedText.slice(0, MAX_OCR_TEXT_LENGTH);
  if (text.length < QUIZ_MIN_TEXT_CHARS) {
    logLibraryQuizFailure({
      requestId,
      docId,
      model,
      stream: false,
      durationMs: Date.now() - startedAt,
      lectureLength: text.length,
      status: 404,
      error: useMachineTxt ? "txt_not_ready" : "ocr_not_ready",
    });
    return jsonNoStore({
      ok: false,
      error: useMachineTxt ? "txt_not_ready" : "ocr_not_ready",
      message: "Extracted text too small or not ready yet.",
      requestId,
      docId,
    }, 404);
  }

  const chunks = chunkText(text, { size: QUIZ_CONTEXT_CHUNK_SIZE, overlap: QUIZ_CONTEXT_CHUNK_OVERLAP });
  const totalChunks = chunks.length;
  const windowSize = Math.min(QUIZ_CONTEXT_CHUNK_COUNT, totalChunks || QUIZ_CONTEXT_CHUNK_COUNT);
  const fallbackCursor = totalChunks ? clampQuizCursor(setIndex * windowSize, totalChunks) : 0;
  const fallbackUsedWindows = totalChunks ? buildQuizWindowHistory(setIndex, windowSize, totalChunks) : [];
  const windowSelection = selectQuizChunkWindow(chunks, {
    cursor: parsedToken ? parsedToken.cursor : fallbackCursor,
    windowSize,
    usedWindowStarts: parsedToken ? parsedToken.usedChunkWindows : fallbackUsedWindows,
  });
  const { context, referenceLabels } = buildQuizContext(windowSelection.selected);
  const promptSourceQuestions = priorQuestions.concat(parsedToken?.usedQuestionFingerprints || []);
  const promptExclusions = buildQuizPromptExclusions(promptSourceQuestions);
  const exclusionIndex = buildQuizExclusionIndex(priorQuestions, parsedToken?.usedQuestionFingerprints || []);
  const excludedCount = exclusionIndex.excludedCount;
  const promptLectureTitle = docTitle || lectureTitleInput || docId;
  const lectureLength = text.length;

  if (!env.AI || typeof env.AI.run !== "function") {
    logLibraryQuizFailure({
      requestId,
      docId,
      model,
      stream: false,
      durationMs: Date.now() - startedAt,
      lectureLength,
      status: 502,
      error: "upstream_ai_unavailable",
    });
    return jsonNoStore({
      ok: false,
      error: "upstream_ai_unavailable",
      message: "AI binding not configured.",
      requestId,
      docId,
    }, 502);
  }

  const timeoutMs = resolveQuizTimeoutMs(env);
  const generateQuizBlock = async (questionCount: number) => {
    return await generateQuizBlockSingleCall({
      env,
      model,
      questionCount,
      lectureTitle: promptLectureTitle,
      docId,
      referenceLabels,
      context,
      promptExclusions: promptExclusions.list,
      timeoutMs,
    });
  };

  const initialBlock = await generateQuizBlock(count);
  if (!initialBlock.ok) {
    const durationMs = Date.now() - startedAt;
    if (initialBlock.error === "upstream_timeout") {
      logLibraryQuizFailure({
        requestId,
        docId,
        model,
        stream: false,
        durationMs,
        lectureLength,
        status: 504,
        error: "upstream_timeout",
      });
      return jsonNoStore({
        ok: false,
        error: "upstream_timeout",
        message: "Quiz generation timed out.",
        requestId,
        docId,
      }, 504);
    }
    const message =
      initialBlock.error === "quiz_invalid_json"
        ? "Quiz generation failed after repair attempts."
        : initialBlock.details || "Quiz generation failed.";
    logLibraryQuizFailure({
      requestId,
      docId,
      model,
      stream: false,
      durationMs,
      lectureLength,
      status: 502,
      error: initialBlock.error,
      details: initialBlock.details || message,
      validationErrors: initialBlock.validationErrors,
      rawOutputSnippet: initialBlock.rawOutputSnippet,
    });
    return jsonNoStore({
      ok: false,
      error: initialBlock.error,
      message,
      requestId,
      docId,
      details: initialBlock.details,
      validationErrors: initialBlock.validationErrors ? initialBlock.validationErrors.slice(0, 8) : undefined,
    }, 502);
  }
  if (
    initialBlock.internalDebug &&
    (
      initialBlock.internalDebug.debugFlag ||
      initialBlock.internalDebug.internalErrors.length ||
      initialBlock.internalDebug.reportedFailedChecks.length
    )
  ) {
    console.warn("[LIBRARY-QUIZ] hidden_pipeline_debug", {
      requestId,
      docId,
      source: initialBlock.internalDebug.source,
      debugFlag: initialBlock.internalDebug.debugFlag,
      internalErrors: initialBlock.internalDebug.internalErrors.slice(0, 10),
      reportedFailedChecks: initialBlock.internalDebug.reportedFailedChecks.slice(0, 10),
    });
  }

  const dedupeFingerprints = new Set(exclusionIndex.fingerprintSet);
  const dedupeTokenSets = exclusionIndex.tokenSets.slice();
  const acceptedQuestions: QuizQuestion[] = [];
  const acceptedFingerprints: string[] = [];
  const allCandidates: QuizQuestion[] = [];
  const usedIds = new Set<string>();
  const collectQuestions = (questions: QuizQuestion[]) => {
    for (const question of questions) {
      if (acceptedQuestions.length >= count) break;
      allCandidates.push(question);
      const stem = typeof question.stem === "string" ? question.stem : "";
      const fingerprintData = buildQuizFingerprint(stem);
      addQuizPromptExclusion(promptExclusions, stem);
      if (!fingerprintData) continue;
      const { fingerprint, tokens } = fingerprintData;
      if (dedupeFingerprints.has(fingerprint) || isNearDuplicate(tokens, dedupeTokenSets)) {
        continue;
      }
      acceptedQuestions.push(normalizeQuizQuestionForOutput(question, usedIds));
      acceptedFingerprints.push(fingerprint);
      dedupeFingerprints.add(fingerprint);
      dedupeTokenSets.push(tokens);
    }
  };

  collectQuestions(initialBlock.batch.questions);

  let coverageExhausted = windowSelection.exhausted;
  let finalQuestions = acceptedQuestions;
  if (acceptedQuestions.length < count) {
    coverageExhausted = true;
    finalQuestions = fillQuizQuestionsWithDuplicates(acceptedQuestions, allCandidates, count, usedIds);
  }

  const uniqueFingerprintList = [...exclusionIndex.ordered, ...acceptedFingerprints];
  const fingerprintSeen = new Set<string>();
  const mergedFingerprints: string[] = [];
  for (const fp of uniqueFingerprintList) {
    if (!fp || fingerprintSeen.has(fp)) continue;
    fingerprintSeen.add(fp);
    mergedFingerprints.push(fp);
  }
  const continuationToken = buildQuizContinuationToken({
    v: 1,
    docId,
    cursor: windowSelection.nextCursor,
    usedChunkWindows: windowSelection.usedWindowStarts,
    usedQuestionFingerprints: mergedFingerprints.slice(-QUIZ_TOKEN_MAX_FINGERPRINTS),
    count,
  });
  const coverage: QuizCoverage = {
    cursor: windowSelection.start,
    windowSize: windowSelection.windowSize,
    totalChunks: windowSelection.totalChunks,
    exhausted: coverageExhausted,
  };

  const lectureTitle = initialBlock.batch.lectureTitle || docTitle || lectureTitleInput || docId;
  return jsonNoStore({
    ok: true,
    requestId,
    docId,
    extractedKey,
    batch: {
      lectureId: docId,
      lectureTitle,
      setSize: count,
      questions: finalQuestions,
    },
    continuationToken,
    coverage,
    excludedCount,
  });
}

async function handleLibraryQuizInterrupt(req: Request, env: Env): Promise<Response> {
  const requestId = `lib-quiz-interrupt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const body = await req.json().catch(() => ({}));
  const docId =
    typeof (body as any).docId === "string"
      ? (body as any).docId.trim()
      : typeof (body as any).lectureId === "string"
        ? (body as any).lectureId.trim()
        : "";
  return jsonNoStore({
    ok: true,
    requestId,
    docId,
  });
}

async function handleLibraryBatchIndex(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const bucketsInput = Array.isArray((body as any).buckets) ? (body as any).buckets : null;
  const bucketNames = bucketsInput?.length
    ? bucketsInput.map((b: unknown) => String(b)).filter(Boolean)
    : Object.keys(BUCKET_BINDINGS);

  const { bucket: libraryBucket } = getLibraryBucket(env);
  const existingIndex = await readLibraryIndex(libraryBucket);
  const existingByDocId = new Map(existingIndex.map(rec => [rec.docId, rec]));
  const records: LibraryIndexRecord[] = [];
  let totalObjects = 0;
  let indexed = 0;

  for (const bucketName of bucketNames) {
    let lookup: R2Bucket;
    try {
      lookup = getBucketByName(env, bucketName);
    } catch {
      console.warn("[LIBRARY-BATCH-INDEX] unknown bucket", { bucketName });
      continue;
    }
    const objects = await listLibrarySourceObjectsFromBucket(lookup);
    totalObjects += objects.length;
    for (const obj of objects) {
      const canonicalKey = typeof obj.key === "string" ? obj.key.trim() : obj.key;
      const isDocUpload = isLibraryWordKey(canonicalKey || "");
      const { docId, basis, fieldsUsed, uploaded } = await computeDocId(bucketName, canonicalKey, {
        etag: obj.etag,
        size: obj.size,
        uploaded: obj.uploaded,
      });
      const title = titleFromKey(canonicalKey);
      const extractedKey = buildExtractedPath(docId);
      let status: "ready" | "missing" | "needs_browser_ocr" = "missing";
      const manifest = await readManifest(libraryBucket, docId);
      if (manifest && manifest.method === "ocr" && !manifest.pagesProcessed) {
        status = "needs_browser_ocr";
      }
      if (isDocUpload) {
        const machineTxtKey = await resolvePreferredMachineTxtKey(libraryBucket, docId, title);
        const machineTxtHead = await resolveObjectHead(libraryBucket, machineTxtKey);
        if (machineTxtHead.exists) {
          status = "ready";
        } else {
          status = status === "needs_browser_ocr" ? "needs_browser_ocr" : "missing";
        }
      } else {
        try {
          const head = typeof libraryBucket.head === "function" ? await libraryBucket.head(extractedKey) : await libraryBucket.get(extractedKey, { range: { offset: 0, length: 0 } as any });
          if (head) status = "ready";
        } catch {
          status = "missing";
        }
      }
      const prior = existingByDocId.get(docId);
      const record: LibraryIndexRecord = {
        docId,
        bucket: bucketName,
        key: canonicalKey,
        title,
        normalizedTokens: tokensFromTitle(title),
        hashBasis: basis,
        hashFieldsUsed: fieldsUsed,
        etag: obj.etag,
        size: obj.size,
        uploaded: uploaded || obj.uploaded?.toISOString?.(),
        status,
        ingestionType: isDocUpload ? "doc_upload" : prior?.ingestionType,
        extractedKey,
        manifestKey: buildManifestPath(docId),
        preview: manifest?.preview,
      };
      if (prior && Object.prototype.hasOwnProperty.call(prior, "yearId")) {
        record.yearId = prior.yearId;
      }
      if (prior && Object.prototype.hasOwnProperty.call(prior, "courseId")) {
        record.courseId = prior.courseId ?? null;
      }
      if (prior && Object.prototype.hasOwnProperty.call(prior, "examId")) {
        record.examId = normalizeLibraryExam(prior.examId) ?? undefined;
      }
      if (prior && Object.prototype.hasOwnProperty.call(prior, "hasStoredQbank")) {
        record.hasStoredQbank = Boolean(prior.hasStoredQbank);
      }
      if (prior && typeof prior.storedQbankCount === "number") {
        record.storedQbankCount = prior.storedQbankCount;
      }
      if (prior && typeof prior.storedQbankUploadedAt === "string") {
        record.storedQbankUploadedAt = prior.storedQbankUploadedAt;
      }
      if (prior && typeof prior.storedQbankKey === "string") {
        record.storedQbankKey = prior.storedQbankKey;
      }
      records.push(record);
      indexed += 1;
    }
  }

  if (records.length) {
    await writeLibraryIndex(libraryBucket, records);
    await Promise.all(
      records.map(rec =>
        libraryBucket.put(buildIndexKeyForDoc(rec.docId), JSON.stringify(rec), {
          httpMetadata: { contentType: "application/json; charset=utf-8" },
        }),
      ),
    );
  }

  return json({
    status: "ok",
    buckets: bucketNames,
    indexed,
    totalObjects,
    indexKey: LIBRARY_INDEX_KEY,
  });
}

async function handleLibraryBatchIngest(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const bucketsInput = Array.isArray((body as any).buckets) ? (body as any).buckets : null;
  const modeInput = typeof (body as any).mode === "string" ? (body as any).mode : "embedded_only";
  const mode = modeInput === "full" ? "full" : "embedded_only";
  const maxDocsRaw = Number((body as any).maxDocs);
  const maxDocs = Number.isFinite(maxDocsRaw) && maxDocsRaw > 0 ? maxDocsRaw : undefined;
  const bucketNames = bucketsInput?.length
    ? bucketsInput.map((b: unknown) => String(b)).filter(Boolean)
    : Object.keys(BUCKET_BINDINGS);

  const queue: Array<{ docId: string; bucket: string; key: string; title: string; pageCount?: number; downloadUrl: string }> = [];
  let processed = 0;
  let ready = 0;
  let skipped = 0;
  let needsBrowser = 0;

  for (const bucketName of bucketNames) {
    let lookup: R2Bucket;
    try {
      lookup = getBucketByName(env, bucketName);
    } catch {
      console.warn("[LIBRARY-BATCH-INGEST] unknown bucket", { bucketName });
      continue;
    }
    const objects = await listLibrarySourceObjectsFromBucket(lookup, { limit: maxDocs ? Math.max(1, maxDocs - processed) : undefined });
    for (const obj of objects) {
      if (maxDocs && processed >= maxDocs) break;
      processed += 1;
      if (isLibraryWordKey(obj.key || "")) {
        try {
          const { docId } = await computeDocId(bucketName, obj.key, {
            etag: obj.etag,
            size: obj.size,
            uploaded: obj.uploaded,
          });
          const machineTxtKey = await resolvePreferredMachineTxtKey(getLibraryBucket(env).bucket, docId, titleFromKey(obj.key));
          const machineTxtHead = await resolveObjectHead(getLibraryBucket(env).bucket, machineTxtKey);
          if (machineTxtHead.exists) {
            ready += 1;
          } else {
            skipped += 1;
          }
        } catch (err) {
          console.warn("[LIBRARY-BATCH-INGEST] doc upload readiness check failed", {
            bucketName,
            key: obj.key,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }
      try {
        const result = await ingestLibraryObject(env, { bucketName, key: obj.key, skipCache: false, mode });
        if (result.status === "cache_hit") {
          skipped += 1;
          continue;
        }
        if (result.status === "needs_browser_ocr") {
          needsBrowser += 1;
          if (mode === "full" && queue.length < LIBRARY_QUEUE_MAX) {
            queue.push({
              docId: result.docId,
              bucket: bucketName,
              key: obj.key,
              title: titleFromKey(obj.key),
              pageCount: result.pageCount,
              downloadUrl: result.downloadUrl || buildLibraryDownloadUrl(bucketName, obj.key),
            });
          }
          continue;
        }
        ready += 1;
      } catch (err) {
        console.warn("[LIBRARY-BATCH-INGEST] failed for object", { bucketName, key: obj.key, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  let queueKey = "";
  if (queue.length) {
    const { bucket } = getLibraryBucket(env);
    queueKey = `${LIBRARY_QUEUE_PREFIX}${Date.now()}.json`;
    await bucket.put(queueKey, JSON.stringify({ docs: queue, createdAt: new Date().toISOString() }), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  }

  return json({
    status: "ok",
    mode,
    processed,
    ready,
    skipped,
    needs_browser_ocr: needsBrowser,
    queueKey: queueKey || undefined,
    queued: queue.length,
  });
}

async function handleSignedUrl(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const bucketName = url.searchParams.get("bucket") || "";
  const key = url.searchParams.get("key") || "";
  if (!bucketName || !key) {
    return json({ error: "Missing bucket or key." }, 400);
  }
  try {
    const bucket = getBucketByName(env, bucketName);
    const exists = typeof bucket.head === "function" ? await bucket.head(key) : await bucket.get(key, { range: { offset: 0, length: 0 } as any });
    if (!exists) return json({ error: "Not found." }, 404);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: "Not found", details: msg }, 404);
  }
  const downloadUrl = buildLibraryDownloadUrl(bucketName, key);
  return json({ url: downloadUrl, bucket: bucketName, key });
}

async function handleAskDoc(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return jsonNoStore({ error: "Send JSON { extractedKey?, fileHash?, question }." }, 400);
  }
  const question = typeof (body as any).question === "string" ? (body as any).question.trim() : "";
  const extractedKeyInput = typeof (body as any).extractedKey === "string" ? (body as any).extractedKey.trim() : "";
  const fileHash = typeof (body as any).fileHash === "string" ? (body as any).fileHash.trim() : "";
  if (!question) return jsonNoStore({ error: "Missing question." }, 400);
  if (!extractedKeyInput && !fileHash) return jsonNoStore({ error: "Provide extractedKey or fileHash." }, 400);

  const extractedKey = extractedKeyInput || buildExtractedKeyForHash(fileHash);
  const { bucket } = getExtractionBucket(env);
  const object = await bucket.get(extractedKey);
  if (!object || !object.body) {
    return jsonNoStore({ error: "extracted_text_not_found", details: "No extracted text stored for this file." }, 404);
  }
  const text = normalizePlainText(await object.text()).slice(0, MAX_OCR_TEXT_LENGTH);
  if (!text) {
    return jsonNoStore({ error: "extracted_text_empty", details: "Stored text is empty." }, 404);
  }

  const chunks = chunkText(text, { size: RETRIEVAL_CHUNK_SIZE, overlap: RETRIEVAL_CHUNK_OVERLAP });
  const ranked = rankChunks(question, chunks, RETRIEVAL_TOP_K);
  const selected = ranked.length ? ranked : chunks.slice(0, Math.min(RETRIEVAL_TOP_K, chunks.length));
  console.log("[ASK-DOC] retrieval", {
    extractedKey,
    totalChunks: chunks.length,
    selectedChunks: selected.map(chunk => chunk.index),
  });

  try {
    const tableIntent = isTableIntent(question);
    const excerptsAllowed = tableIntent ? false : allowExcerpts(question);
    const tableHeaders = tableIntent ? deriveTableHeaders(question) : undefined;
    debugFormatLog("[ASK-DOC] format route", {
      tableIntent,
      allowExcerpts: excerptsAllowed,
      tableHeaders,
      selectedChunks: selected.length,
    });
    const rawAnswerResult = await answerWithRetrievedChunks(env, selected, question, {
      tableOnly: tableIntent,
      tableSchema: tableIntent ? undefined : undefined,
      tableHeaders,
      allowExcerpts: excerptsAllowed,
    });
    const rawAnswer = rawAnswerResult.fullText;
    const preferTable = tableIntent || isInherentlyTabularQuestion(question);
    const formatted = preferTable ? trimAfterFirstTable(rawAnswer) : rawAnswer;
    const repaired = preferTable ? ensureTablePresence(formatted, tableHeaders || deriveTableHeaders(question)) : formatted;
    const sanitized = sanitizeAnswer(repaired, { allowExcerpts: excerptsAllowed });
    const answerCore = finalizeAssistantText(rawAnswer, sanitized);
    const answer = rawAnswerResult.truncated ? appendTruncationNotice(answerCore) : answerCore;
    debugFormatLog("[ASK-DOC] format result", {
      preferTable,
      rawLength: rawAnswer.length,
      repairedLength: repaired.length,
      finalLength: answer.length,
    });
    const references = buildReferencesFromChunks(selected);
    const evidence = excerptsAllowed ? buildEvidenceFromChunks(selected) : undefined;
    const payload: Record<string, unknown> = {
      answer,
      method: "retrieval",
      extractedKey,
      chunksUsed: selected.map(chunk => chunk.index),
      references,
    };
    if (evidence && evidence.length) {
      payload.evidence = evidence;
    }
    return jsonNoStore({
      ...payload,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[ASK-DOC] Answer failed", err);
    return jsonNoStore({ error: "answer_failed", details: msg }, 502);
  }
}

async function handleOcrPage(req: Request, env: Env): Promise<Response> {
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return json({ error: "Send multipart/form-data with fields: fileId, pageIndex, image" }, 400);
  }
  const form = await req.formData();
  const fileId = typeof form.get("fileId") === "string" ? (form.get("fileId") as string).trim() : "";
  const fileHash = typeof form.get("fileHash") === "string" ? (form.get("fileHash") as string).trim() : "";
  const rawIndex = form.get("pageIndex");
  const pageIndex = typeof rawIndex === "string" ? Number(rawIndex) : Number(rawIndex);
  const image = form.get("image");

  if (!fileId && !fileHash) return json({ error: "Missing fileId or fileHash." }, 400);
  if (!Number.isFinite(pageIndex)) return json({ error: "Invalid pageIndex." }, 400);
  if (!(image instanceof File)) return json({ error: "Missing image file." }, 400);

  try {
    const mimeType = image.type || "image/png";
    const bytes = new Uint8Array(await image.arrayBuffer());
    const prepared = prepareOcrImageInput(bytes, mimeType);
    if (!prepared.ok) {
      console.warn("[OCR-PAGE] Invalid image bytes", {
        fileHash: fileHash || fileId,
        pageIndex,
        head: prepared.head,
        mimeType: prepared.mimeType,
      });
      return json(invalidImagePayload({ pageIndex }), 422);
    }
    logOcrInputDebug({
      key: fileHash || fileId || "ocr-page",
      head: prepared.head,
      mimeType: prepared.mimeType,
      signature: prepared.signature,
      byteLength: prepared.byteLength,
    });
    const label = Number.isFinite(pageIndex) ? `Page ${Number(pageIndex) + 1}` : "Page";
    const started = Date.now();
    const prompt = "You are an OCR service. Transcribe every readable character from the page image. Return plain text only.";
    const text = await callResponsesOcr(
      env,
      [
        { type: "input_text", text: prompt },
        { type: "input_image", image_url: prepared.dataUrl, detail: "high" as InputImageDetail },
      ],
      { label: `ocr-page:${fileHash || fileId}:${pageIndex}`, maxOutputTokens: OCR_PAGE_OUTPUT_TOKENS },
    );
    const normalized = normalizeExtractedText(text).slice(0, MAX_OCR_TEXT_LENGTH);
    if (!normalized) {
      return json({
        pageIndex: Number(pageIndex),
        text: NO_TEXT_PLACEHOLDER,
        blank: true,
        status: "blank",
      });
    }
    console.log("[OCR-PAGE] completed", {
      fileHash: fileHash || fileId,
      pageIndex,
      bytes: bytes.length,
      ms: Date.now() - started,
      length: normalized.length,
    });
    return json({ pageIndex: Number(pageIndex), text: normalized });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[OCR-PAGE] Failed", { fileHash: fileHash || fileId, pageIndex, error: msg });
    return json({ error: "ocr_failed", details: msg }, 502);
  }
}

async function handleOcrFinalize(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return json({ error: "Send JSON { fileId?, fileHash?, pages: [{ pageIndex, text }] }." }, 400);
  }
  const fileId = typeof (body as any).fileId === "string" ? (body as any).fileId.trim() : "";
  const fileHash = typeof (body as any).fileHash === "string" ? (body as any).fileHash.trim() : "";
  const filename = typeof (body as any).filename === "string" ? (body as any).filename : undefined;
  const pages = Array.isArray((body as any).pages) ? (body as any).pages : [];
  const totalPages = Number((body as any).totalPages);
  const reset = Boolean((body as any).reset);
  if (!fileId && !fileHash) return json({ error: "Missing fileId or fileHash." }, 400);
  if (!pages.length) return json({ error: "No pages provided." }, 400);

  const normalizedPages = pages
    .map((entry: any) => {
      const idxRaw = typeof entry?.pageIndex === "number" ? entry.pageIndex : Number(entry?.pageIndex);
      const text = typeof entry?.text === "string" ? entry.text : "";
      const blank = entry?.blank === true || entry?.status === "blank";
      if (!Number.isFinite(idxRaw)) return null;
      const clean = normalizeExtractedText(text);
      return {
        pageIndex: Number(idxRaw),
        text: blank || !clean ? NO_TEXT_PLACEHOLDER : clean,
      };
    })
    .filter(
      (p: { pageIndex: number; text: string } | null): p is { pageIndex: number; text: string } => Boolean(p),
    )
    .sort((a: { pageIndex: number; text: string }, b: { pageIndex: number; text: string }) => a.pageIndex - b.pageIndex);

  if (!normalizedPages.length) {
    return json({ error: "No valid OCR pages to finalize." }, 422);
  }

  const { bucket } = getExtractionBucket(env);
  const extractedKey = fileHash ? buildExtractedKeyForHash(fileHash) : buildExtractedKey(fileId);
  const existingPages = new Map<number, string>();
  let manifest: PdfManifest | null = null;
  if (fileHash) {
    manifest = await readManifest(bucket, fileHash);
  }
  if (!reset) {
    try {
      const existing = await bucket.get(extractedKey);
      if (existing && existing.body) {
        const existingText = normalizePlainText(await existing.text());
        parseNormalizedPagesFromText(existingText).forEach((text, pageIdx) => existingPages.set(pageIdx, text));
      }
    } catch {}
  }

  normalizedPages.forEach(page => {
    existingPages.set(page.pageIndex, page.text.trim() || NO_TEXT_PLACEHOLDER);
  });

  const rebuilt = Array.from(existingPages.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([pageIndex, text]) => `--- Page ${pageIndex + 1} ---\n${text || NO_TEXT_PLACEHOLDER}`)
    .join("\n\n");

  const normalizedFinal = normalizePlainText(rebuilt).slice(0, MAX_OCR_TEXT_LENGTH);

  try {
    await bucket.put(extractedKey, normalizedFinal, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });
    const preview = normalizedFinal.slice(0, ONE_SHOT_PREVIEW_LIMIT);
    if (fileHash) {
      const currentRanges = buildRangesFromPages(normalizedPages.map(p => p.pageIndex));
      const newRanges = reset
        ? currentRanges
        : mergeRanges([
            ...(manifest?.ranges || []),
            ...currentRanges,
          ]);
      const pagesProcessed = newRanges.reduce((total, range) => total + (range.end - range.start + 1), 0);
      const nextManifest: PdfManifest = {
        fileHash,
        filename: manifest?.filename || filename,
        method: "ocr",
        ocrStatus: "finalized",
        pagesProcessed,
        pageCount: Number.isFinite(totalPages) ? Number(totalPages) : manifest?.pageCount,
        ranges: newRanges,
        createdAt: manifest?.createdAt || new Date().toISOString(),
        preview,
        extractedKey,
        updatedAt: new Date().toISOString(),
      };
      await writeManifest(bucket, nextManifest);
      console.log("[OCR-FINALIZE] persisted OCR text", {
        fileHash,
        pagesProcessed,
        pageCount: nextManifest.pageCount,
        ranges: newRanges,
      });
    }
    return json({
      extractionStatus: "ok",
      method: "ocr",
      extractedKey,
      preview,
      fileId,
      fileHash,
      pageCount: Number.isFinite(totalPages) ? Number(totalPages) : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[OCR-FINALIZE] Failed to persist OCR text", { fileId: fileHash || fileId, error: msg });
    return json({ error: "persist_failed", details: msg }, 500);
  }
}

async function ingestLibraryObject(
  env: Env,
  {
    bucketName,
    key,
    skipCache = false,
    mode = "single",
  }: { bucketName: string; key: string; skipCache?: boolean; mode?: "embedded_only" | "full" | "single" },
) {
  const stageError = (stage: string, message: string, statusCode = 500) => {
    const err = new Error(message) as Error & { stage?: string; statusCode?: number };
    err.stage = stage;
    err.statusCode = statusCode;
    return err;
  };

  const canonicalKey = key.trim();
  const sourceLookup = lookupBucket(env, bucketName) || lookupBucket(env, BUCKET_BINDINGS[bucketName as keyof typeof BUCKET_BINDINGS]);
  if (!sourceLookup) {
    throw stageError("bucket_lookup", `Unknown bucket: ${bucketName}`, 400);
  }
  const sourceBucket = sourceLookup.bucket;
  const { bucket: libraryBucket } = getLibraryBucket(env);

  const object = await sourceBucket.get(canonicalKey);
  if (!object || !object.body) {
    throw stageError("get_object", "Object not found.", 404);
  }

  const { docId, basis, fieldsUsed, uploaded } = await computeDocId(bucketName, canonicalKey, {
    etag: object.etag,
    size: object.size,
    uploaded: (object as any)?.uploaded,
  });
  console.log("[LIBRARY_INGEST] start", {
    bucket: bucketName,
    key: canonicalKey,
    docId,
    etag: object.etag,
    size: object.size,
    uploaded: uploaded || (object as any)?.uploaded,
  });
  const extractedKey = buildExtractedPath(docId);
  const manifestKey = buildManifestPath(docId);
  const title = titleFromKey(canonicalKey);

  if (!skipCache) {
    try {
      const existing = typeof libraryBucket.head === "function"
        ? await libraryBucket.head(extractedKey)
        : await libraryBucket.get(extractedKey, { range: { offset: 0, length: 0 } as any });
      if (existing) {
        const manifest = await readManifest(libraryBucket, docId);
        await upsertLibraryIndexRecord(env, {
          docId,
          bucket: bucketName,
          key: canonicalKey,
          title,
          hashBasis: basis,
          hashFieldsUsed: fieldsUsed,
          normalizedTokens: tokensFromTitle(title),
          status: "ready",
          extractedKey,
          manifestKey,
          preview: manifest?.preview,
          size: object.size,
          etag: object.etag,
          uploaded: uploaded || (object as any)?.uploaded?.toISOString?.(),
        });
        console.log("[LIBRARY_INGEST] cache_hit", { docId, bucket: bucketName, key: canonicalKey, extractedKey });
        return { status: "cache_hit", docId, extractedKey, manifest };
      }
    } catch (err) {
      console.warn("[LIBRARY-INGEST] cache probe failed", { docId, extractedKey, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const cachedManifest = await readManifest(libraryBucket, docId);
  if (cachedManifest && cachedManifest.method === "ocr" && !cachedManifest.pagesProcessed) {
    await upsertLibraryIndexRecord(env, {
      docId,
      bucket: bucketName,
      key: canonicalKey,
      title,
      hashBasis: basis,
      hashFieldsUsed: fieldsUsed,
      normalizedTokens: tokensFromTitle(title),
      status: "needs_browser_ocr",
      extractedKey,
      manifestKey,
      preview: cachedManifest.preview,
      size: object.size,
      etag: object.etag,
      uploaded: uploaded || (object as any)?.uploaded?.toISOString?.(),
    });
    console.log("[LIBRARY_INGEST] needs_browser_ocr", {
      docId,
      bucket: bucketName,
      key: canonicalKey,
      pageCount: cachedManifest?.pageCount,
    });
    return {
      status: "needs_browser_ocr",
      docId,
      bucket: bucketName,
      key: canonicalKey,
      pageCount: cachedManifest.pageCount,
      downloadUrl: buildLibraryDownloadUrl(bucketName, canonicalKey),
    };
  }

  const bytes = new Uint8Array(await object.arrayBuffer());
  let extraction;
  try {
    extraction = await extractEmbeddedPagesFromPdf(bytes, {
      sampleCount: PDF_SAMPLE_PAGE_TARGET,
      maxPages: mode === "embedded_only" ? LIBRARY_BATCH_PAGE_LIMIT : MAX_EXTRACT_PAGES,
      allowEarlyStop: true,
    });
  } catch (err) {
    throw stageError("extract_embedded", err instanceof Error ? err.message : "Embedded extraction failed.");
  }

  if (extraction.scanned || !extraction.pages.length) {
    const manifest: PdfManifest = {
      fileHash: docId,
      filename: title,
      method: "ocr",
      extractionMethod: "ocr",
      pagesProcessed: 0,
      pageCount: extraction.pageCount,
      createdAt: new Date().toISOString(),
      bucket: bucketName,
      key: canonicalKey,
      docId,
      hashBasis: basis,
      hashFieldsUsed: fieldsUsed,
      title,
    };
    try {
      await writeManifest(libraryBucket, manifest);
    } catch (err) {
      throw stageError("write_manifest", err instanceof Error ? err.message : "Failed to persist manifest.");
    }
    await upsertLibraryIndexRecord(env, {
      docId,
      bucket: bucketName,
      key: canonicalKey,
      title,
      hashBasis: basis,
      hashFieldsUsed: fieldsUsed,
      normalizedTokens: tokensFromTitle(title),
      status: "needs_browser_ocr",
      extractedKey,
      manifestKey,
      preview: "",
      size: object.size,
      etag: object.etag,
      uploaded: uploaded || (object as any)?.uploaded?.toISOString?.(),
    });
    return {
      status: "needs_browser_ocr",
      docId,
      bucket: bucketName,
      key: canonicalKey,
      pageCount: extraction.pageCount,
      downloadUrl: buildLibraryDownloadUrl(bucketName, canonicalKey),
    };
  }

  const normalized = normalizePages(extraction.pages);
  const finalText = normalized.text.slice(0, MAX_OCR_TEXT_LENGTH);
  const preview = finalText.slice(0, ONE_SHOT_PREVIEW_LIMIT);
  try {
    await libraryBucket.put(extractedKey, finalText, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });
  } catch (err) {
    throw stageError("write_extracted", err instanceof Error ? err.message : "Failed to persist extracted text.");
  }
  const manifest: PdfManifest = {
    fileHash: docId,
    filename: title,
    method: "embedded",
    extractionMethod: "embedded",
    pagesProcessed: normalized.pagesProcessed,
    pageCount: extraction.pageCount,
    createdAt: new Date().toISOString(),
    preview,
    bucket: bucketName,
    key: canonicalKey,
    docId,
    hashBasis: basis,
    hashFieldsUsed: fieldsUsed,
    title,
  };
  try {
    await writeManifest(libraryBucket, manifest);
  } catch (err) {
    throw stageError("write_manifest", err instanceof Error ? err.message : "Failed to persist manifest.");
  }
  await upsertLibraryIndexRecord(env, {
    docId,
    bucket: bucketName,
    key: canonicalKey,
    title,
    hashBasis: basis,
    hashFieldsUsed: fieldsUsed,
    normalizedTokens: tokensFromTitle(title),
    status: "ready",
    extractedKey,
    manifestKey,
    preview,
    size: object.size,
    etag: object.etag,
    uploaded: uploaded || (object as any)?.uploaded?.toISOString?.(),
  });

  console.log("[LIBRARY_INGEST] ready", {
    docId,
    bucket: bucketName,
    key: canonicalKey,
    pages: extraction.pageCount,
    previewLen: preview.length,
    extractedKey,
  });
  return { status: "ok", docId, extractedKey, manifest, preview, pageCount: extraction.pageCount };
}

async function upsertLibraryIndexRecord(env: Env, record: LibraryIndexRecord) {
  const { bucket } = getLibraryBucket(env);
  const existing = await readLibraryIndex(bucket);
  const map = new Map<string, LibraryIndexRecord>();
  existing.forEach(rec => map.set(rec.docId, rec));
  const config = getAppConfig(env);

  const prior = map.get(record.docId);
  const normalizedTokens = record.normalizedTokens?.length
    ? record.normalizedTokens
    : prior?.normalizedTokens?.length
      ? prior.normalizedTokens
      : tokensFromTitle(record.title);

  const merged: LibraryIndexRecord = {
    ...(prior || {}),
    ...record,
    institutionId: record.institutionId || prior?.institutionId || config.institutionId,
    ownerUserId: record.ownerUserId ?? prior?.ownerUserId ?? null,
    normalizedTokens,
    status: record.status || prior?.status,
    preview: normalizePreview(record.preview || prior?.preview),
    manifestKey: record.manifestKey || prior?.manifestKey || buildManifestPath(record.docId),
    extractedKey: record.extractedKey || prior?.extractedKey || buildExtractedPath(record.docId),
  };
  map.set(record.docId, merged);
  const nextList = Array.from(map.values());
  await writeLibraryIndex(bucket, nextList);
  await bucket.put(buildIndexKeyForDoc(record.docId), JSON.stringify(merged), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  return merged;
}

async function listLibrarySourceObjectsFromBucket(bucket: R2Bucket, opts: { limit?: number } = {}) {
  const results: R2Object[] = [];
  let cursor: string | undefined;
  const limit = opts.limit ?? 0;
  do {
    const page = await bucket.list({ cursor, limit: 1000 });
    for (const obj of page.objects ?? []) {
      if (isPdfKey(obj.key) || (String(obj.key || "").startsWith("library/") && isLibraryWordKey(obj.key || ""))) {
        results.push(obj);
        if (limit && results.length >= limit) {
          return results;
        }
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return results;
}

function buildLibraryDownloadUrl(bucket: string, key: string) {
  const base = `/api/file?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(key)}`;
  return base;
}

function buildRangesFromPages(pageIndices: number[]) {
  const sorted = Array.from(new Set(pageIndices.map(idx => Number(idx) + 1).filter(n => Number.isFinite(n)))).sort((a, b) => a - b);
  const ranges: Array<{ start: number; end: number }> = [];
  if (!sorted.length) return ranges;
  let start = sorted[0];
  let end = sorted[0];
  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    if (current === end + 1) {
      end = current;
    } else {
      ranges.push({ start, end });
      start = current;
      end = current;
    }
  }
  ranges.push({ start, end });
  return ranges;
}

function mergeRanges(ranges: Array<{ start: number; end: number }>) {
  const cleaned = ranges
    .filter(range => Number.isFinite(range.start) && Number.isFinite(range.end))
    .map(range => (range.start <= range.end ? { start: range.start, end: range.end } : { start: range.end, end: range.start }))
    .sort((a, b) => a.start - b.start);
  if (!cleaned.length) return [];
  const merged: Array<{ start: number; end: number }> = [cleaned[0]];
  for (let i = 1; i < cleaned.length; i += 1) {
    const current = cleaned[i];
    const last = merged[merged.length - 1];
    if (current.start <= last.end + 1) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ start: current.start, end: current.end });
    }
  }
  return merged;
}

function escapeHtml(value: string): string {
  return (value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatSlideRange(range: { start: number; end: number }) {
  if (range.start === range.end) return `Slide ${range.start}`;
  return `Slides ${range.start}-${range.end}`;
}

function formatRangeList(ranges: Array<{ start: number; end: number }>) {
  if (!ranges.length) return "None";
  return ranges.map(formatSlideRange).join(", ");
}

function buildStepACoverageSection(opts: {
  processed: Array<{ start: number; end: number }>;
  failures: Array<{ start: number; end: number; kind?: StepA1FailureKind }>;
  unprocessed: Array<{ start: number; end: number }>;
  timeBudgetHit: boolean;
  docKey: string;
  mode: string;
  promptVersion: string;
}): string {
  const failureKindLabels: Record<StepA1FailureKind, string> = {
    TRUNCATED: "Model output truncated",
    PARSE: "JSON parse failed",
    SCHEMA: "Schema mismatch",
    EXTRACT: "Empty extraction",
  };
  const mergedProcessed = mergeRanges(opts.processed);
  const mergedUnprocessed = mergeRanges(opts.unprocessed);
  const failuresByKind = new Map<StepA1FailureKind, Array<{ start: number; end: number }>>();
  for (const failure of opts.failures) {
    if (!failure.kind) continue;
    const list = failuresByKind.get(failure.kind) || [];
    list.push({ start: failure.start, end: failure.end });
    failuresByKind.set(failure.kind, list);
  }
  const failureLines: string[] = [];
  for (const [kind, ranges] of failuresByKind.entries()) {
    const merged = mergeRanges(ranges);
    const label = failureKindLabels[kind] || "Extraction failed";
    failureLines.push(`${label}: ${formatRangeList(merged)}`);
  }

  const lines: string[] = [];
  lines.push("<section id=\"coverage-qa-chunks\" class=\"section-card\" style=\"border:1px solid var(--border-subtle);padding:12px;margin:16px 0;background:var(--bg-surface);\">");
  lines.push("  <h1>Coverage &amp; QA</h1>");
  lines.push(`  <p><strong>Processed:</strong> ${escapeHtml(formatRangeList(mergedProcessed))}</p>`);
  if (failureLines.length) {
    lines.push("  <p><strong>Failed:</strong></p>");
    lines.push("  <ul>");
    for (const line of failureLines) {
      lines.push(`    <li>${escapeHtml(line)}</li>`);
    }
    lines.push("  </ul>");
  }
  if (mergedUnprocessed.length || opts.timeBudgetHit) {
    lines.push(`  <p><strong>Unprocessed:</strong> ${escapeHtml(formatRangeList(mergedUnprocessed))}</p>`);
  }
  lines.push("  <p>Rerun generation to resume from cached chunks.</p>");
  lines.push(
    `  <p style=\"color:var(--text-secondary);font-size:0.9em;\">docKey=${escapeHtml(opts.docKey)} | mode=${escapeHtml(opts.mode)} | promptVersion=${escapeHtml(opts.promptVersion)}</p>`,
  );
  lines.push("</section>");
  return lines.join("\n");
}

function injectCoverageQaSection(html: string, sectionHtml: string): string {
  if (!sectionHtml) return html;
  if (/coverage-qa-chunks/i.test(html)) return html;
  const lower = (html || "").toLowerCase();
  const bodyIdx = lower.lastIndexOf("</body>");
  if (bodyIdx !== -1) {
    return `${html.slice(0, bodyIdx)}\n${sectionHtml}\n${html.slice(bodyIdx)}`;
  }
  const htmlIdx = lower.lastIndexOf("</html>");
  if (htmlIdx !== -1) {
    return `${html.slice(0, htmlIdx)}\n${sectionHtml}\n${html.slice(htmlIdx)}`;
  }
  return `${html}\n${sectionHtml}`;
}

function parseNormalizedPagesFromText(text: string) {
  const map = new Map<number, string>();
  const parts = (text || "").split(/---\s*Page\s+(\d+)\s*---/i);
  for (let i = 1; i < parts.length; i += 2) {
    const pageNumber = Number(parts[i]);
    const pageText = parts[i + 1] || "";
    if (Number.isFinite(pageNumber)) {
      map.set(pageNumber - 1, normalizePlainText(pageText));
    }
  }
  return map;
}

type MachineSlide = { n: number; title: string; page: number };
type MachineSlideBlock = { n: number; page: number; text: string };

function sanitizeMachineSlug(input: string, fallback: string) {
  const cleaned = (input || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || fallback;
}

function buildMachineTxtKey(docId: string, lectureTitle: string) {
  const safeDocId = sanitizeMachineSlug(docId, "doc");
  const safeTitle = sanitizeMachineSlug(lectureTitle, "lecture");
  return `${MACHINE_TXT_PREFIX}/${safeDocId}/${safeTitle}.txt`;
}

function buildFacultyUploadedMachineTxtKey(docId: string) {
  const safeDocId = sanitizeMachineSlug(docId, "doc");
  return `${MACHINE_TXT_PREFIX}/${safeDocId}/${FACULTY_UPLOADED_TXT_FILENAME}`;
}

function buildDeferredLectureUploadSourceKey(docId: string, filename: string) {
  const safeDocId = sanitizeMachineSlug(docId, "doc");
  const safeFilename = sanitizeFilename(filename || "lecture-upload.bin");
  return `machine/source/${safeDocId}/${Date.now()}_${safeFilename}`;
}

function buildLectureMachineTxtMetadataKey(docId: string) {
  const safeDocId = sanitizeMachineSlug(docId, "doc");
  return `library:machine_txt:${safeDocId}`;
}

function isDocMimeType(mimeType: string) {
  return (mimeType || "").toLowerCase() === "application/msword";
}

function isDocxMimeType(mimeType: string) {
  return (mimeType || "").toLowerCase() === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
}

function isWordDocumentMimeType(mimeType: string) {
  return isDocMimeType(mimeType) || isDocxMimeType(mimeType);
}

function isDocFilename(filename: string) {
  return /\.doc$/i.test(filename || "");
}

function isDocxFilename(filename: string) {
  return /\.docx$/i.test(filename || "");
}

function isWordDocumentFilename(filename: string) {
  return isDocFilename(filename) || isDocxFilename(filename);
}

function isLibraryWordKey(key: string) {
  return isWordDocumentFilename(key || "");
}

function isLibrarySourceDocumentKey(key: string) {
  return isPdfKey(key) || isLibraryWordKey(key);
}

function isSupportedLectureWordUpload(filename: string, mimeType: string) {
  if (isWordDocumentMimeType(mimeType)) return true;
  return isWordDocumentFilename(filename);
}

function buildMachineTxtHashKey(hash: string) {
  const safeHash = (hash || "").replace(/[^a-f0-9]/gi, "");
  return `${MACHINE_TXT_PREFIX}/${safeHash || "unknown"}.txt`;
}

function isMachineTxtKey(key: string) {
  return (key || "").startsWith(`${MACHINE_TXT_PREFIX}/`);
}

function isFacultyUploadedMachineTxtKey(key: string) {
  return (key || "").endsWith(`/${FACULTY_UPLOADED_TXT_FILENAME}`);
}

type MachineTxtObjectInfo = {
  key: string;
  uploaded?: Date;
  size?: number;
};

function pickPreferredMachineTxtObject(
  candidate: MachineTxtObjectInfo,
  existing: MachineTxtObjectInfo | null,
): MachineTxtObjectInfo {
  if (!existing) return candidate;
  const candidateUploaded = isFacultyUploadedMachineTxtKey(candidate.key);
  const existingUploaded = isFacultyUploadedMachineTxtKey(existing.key);
  if (candidateUploaded !== existingUploaded) {
    return candidateUploaded ? candidate : existing;
  }
  const candidateTime = candidate.uploaded instanceof Date ? candidate.uploaded.getTime() : 0;
  const existingTime = existing.uploaded instanceof Date ? existing.uploaded.getTime() : 0;
  if (candidateTime !== existingTime) {
    return candidateTime > existingTime ? candidate : existing;
  }
  return candidate.key.localeCompare(existing.key) > 0 ? candidate : existing;
}

async function resolvePreferredMachineTxtKey(
  bucket: R2Bucket,
  docId: string,
  lectureTitle?: string,
): Promise<string> {
  const uploadedKey = buildFacultyUploadedMachineTxtKey(docId);
  const uploadedHead = await resolveObjectHead(bucket, uploadedKey);
  if (uploadedHead.exists) return uploadedKey;

  const canonicalKey = buildMachineTxtKey(docId, lectureTitle || docId);
  const canonicalHead = await resolveObjectHead(bucket, canonicalKey);
  if (canonicalHead.exists) return canonicalKey;

  const prefix = `${MACHINE_TXT_PREFIX}/${sanitizeMachineSlug(docId, "doc")}/`;
  let cursor: string | undefined;
  let preferred: MachineTxtObjectInfo | null = null;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const obj of page.objects ?? []) {
      const key = obj.key || "";
      if (!key || !/\.txt$/i.test(key)) continue;
      preferred = pickPreferredMachineTxtObject({
        key,
        uploaded: obj.uploaded instanceof Date ? obj.uploaded : undefined,
        size: obj.size,
      }, preferred);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return preferred?.key || "";
}

async function loadMachineTxtFromStorage(env: Env, storedKey: string): Promise<string | null> {
  if (!storedKey || !isMachineTxtKey(storedKey)) {
    throw new Error("Invalid storedKey (expected machine/txt/*).");
  }
  const { bucket } = getLibraryBucket(env);
  const object = await bucket.get(storedKey);
  if (!object || !object.body) return null;
  return await object.text();
}

async function ensureMachineTxtStored(env: Env, normalizedText: string): Promise<{ storedKey: string; hash: string }> {
  const hash = await sha256(normalizedText || "");
  const storedKey = buildMachineTxtHashKey(hash);
  const { bucket } = getLibraryBucket(env);
  const exists = typeof bucket.head === "function"
    ? await bucket.head(storedKey)
    : await bucket.get(storedKey, { range: { offset: 0, length: 0 } as any });
  if (!exists) {
    await bucket.put(storedKey, normalizedText, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });
  }
  return { storedKey, hash };
}

async function persistLectureMachineTxtMetadata(
  env: Env,
  docId: string,
  storedKey: string,
  ingestionType: "doc_upload",
) {
  if (!env.DOCS_KV || !docId || !storedKey) return;
  await env.DOCS_KV.put(buildLectureMachineTxtMetadataKey(docId), JSON.stringify({
    extractedKey: storedKey,
    source: "machine_txt",
    ingestionType,
    updatedAt: Date.now(),
  }));
}

async function clearLectureMachineTxtCache(env: Env, docId: string, storedKey: string) {
  if (!env.OWEN_DOC_CACHE) return;
  const keys = Array.from(new Set([
    buildLectureMachineTxtMetadataKey(docId),
    `lecture:${docId}`,
    docId,
    storedKey,
  ].filter(Boolean)));
  await Promise.all(keys.map(async (key) => {
    try {
      await env.OWEN_DOC_CACHE?.delete(key);
    } catch (err) {
      console.warn("[OWEN_DOC_CACHE] delete failed", {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }));
}

function decodeXmlEntities(value: string) {
  return (value || "").replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => {
    const normalized = String(entity || "").toLowerCase();
    if (normalized === "amp") return "&";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    if (normalized === "quot") return "\"";
    if (normalized === "apos") return "'";
    if (normalized.startsWith("#x")) {
      const parsed = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : "";
    }
    if (normalized.startsWith("#")) {
      const parsed = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : "";
    }
    return "";
  });
}

function readUint16LE(bytes: Uint8Array, offset: number) {
  const b0 = bytes[offset] ?? 0;
  const b1 = bytes[offset + 1] ?? 0;
  return b0 | (b1 << 8);
}

function readUint32LE(bytes: Uint8Array, offset: number) {
  const b0 = bytes[offset] ?? 0;
  const b1 = bytes[offset + 1] ?? 0;
  const b2 = bytes[offset + 2] ?? 0;
  const b3 = bytes[offset + 3] ?? 0;
  return (
    b0 |
    (b1 << 8) |
    (b2 << 16) |
    (b3 << 24)
  ) >>> 0;
}

type ZipEntryInfo = {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  localHeaderOffset: number;
};

function findZipEndOfCentralDirectory(bytes: Uint8Array) {
  const minOffset = Math.max(0, bytes.length - 0xffff - 22);
  for (let offset = bytes.length - 22; offset >= minOffset; offset -= 1) {
    if (
      bytes[offset] === 0x50 &&
      bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x05 &&
      bytes[offset + 3] === 0x06
    ) {
      return offset;
    }
  }
  return -1;
}

function listZipEntries(bytes: Uint8Array): ZipEntryInfo[] {
  const eocdOffset = findZipEndOfCentralDirectory(bytes);
  if (eocdOffset === -1) {
    throw new Error("DOCX archive is missing the central directory.");
  }
  const totalEntries = readUint16LE(bytes, eocdOffset + 10);
  const centralDirectoryOffset = readUint32LE(bytes, eocdOffset + 16);
  const entries: ZipEntryInfo[] = [];
  let offset = centralDirectoryOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (
      bytes[offset] !== 0x50 ||
      bytes[offset + 1] !== 0x4b ||
      bytes[offset + 2] !== 0x01 ||
      bytes[offset + 3] !== 0x02
    ) {
      throw new Error("DOCX archive central directory is corrupted.");
    }
    const compressionMethod = readUint16LE(bytes, offset + 10);
    const compressedSize = readUint32LE(bytes, offset + 20);
    const fileNameLength = readUint16LE(bytes, offset + 28);
    const extraLength = readUint16LE(bytes, offset + 30);
    const commentLength = readUint16LE(bytes, offset + 32);
    const localHeaderOffset = readUint32LE(bytes, offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameEnd));
    entries.push({
      name,
      compressionMethod,
      compressedSize,
      localHeaderOffset,
    });
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

async function inflateZipEntry(bytes: Uint8Array) {
  const compressedBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const stream = new Blob([compressedBuffer]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const inflatedBuffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(inflatedBuffer);
}

async function readZipEntry(bytes: Uint8Array, entry: ZipEntryInfo) {
  const localOffset = entry.localHeaderOffset;
  if (
    bytes[localOffset] !== 0x50 ||
    bytes[localOffset + 1] !== 0x4b ||
    bytes[localOffset + 2] !== 0x03 ||
    bytes[localOffset + 3] !== 0x04
  ) {
    throw new Error(`DOCX archive entry is missing its local header (${entry.name}).`);
  }
  const fileNameLength = readUint16LE(bytes, localOffset + 26);
  const extraLength = readUint16LE(bytes, localOffset + 28);
  const dataStart = localOffset + 30 + fileNameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  const compressed = bytes.subarray(dataStart, dataEnd);
  if (entry.compressionMethod === 0) {
    return compressed;
  }
  if (entry.compressionMethod === 8) {
    return inflateZipEntry(compressed);
  }
  throw new Error(`DOCX archive uses an unsupported compression method (${entry.compressionMethod}).`);
}

function extractDocxTextFromXml(xml: string) {
  if (!xml) return "";
  let text = xml;
  text = text.replace(/<w:tab\b[^>]*\/>/gi, "\t");
  text = text.replace(/<w:(?:br|cr)\b[^>]*\/>/gi, "\n");
  text = text.replace(/<\/w:tc>/gi, "\t");
  text = text.replace(/<\/w:tr>/gi, "\n");
  text = text.replace(/<\/w:p>/gi, "\n\n");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeXmlEntities(text).replace(/\u00a0/g, " ");
  return normalizePlainText(text);
}

function collectPrintableRuns(text: string, minLength = 24) {
  const runs: string[] = [];
  let current = "";
  const pushCurrent = () => {
    const normalized = normalizePlainText(current.replace(/[^\S\n]+/g, " "));
    const wordCount = normalized ? normalized.split(/\s+/).filter(Boolean).length : 0;
    if (normalized.length >= minLength || wordCount >= 4) {
      runs.push(normalized);
    }
    current = "";
  };
  for (const ch of text || "") {
    const code = ch.charCodeAt(0);
    const printable =
      ch === "\n" ||
      ch === "\t" ||
      (code >= 32 && code <= 126) ||
      (code >= 160 && code <= 591);
    if (!printable) {
      pushCurrent();
      continue;
    }
    current += ch;
  }
  pushCurrent();
  return runs;
}

function extractLegacyDocText(bytes: Uint8Array) {
  let utf16Candidate = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const low = bytes[i] ?? 0;
    const high = bytes[i + 1] ?? 0;
    const code = low | (high << 8);
    if (code === 9 || code === 10 || code === 13) {
      utf16Candidate += "\n";
    } else if ((code >= 32 && code <= 126) || (code >= 160 && code <= 591)) {
      utf16Candidate += String.fromCharCode(code);
    } else {
      utf16Candidate += "\n";
    }
  }

  let latinCandidate = "";
  for (const byte of bytes) {
    if (byte === 9 || byte === 10 || byte === 13) {
      latinCandidate += "\n";
    } else if ((byte >= 32 && byte <= 126) || byte >= 160) {
      latinCandidate += String.fromCharCode(byte);
    } else {
      latinCandidate += "\n";
    }
  }

  const deduped = new Map<string, string>();
  for (const segment of [...collectPrintableRuns(utf16Candidate), ...collectPrintableRuns(latinCandidate)]) {
    const key = segment.toLowerCase();
    if (!deduped.has(key)) deduped.set(key, segment);
  }
  return normalizePlainText(Array.from(deduped.values()).join("\n\n"));
}

async function extractDocxText(bytes: Uint8Array) {
  const entries = listZipEntries(bytes);
  const preferredEntries = entries
    .filter(entry =>
      /^word\/document\.xml$/i.test(entry.name) ||
      /^word\/footnotes\.xml$/i.test(entry.name) ||
      /^word\/endnotes\.xml$/i.test(entry.name) ||
      /^word\/header\d+\.xml$/i.test(entry.name) ||
      /^word\/footer\d+\.xml$/i.test(entry.name),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const extractedParts: string[] = [];
  for (const entry of preferredEntries) {
    const raw = await readZipEntry(bytes, entry);
    const xml = new TextDecoder().decode(raw);
    const extracted = extractDocxTextFromXml(xml);
    if (extracted) extractedParts.push(extracted);
  }
  return normalizePlainText(extractedParts.join("\n\n"));
}

async function extractLectureUploadTextFromBytes(bytes: Uint8Array, filename: string, mimeType: string) {
  if (isDocxMimeType(mimeType) || isDocxFilename(filename)) {
    return extractDocxText(bytes);
  }
  if (isDocMimeType(mimeType) || isDocFilename(filename)) {
    return extractLegacyDocText(bytes);
  }
  if (isTextKeyByExtension(filename) || isTextContentType(mimeType)) {
    return new TextDecoder().decode(bytes);
  }
  throw new Error("Unsupported lecture text upload type.");
}

function normalizeLectureUploadText(text: string) {
  const normalized = sanitizeDocText(normalizeExtractedText(text));
  if (!normalized.trim() || normalized === NO_TEXT_PLACEHOLDER) {
    throw new Error("Document conversion produced no usable text.");
  }
  return normalized;
}

async function storeLectureMachineTxtArtifact(
  env: Env,
  docId: string,
  text: string,
  ingestionType: "doc_upload",
) {
  const normalized = normalizeLectureUploadText(text);
  const storedKey = buildFacultyUploadedMachineTxtKey(docId);
  const { bucket } = getLibraryBucket(env);
  await bucket.put(storedKey, normalized, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });
  await persistLectureMachineTxtMetadata(env, docId, storedKey, ingestionType);
  await clearLectureMachineTxtCache(env, docId, storedKey);
  return {
    storedKey,
    normalizedText: normalized,
    preview: normalized.slice(0, ONE_SHOT_PREVIEW_LIMIT),
  };
}

function cleanMachinePageText(text: string) {
  if (!text) return "";
  const normalized = normalizePlainText(text);
  if (!normalized) return "";
  return normalized
    .split("\n")
    .map(line => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

function formatMachineTxtFromPageMap(pageMap: Map<number, string>, pageCount?: number) {
  const pageIndices = Array.from(pageMap.keys()).filter(n => Number.isFinite(n));
  const maxIndex = pageIndices.length ? Math.max(...pageIndices) : -1;
  const inferredCount = maxIndex >= 0 ? maxIndex + 1 : 0;
  const totalPages = Math.max(
    Number.isFinite(pageCount as number) ? Number(pageCount) : 0,
    inferredCount,
  );
  const blocks: string[] = [];
  for (let i = 0; i < totalPages; i += 1) {
    const pageNumber = i + 1;
    const cleaned = cleanMachinePageText(pageMap.get(i) || "");
    if (cleaned) {
      blocks.push(`Slide ${pageNumber} (p.${pageNumber}):\n${cleaned}`);
    } else {
      blocks.push(`Slide ${pageNumber} (p.${pageNumber}): [NO TEXT]`);
    }
  }
  return blocks.join("\n\n");
}

/**
 * Convert extracted PDF text into the "Slide N (p.N)" machine TXT format.
 *
 * @param extractedText - Normalized text from PDF extraction.
 * @param pageCount - Optional page count to enforce missing slide placeholders.
 * @returns Machine-formatted slide text.
 */
export function formatMachineTxtFromExtractedText(extractedText: string, pageCount?: number) {
  const normalized = normalizePlainText(extractedText || "");
  const pageMap = parseNormalizedPagesFromText(normalized);
  if (!pageMap.size && normalized) {
    pageMap.set(0, normalized);
  }
  return formatMachineTxtFromPageMap(pageMap, pageCount);
}

function normalizeMachineTxtInput(text: string) {
  const normalized = (text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  return normalized.replace(/\s+$/g, "");
}

/**
 * Parse slide headers from machine TXT into a slide list.
 *
 * @param text - Machine TXT content with "Slide N (p.N)" headers.
 * @returns Slides, count, and normalized text.
 */
export function parseMachineSlideListFromTxt(text: string) {
  const normalized = normalizeMachineTxtInput(text);
  const regex = /^Slide\s+(\d+)\s+\(p\.(\d+)\):/gim;
  const slides: Array<MachineSlide & { order: number }> = [];
  let match: RegExpExecArray | null;
  let order = 0;
  while ((match = regex.exec(normalized))) {
    const n = Number(match[1]);
    const pageRaw = Number(match[2]);
    if (!Number.isFinite(n)) continue;
    const page = Number.isFinite(pageRaw) ? pageRaw : n;
    slides.push({ n, page, title: "", order });
    order += 1;
  }
  const sorted = slides
    .sort((a, b) => (a.n - b.n) || (a.order - b.order))
    .map(({ order: _order, ...rest }) => rest);
  return { slides: sorted, slideCount: slides.length, normalizedText: normalized };
}

/**
 * Parse machine TXT into slide blocks with per-slide body text.
 *
 * @param text - Machine TXT content with slide headers and bodies.
 * @returns Slides with body text, count, and normalized text.
 */
export function parseMachineSlideBlocksFromTxt(text: string) {
  const normalized = normalizeMachineTxtInput(text);
  const regex = /^Slide\s+(\d+)\s+\(p\.(\d+)\):.*$/gim;
  const matches = Array.from(normalized.matchAll(regex));
  const slides: Array<MachineSlideBlock & { order: number }> = [];
  let order = 0;

  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    if (!match || typeof match.index !== "number") continue;
    const n = Number(match[1]);
    const pageRaw = Number(match[2]);
    if (!Number.isFinite(n)) continue;
    const page = Number.isFinite(pageRaw) ? pageRaw : n;
    const headerEnd = match.index + match[0].length;
    const nextIndex = i + 1 < matches.length && typeof matches[i + 1].index === "number"
      ? (matches[i + 1].index as number)
      : normalized.length;
    let body = normalized.slice(headerEnd, nextIndex);
    if (body.startsWith("\n")) body = body.slice(1);
    const cleaned = body.replace(/\s+$/g, "").trim();
    slides.push({ n, page, text: cleaned || "[NO TEXT]", order });
    order += 1;
  }

  const sorted = slides
    .sort((a, b) => (a.n - b.n) || (a.order - b.order))
    .map(({ order: _order, ...rest }) => rest);
  return { slides: sorted, slideCount: slides.length, normalizedText: normalized };
}

/**
 * Replace all placeholder strings in a prompt template.
 *
 * @param template - Template string containing placeholder tokens.
 * @param replacements - Map of placeholder to replacement text.
 * @returns Template with all replacements applied.
 */
export function applyStudyGuidePromptTemplate(template: string, replacements: Record<string, string>) {
  let output = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    output = output.split(placeholder).join(value);
  }
  return output;
}

type StepAChunk = {
  startSlide: number;
  endSlide: number;
  text: string;
  slides: MachineSlideBlock[];
};

type StepAChunkExtractOutput = {
  lecture_title: string;
  chunk: { start_slide: number; end_slide: number };
  slides: StepAOutput["slides"];
};

type StepAExtractOutput = Pick<StepAOutput, "lecture_title" | "slides">;

type StepA1FailureKind = "EXTRACT" | "PARSE" | "TRUNCATED" | "SCHEMA";

type StepA1Result<T> =
  | { ok: true; data: T; raw: string; retries: number }
  | { ok: false; kind: StepA1FailureKind; raw: string; detail: string; retries: number };

type StepAChunkStatus = "ok" | "failed" | "partial";

type StepAChunkManifestEntry = {
  start: number;
  end: number;
  status: StepAChunkStatus;
  storedKey?: string;
  retries?: number;
  errorKind?: StepA1FailureKind;
  errorDetail?: string;
  updatedAt: number;
};

type StepAChunkManifest = {
  docKey: string;
  mode: string;
  promptVersion: string;
  chunks: StepAChunkManifestEntry[];
};

type StepAChunkOutcome = {
  start: number;
  end: number;
  status: "ok" | "failed";
  kind?: StepA1FailureKind;
  detail?: string;
  retries: number;
  fromCache: boolean;
};

type StepAExtractionResult = {
  stepA: StepAOutput;
  chunkCount: number;
  okChunks: number;
  totalChunks: number;
  failures: StepAChunkOutcome[];
  processed: StepAChunkOutcome[];
  unprocessed: Array<{ start: number; end: number }>;
  timeBudgetHit: boolean;
  promptVersion: string;
  docKey: string;
  manifestKey: string;
};

type StepADerivedOutput = {
  raw_facts: StepAOutput["raw_facts"];
  buckets: StepAOutput["buckets"];
  discriminators: StepAOutput["discriminators"];
  exam_atoms: StepAOutput["exam_atoms"];
  abbrev_map: StepAOutput["abbrev_map"];
  source_spans: StepAOutput["source_spans"];
};

type StepCSummary = {
  lecture_title: string;
  slide_count: number;
  headings: string[];
  section_count: number;
  fact_count: number;
  table_count: number;
  global_entities: {
    diseases: string[];
    drugs: string[];
    labs: string[];
    genes: string[];
    buzzwords: string[];
    cutoffs: string[];
  };
  checks_input: {
    has_high_yield_summary: boolean;
    has_rapid_approach_table: boolean;
    has_one_page_review: boolean;
    slide_count_stepA: number;
    slide_count_rendered: number;
  };
  step_b_counts: {
    high_yield_summary_count: number;
    rapid_approach_table_count: number;
    one_page_review_count: number;
    compare_differential_count: number;
    quant_cutoffs_count: number;
    pitfalls_count: number;
    glossary_count: number;
    supplemental_glue_count: number;
  };
};

function formatStudyGuideSlideBlock(slide: MachineSlideBlock): string {
  const body = slide.text || "[NO TEXT]";
  return `Slide ${slide.n} (p.${slide.page}):\n${body}`;
}

/**
 * Split slide blocks into Step A extraction chunks within size limits.
 *
 * @param slides - Slide blocks with page text.
 * @param maxSlides - Maximum slides per chunk.
 * @param maxChars - Maximum characters per chunk.
 * @returns Chunk list for Step A extraction.
 */
export function buildStudyGuideStepAChunks(
  slides: MachineSlideBlock[],
  maxSlides = MACHINE_STUDY_GUIDE_STEP_A_MAX_SLIDES,
  maxChars = MACHINE_STUDY_GUIDE_STEP_A_MAX_CHARS,
): StepAChunk[] {
  const chunks: StepAChunk[] = [];
  let currentSlides: MachineSlideBlock[] = [];
  let currentParts: string[] = [];
  let currentLength = 0;

  const flush = () => {
    if (!currentSlides.length) return;
    const first = currentSlides[0];
    const last = currentSlides[currentSlides.length - 1];
    if (!first || !last) return;
    const text = currentParts.join("\n\n");
    chunks.push({
      startSlide: first.n,
      endSlide: last.n,
      text,
      slides: currentSlides,
    });
    currentSlides = [];
    currentParts = [];
    currentLength = 0;
  };

  for (const slide of slides) {
    const blockText = formatStudyGuideSlideBlock(slide);
    const separatorLength = currentParts.length ? 2 : 0;
    if (
      currentSlides.length &&
      (currentSlides.length >= maxSlides || currentLength + separatorLength + blockText.length > maxChars)
    ) {
      flush();
    }
    const nextSeparator = currentParts.length ? 2 : 0;
    currentSlides.push(slide);
    currentParts.push(blockText);
    currentLength += nextSeparator + blockText.length;
  }

  flush();
  return chunks;
}

function shouldReduceStepAChunkSize(chunks: StepAChunk[]): boolean {
  return chunks.some(
    chunk =>
      chunk.text.length > MACHINE_STUDY_GUIDE_STEP_A_ADAPTIVE_CHARS ||
      estimateTokenCount(chunk.text) > MACHINE_STUDY_GUIDE_STEP_A_ADAPTIVE_TOKENS,
  );
}

function buildAdaptiveStudyGuideStepAChunks(
  slides: MachineSlideBlock[],
  maxSlides = MACHINE_STUDY_GUIDE_STEP_A_MAX_SLIDES,
  maxChars = MACHINE_STUDY_GUIDE_STEP_A_MAX_CHARS,
): StepAChunk[] {
  const initial = buildStudyGuideStepAChunks(slides, maxSlides, maxChars);
  if (!initial.length || maxSlides <= 1) return initial;
  if (!shouldReduceStepAChunkSize(initial)) return initial;
  const reducedMaxSlides = Math.max(1, Math.floor(maxSlides / 2));
  const reduced = buildStudyGuideStepAChunks(slides, reducedMaxSlides, maxChars);
  console.log("[machine.studyGuide] step=A chunk_size_reduced", {
    from: maxSlides,
    to: reducedMaxSlides,
    initialChunks: initial.length,
    reducedChunks: reduced.length,
  });
  return reduced;
}

function buildStepAChunkFromSlides(slides: MachineSlideBlock[]): StepAChunk | null {
  if (!slides.length) return null;
  const first = slides[0];
  const last = slides[slides.length - 1];
  if (!first || !last) return null;
  const text = slides.map(formatStudyGuideSlideBlock).join("\n\n");
  return {
    startSlide: first.n,
    endSlide: last.n,
    text,
    slides,
  };
}

function splitStepAChunk(chunk: StepAChunk): [StepAChunk, StepAChunk] | null {
  const count = chunk.slides.length;
  if (count < 2) return null;
  const mid = Math.floor(count / 2);
  if (mid < 1 || mid >= count) return null;
  const left = buildStepAChunkFromSlides(chunk.slides.slice(0, mid));
  const right = buildStepAChunkFromSlides(chunk.slides.slice(mid));
  if (!left || !right) return null;
  return [left, right];
}

function chunkHasRealContent(chunk: StepAChunk): boolean {
  return chunk.slides.some(slide => {
    const text = (slide.text || "").trim();
    return text && text !== "[NO TEXT]" && text.length > 30;
  });
}

function buildStepAKeyPrefix(docKey: string, mode: string, promptVersion: string) {
  const safeDocKey = sanitizeMachineSlug(docKey, "doc");
  const safeMode = sanitizeMachineSlug(mode || "maximal", "maximal");
  return `study_guides/${safeDocKey}/${safeMode}/stepA/${promptVersion}`;
}

function buildStepAChunkCacheKey(prefix: string, start: number, end: number) {
  return `${prefix}/chunk_${start}_${end}.json`;
}

function buildStepAManifestKey(prefix: string) {
  return `${prefix}/manifest.json`;
}

async function readStepAChunkManifest(env: Env, manifestKey: string): Promise<StepAChunkManifest | null> {
  const { bucket } = getLibraryBucket(env);
  const object = await bucket.get(manifestKey);
  if (!object || !object.body) return null;
  const text = await object.text();
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    if (!Array.isArray(parsed.chunks)) return null;
    return parsed as StepAChunkManifest;
  } catch {
    return null;
  }
}

async function writeStepAChunkManifest(env: Env, manifestKey: string, manifest: StepAChunkManifest) {
  const { bucket } = getLibraryBucket(env);
  await bucket.put(manifestKey, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

async function readStepAChunkCache(env: Env, storedKey: string): Promise<StepAChunkExtractOutput | null> {
  const { bucket } = getLibraryBucket(env);
  const object = await bucket.get(storedKey);
  if (!object || !object.body) return null;
  const text = await object.text();
  try {
    const parsed = JSON.parse(text);
    if (validateStepAChunkExtractOutput(parsed).length) return null;
    return parsed as StepAChunkExtractOutput;
  } catch {
    return null;
  }
}

function upsertStepAChunkManifestEntry(
  manifest: StepAChunkManifest,
  entry: StepAChunkManifestEntry,
) {
  const idx = manifest.chunks.findIndex(chunk => chunk.start === entry.start && chunk.end === entry.end);
  if (idx >= 0) {
    manifest.chunks[idx] = { ...manifest.chunks[idx], ...entry };
  } else {
    manifest.chunks.push(entry);
  }
}

/**
 * Merge multiple Step A chunk outputs into a single slide list.
 *
 * @param chunks - Step A outputs for individual chunks.
 * @returns Merged Step A extract output.
 * @remarks Side effects: logs warnings for duplicate slides.
 */
export function mergeStepAChunks(chunks: StepAChunkExtractOutput[]): StepAExtractOutput {
  if (!chunks.length) {
    return { lecture_title: "Lecture", slides: [] };
  }
  const sortedChunks = [...chunks].sort((a, b) => {
    const aStart = Number.isFinite(a.chunk?.start_slide) ? a.chunk.start_slide : 0;
    const bStart = Number.isFinite(b.chunk?.start_slide) ? b.chunk.start_slide : 0;
    return aStart - bStart;
  });
  const firstChunk = sortedChunks[0];
  if (!firstChunk) {
    return { lecture_title: "Lecture", slides: [] };
  }
  const slides: StepAOutput["slides"] = [];
  const seen = new Set<number>();
  for (const chunk of sortedChunks) {
    const sortedSlides = [...(chunk.slides || [])].sort((a, b) => a.n - b.n);
    for (const slide of sortedSlides) {
      if (seen.has(slide.n)) {
        console.warn("[machine.studyGuide] Duplicate slide in Step A merge", { slide: slide.n });
        continue;
      }
      seen.add(slide.n);
      slides.push(slide);
    }
  }
  return {
    lecture_title: firstChunk.lecture_title || "Lecture",
    slides,
  };
}

function buildDefaultStepADerivedOutput(): StepADerivedOutput {
  return {
    raw_facts: [],
    buckets: {
      dx: [],
      pathophys: [],
      clinical: [],
      labs: [],
      imaging: [],
      treatment: [],
      complications: [],
      risk_factors: [],
      epidemiology: [],
      red_flags: [],
      buzzwords: [],
    },
    discriminators: [],
    exam_atoms: [],
    abbrev_map: {},
    source_spans: [],
  };
}

/**
 * Combine Step A extract output with derived metadata (buckets, atoms).
 *
 * @param stepAExtract - Step A extract output (slides + title).
 * @param derived - Derived buckets/atoms from Step A.
 * @returns Complete Step A output.
 */
export function mergeStepAExtractAndDerived(
  stepAExtract: StepAExtractOutput,
  derived: StepADerivedOutput | null | undefined,
): StepAOutput {
  const safeDerived = derived ?? buildDefaultStepADerivedOutput();
  return {
    lecture_title: stepAExtract.lecture_title || "Lecture",
    slides: stepAExtract.slides || [],
    raw_facts: safeDerived.raw_facts,
    buckets: safeDerived.buckets,
    discriminators: safeDerived.discriminators,
    exam_atoms: safeDerived.exam_atoms,
    abbrev_map: safeDerived.abbrev_map,
    source_spans: safeDerived.source_spans,
  };
}

async function extractStepAFromChunks(opts: {
  env: Env;
  requestId: string;
  lectureTitle: string;
  stepJsonModel: string;
  stepAChunks: StepAChunk[];
  docKey: string;
  mode: string;
  promptVersion: string;
  startedAt: number;
  timeBudgetMs: number;
}): Promise<StepAExtractionResult> {
  const now = Date.now;
  const chunkOutputs: StepAChunkExtractOutput[] = [];
  const outcomes: StepAChunkOutcome[] = [];
  const failures: StepAChunkOutcome[] = [];
  const unprocessed: Array<{ start: number; end: number }> = [];
  let timeBudgetHit = false;

  const prefix = buildStepAKeyPrefix(opts.docKey, opts.mode, opts.promptVersion);
  const manifestKey = buildStepAManifestKey(prefix);
  const existingManifest = await readStepAChunkManifest(opts.env, manifestKey);
  let manifest: StepAChunkManifest = {
    docKey: opts.docKey,
    mode: opts.mode,
    promptVersion: opts.promptVersion,
    chunks: [],
  };
  if (
    existingManifest &&
    existingManifest.docKey === opts.docKey &&
    existingManifest.promptVersion === opts.promptVersion &&
    existingManifest.mode === opts.mode
  ) {
    manifest = existingManifest;
  }

  const persistManifest = async () => {
    try {
      await writeStepAChunkManifest(opts.env, manifestKey, manifest);
    } catch (err) {
      console.warn("[machine.studyGuide] step=A manifest write failed", {
        key: manifestKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const recordOutcome = (entry: StepAChunkOutcome) => {
    outcomes.push(entry);
    if (entry.status === "failed") failures.push(entry);
  };

  const tryLoadCachedCoverage = async (start: number, end: number): Promise<StepAChunkExtractOutput[] | null> => {
    const candidates = manifest.chunks
      .filter(entry => entry.status === "ok" && entry.start >= start && entry.end <= end && entry.storedKey)
      .sort((a, b) => a.start - b.start);
    if (!candidates.length) return null;
    if (candidates[0].start !== start) return null;
    let cursor = start;
    const outputs: StepAChunkExtractOutput[] = [];
    for (const entry of candidates) {
      if (entry.start !== cursor) return null;
      const cached = await readStepAChunkCache(opts.env, entry.storedKey || "");
      if (!cached) return null;
      outputs.push(cached);
      cursor = entry.end + 1;
    }
    if (cursor - 1 !== end) return null;
    for (const entry of candidates) {
      recordOutcome({
        start: entry.start,
        end: entry.end,
        status: "ok",
        retries: entry.retries || 0,
        fromCache: true,
      });
    }
    return outputs;
  };

  const runChunkExtraction = async (chunk: StepAChunk, label: string): Promise<StepA1Result<StepAChunkExtractOutput>> => {
    const stepAPrompt = applyStudyGuidePromptTemplate(STUDY_GUIDE_STEP_A_EXTRACT_PROMPT, {
      "{{LECTURE_TITLE}}": opts.lectureTitle,
      "{{CHUNK_START}}": String(chunk.startSlide),
      "{{CHUNK_END}}": String(chunk.endSlide),
      "{{CHUNK_TEXT}}": chunk.text,
    });
    const stepAPromptStrict = [
      stepAPrompt,
      "",
      "STRICT_JSON_ONLY:",
      "Return ONLY a single JSON object for the schema above.",
      "No markdown. No backticks. No extra keys. No trailing commentary.",
      "End immediately after the final }.",
      "Do not repeat closing braces.",
      "Keep strings concise and avoid verbosity.",
    ].join("\n");
    const hasContent = chunkHasRealContent(chunk);
    let stepARaw = "";
    console.log("[machine.studyGuide] step=A1 request=%s chunk=%s-%s chars=%s", opts.requestId, chunk.startSlide, chunk.endSlide, chunk.text.length);
    try {
      stepARaw = await callStudyGuideResponses(
        opts.env,
        opts.requestId,
        label,
        opts.stepJsonModel,
        stepAPrompt,
        MACHINE_STUDY_GUIDE_STEP_A_MAX_OUTPUT_TOKENS,
        { expectsJson: true },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, kind: "EXTRACT", raw: "", detail: msg, retries: 0 };
    }
    let result = classifyStepAChunkRaw(stepARaw, {
      validate: validateStepAChunkExtractOutput,
      hasContent,
    });
    if (result.ok) {
      return result;
    }
    const shouldRetry = ["TRUNCATED", "PARSE", "SCHEMA", "EXTRACT"].includes(result.kind);
    if (!shouldRetry) {
      return result;
    }
    let retryRaw = "";
    try {
      retryRaw = await callStudyGuideResponses(
        opts.env,
        opts.requestId,
        `${label}-retry`,
        opts.stepJsonModel,
        stepAPromptStrict,
        MACHINE_STUDY_GUIDE_STEP_A_MAX_OUTPUT_TOKENS,
        { expectsJson: true },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, kind: "EXTRACT", raw: retryRaw, detail: msg, retries: 1 };
    }
    const retryResult = classifyStepAChunkRaw(retryRaw, {
      validate: validateStepAChunkExtractOutput,
      hasContent,
    });
    if (retryResult.ok) {
      return { ...retryResult, retries: 1 };
    }
    return { ...retryResult, retries: 1 };
  };

  const processChunk = async (chunk: StepAChunk, depth: number): Promise<boolean> => {
    if (now() - opts.startedAt > opts.timeBudgetMs) {
      timeBudgetHit = true;
      return false;
    }
    const cachedCoverage = await tryLoadCachedCoverage(chunk.startSlide, chunk.endSlide);
    if (cachedCoverage) {
      chunkOutputs.push(...cachedCoverage);
      return true;
    }
    const chunkKey = buildStepAChunkCacheKey(prefix, chunk.startSlide, chunk.endSlide);
    const cached = await readStepAChunkCache(opts.env, chunkKey);
    if (cached) {
      const existingEntry = manifest.chunks.find(entry => entry.start === chunk.startSlide && entry.end === chunk.endSlide);
      chunkOutputs.push(cached);
      recordOutcome({
        start: chunk.startSlide,
        end: chunk.endSlide,
        status: "ok",
        retries: existingEntry?.retries || 0,
        fromCache: true,
      });
      upsertStepAChunkManifestEntry(manifest, {
        start: chunk.startSlide,
        end: chunk.endSlide,
        status: "ok",
        storedKey: chunkKey,
        retries: existingEntry?.retries || 0,
        updatedAt: now(),
      });
      await persistManifest();
      return true;
    }
    const stepLabel = `A${chunk.startSlide}-${chunk.endSlide}`;
    const result = await runChunkExtraction(chunk, stepLabel);
    if (result.ok) {
      const storedPayload = JSON.stringify(result.data, null, 2);
      const { bucket } = getLibraryBucket(opts.env);
      await bucket.put(chunkKey, storedPayload, {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });
      upsertStepAChunkManifestEntry(manifest, {
        start: chunk.startSlide,
        end: chunk.endSlide,
        status: "ok",
        storedKey: chunkKey,
        retries: result.retries,
        updatedAt: now(),
      });
      await persistManifest();
      chunkOutputs.push(result.data);
      recordOutcome({
        start: chunk.startSlide,
        end: chunk.endSlide,
        status: "ok",
        retries: result.retries,
        fromCache: false,
      });
      return true;
    }

    let canSplit =
      depth < MACHINE_STUDY_GUIDE_STEP_A_SPLIT_MAX_DEPTH &&
      chunk.slides.length > MACHINE_STUDY_GUIDE_STEP_A_MIN_SLIDES;
    if (canSplit) {
      upsertStepAChunkManifestEntry(manifest, {
        start: chunk.startSlide,
        end: chunk.endSlide,
        status: "partial",
        retries: result.retries,
        errorKind: result.kind,
        errorDetail: result.detail,
        updatedAt: now(),
      });
      await persistManifest();
      const split = splitStepAChunk(chunk);
      if (!split) {
        canSplit = false;
      } else {
        const [left, right] = split;
        const leftOk = await processChunk(left, depth + 1);
        if (!leftOk) {
          return false;
        }
        const rightOk = await processChunk(right, depth + 1);
        if (!rightOk) {
          return false;
        }
        return true;
      }
    }

    recordOutcome({
      start: chunk.startSlide,
      end: chunk.endSlide,
      status: "failed",
      kind: result.kind,
      detail: result.detail,
      retries: result.retries,
      fromCache: false,
    });
    upsertStepAChunkManifestEntry(manifest, {
      start: chunk.startSlide,
      end: chunk.endSlide,
      status: "failed",
      retries: result.retries,
      errorKind: result.kind,
      errorDetail: result.detail,
      updatedAt: now(),
    });
    await persistManifest();
    return true;
  };

  for (let i = 0; i < opts.stepAChunks.length; i += 1) {
    const chunk = opts.stepAChunks[i];
    const processed = await processChunk(chunk, 0);
    if (!processed || timeBudgetHit) {
      unprocessed.push({ start: chunk.startSlide, end: chunk.endSlide });
      for (let j = i + 1; j < opts.stepAChunks.length; j += 1) {
        const remaining = opts.stepAChunks[j];
        unprocessed.push({ start: remaining.startSlide, end: remaining.endSlide });
      }
      break;
    }
    const hasRemaining = i + 1 < opts.stepAChunks.length;
    if (hasRemaining && now() - opts.startedAt > opts.timeBudgetMs) {
      timeBudgetHit = true;
      for (let j = i + 1; j < opts.stepAChunks.length; j += 1) {
        const remaining = opts.stepAChunks[j];
        unprocessed.push({ start: remaining.startSlide, end: remaining.endSlide });
      }
      break;
    }
  }

  const stepAExtract = mergeStepAChunks(chunkOutputs);
  let stepADerived: StepADerivedOutput | null = null;
  if (!timeBudgetHit && chunkOutputs.length) {
    try {
      stepADerived = await deriveStepAFromExtract({
        env: opts.env,
        requestId: opts.requestId,
        stepJsonModel: opts.stepJsonModel,
        stepAExtract,
      });
    } catch (err) {
      console.warn("[machine.studyGuide] step=A2 derive failed; using fallback", {
        error: err instanceof Error ? err.message : String(err),
      });
      stepADerived = null;
    }
  }
  const stepA = mergeStepAExtractAndDerived(stepAExtract, stepADerived);
  console.log("[machine.studyGuide] step=A json=ok chunks=%s", chunkOutputs.length);

  return {
    stepA,
    chunkCount: chunkOutputs.length,
    okChunks: chunkOutputs.length,
    totalChunks: outcomes.length,
    failures,
    processed: outcomes,
    unprocessed,
    timeBudgetHit,
    promptVersion: opts.promptVersion,
    docKey: opts.docKey,
    manifestKey,
  };
}

async function deriveStepAFromExtract(opts: {
  env: Env;
  requestId: string;
  stepJsonModel: string;
  stepAExtract: StepAExtractOutput;
}): Promise<StepADerivedOutput> {
  const stepAExtractJson = JSON.stringify(
    {
      lecture_title: opts.stepAExtract.lecture_title || "",
      slides: opts.stepAExtract.slides || [],
    },
    null,
    2,
  );
  const derivePrompt = applyStudyGuidePromptTemplate(STUDY_GUIDE_STEP_A_DERIVE_PROMPT, {
    "{{STEP_A1_JSON}}": stepAExtractJson,
  });
  const deriveRaw = await callStudyGuideResponses(
    opts.env,
    opts.requestId,
    "A2-derive",
    opts.stepJsonModel,
    derivePrompt,
    MACHINE_STUDY_GUIDE_STEP_A_MAX_OUTPUT_TOKENS,
    { expectsJson: true },
  );
  return parseStudyGuideJsonStrict<StepADerivedOutput>(deriveRaw, "A2-derive", validateStepADerivedOutput);
}

function buildStepCSummary(stepA: StepAOutput, stepB: StepBOutput, renderedSlideCount: number): StepCSummary {
  const headings: string[] = [];
  const seenHeadings = new Set<string>();
  let sectionCount = 0;
  let factCount = 0;
  let tableCount = 0;
  const globalEntities = {
    diseases: new Set<string>(),
    drugs: new Set<string>(),
    labs: new Set<string>(),
    genes: new Set<string>(),
    buzzwords: new Set<string>(),
    cutoffs: new Set<string>(),
  };

  for (const slide of stepA.slides || []) {
    tableCount += (slide.tables || []).length;
    for (const section of slide.sections || []) {
      sectionCount += 1;
      const heading = (section.heading || "").trim();
      if (heading && !seenHeadings.has(heading) && headings.length < 60) {
        seenHeadings.add(heading);
        headings.push(heading);
      }
      for (const fact of section.facts || []) {
        factCount += 1;
        const factText = (fact.text || "").replace(/\s+/g, " ").trim();
        if (!factText) continue;
        const limitedFactText = factText.length > 120 ? factText.slice(0, 120) : factText;
        for (const tag of fact.tags || []) {
          switch (tag) {
            case "disease":
              if (globalEntities.diseases.size < 50) globalEntities.diseases.add(limitedFactText);
              break;
            case "treatment":
              if (globalEntities.drugs.size < 50) globalEntities.drugs.add(limitedFactText);
              break;
            case "lab":
              if (globalEntities.labs.size < 50) globalEntities.labs.add(limitedFactText);
              break;
            case "gene":
            case "enzyme":
              if (globalEntities.genes.size < 50) globalEntities.genes.add(limitedFactText);
              break;
            case "buzz":
              if (globalEntities.buzzwords.size < 50) globalEntities.buzzwords.add(limitedFactText);
              break;
            case "cutoff":
              if (globalEntities.cutoffs.size < 50) globalEntities.cutoffs.add(limitedFactText);
              break;
            default:
              break;
          }
        }
      }
    }
  }

  const slideCount = stepA.slides.length;
  const checksInput = {
    has_high_yield_summary: (stepB.high_yield_summary || []).length > 0,
    has_rapid_approach_table: (stepB.rapid_approach_table || []).length > 0,
    has_one_page_review: (stepB.one_page_last_minute_review || []).length > 0,
    slide_count_stepA: slideCount,
    slide_count_rendered: renderedSlideCount,
  };

  return {
    lecture_title: stepA.lecture_title || "Lecture",
    slide_count: slideCount,
    headings,
    section_count: sectionCount,
    fact_count: factCount,
    table_count: tableCount,
    global_entities: {
      diseases: Array.from(globalEntities.diseases),
      drugs: Array.from(globalEntities.drugs),
      labs: Array.from(globalEntities.labs),
      genes: Array.from(globalEntities.genes),
      buzzwords: Array.from(globalEntities.buzzwords),
      cutoffs: Array.from(globalEntities.cutoffs),
    },
    checks_input: checksInput,
    step_b_counts: {
      high_yield_summary_count: (stepB.high_yield_summary || []).length,
      rapid_approach_table_count: (stepB.rapid_approach_table || []).length,
      one_page_review_count: (stepB.one_page_last_minute_review || []).length,
      compare_differential_count: (stepB.compare_differential || []).length,
      quant_cutoffs_count: (stepB.quant_cutoffs || []).length,
      pitfalls_count: (stepB.pitfalls || []).length,
      glossary_count: (stepB.glossary || []).length,
      supplemental_glue_count: (stepB.supplemental_glue || []).length,
    },
  };
}

function buildDefaultStepB(): StepBOutput {
  return {
    high_yield_summary: [],
    rapid_approach_table: [],
    one_page_last_minute_review: [],
    compare_differential: [],
    quant_cutoffs: [],
    pitfalls: [],
    glossary: [],
    supplemental_glue: [],
  };
}

function buildDefaultStepC(stepA: StepAOutput, stepB: StepBOutput, renderedSlideCount: number): StepCOutput {
  return {
    coverage_confidence: "Med",
    unparsed_items: [],
    omissions: [],
    conflicts: [],
    checks: {
      has_high_yield_summary: (stepB.high_yield_summary || []).length > 0,
      has_rapid_approach_table: (stepB.rapid_approach_table || []).length > 0,
      has_one_page_review: (stepB.one_page_last_minute_review || []).length > 0,
      slide_count_stepA: (stepA.slides || []).length,
      slide_count_rendered: renderedSlideCount,
    },
  };
}

/**
 * Build a human-readable filename for the study guide HTML.
 *
 * @param lectureTitle - Optional lecture title to embed in the filename.
 * @returns Filename string (no path).
 */
export function buildStudyGuideFilename(lectureTitle?: string) {
  const title = lectureTitle?.trim() || "Lecture";
  return `Study_Guide_${title}.html`;
}

/**
 * Build a human-readable filename for the study guide source TXT.
 *
 * @param lectureTitle - Optional lecture title to embed in the filename.
 * @returns Filename string (no path).
 */
export function buildStudyGuideSourceFilename(lectureTitle?: string) {
  const title = lectureTitle?.trim() || "Lecture";
  return `Study_Guide_${title}_Source.txt`;
}

/**
 * Build the R2 key for storing the generated study guide HTML.
 *
 * @param docId - Lecture doc id used to scope the study guide to one lecture instance.
 * @param lectureTitle - Lecture title used to build a stable filename within the lecture scope.
 * @returns Storage key under the study guide prefix.
 */
export function buildStudyGuideStoredKey(docId?: string, lectureTitle?: string) {
  const safeDocId = sanitizeMachineSlug(docId?.trim() || "", "doc");
  const title = lectureTitle?.trim() || "Lecture";
  const safeTitle = sanitizeMachineSlug(title, "lecture");
  return `${MACHINE_STUDY_GUIDE_PREFIX}/${safeDocId}/${safeTitle}/Study_Guide_${safeTitle}.html`;
}

/**
 * Build the R2 key for storing the study guide source TXT.
 *
 * @param docId - Lecture doc id used to scope the study guide source to one lecture instance.
 * @param lectureTitle - Lecture title used to build a stable filename within the lecture scope.
 * @returns Storage key under the study guide prefix.
 */
export function buildStudyGuideSourceKey(docId?: string, lectureTitle?: string) {
  const safeDocId = sanitizeMachineSlug(docId?.trim() || "", "doc");
  const title = lectureTitle?.trim() || "Lecture";
  const safeTitle = sanitizeMachineSlug(title, "lecture");
  return `${MACHINE_STUDY_GUIDE_PREFIX}/${safeDocId}/${safeTitle}/Study_Guide_${safeTitle}.txt`;
}

type StudyGuidePublishInput = {
  kind: string;
  key: string;
  filename?: string;
  contentType?: string;
};

type StudyGuidePublishedAsset = {
  kind: string;
  path: string;
  filename: string;
  contentType: string;
  size?: number;
};

type ArtifactLifecycleStatus = "draft" | "in_review" | "approved" | "published" | "archived";

type ArtifactReviewMetadata = {
  status: Exclude<ArtifactLifecycleStatus, "draft" | "archived">;
  reviewedAt: string;
  reviewedBy: {
    userId: string;
    email: string;
    displayName: string;
    role: UserRole;
  };
  notes?: string;
};

type ArtifactProvenance = {
  institutionId: string;
  sourceStoredKey?: string;
  sourceLectureId?: string;
  sourceLectureTitle?: string;
  sourceManifestKey?: string;
  generatedFrom: "lecture_materials";
};

type ArtifactQualitySignals = {
  validationPassed: boolean;
  needsReview: boolean;
  missingSourceMapping: boolean;
  incompleteExtraction: boolean;
};

type StudyGuideManifest = {
  code: string;
  title: string;
  publishedAt: string;
  assets: StudyGuidePublishedAsset[];
  lifecycleStatus?: ArtifactLifecycleStatus;
  review?: ArtifactReviewMetadata;
  provenance?: ArtifactProvenance;
  qualitySignals?: ArtifactQualitySignals;
  docId?: string;
  lectureId?: string;
  mode?: string;
};

type StudyGuidePublishRecord = {
  docId: string;
  code: string;
  publishedAt: string;
  manifestKey: string;
  storedKey?: string;
  title?: string;
};

type StudyGuideManifestIndexEntry = {
  docId?: string;
  title?: string;
  code: string;
  publishedAt?: string;
  manifestKey: string;
};

type AnkiManifest = {
  code: string;
  ankiKey: string;
  lectureTitle?: string;
  lectureId?: string;
  createdAt: string;
  publishedAt?: string;
  createdBy?: string;
  imageCount?: number;
  hasBoldmap?: boolean;
  hasClassmateDeck?: boolean;
  mediaPrefix?: string;
  lifecycleStatus?: ArtifactLifecycleStatus;
  review?: ArtifactReviewMetadata;
  provenance?: ArtifactProvenance;
  qualitySignals?: ArtifactQualitySignals;
};

type AnkiPublishRecord = {
  docId: string;
  code: string;
  publishedAt: string;
  manifestKey: string;
  ankiKey: string;
  storedKey?: string;
  title?: string;
};

function normalizeStudyGuideCode(value: string) {
  return (value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isStudyGuideCodeValid(code: string) {
  if (!code) return false;
  if (code.length < 6 || code.length > 10) return false;
  for (const ch of code) {
    if (!STUDY_GUIDE_CODE_ALPHABET.includes(ch)) return false;
  }
  return true;
}

function buildStudyGuidePublishPrefix(code: string) {
  return `${STUDY_GUIDE_PUBLISH_PREFIX}/${code}`;
}

function buildStudyGuideManifestKey(code: string) {
  return `${buildStudyGuidePublishPrefix(code)}/${STUDY_GUIDE_MANIFEST_FILENAME}`;
}

function buildStudyGuideSourceMappingKey(storedKey: string) {
  return `studyguide:source:${storedKey}`;
}

function buildStudyGuidePublishRecordKey(docId: string) {
  const safeDocId = sanitizeMachineSlug(docId, "doc");
  return `${STUDY_GUIDE_PUBLISH_INDEX_PREFIX}/${safeDocId}.json`;
}

function coerceStudyGuidePublishRecord(raw: unknown): StudyGuidePublishRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const docId = typeof (raw as any).docId === "string" ? (raw as any).docId.trim() : "";
  const rawCode = typeof (raw as any).code === "string" ? (raw as any).code : "";
  const code = normalizeStudyGuideCode(rawCode);
  if (!docId || !isStudyGuideCodeValid(code)) return null;
  const publishedAt = typeof (raw as any).publishedAt === "string" ? (raw as any).publishedAt : "";
  const manifestKey = typeof (raw as any).manifestKey === "string"
    ? (raw as any).manifestKey
    : buildStudyGuideManifestKey(code);
  const storedKey = typeof (raw as any).storedKey === "string" ? (raw as any).storedKey : undefined;
  const title = typeof (raw as any).title === "string" ? (raw as any).title : undefined;
  return { docId, code, publishedAt, manifestKey, storedKey, title };
}

async function persistStudyGuidePublishRecord(env: Env, record: StudyGuidePublishRecord) {
  if (!record?.docId) return;
  const code = normalizeStudyGuideCode(record.code || "");
  if (!isStudyGuideCodeValid(code)) return;
  const normalized: StudyGuidePublishRecord = {
    ...record,
    code,
    manifestKey: record.manifestKey || buildStudyGuideManifestKey(code),
  };
  try {
    const { bucket } = getPublishBucket(env);
    await bucket.put(buildStudyGuidePublishRecordKey(record.docId), JSON.stringify(normalized), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  } catch {}
  if (env.DOCS_KV) {
    await env.DOCS_KV.put(`studyguide:lecture:${record.docId}`, JSON.stringify(normalized));
  }
}

async function loadStudyGuidePublishRecord(env: Env, docId: string): Promise<StudyGuidePublishRecord | null> {
  if (!docId) return null;
  if (env.DOCS_KV) {
    const cached = await env.DOCS_KV.get(`studyguide:lecture:${docId}`, { type: "json" }) as any;
    const parsed = coerceStudyGuidePublishRecord(cached);
    if (parsed) return parsed;
  }
  try {
    const { bucket } = getPublishBucket(env);
    const obj = await bucket.get(buildStudyGuidePublishRecordKey(docId));
    if (!obj || !obj.body) return null;
    const text = await obj.text();
    const parsed = coerceStudyGuidePublishRecord(JSON.parse(text));
    return parsed;
  } catch {
    return null;
  }
}

function buildAnkiSourceMappingKey(storedKey: string) {
  return `anki:source:${storedKey}`;
}

function buildAnkiPublishRecordKey(docId: string) {
  const safeDocId = sanitizeMachineSlug(docId, "doc");
  return `${ANKI_PUBLISH_INDEX_PREFIX}/${safeDocId}.json`;
}

function coerceAnkiPublishRecord(raw: unknown): AnkiPublishRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const docId = typeof (raw as any).docId === "string" ? (raw as any).docId.trim() : "";
  const rawCode = typeof (raw as any).code === "string" ? (raw as any).code : "";
  const code = normalizeAnkiCode(rawCode);
  if (!docId || !isAnkiCodeValid(code)) return null;
  const publishedAt = typeof (raw as any).publishedAt === "string" ? (raw as any).publishedAt : "";
  const manifestKey = typeof (raw as any).manifestKey === "string"
    ? (raw as any).manifestKey
    : buildAnkiManifestKey(code);
  const ankiKey = typeof (raw as any).ankiKey === "string" ? (raw as any).ankiKey : "";
  if (!ankiKey) return null;
  const storedKey = typeof (raw as any).storedKey === "string" ? (raw as any).storedKey : undefined;
  const title = typeof (raw as any).title === "string" ? (raw as any).title : undefined;
  return { docId, code, publishedAt, manifestKey, ankiKey, storedKey, title };
}

async function persistAnkiPublishRecord(env: Env, record: AnkiPublishRecord) {
  if (!record?.docId) return;
  const code = normalizeAnkiCode(record.code || "");
  if (!isAnkiCodeValid(code)) return;
  const ankiKey = typeof record.ankiKey === "string" ? record.ankiKey.trim() : "";
  if (!ankiKey) return;
  const normalized: AnkiPublishRecord = {
    ...record,
    code,
    ankiKey,
    manifestKey: record.manifestKey || buildAnkiManifestKey(code),
  };
  try {
    const { bucket } = getPublishBucket(env);
    await bucket.put(buildAnkiPublishRecordKey(record.docId), JSON.stringify(normalized), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  } catch {}
  if (env.DOCS_KV) {
    await env.DOCS_KV.put(`anki:lecture:${record.docId}`, JSON.stringify(normalized));
  }
}

async function loadAnkiPublishRecord(env: Env, docId: string): Promise<AnkiPublishRecord | null> {
  if (!docId) return null;
  if (env.DOCS_KV) {
    const cached = await env.DOCS_KV.get(`anki:lecture:${docId}`, { type: "json" }) as any;
    const parsed = coerceAnkiPublishRecord(cached);
    if (parsed) return parsed;
  }
  try {
    const { bucket } = getPublishBucket(env);
    const obj = await bucket.get(buildAnkiPublishRecordKey(docId));
    if (!obj || !obj.body) return null;
    const text = await obj.text();
    const parsed = coerceAnkiPublishRecord(JSON.parse(text));
    return parsed;
  } catch {
    return null;
  }
}

async function loadPublishedAnkiBySource(env: Env, storedKey: string) {
  if (!env.DOCS_KV || !storedKey) return null;
  const cached = await env.DOCS_KV.get(buildAnkiSourceMappingKey(storedKey), { type: "json" }) as any;
  const rawCode = typeof cached?.code === "string" ? cached.code : "";
  const code = normalizeAnkiCode(rawCode);
  if (!isAnkiCodeValid(code)) return null;
  const manifest = await loadAnkiManifest(env, code);
  if (!manifest) return null;
  const manifestKey = typeof cached?.manifestKey === "string" ? cached.manifestKey : buildAnkiManifestKey(code);
  const publishedPaths = [manifestKey, manifest.ankiKey].filter(Boolean);
  return { code, manifest, manifestKey, publishedPaths };
}

async function loadStudyGuideAccessCodeFromSource(env: Env, storedKey: string) {
  if (!env.DOCS_KV || !storedKey) return null;
  const cached = await env.DOCS_KV.get(buildStudyGuideSourceMappingKey(storedKey), { type: "json" }) as any;
  const rawCode = typeof cached?.code === "string" ? cached.code : "";
  const code = normalizeStudyGuideCode(rawCode);
  if (!isStudyGuideCodeValid(code)) return null;
  return {
    code,
    manifestKey: typeof cached?.manifestKey === "string" ? cached.manifestKey : undefined,
  };
}

function extractStudyGuideCodeFromManifestKey(key: string) {
  if (!key) return "";
  const parts = key.split("/");
  if (parts.length < 2) return "";
  return normalizeStudyGuideCode(parts[parts.length - 2] || "");
}

function isManifestEntryNewer(candidate: StudyGuideManifestIndexEntry, existing?: StudyGuideManifestIndexEntry | null) {
  if (!existing) return true;
  const candidateDate = coerceDate(candidate.publishedAt);
  const existingDate = coerceDate(existing.publishedAt);
  if (candidateDate && existingDate) return candidateDate > existingDate;
  if (candidateDate && !existingDate) return true;
  return false;
}

function addLatestManifestEntry(map: Map<string, StudyGuideManifestIndexEntry>, key: string, entry: StudyGuideManifestIndexEntry) {
  if (!key) return;
  const existing = map.get(key);
  if (!existing || isManifestEntryNewer(entry, existing)) {
    map.set(key, entry);
  }
}

async function loadPublishedStudyGuideManifestIndex(env: Env): Promise<StudyGuideManifestIndexEntry[]> {
  const entries: StudyGuideManifestIndexEntry[] = [];
  try {
    const { bucket } = getPublishBucket(env);
    const prefix = `${STUDY_GUIDE_PUBLISH_PREFIX}/`;
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix, cursor, limit: 1000 });
      const manifestObjects = (page.objects || []).filter(obj =>
        typeof obj.key === "string" && obj.key.endsWith(`/${STUDY_GUIDE_MANIFEST_FILENAME}`),
      );
      const manifests = await Promise.all(
        manifestObjects.map(async (obj) => {
          try {
            const stored = await bucket.get(obj.key);
            if (!stored || !stored.body) return null;
            const text = await stored.text();
            const parsed = JSON.parse(text);
            return { manifestKey: obj.key, manifest: parsed, uploaded: obj.uploaded };
          } catch {
            return null;
          }
        }),
      );
      manifests.forEach((entry) => {
        if (!entry || typeof entry.manifest !== "object" || !entry.manifest) return;
        const manifest = entry.manifest as StudyGuideManifest;
        const docIdRaw =
          typeof (manifest as any).docId === "string"
            ? (manifest as any).docId
            : typeof (manifest as any).lectureId === "string"
              ? (manifest as any).lectureId
              : "";
        const docId = docIdRaw.trim() || undefined;
        const title = typeof manifest.title === "string" ? manifest.title : undefined;
        const codeRaw = typeof manifest.code === "string" ? manifest.code : extractStudyGuideCodeFromManifestKey(entry.manifestKey);
        const code = normalizeStudyGuideCode(codeRaw);
        if (!isStudyGuideCodeValid(code)) return;
        const publishedAt =
          typeof manifest.publishedAt === "string"
            ? manifest.publishedAt
            : entry.uploaded instanceof Date
              ? entry.uploaded.toISOString()
              : undefined;
        entries.push({ docId, title, code, publishedAt, manifestKey: entry.manifestKey });
      });
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } catch {
    return entries;
  }
  return entries;
}

type StudyGuidePublishInfo = { code: string; publishedAt?: string };

async function resolveStudyGuideAccessCodes(
  env: Env,
  lectures: Array<{ docId: string; lectureTitle: string }>,
): Promise<Map<string, StudyGuidePublishInfo>> {
  const publishInfo = new Map<string, StudyGuidePublishInfo>();
  if (!lectures.length) return publishInfo;

  const lookups = lectures.map(lecture => ({
    ...lecture,
    storedKey: buildStudyGuideStoredKey(lecture.docId, lecture.lectureTitle),
  }));

  await Promise.all(
    lookups.map(async (lecture) => {
      if (!lecture.docId) return;
      const record = await loadStudyGuidePublishRecord(env, lecture.docId);
      if (record?.code && isStudyGuideCodeValid(record.code)) {
        publishInfo.set(lecture.docId, { code: record.code, publishedAt: record.publishedAt || undefined });
        return;
      }
      const source = await loadStudyGuideAccessCodeFromSource(env, lecture.storedKey);
      if (source?.code) {
        publishInfo.set(lecture.docId, { code: source.code });
      }
    }),
  );

  const missing = lookups.filter(lecture => lecture.docId && !publishInfo.has(lecture.docId));
  if (!missing.length) return publishInfo;

  const manifestIndex = await loadPublishedStudyGuideManifestIndex(env);
  if (!manifestIndex.length) return publishInfo;

  const byDocId = new Map<string, StudyGuideManifestIndexEntry>();
  manifestIndex.forEach((entry) => {
    if (entry.docId) {
      addLatestManifestEntry(byDocId, entry.docId, entry);
    }
  });

  const recordsToPersist: StudyGuidePublishRecord[] = [];
  missing.forEach((lecture) => {
    const match = byDocId.get(lecture.docId);
    if (!match?.code) return;
    publishInfo.set(lecture.docId, { code: match.code, publishedAt: match.publishedAt });
    recordsToPersist.push({
      docId: lecture.docId,
      code: match.code,
      publishedAt: match.publishedAt || new Date().toISOString(),
      manifestKey: match.manifestKey,
      storedKey: lecture.storedKey,
      title: lecture.lectureTitle,
    });
  });

  if (recordsToPersist.length) {
    await Promise.allSettled(recordsToPersist.map(record => persistStudyGuidePublishRecord(env, record)));
  }

  return publishInfo;
}

type AnkiPublishInfo = { code: string; publishedAt?: string };

async function resolveAnkiPublishInfo(
  env: Env,
  lectures: Array<{ docId: string }>,
): Promise<Map<string, AnkiPublishInfo>> {
  const publishInfo = new Map<string, AnkiPublishInfo>();
  if (!lectures.length) return publishInfo;
  await Promise.all(
    lectures.map(async (lecture) => {
      if (!lecture.docId) return;
      const record = await loadAnkiPublishRecord(env, lecture.docId);
      if (record?.code && isAnkiCodeValid(record.code)) {
        publishInfo.set(lecture.docId, { code: record.code, publishedAt: record.publishedAt || undefined });
      }
    }),
  );
  return publishInfo;
}

function generateStudyGuideCode(length = STUDY_GUIDE_CODE_LENGTH) {
  const alphabet = STUDY_GUIDE_CODE_ALPHABET;
  let code = "";
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < length; i += 1) {
      code += alphabet[bytes[i] % alphabet.length];
    }
    return code;
  }
  for (let i = 0; i < length; i += 1) {
    const idx = Math.floor(Math.random() * alphabet.length);
    code += alphabet[idx];
  }
  return code;
}

function normalizeLectureTitle(value: string) {
  const cleaned = (value || "").trim().replace(/\s+/g, " ");
  if (!cleaned) return "Lecture";
  return cleaned.replace(/\.(html?|txt|pdf)$/i, "").trim() || "Lecture";
}

function inferPublishedContentType(filename: string, fallback?: string) {
  if (fallback && fallback.trim()) return fallback;
  const ext = (filename || "").split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "html":
    case "htm":
      return "text/html; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "txt":
      return "text/plain; charset=utf-8";
    case "apkg":
    case "zip":
      return "application/octet-stream";
    default:
      return "application/octet-stream";
  }
}

function getPublishBucket(env: Env) {
  const lookup =
    lookupBucket(env, CANONICAL_CACHE_BUCKET_NAME) ||
    lookupBucket(env, BUCKET_BINDINGS[CANONICAL_CACHE_BUCKET_NAME as keyof typeof BUCKET_BINDINGS]);
  if (!lookup) {
    throw new Error("No publish bucket configured.");
  }
  return lookup;
}

async function isStudyGuideCodeAvailable(env: Env, rawCode: string) {
  const code = normalizeStudyGuideCode(rawCode);
  if (!isStudyGuideCodeValid(code)) return false;
  if (env.DOCS_KV) {
    const existing = await env.DOCS_KV.get(`studyguide:${code}`);
    if (existing) return false;
  }
  const { bucket } = getPublishBucket(env);
  const head = await bucket.head(buildStudyGuideManifestKey(code));
  return !head;
}

async function generateUniqueStudyGuideCode(env: Env) {
  const lengths = [STUDY_GUIDE_CODE_LENGTH, STUDY_GUIDE_CODE_LENGTH + 2, STUDY_GUIDE_CODE_LENGTH + 4];
  for (const length of lengths) {
    for (let attempt = 0; attempt < STUDY_GUIDE_CODE_MAX_ATTEMPTS; attempt += 1) {
      const code = generateStudyGuideCode(length);
      if (await isStudyGuideCodeAvailable(env, code)) return code;
    }
  }
  throw new Error("Unable to generate a unique access code.");
}

type TokenLimit = { max_tokens?: number; max_completion_tokens?: number };

/**
 * Build a token-limit parameter object for the given model/API type.
 *
 * @param model - Model id string.
 * @param desired - Desired token limit.
 * @param apiType - API family ("chat" or "responses").
 * @returns Object containing `max_tokens` or `max_completion_tokens`.
 */
export function buildTokenLimit(model: string, desired: number, apiType: "chat" | "responses" = "chat"): TokenLimit {
  const m = (model || "").toLowerCase();
  const needsMaxCompletion =
    apiType === "responses" ||
    m === DEFAULT_TEXT_MODEL ||
    m.startsWith("o1") ||
    m.startsWith("o3");
  return needsMaxCompletion
    ? { max_completion_tokens: desired }
    : { max_tokens: desired };
}

const STUDY_GUIDE_FORBIDDEN_KEYS = [
  "stop",
  "stop_sequences",
  "stopSequences",
  "response",
  "seed",
  "frequency_penalty",
  "presence_penalty",
  "max_completion_tokens",
  "max_tokens",
  "n",
  "stream",
] as const;

/**
 * Remove forbidden keys from a study guide payload in-place.
 *
 * @param payload - Payload object to mutate.
 * @returns The same payload object with forbidden keys removed.
 */
export function stripStudyGuideForbiddenKeys<T extends Record<string, unknown>>(payload: T): T {
  for (const key of STUDY_GUIDE_FORBIDDEN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      delete (payload as Record<string, unknown>)[key];
    }
  }
  return payload;
}

function sanitizeResponsesPayload(
  payload: Record<string, unknown>,
  model: string,
  env?: SamplingEnv,
): Record<string, unknown> {
  const sanitized = sanitizeOpenAIPayload(payload, { endpoint: "responses", env, model });
  return stripStudyGuideForbiddenKeys(sanitized.payload);
}

function buildModelParams(opts: {
  model?: string;
  endpoint: OpenAIEndpoint;
  temperature?: number;
  top_p?: number;
  env?: SamplingEnv;
}) {
  const params: { temperature?: number; top_p?: number } = {};
  const support = resolveSamplingSupport(opts.model || "", opts.endpoint, opts.env);
  if (support.supportsTemperature && typeof opts.temperature === "number") params.temperature = opts.temperature;
  if (support.supportsTopP && typeof opts.top_p === "number") params.top_p = opts.top_p;
  return params;
}

/**
 * Build a Responses API payload for study guide generation.
 *
 * @param model - Model id to use.
 * @param prompt - Prompt text to send as input.
 * @param maxTokens - Max output tokens to request.
 * @returns Payload object ready for Responses API.
 */
export function buildStudyGuidePayload(
  model: string,
  prompt: string,
  maxTokens = MACHINE_STUDY_GUIDE_MAX_OUTPUT_TOKENS,
) {
  return withMaxOutputTokens(
    {
      model,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        },
      ],
      temperature: STUDY_GUIDE_TEMPERATURE,
      top_p: STUDY_GUIDE_TOP_P,
    },
    maxTokens,
  );
}

/**
 * Force a payload to use `max_output_tokens`, removing other token fields.
 *
 * @param payload - Payload object to mutate.
 * @param n - Max output tokens value.
 * @returns The same payload object for chaining.
 */
export function withMaxOutputTokens(payload: Record<string, unknown>, n: number) {
  payload.max_output_tokens = n;
  delete payload.max_completion_tokens;
  delete payload.max_tokens;
  return payload;
}

/**
 * Truncate text to the first closing `</html>` tag.
 *
 * @param text - Raw model output.
 * @returns Ok result with truncated HTML or error with message.
 */
export function truncateAtHtmlEnd(
  text: string,
): { ok: true; html: string } | { ok: false; error: string } {
  const marker = "</html>";
  const lower = (text || "").toLowerCase();
  const idx = lower.indexOf(marker);
  if (idx === -1) {
    return {
      ok: false,
      error: "Model output missing </html>. Study guide generation failed.",
    };
  }
  const endIdx = idx + marker.length;
  const html = (text || "").slice(0, endIdx);
  return { ok: true, html };
}

function stripPlaceholderPhrasesFromHtml(html: string, placeholders?: string[]): string {
  const list = placeholders || ["not stated", "not specified", "not provided", "not in lecture", "n/a"];
  let cleaned = html || "";
  for (const placeholder of list) {
    const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned.replace(new RegExp(escaped, "gi"), "");
  }
  cleaned = cleaned.replace(/<li>\s*(?:<[^>]+>\s*)*<\/li>/gi, "");
  cleaned = cleaned.replace(/<td>\s*(?:<[^>]+>\s*)*<\/td>/gi, "<td></td>");
  return cleaned;
}

/**
 * Extract and parse JSON from a study guide model response.
 *
 * @param raw - Raw model output.
 * @param label - Step label for error messages.
 * @returns Parsed JSON payload.
 * @throws When JSON cannot be extracted or parsed.
 */
export function parseStudyGuideJson<T>(raw: string, label: string): T {
  const { candidate } = extractJsonCandidate(raw, true);
  const trimmed = (candidate || "").trim();
  if (!trimmed) {
    throw new Error(`Study guide step ${label} returned invalid JSON. No JSON object found.`);
  }
  const parsed = tryParseJson<T>(trimmed);
  if (parsed) return parsed;
  const tail = trimmed.slice(-500);
  throw new Error(`Study guide step ${label} returned invalid JSON. Tail: ${tail}`);
}

function parseStudyGuideJsonStrict<T>(
  raw: string,
  label: string,
  validate?: (value: T) => string[],
): T {
  const stripped = stripMarkdownFences(raw);
  const extracted = extractFirstJsonObject(stripped);
  if (!extracted) {
    throw new Error(`Study guide step ${label} JSON extract failed.`);
  }
  const parsed = tryParseJson<T>(extracted.trim());
  if (!parsed) {
    throw new Error(`Study guide step ${label} JSON parse failed.`);
  }
  const validationErrors = validate ? validate(parsed) : [];
  if (validationErrors.length) {
    const error = new Error(`Study guide step ${label} JSON schema validation failed.`);
    (error as any).validationErrors = validationErrors;
    throw error;
  }
  return parsed;
}

const STUDY_GUIDE_STEP_B_REPAIR_PROMPT =
  "You will be given invalid JSON. Return ONLY valid JSON. Fix only JSON syntax (missing braces/brackets/commas/quotes/escapes). Do NOT add new keys. Do NOT add new items. Do NOT output prose. Your output must start with '{' and end with '}'.\nJSON:\n";

const STUDY_GUIDE_STEP_C_REPAIR_PROMPT =
  "You will be given invalid JSON. Return ONLY valid JSON. Fix only JSON syntax (missing brackets/commas/quotes/escapes). Do not add new information. If a string is unterminated, close it or truncate the string safely. Output must be a single JSON object, no prose.\nInput:\n";

const STUDY_GUIDE_MAXIMAL_FACT_REWRITE_REPAIR_PROMPT =
  "You will be given invalid JSON. Return ONLY valid JSON. Fix only JSON syntax (missing brackets/commas/quotes/escapes). Do not add new keys. Do not add new items. Output must start with '{' and end with '}'.\nJSON:\n";
function hasUnescapedQuoteAhead(text: string, start: number): boolean {
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "\"") return true;
  }
  return false;
}

function repairInvalidJsonEscapes(raw: string): string {
  if (!raw) return raw;
  const validEscapes = new Set(["\"", "\\", "/", "b", "f", "n", "r", "t", "u"]);
  let inString = false;
  let output = "";

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (!inString) {
      if (ch === "\"") inString = true;
      output += ch;
      continue;
    }
    if (ch === "\"") {
      inString = false;
      output += ch;
      continue;
    }
    if (ch === "\\") {
      const next = raw[i + 1];
      if (!next) {
        output += "\\\\";
        continue;
      }
      if (next === "\"" && !hasUnescapedQuoteAhead(raw, i + 2)) {
        output += "\\\\";
        continue;
      }
      if (validEscapes.has(next)) {
        output += `\\${next}`;
        i += 1;
        continue;
      }
      output += "\\\\";
      continue;
    }
    output += ch;
  }

  return output;
}

function tryParseJson<T>(raw: string): T | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  try {
    const repaired = repairInvalidJsonEscapes(trimmed);
    return JSON.parse(repaired) as T;
  } catch {
    return null;
  }
}

function stripBom(value: string): string {
  return value.replace(/^\uFEFF/, "");
}

function stripMarkdownFences(raw: string): string {
  const trimmed = (raw || "").trim();
  if (!trimmed.startsWith("```")) return raw;
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced && typeof fenced[1] === "string") {
    return fenced[1].trim();
  }
  const firstLineEnd = trimmed.indexOf("\n");
  if (firstLineEnd === -1) return raw;
  const firstLine = trimmed.slice(0, firstLineEnd).trim();
  if (!firstLine.startsWith("```")) return raw;
  let body = trimmed.slice(firstLineEnd + 1);
  const closingIndex = body.lastIndexOf("```");
  if (closingIndex !== -1) {
    body = body.slice(0, closingIndex);
  }
  return body.trim();
}

/**
 * Extract the first balanced JSON object from a raw string.
 *
 * @param raw - Raw string that may contain JSON.
 * @returns JSON string or null if not found.
 */
export function extractFirstJsonObject(raw: string): string | null {
  const text = raw || "";
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depthCurly = 0;
  let depthSquare = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        escapeNext = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depthCurly += 1;
      continue;
    }
    if (ch === "}") {
      depthCurly -= 1;
      if (depthCurly === 0 && depthSquare === 0) {
        return text.slice(start, i + 1);
      }
      continue;
    }
    if (ch === "[") {
      depthSquare += 1;
      continue;
    }
    if (ch === "]") {
      depthSquare -= 1;
      continue;
    }
  }
  return null;
}

type JsonTokenAnalysis = {
  openCurly: number;
  closeCurly: number;
  openSquare: number;
  closeSquare: number;
  stack: Array<"{" | "[">;
  inString: boolean;
};

function analyzeJsonTokens(raw: string): JsonTokenAnalysis {
  let openCurly = 0;
  let closeCurly = 0;
  let openSquare = 0;
  let closeSquare = 0;
  const stack: Array<"{" | "["> = [];
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        escapeNext = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      openCurly += 1;
      stack.push("{");
      continue;
    }
    if (ch === "[") {
      openSquare += 1;
      stack.push("[");
      continue;
    }
    if (ch === "}") {
      closeCurly += 1;
      if (stack[stack.length - 1] === "{") stack.pop();
      continue;
    }
    if (ch === "]") {
      closeSquare += 1;
      if (stack[stack.length - 1] === "[") stack.pop();
      continue;
    }
  }
  return { openCurly, closeCurly, openSquare, closeSquare, stack, inString };
}

function looksTruncatedJson(raw: string): boolean {
  const stripped = stripMarkdownFences(raw);
  const trimmed = stripped.trim();
  if (!trimmed) return false;
  const extracted = extractFirstJsonObject(trimmed);
  const candidate = (extracted ?? trimmed).trim();
  if (!candidate) return false;
  if (!candidate.includes("{")) return false;
  const analysis = analyzeJsonTokens(candidate);
  if (analysis.inString) return true;
  if (analysis.stack.length) return true;
  if (analysis.openCurly > analysis.closeCurly || analysis.openSquare > analysis.closeSquare) return true;
  const lastChar = candidate[candidate.length - 1];
  if (lastChar === ",") return true;
  if (lastChar === "]" && analysis.openCurly > analysis.closeCurly) return true;
  if (lastChar !== "}" && lastChar !== "]") return true;
  return false;
}

function detectTruncatedJson(raw: string): boolean {
  const stripped = stripMarkdownFences(raw);
  const trimmed = stripped.trim();
  if (!trimmed) return false;
  const candidate = (extractFirstJsonObject(trimmed) || trimmed).trim();
  if (!candidate) return false;
  if (!candidate.endsWith("}")) return true;
  const analysis = analyzeJsonTokens(candidate);
  if (analysis.inString) return true;
  if (analysis.stack.length) return true;
  if (analysis.openCurly !== analysis.closeCurly || analysis.openSquare !== analysis.closeSquare) return true;
  return false;
}

/**
 * Attempt minimal JSON repair (trim, remove trailing commas, close braces).
 *
 * @param jsonLike - JSON-like string to repair.
 * @param originalRaw - Optional raw string for re-extraction.
 * @returns Repair result or null if unrecoverable.
 */
export function repairJsonMinimal(
  jsonLike: string,
  originalRaw?: string,
): { repaired: string; appendedClosers: string; usedReextract: boolean } | null {
  if (!jsonLike) return null;
  let cleaned = stripBom(jsonLike).trim();
  const start = cleaned.indexOf("{");
  if (start !== -1) cleaned = cleaned.slice(start);
  const end = cleaned.lastIndexOf("}");
  if (end !== -1) cleaned = cleaned.slice(0, end + 1);
  cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");
  cleaned = repairInvalidJsonEscapes(cleaned);

  let analysis = analyzeJsonTokens(cleaned);
  const hasExcessClosers =
    analysis.closeCurly > analysis.openCurly || analysis.closeSquare > analysis.openSquare;
  let usedReextract = false;
  if (hasExcessClosers && originalRaw) {
    const reextracted = extractFirstJsonObject(originalRaw);
    if (reextracted) {
      cleaned = reextracted.trim().replace(/,\s*([}\]])/g, "$1");
      cleaned = repairInvalidJsonEscapes(cleaned);
      usedReextract = true;
      analysis = analyzeJsonTokens(cleaned);
    }
  }
  if (analysis.closeCurly > analysis.openCurly || analysis.closeSquare > analysis.openSquare) {
    return null;
  }
  let appendedClosers = "";
  if (analysis.openCurly > analysis.closeCurly || analysis.openSquare > analysis.closeSquare) {
    appendedClosers = analysis.stack
      .slice()
      .reverse()
      .map(token => (token === "{" ? "}" : "]"))
      .join("");
    cleaned += appendedClosers;
  }
  return { repaired: cleaned, appendedClosers, usedReextract };
}

type JsonExtractionMethod = "first_object" | "raw_fallback" | "none";

type JsonParseAttempt<T> = {
  ok: boolean;
  value?: T;
  reason?: "no-json" | "parse" | "validation";
  extraction: JsonExtractionMethod;
  candidate?: string;
  usedMinimalRepair: boolean;
  repairMeta?: { appendedClosers: string; usedReextract: boolean };
  validationErrors?: string[];
};

type StepAChunkParseDiagnostic = {
  step: string;
  attempt: "initial" | "repair" | "retry";
  raw: string;
  raw_tail: string;
  extraction: JsonExtractionMethod;
  extracted_null: boolean;
  reason?: "no-json" | "parse" | "validation" | "truncated";
  error_code?: string;
  validation_errors?: string[];
  used_minimal_repair: boolean;
  repair_meta?: { appendedClosers: string; usedReextract: boolean };
};

function extractJsonCandidate(raw: string, strict: boolean): { candidate: string | null; extraction: JsonExtractionMethod } {
  const stripped = stripMarkdownFences(raw);
  const extracted = extractFirstJsonObject(stripped);
  if (extracted) return { candidate: extracted, extraction: "first_object" };
  if (strict) return { candidate: null, extraction: "none" };
  return { candidate: stripped.trim(), extraction: "raw_fallback" };
}

function parseJsonCandidate<T>(
  raw: string,
  opts: { strictExtraction: boolean; validate?: (value: T) => string[] },
): JsonParseAttempt<T> {
  const { candidate, extraction } = extractJsonCandidate(raw, opts.strictExtraction);
  if (!candidate) {
    return { ok: false, reason: "no-json", extraction, usedMinimalRepair: false };
  }
  const cleaned = candidate.trim();
  const parsed = tryParseJson<T>(cleaned);
  if (parsed) {
    const validationErrors = opts.validate ? opts.validate(parsed) : [];
    if (!validationErrors.length) {
      return { ok: true, value: parsed, extraction, candidate: cleaned, usedMinimalRepair: false };
    }
    return {
      ok: false,
      reason: "validation",
      extraction,
      candidate: cleaned,
      usedMinimalRepair: false,
      validationErrors,
    };
  }
  const minimal = repairJsonMinimal(cleaned, raw);
  if (minimal) {
    const repairedParsed = tryParseJson<T>(minimal.repaired);
    if (repairedParsed) {
      const validationErrors = opts.validate ? opts.validate(repairedParsed) : [];
      if (!validationErrors.length) {
        return {
          ok: true,
          value: repairedParsed,
          extraction,
          candidate: minimal.repaired,
          usedMinimalRepair: true,
          repairMeta: { appendedClosers: minimal.appendedClosers, usedReextract: minimal.usedReextract },
        };
      }
      return {
        ok: false,
        reason: "validation",
        extraction,
        candidate: minimal.repaired,
        usedMinimalRepair: true,
        repairMeta: { appendedClosers: minimal.appendedClosers, usedReextract: minimal.usedReextract },
        validationErrors,
      };
    }
  }
  return {
    ok: false,
    reason: "parse",
    extraction,
    candidate: minimal?.repaired || cleaned,
    usedMinimalRepair: Boolean(minimal),
    repairMeta: minimal
      ? { appendedClosers: minimal.appendedClosers, usedReextract: minimal.usedReextract }
      : undefined,
  };
}

function tailPreview(raw: string, max = 240): string {
  const trimmed = (raw || "").trim();
  return trimmed.length > max ? trimmed.slice(-max) : trimmed;
}

const STEP_A1_JSON_EXTRACT_FAILED = "STEP_A1_JSON_EXTRACT_FAILED";
const STEP_A1_JSON_PARSE_FAILED = "STEP_A1_JSON_PARSE_FAILED";
const STEP_A1_SCHEMA_VALIDATION_FAILED = "STEP_A1_SCHEMA_VALIDATION_FAILED";

type StepAJsonErrorCode =
  | typeof STEP_A1_JSON_EXTRACT_FAILED
  | typeof STEP_A1_JSON_PARSE_FAILED
  | typeof STEP_A1_SCHEMA_VALIDATION_FAILED;

type StepAParseAttempt<T> =
  | {
      ok: true;
      value: T;
      extraction: JsonExtractionMethod;
      candidate: string;
    }
  | {
      ok: false;
      reason: "no-json" | "parse" | "validation" | "truncated";
      extraction: JsonExtractionMethod;
      candidate?: string;
      validationErrors?: string[];
    };

function mapStepAErrorCode(reason?: StepAParseAttempt<unknown>["reason"]): StepAJsonErrorCode | undefined {
  switch (reason) {
    case "no-json":
      return STEP_A1_JSON_EXTRACT_FAILED;
    case "parse":
      return STEP_A1_JSON_PARSE_FAILED;
    case "validation":
      return STEP_A1_SCHEMA_VALIDATION_FAILED;
    default:
      return undefined;
  }
}

function buildStepAJsonError(
  code: StepAJsonErrorCode,
  label: string,
  validationErrors?: string[],
): Error {
  const messageMap: Record<StepAJsonErrorCode, string> = {
    [STEP_A1_JSON_EXTRACT_FAILED]: `Study guide step ${label} JSON extract failed.`,
    [STEP_A1_JSON_PARSE_FAILED]: `Study guide step ${label} JSON parse failed.`,
    [STEP_A1_SCHEMA_VALIDATION_FAILED]: `Study guide step ${label} JSON schema validation failed.`,
  };
  const message = `${code}: ${messageMap[code]}`;
  const error = new Error(message);
  (error as any).code = code;
  if (validationErrors?.length) {
    (error as any).validationErrors = validationErrors;
  }
  return error;
}

function parseStepAJsonCandidate<T>(raw: string, validate?: (value: T) => string[]): StepAParseAttempt<T> {
  const stripped = stripMarkdownFences(raw);
  const extracted = extractFirstJsonObject(stripped);
  if (!extracted) {
    if (looksTruncatedJson(stripped)) {
      return { ok: false, reason: "truncated", extraction: "none" };
    }
    return { ok: false, reason: "no-json", extraction: "none" };
  }
  const candidate = extracted.trim();
  const parsed = tryParseJson<T>(candidate);
  if (!parsed) {
    return { ok: false, reason: "parse", extraction: "first_object", candidate };
  }
  const validationErrors = validate ? validate(parsed) : [];
  if (validationErrors.length) {
    return {
      ok: false,
      reason: "validation",
      extraction: "first_object",
      candidate,
      validationErrors,
    };
  }
  return { ok: true, value: parsed, extraction: "first_object", candidate };
}

function buildStepAChunkParseDiagnostic(
  step: string,
  attempt: "initial" | "repair" | "retry",
  raw: string,
  validate?: (value: StepAChunkExtractOutput) => string[],
): StepAChunkParseDiagnostic {
  const parseAttempt = parseStepAJsonCandidate<StepAChunkExtractOutput>(raw, validate);
  const stripped = stripMarkdownFences(raw);
  const extractedNull = extractFirstJsonObject(stripped) === null;
  const errorCode = mapStepAErrorCode(parseAttempt.ok ? undefined : parseAttempt.reason);
  return {
    step,
    attempt,
    raw,
    raw_tail: tailPreview(raw, 800),
    extraction: parseAttempt.extraction,
    extracted_null: extractedNull,
    reason: parseAttempt.ok ? undefined : parseAttempt.reason,
    error_code: errorCode,
    validation_errors: parseAttempt.ok ? undefined : parseAttempt.validationErrors,
    used_minimal_repair: false,
    repair_meta: undefined,
  };
}

function classifyStepAChunkRaw(
  raw: string,
  opts: { validate?: (value: StepAChunkExtractOutput) => string[]; hasContent: boolean },
): StepA1Result<StepAChunkExtractOutput> {
  const stripped = stripMarkdownFences(raw);
  const trimmed = stripped.trim();
  if (!trimmed) {
    return { ok: false, kind: "EXTRACT", raw, detail: "Empty response.", retries: 0 };
  }
  const extracted = extractFirstJsonObject(trimmed);
  if (!extracted) {
    return detectTruncatedJson(trimmed)
      ? { ok: false, kind: "TRUNCATED", raw, detail: "JSON appears truncated.", retries: 0 }
      : { ok: false, kind: "PARSE", raw, detail: "No JSON object found.", retries: 0 };
  }
  const candidate = extracted.trim();
  const parsed = tryParseJson<StepAChunkExtractOutput>(candidate);
  if (!parsed) {
    return detectTruncatedJson(candidate)
      ? { ok: false, kind: "TRUNCATED", raw, detail: "JSON appears truncated.", retries: 0 }
      : { ok: false, kind: "PARSE", raw, detail: "JSON parse failed.", retries: 0 };
  }
  const validationErrors = opts.validate ? opts.validate(parsed) : [];
  if (validationErrors.length) {
    return {
      ok: false,
      kind: "SCHEMA",
      raw,
      detail: validationErrors.slice(0, 6).join(", "),
      retries: 0,
    };
  }
  if (opts.hasContent && Array.isArray(parsed.slides) && parsed.slides.length === 0) {
    return { ok: false, kind: "EXTRACT", raw, detail: "Model returned empty slides.", retries: 0 };
  }
  return { ok: true, data: parsed, raw, retries: 0 };
}

/**
 * Parse JSON with an LLM-powered repair fallback.
 *
 * @param raw - Raw model output.
 * @param label - Step label for logging/errors.
 * @param repair - Repair function that returns corrected JSON.
 * @param opts - Parsing options and optional schema validation.
 * @returns Parsed JSON payload.
 * @throws When repair fails or JSON remains invalid.
 */
export async function parseStudyGuideJsonWithRepair<T>(
  raw: string,
  label: string,
  repair: (raw: string) => Promise<string>,
  opts?: { strictExtraction?: boolean; validate?: (value: T) => string[] },
): Promise<T> {
  const strictExtraction = opts?.strictExtraction ?? false;
  const initial = parseJsonCandidate<T>(raw, { strictExtraction, validate: opts?.validate });
  if (initial.ok) return initial.value as T;
  console.warn("[machine.studyGuide] step=%s json=invalid; attempting repair", label);
  const repairInput = initial.candidate || raw;
  const repairedRaw = await repair(repairInput);
  const repaired = parseJsonCandidate<T>(repairedRaw, { strictExtraction, validate: opts?.validate });
  if (repaired.ok) return repaired.value as T;
  console.warn("[machine.studyGuide] step=%s json=repair_failed reason=%s extract=%s tail=%s", label, repaired.reason, repaired.extraction, tailPreview(repaired.candidate || repairedRaw));
  throw new Error(`Study guide step ${label} repair failed.`);
}

/**
 * Parse Step A JSON with retry handling for truncation.
 *
 * @param opts - Raw output, retry callback, and optional validation.
 * @returns Parsed JSON payload.
 * @throws When parsing/validation fails after retries.
 */
export async function parseStudyGuideJsonWithRepairAndRetry<T>(opts: {
  raw: string;
  label: string;
  retry: () => Promise<string>;
  validate?: (value: T) => string[];
  fallback?: () => T;
  maxTruncationRetries?: number;
}): Promise<T> {
  const maxRetries =
    typeof opts.maxTruncationRetries === "number"
      ? opts.maxTruncationRetries
      : MACHINE_STUDY_GUIDE_STEP_A_TRUNCATION_MAX_RETRIES;
  let attempt = parseStepAJsonCandidate<T>(opts.raw, opts.validate);
  console.log("[machine.studyGuide] step=%s json=extract method=%s", opts.label, attempt.extraction);
  if (attempt.ok) {
    console.log("[machine.studyGuide] step=%s json=parse ok", opts.label);
    return attempt.value as T;
  }
  if (attempt.reason === "validation" && attempt.validationErrors?.length) {
    console.warn(
      "[machine.studyGuide] step=%s json=validation_failed errors=%o",
      opts.label,
      attempt.validationErrors,
    );
  }
  if (attempt.reason !== "truncated") {
    console.warn(
      "[machine.studyGuide] step=%s json=parse_failed reason=%s extract=%s tail=%s",
      opts.label,
      attempt.reason,
      attempt.extraction,
      tailPreview(attempt.candidate || opts.raw),
    );
    const code = mapStepAErrorCode(attempt.reason);
    if (!code) {
      throw new Error(`Study guide step ${opts.label} JSON parse failed.`);
    }
    throw buildStepAJsonError(code, opts.label, attempt.validationErrors);
  }

  let retries = 0;
  let retryRaw = opts.raw;
  while (attempt.reason === "truncated" && retries < maxRetries) {
    retries += 1;
    console.warn("[machine.studyGuide] step=%s json=truncated; retrying", opts.label);
    console.warn("[machine.studyGuide] step=%s json=retry_triggered reason=truncation", opts.label);
    retryRaw = await opts.retry();
    attempt = parseStepAJsonCandidate<T>(retryRaw, opts.validate);
    if (attempt.ok) {
      console.log("[machine.studyGuide] step=%s json=retry ok", opts.label);
      return attempt.value as T;
    }
    if (attempt.reason === "validation" && attempt.validationErrors?.length) {
      console.warn(
        "[machine.studyGuide] step=%s json=retry_validation_failed errors=%o",
        opts.label,
        attempt.validationErrors,
      );
    }
    if (attempt.reason !== "truncated") {
      console.warn(
        "[machine.studyGuide] step=%s json=retry_failed reason=%s extract=%s tail=%s",
        opts.label,
        attempt.reason,
        attempt.extraction,
        tailPreview(attempt.candidate || retryRaw),
      );
      const code = mapStepAErrorCode(attempt.reason);
      if (!code) {
        throw new Error(`Study guide step ${opts.label} JSON parse failed.`);
      }
      throw buildStepAJsonError(code, opts.label, attempt.validationErrors);
    }
  }

  console.warn(
    "[machine.studyGuide] step=%s json=retry_failed reason=truncated tail=%s",
    opts.label,
    tailPreview(retryRaw),
  );
  if (opts.fallback) {
    console.warn("[machine.studyGuide] step=%s json=fallback_used reason=truncation", opts.label);
    return opts.fallback();
  }
  throw buildStepAJsonError(STEP_A1_JSON_PARSE_FAILED, opts.label);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(item => typeof item === "number" && Number.isFinite(item));
}

type JsonSchema =
  | {
      type: "object";
      properties: Record<string, JsonSchema>;
      required?: string[];
      additionalProperties?: boolean;
    }
  | {
      type: "array";
      items: JsonSchema;
      minItems?: number;
      maxItems?: number;
    }
  | {
      type: "string";
      enum?: readonly string[];
      const?: string;
      minLength?: number;
    }
  | {
      type: "number" | "integer";
      enum?: readonly number[];
      const?: number;
      minimum?: number;
      maximum?: number;
    };

function validateJsonSchemaValue(schema: JsonSchema, value: unknown, path = ""): string[] {
  const errors: string[] = [];
  const location = path || "root";
  const add = (message: string) => {
    errors.push(`${location} ${message}`);
  };

  if (schema.type === "object") {
    if (!isPlainObject(value) || Array.isArray(value)) {
      add("must be an object.");
      return errors;
    }
    const obj = value as Record<string, unknown>;
    if (schema.required?.length) {
      for (const key of schema.required) {
        if (!(key in obj)) {
          errors.push(`${path ? `${path}.` : ""}${key} is required.`);
        }
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (key in obj) {
        errors.push(...validateJsonSchemaValue(childSchema, obj[key], path ? `${path}.${key}` : key));
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(obj)) {
        if (!(key in schema.properties)) {
          errors.push(`${path ? `${path}.` : ""}${key} is not allowed.`);
        }
      }
    }
    return errors;
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      add("must be an array.");
      return errors;
    }
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${location} must have at least ${schema.minItems} items.`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${location} must have at most ${schema.maxItems} items.`);
    }
    value.forEach((item, index) => {
      errors.push(...validateJsonSchemaValue(schema.items, item, `${path}[${index}]`));
    });
    return errors;
  }

  if (schema.type === "string") {
    if (typeof value !== "string") {
      add("must be a string.");
      return errors;
    }
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      add(`must be at least ${schema.minLength} characters.`);
    }
    if (schema.const !== undefined && value !== schema.const) {
      add(`must be ${schema.const}.`);
    }
    if (schema.enum && !schema.enum.includes(value)) {
      add(`must be one of ${schema.enum.join(", ")}.`);
    }
    return errors;
  }

  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      add("must be a number.");
      return errors;
    }
    if (schema.type === "integer" && !Number.isInteger(value)) {
      add("must be an integer.");
    }
    if (schema.const !== undefined && value !== schema.const) {
      add(`must be ${schema.const}.`);
    }
    if (schema.enum && !schema.enum.includes(value)) {
      add(`must be one of ${schema.enum.join(", ")}.`);
    }
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      add(`must be >= ${schema.minimum}.`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      add(`must be <= ${schema.maximum}.`);
    }
  }

  return errors;
}

const QUIZ_CHOICE_IDS = new Set(QUIZ_CHOICE_ID_LIST);
const QUIZ_DIFFICULTY_LEVELS = new Set(QUIZ_DIFFICULTY_LIST);

function validateQuizBatchWithCount(value: unknown, expectedLectureId: string, expectedCount: number): string[] {
  const safeCount = Number.isFinite(expectedCount) && expectedCount > 0 ? Math.floor(expectedCount) : QUIZ_BATCH_SIZE;
  const errors = validateJsonSchemaValue(buildQuizJsonSchema(safeCount) as JsonSchema, value);
  if (errors.length) return errors;
  const batch = value as QuizBatch;
  const lectureId = typeof batch.lectureId === "string" ? batch.lectureId.trim() : "";
  if (lectureId && expectedLectureId && lectureId !== expectedLectureId) {
    errors.push("lectureId does not match request.");
  }
  const lectureTitle = typeof batch.lectureTitle === "string" ? batch.lectureTitle.trim() : "";
  if (!lectureTitle) {
    errors.push("lectureTitle is required.");
  }
  const setSize = typeof batch.setSize === "number" && Number.isFinite(batch.setSize) ? batch.setSize : NaN;
  if (!Number.isFinite(setSize)) {
    errors.push("setSize is required.");
  } else if (setSize !== safeCount) {
    errors.push(`setSize must be ${safeCount}.`);
  }
  const questions = batch.questions;
  if (questions.length !== safeCount) {
    errors.push(`questions must include exactly ${safeCount} items.`);
  }
  if (Number.isFinite(setSize) && questions.length !== setSize) {
    errors.push("questions length must match setSize.");
  }
  const questionIds = new Set<string>();
  questions.forEach((question, index) => {
    const id = typeof question.id === "string" ? question.id.trim() : "";
    if (!id) {
      errors.push(`questions[${index}].id is required.`);
    } else if (questionIds.has(id)) {
      errors.push(`questions[${index}].id is duplicated.`);
    } else {
      questionIds.add(id);
    }
    if (typeof question.stem !== "string" || !question.stem.trim()) {
      errors.push(`questions[${index}].stem is required.`);
    }
    if (typeof question.rationale !== "string" || !question.rationale.trim()) {
      errors.push(`questions[${index}].rationale is required.`);
    }
    const tags = question.tags;
    if (!Array.isArray(tags) || !tags.length) {
      errors.push(`questions[${index}].tags must be a non-empty array.`);
    } else {
      if (tags.length > 3) {
        errors.push(`questions[${index}].tags must have at most 3 items.`);
      }
      tags.forEach((tag, tagIndex) => {
        if (typeof tag !== "string" || !tag.trim()) {
          errors.push(`questions[${index}].tags[${tagIndex}] must be a string.`);
        }
      });
    }
    const difficulty = typeof question.difficulty === "string" ? question.difficulty.trim().toLowerCase() : "";
    if (!difficulty || !QUIZ_DIFFICULTY_LEVELS.has(difficulty)) {
      errors.push(`questions[${index}].difficulty must be easy, medium, or hard.`);
    }
    const choices = question.choices;
    if (!Array.isArray(choices) || choices.length !== QUIZ_CHOICE_ID_LIST.length) {
      errors.push(`questions[${index}].choices must have exactly 5 items.`);
    }
    const choiceIds = new Set<string>();
    choices.forEach((choice, choiceIndex) => {
      const choiceId = typeof choice.id === "string" ? choice.id.trim() : "";
      if (!choiceId || !QUIZ_CHOICE_IDS.has(choiceId)) {
        errors.push(`questions[${index}].choices[${choiceIndex}].id must be A-E.`);
      } else if (choiceIds.has(choiceId)) {
        errors.push(`questions[${index}].choices has duplicate id ${choiceId}.`);
      } else {
        choiceIds.add(choiceId);
      }
      if (typeof choice.text !== "string" || !choice.text.trim()) {
        errors.push(`questions[${index}].choices[${choiceIndex}].text is required.`);
      }
    });
    const missingChoiceIds = QUIZ_CHOICE_ID_LIST.filter(choiceId => !choiceIds.has(choiceId));
    if (missingChoiceIds.length) {
      errors.push(`questions[${index}].choices must include ids A-E exactly once.`);
    }
    const answer = typeof question.answer === "string" ? question.answer.trim().toUpperCase() : "";
    if (!answer || !QUIZ_CHOICE_IDS.has(answer)) {
      errors.push(`questions[${index}].answer must be A-E.`);
    } else if (!choiceIds.has(answer)) {
      errors.push(`questions[${index}].answer must match a choice id.`);
    }
    const references = question.references;
    if (!Array.isArray(references)) {
      errors.push(`questions[${index}].references must be an array of strings.`);
    } else if (!isStringArray(references)) {
      errors.push(`questions[${index}].references must be an array of strings.`);
    } else if (references.length > 2) {
      errors.push(`questions[${index}].references must have at most 2 items.`);
    }
  });
  return errors;
}

function validateQuizBatch(value: unknown, expectedLectureId: string): string[] {
  const errors = validateJsonSchemaValue(QUIZ_JSON_SCHEMA as JsonSchema, value);
  if (errors.length) return errors;
  const batch = value as QuizBatch;
  const lectureId = typeof batch.lectureId === "string" ? batch.lectureId.trim() : "";
  if (lectureId && expectedLectureId && lectureId !== expectedLectureId) {
    errors.push("lectureId does not match request.");
  }
  const lectureTitle = typeof batch.lectureTitle === "string" ? batch.lectureTitle.trim() : "";
  if (!lectureTitle) {
    errors.push("lectureTitle is required.");
  }
  const setSize = typeof batch.setSize === "number" && Number.isFinite(batch.setSize) ? batch.setSize : NaN;
  if (!Number.isFinite(setSize)) {
    errors.push("setSize is required.");
  } else if (setSize !== QUIZ_BATCH_SIZE) {
    errors.push(`setSize must be ${QUIZ_BATCH_SIZE}.`);
  }
  const questions = batch.questions;
  if (questions.length !== QUIZ_BATCH_SIZE) {
    errors.push(`questions must include exactly ${QUIZ_BATCH_SIZE} items.`);
  }
  if (Number.isFinite(setSize) && questions.length !== setSize) {
    errors.push("questions length must match setSize.");
  }
  const questionIds = new Set<string>();
  questions.forEach((question, index) => {
    const id = typeof question.id === "string" ? question.id.trim() : "";
    if (!id) {
      errors.push(`questions[${index}].id is required.`);
    } else if (questionIds.has(id)) {
      errors.push(`questions[${index}].id is duplicated.`);
    } else {
      questionIds.add(id);
    }
    if (typeof question.stem !== "string" || !question.stem.trim()) {
      errors.push(`questions[${index}].stem is required.`);
    }
    if (typeof question.rationale !== "string" || !question.rationale.trim()) {
      errors.push(`questions[${index}].rationale is required.`);
    }
    const tags = question.tags;
    if (!Array.isArray(tags) || !tags.length) {
      errors.push(`questions[${index}].tags must be a non-empty array.`);
    } else {
      if (tags.length > 3) {
        errors.push(`questions[${index}].tags must have at most 3 items.`);
      }
      tags.forEach((tag, tagIndex) => {
        if (typeof tag !== "string" || !tag.trim()) {
          errors.push(`questions[${index}].tags[${tagIndex}] must be a string.`);
        }
      });
    }
    const difficulty = typeof question.difficulty === "string" ? question.difficulty.trim().toLowerCase() : "";
    if (!difficulty || !QUIZ_DIFFICULTY_LEVELS.has(difficulty)) {
      errors.push(`questions[${index}].difficulty must be easy, medium, or hard.`);
    }
    const choices = question.choices;
    if (!Array.isArray(choices) || choices.length !== QUIZ_CHOICE_ID_LIST.length) {
      errors.push(`questions[${index}].choices must have exactly 5 items.`);
    }
    const choiceIds = new Set<string>();
    choices.forEach((choice, choiceIndex) => {
      const choiceId = typeof choice.id === "string" ? choice.id.trim() : "";
      if (!choiceId || !QUIZ_CHOICE_IDS.has(choiceId)) {
        errors.push(`questions[${index}].choices[${choiceIndex}].id must be A-E.`);
      } else if (choiceIds.has(choiceId)) {
        errors.push(`questions[${index}].choices has duplicate id ${choiceId}.`);
      } else {
        choiceIds.add(choiceId);
      }
      if (typeof choice.text !== "string" || !choice.text.trim()) {
        errors.push(`questions[${index}].choices[${choiceIndex}].text is required.`);
      }
    });
    const missingChoiceIds = QUIZ_CHOICE_ID_LIST.filter(choiceId => !choiceIds.has(choiceId));
    if (missingChoiceIds.length) {
      errors.push(`questions[${index}].choices must include ids A-E exactly once.`);
    }
    const answer = typeof question.answer === "string" ? question.answer.trim().toUpperCase() : "";
    if (!answer || !QUIZ_CHOICE_IDS.has(answer)) {
      errors.push(`questions[${index}].answer must be A-E.`);
    } else if (!choiceIds.has(answer)) {
      errors.push(`questions[${index}].answer must match a choice id.`);
    }
    const references = question.references;
    if (!Array.isArray(references)) {
      errors.push(`questions[${index}].references must be an array of strings.`);
    } else if (!isStringArray(references)) {
      errors.push(`questions[${index}].references must be an array of strings.`);
    } else if (references.length > 2) {
      errors.push(`questions[${index}].references must have at most 2 items.`);
    }
  });
  return errors;
}

function validateStepAChunkExtractOutput(value: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) {
    return ["root:not_object"];
  }
  if (typeof value.lecture_title !== "string") errors.push("lecture_title");
  const chunk = value.chunk;
  if (!isPlainObject(chunk)) {
    errors.push("chunk");
  } else {
    if (typeof chunk.start_slide !== "number" || !Number.isFinite(chunk.start_slide)) errors.push("chunk.start_slide");
    if (typeof chunk.end_slide !== "number" || !Number.isFinite(chunk.end_slide)) errors.push("chunk.end_slide");
  }
  if (!Array.isArray(value.slides)) {
    errors.push("slides");
  } else {
    value.slides.forEach((slide, idx) => {
      if (!isPlainObject(slide)) {
        errors.push(`slides[${idx}]`);
        return;
      }
      if (typeof slide.n !== "number" || !Number.isFinite(slide.n)) errors.push(`slides[${idx}].n`);
      if (typeof slide.page !== "number" || !Number.isFinite(slide.page)) errors.push(`slides[${idx}].page`);
      if (!Array.isArray(slide.sections)) errors.push(`slides[${idx}].sections`);
      if (!Array.isArray(slide.tables)) errors.push(`slides[${idx}].tables`);
    });
  }
  return errors;
}

function validateStepADerivedOutput(value: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) {
    return ["root:not_object"];
  }
  if (!isStringArray(value.raw_facts)) errors.push("raw_facts");
  const buckets = value.buckets;
  if (!isPlainObject(buckets)) {
    errors.push("buckets");
  } else {
    const bucketKeys = [
      "dx",
      "pathophys",
      "clinical",
      "labs",
      "imaging",
      "treatment",
      "complications",
      "risk_factors",
      "epidemiology",
      "red_flags",
      "buzzwords",
    ] as const;
    for (const key of bucketKeys) {
      if (!isStringArray((buckets as Record<string, unknown>)[key])) errors.push(`buckets.${key}`);
    }
  }
  if (!Array.isArray(value.discriminators)) {
    errors.push("discriminators");
  } else {
    value.discriminators.forEach((item, idx) => {
      if (!isPlainObject(item)) {
        errors.push(`discriminators[${idx}]`);
        return;
      }
      if (typeof item.topic !== "string") errors.push(`discriminators[${idx}].topic`);
      if (!isStringArray(item.signals)) errors.push(`discriminators[${idx}].signals`);
      if (!isStringArray(item.pitfalls)) errors.push(`discriminators[${idx}].pitfalls`);
    });
  }
  if (!isStringArray(value.exam_atoms)) errors.push("exam_atoms");
  const abbrevMap = value.abbrev_map;
  if (!isPlainObject(abbrevMap)) {
    errors.push("abbrev_map");
  } else {
    for (const [key, val] of Object.entries(abbrevMap)) {
      if (!key || typeof val !== "string") {
        errors.push("abbrev_map.entry");
        break;
      }
    }
  }
  if (!Array.isArray(value.source_spans)) {
    errors.push("source_spans");
  } else {
    value.source_spans.forEach((item, idx) => {
      if (!isPlainObject(item)) {
        errors.push(`source_spans[${idx}]`);
        return;
      }
      if (typeof item.text !== "string") errors.push(`source_spans[${idx}].text`);
      if (item.slides !== undefined && !isNumberArray(item.slides)) errors.push(`source_spans[${idx}].slides`);
      if (item.pages !== undefined && !isNumberArray(item.pages)) errors.push(`source_spans[${idx}].pages`);
    });
  }
  return errors;
}

type StepBPlan = {
  selected_exam_atoms: string[];
  section_counts: {
    high_yield_summary: number;
    one_page_last_minute_review: number;
    rapid_approach_table_rows: number;
    compare_topics: number;
    compare_rows_per_topic: number;
  };
  compare_topics: string[];
  atom_to_section_map: Array<{ atom: string; section: string }>;
  warnings: string[];
};

type StepBStageDiagnostic = {
  step: string;
  model?: string;
  max_output_tokens?: number;
  input_chars?: number;
  estimated_input_tokens?: number;
  output_chars?: number;
  parse_ok?: boolean;
  stop_token_hit?: boolean;
  provider_status?: number;
  provider_error?: string;
  exception?: string;
  stack?: string;
  validation_failures?: unknown;
};

type StudyGuideDiagnostics = {
  requestId: string;
  docId?: string;
  lectureTitle?: string;
  stepACharCount?: number;
  stepAMethod?: string;
  stepATextHash?: string;
  stepAPreview?: string;
  stepAChunkDiagnostics?: StepAChunkParseDiagnostic[];
  stepBModel?: string;
  stepBMaxTokens?: number;
  estimatedInputTokens?: number;
  stopTokens?: string[];
  stepBParseOk?: boolean;
  stepBStopTokenHit?: boolean;
  stepBInputMethod?: string;
  stepBStages?: StepBStageDiagnostic[];
  errors?: Array<Record<string, unknown>>;
  fallbackUsed?: boolean;
  fallbackSourceTxtKey?: string;
  fallbackSourceTxtUrl?: string;
};

type StepAPlanSlim = Pick<StepAOutput, "lecture_title" | "exam_atoms" | "discriminators" | "buckets">;

function buildStepAPlanSlim(stepA: StepAOutput): StepAPlanSlim {
  return {
    lecture_title: stepA.lecture_title,
    exam_atoms: stepA.exam_atoms || [],
    discriminators: stepA.discriminators || [],
    buckets: stepA.buckets,
  };
}

function normalizeStrings(items: string[] | undefined | null): string[] {
  return (items || []).map(item => (item || "").trim()).filter(Boolean);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const unsigned = hash >>> 0;
  return unsigned.toString(16).padStart(8, "0");
}

function previewText(value: string, max = 300): string {
  if (!value) return "";
  return value.length > max ? value.slice(0, max) : value;
}

function pickFirstN(items: string[], n: number): string[] {
  return items.slice(0, Math.max(0, n));
}

function sanitizeTopicInventory(inventory: TopicInventory): TopicInventory {
  const clean = (items: string[]) => (items || []).filter(item => !isGarbageTopicLabel(item));
  return {
    ...inventory,
    conditions: clean(inventory.conditions),
    drugs: clean(inventory.drugs),
    drug_classes: clean(inventory.drug_classes),
    phenotypes: clean(inventory.phenotypes),
    processes: clean(inventory.processes),
    garbage: clean(inventory.garbage),
    tests: clean(inventory.tests),
    treatments: clean(inventory.treatments),
    formulas_cutoffs: clean(inventory.formulas_cutoffs),
    mechanisms: clean(inventory.mechanisms),
  };
}

function summarizeRegistryQualityFailure(err: unknown): string {
  const code = (err as any)?.code;
  if (code === "MAXIMAL_QUALITY_FAILED_DRUG_COVERAGE") {
    const missing = (err as any)?.missing as Array<{ drug: string; missing: string[] }> | undefined;
    if (missing?.length) {
      return `Drug coverage gaps: ${missing
        .map(entry => `${entry.drug} missing ${entry.missing.join(", ")}`)
        .join("; ")}`;
    }
  }
  if (code === "MAXIMAL_QUALITY_FAILED_TOPIC_DENSITY") {
    const offenders = (err as any)?.offenders as Array<{ label?: string }> | undefined;
    if (offenders?.length) {
      const summary = offenders
        .map(topic => {
          const label = topic?.label || "Unknown";
          const count = countTopicFacts(topic as any);
          return `${label}(${count})`;
        })
        .join(", ");
      return `Topic density gaps: ${summary}`;
    }
  }
  if (code === "MAXIMAL_QUALITY_FAILED_TOPIC_KIND") {
    const offenders = (err as any)?.offenders as Array<{ label?: string }> | undefined;
    if (offenders?.length) {
      return `Unexpected topic kinds: ${offenders.map(topic => topic?.label || "Unknown").join(", ")}`;
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^MAXIMAL_[^:]+:\s*/i, "");
}

function classifyFallbackAtom(atom: string): string {
  const lower = (atom || "").toLowerCase();
  if (/(treat|therapy|management|tx|drug|medication|antibiotic)/.test(lower)) {
    return "one_page_last_minute_review";
  }
  if (
    /(lab|test|assay|panel|level|value|cutoff|threshold|titer|ratio|imaging|x-ray|ct|mri|ultrasound|scan)/.test(
      lower,
    ) ||
    /\d/.test(lower)
  ) {
    return "rapid_approach_table";
  }
  return "high_yield_summary";
}

/**
 * Build a best-effort Step B plan when planning fails.
 *
 * @param stepA - Step A output used to derive fallback counts/topics.
 * @returns Fallback Step B plan.
 */
export function buildFallbackPlanFromStepA(stepA: StepAOutput): StepBPlan {
  const examAtoms = normalizeStrings(stepA.exam_atoms);
  const bucketAtoms = uniqueStrings([
    ...normalizeStrings(stepA.buckets?.dx),
    ...normalizeStrings(stepA.buckets?.clinical),
    ...normalizeStrings(stepA.buckets?.labs),
    ...normalizeStrings(stepA.buckets?.treatment),
  ]);
  const selectedSource = examAtoms.length ? examAtoms : bucketAtoms;
  const selected_exam_atoms = pickFirstN(selectedSource, 18);

  const discriminatorTopics = uniqueStrings(
    normalizeStrings((stepA.discriminators || []).map(item => item?.topic || "")),
  );
  let compareTopics = pickFirstN(discriminatorTopics, 3);
  if (!compareTopics.length) {
    compareTopics = pickFirstN(normalizeStrings(stepA.buckets?.dx), 3);
  }
  while (compareTopics.length < 3) {
    compareTopics.push(`Topic ${compareTopics.length + 1}`);
  }

  return {
    selected_exam_atoms,
    section_counts: {
      high_yield_summary: clamp(10, 8, 12),
      one_page_last_minute_review: clamp(16, 12, 18),
      rapid_approach_table_rows: clamp(14, 10, 18),
      compare_topics: clamp(3, 2, 4),
      compare_rows_per_topic: clamp(5, 4, 7),
    },
    compare_topics: compareTopics,
    atom_to_section_map: selected_exam_atoms.map(atom => ({
      atom,
      section: classifyFallbackAtom(atom),
    })),
    warnings: ["fallback_plan_used"],
  };
}

let loggedMissingStudyGuideDiagKv = false;

function isOwenDebug(env: Env): boolean {
  const flag = (env.OWEN_DEBUG || "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

function buildStudyGuideDiagnosticsKey(requestId: string): string {
  const trimmed = (requestId || "").trim() || "unknown";
  return `diagnostics/${trimmed}.json`;
}

async function saveStudyGuideDiagnostics(env: Env, key: string, diagnostics: StudyGuideDiagnostics) {
  const kv = env.OWEN_DIAG_KV || env.DOCS_KV;
  if (!kv) {
    if (!loggedMissingStudyGuideDiagKv) {
      loggedMissingStudyGuideDiagKv = true;
      console.warn("[machine.studyGuide] diagnostics KV missing");
    }
    return;
  }
  try {
    await kv.put(key, JSON.stringify(diagnostics), { expirationTtl: 60 * 60 * 24 * 7 });
  } catch (err) {
    console.warn("[machine.studyGuide] diagnostics write failed", {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Assess whether Step A extraction is sufficiently dense for downstream steps.
 *
 * @param stepA - Step A output to inspect.
 * @param slides - Parsed slide blocks used for OCR quality checks.
 * @param stepACharCount - Raw character count of Step A input.
 * @returns Ok result or failure reason/message.
 */
export function assessStepAQuality(
  stepA: StepAOutput,
  slides: MachineSlideBlock[],
  stepACharCount: number,
): { ok: true } | { ok: false; reason: string; message: string } {
  if (stepACharCount < MACHINE_STUDY_GUIDE_STEP_A_MIN_CHARS) {
    return {
      ok: false,
      reason: "step_a_too_small",
      message: "Step A extraction is too small. Please upload a clearer TXT or re-run OCR.",
    };
  }
  const slideCount = slides.length;
  if (slideCount) {
    const lowTextSlides = slides.filter(slide => {
      const text = (slide.text || "").trim();
      return !text || text === "[NO TEXT]" || text.length < 30;
    }).length;
    if (lowTextSlides / slideCount >= 0.7) {
      return {
        ok: false,
        reason: "ocr_failure",
        message: "The source appears to be OCR-empty. Re-run OCR or upload a higher-quality PDF.",
      };
    }
  }
  const rawFacts = normalizeStrings(stepA.raw_facts);
  const examAtoms = normalizeStrings(stepA.exam_atoms);
  if (rawFacts.length < 3 && examAtoms.length < 3) {
    return {
      ok: false,
      reason: "step_a_sparse",
      message: "Step A extraction is too sparse. Verify the source TXT contains real lecture text.",
    };
  }
  return { ok: true };
}

function buildStepASlideText(slide: StepAOutput["slides"][number]): string {
  const lines: string[] = [`Slide ${slide.n} (p.${slide.page})`];
  for (const section of slide.sections || []) {
    if (section.heading) lines.push(section.heading);
    for (const fact of section.facts || []) {
      if (fact?.text) lines.push(`- ${fact.text}`);
    }
  }
  return lines.join("\n").trim();
}

function buildStepASummaryChunks(stepA: StepAOutput, maxChars: number): string[] {
  const slideTexts = (stepA.slides || []).map(buildStepASlideText).filter(Boolean);
  const baseTexts = slideTexts.length
    ? slideTexts
    : normalizeStrings([...(stepA.raw_facts || []), ...(stepA.exam_atoms || [])]);
  if (!baseTexts.length) return [];
  const chunks: string[] = [];
  let current = "";
  for (const text of baseTexts) {
    const next = current ? `${current}\n\n${text}` : text;
    if (next.length > maxChars && current) {
      chunks.push(current);
      current = text;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function extractSummaryLines(raw: string): string[] {
  const lines = (raw || "")
    .split(/\r?\n/)
    .map(line => line.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);
  if (lines.length) return lines;
  const fallback = (raw || "").split(/[.;]\s+/).map(line => line.trim()).filter(Boolean);
  return fallback;
}

function trimBucket(values: string[] | undefined, limit: number): string[] {
  return normalizeStrings(values).slice(0, limit);
}

function trimAbbrevMap(map: Record<string, string> | undefined, limit: number): Record<string, string> {
  const entries = Object.entries(map || {}).filter(([key, value]) => key && value);
  const trimmed = entries.slice(0, limit);
  return trimmed.reduce<Record<string, string>>((acc, [key, value]) => {
    acc[key] = value;
    return acc;
  }, {});
}

function buildCondensedStepAFromSummaries(stepA: StepAOutput, summaries: string[]): StepAOutput {
  return {
    lecture_title: stepA.lecture_title,
    slides: [],
    raw_facts: summaries.slice(0, 80),
    buckets: {
      dx: trimBucket(stepA.buckets?.dx, 12),
      pathophys: trimBucket(stepA.buckets?.pathophys, 8),
      clinical: trimBucket(stepA.buckets?.clinical, 12),
      labs: trimBucket(stepA.buckets?.labs, 10),
      imaging: trimBucket(stepA.buckets?.imaging, 8),
      treatment: trimBucket(stepA.buckets?.treatment, 10),
      complications: trimBucket(stepA.buckets?.complications, 8),
      risk_factors: trimBucket(stepA.buckets?.risk_factors, 8),
      epidemiology: trimBucket(stepA.buckets?.epidemiology, 6),
      red_flags: trimBucket(stepA.buckets?.red_flags, 8),
      buzzwords: trimBucket(stepA.buckets?.buzzwords, 8),
    },
    discriminators: (stepA.discriminators || []).slice(0, 6).map(item => ({
      topic: item.topic,
      signals: trimBucket(item.signals, 4),
      pitfalls: trimBucket(item.pitfalls, 3),
    })),
    exam_atoms: summaries.slice(0, 30),
    abbrev_map: trimAbbrevMap(stepA.abbrev_map, 30),
    source_spans: [],
  };
}

/**
 * Condense Step A output into a smaller summary for Step B synthesis.
 *
 * @param opts - Step A input and model call helper.
 * @returns Condensed Step A plus summary metadata.
 * @remarks Side effects: calls the model via `callModel`.
 */
export async function condenseStepAForSynthesis(opts: {
  stepA: StepAOutput;
  callModel: (step: string, prompt: string, maxOutputTokens: number) => Promise<string>;
  maxChunkChars?: number;
  maxOutputTokens?: number;
}): Promise<{ stepA: StepAOutput; summaryLines: string[]; chunkCount: number; usedFallback: boolean }> {
  const chunkSize = Math.max(4000, opts.maxChunkChars || MACHINE_STUDY_GUIDE_STEP_A_SUMMARY_CHUNK_CHARS);
  const chunks = buildStepASummaryChunks(opts.stepA, chunkSize);
  const summaries: string[] = [];
  let usedFallback = false;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const prompt = [
      "Summarize the study guide source into 8-12 short bullet lines.",
      "Use ONLY the text provided. No external facts.",
      "Return plain text lines starting with '- '.",
      "",
      "SOURCE:",
      chunk,
    ].join("\n");
    try {
      const raw = await opts.callModel(`B-summary-${i + 1}`, prompt, opts.maxOutputTokens || MACHINE_STUDY_GUIDE_STEP_A_SUMMARY_MAX_OUTPUT_TOKENS);
      summaries.push(...extractSummaryLines(raw));
    } catch {
      usedFallback = true;
    }
  }
  let unique = uniqueStrings(summaries);
  if (!unique.length) {
    usedFallback = true;
    unique = uniqueStrings([...(opts.stepA.exam_atoms || []), ...(opts.stepA.raw_facts || [])]);
  }
  const condensed = buildCondensedStepAFromSummaries(opts.stepA, unique);
  return { stepA: condensed, summaryLines: unique, chunkCount: chunks.length, usedFallback };
}

function shortenWords(text: string, maxWords: number): string {
  const words = (text || "").split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return words.slice(0, maxWords).join(" ");
}

function fillToCount(items: string[], count: number, maxWords: number): string[] {
  const cleaned = normalizeStrings(items);
  const source = cleaned.length ? cleaned : ["Review source text"];
  const results: string[] = [];
  let idx = 0;
  while (results.length < count) {
    results.push(shortenWords(source[idx % source.length], maxWords));
    idx += 1;
  }
  return results;
}

/**
 * Build a minimal Step B output when synthesis fails.
 *
 * @param stepA - Step A output to seed fallback content.
 * @param opts - Optional download URL to include in supplemental glue.
 * @returns Step B output that meets minimum structure.
 */
export function buildFallbackStepBOutput(stepA: StepAOutput, opts?: { downloadUrl?: string }): StepBOutput {
  const baseItems = uniqueStrings([...(stepA.exam_atoms || []), ...(stepA.raw_facts || [])]);
  const highYield = fillToCount(baseItems, 8, 16);
  const onePage = fillToCount(baseItems, 12, 14);
  const rapidSource = uniqueStrings([
    ...normalizeStrings(stepA.buckets?.labs),
    ...normalizeStrings(stepA.buckets?.imaging),
    ...normalizeStrings(stepA.buckets?.clinical),
    ...normalizeStrings(stepA.buckets?.dx),
  ]);
  const rapidItems = rapidSource.length ? rapidSource : baseItems;
  const rapidRows = Array.from({ length: 10 }, (_, i) => {
    const value = rapidItems[i % rapidItems.length] || "Review source text";
    return {
      clue: shortenWords(value, 10),
      think_of: shortenWords(value, 6),
      why: shortenWords(value, 14),
      confirm: "Review source slide",
    };
  });
  const supplemental = opts?.downloadUrl ? [`Download source TXT: ${opts.downloadUrl}`] : [];
  return {
    high_yield_summary: highYield,
    rapid_approach_table: rapidRows,
    one_page_last_minute_review: onePage,
    compare_differential: [],
    quant_cutoffs: [],
    pitfalls: [],
    glossary: [],
    supplemental_glue: supplemental,
  };
}

function buildOutlineFromStepB(stepB: StepBOutput): string {
  const lines: string[] = [];
  lines.push("HIGH_YIELD_SUMMARY:");
  for (const item of stepB.high_yield_summary || []) {
    lines.push(`- ${item}`);
  }
  lines.push("RAPID_APPROACH_TABLE:");
  for (const row of stepB.rapid_approach_table || []) {
    const clue = row?.clue || "";
    const thinkOf = row?.think_of || "";
    const why = row?.why || "";
    const confirm = row?.confirm || "";
    lines.push(`- ${clue} | ${thinkOf} | ${why} | ${confirm}`.trim());
  }
  lines.push("ONE_PAGE_LAST_MINUTE_REVIEW:");
  for (const item of stepB.one_page_last_minute_review || []) {
    lines.push(`- ${item}`);
  }
  lines.push("COMPARE_DIFFERENTIAL:");
  for (const topic of stepB.compare_differential || []) {
    const label = topic?.topic || "Topic";
    lines.push(`- Topic: ${label}`);
    for (const row of topic?.rows || []) {
      lines.push(`  - ${row?.dx1 || ""} | ${row?.dx2 || ""} | ${row?.how_to_tell || ""}`.trim());
    }
  }
  lines.push("QUANT_CUTOFFS:");
  for (const item of stepB.quant_cutoffs || []) {
    lines.push(`- ${item?.item || ""} | ${item?.value || ""} | ${item?.note || ""}`.trim());
  }
  lines.push("PITFALLS:");
  for (const item of stepB.pitfalls || []) {
    lines.push(`- ${item}`);
  }
  lines.push("GLOSSARY:");
  for (const item of stepB.glossary || []) {
    lines.push(`- ${item?.term || ""} | ${item?.definition || ""}`.trim());
  }
  lines.push("SUPPLEMENTAL_GLUE:");
  for (const item of stepB.supplemental_glue || []) {
    lines.push(`- ${item}`);
  }
  return lines.filter(Boolean).join("\n").trim();
}

type StepBCompileResult = {
  plan: StepBPlan;
  outline: string;
  draft: StepBOutput;
  final: StepBOutput;
  failures: StepBValidationFailure[];
  finalFailures: StepBValidationFailure[];
  hadRewrite: boolean;
  coerced: boolean;
};

/**
 * Compile Step B output via planning, outlining, packing, and rewriting.
 *
 * @param opts - Step A input and model call helpers for outline/JSON steps.
 * @returns Compilation result including validation failures and final output.
 * @remarks Side effects: multiple model calls and diagnostic logging.
 */
export async function compileStudyGuideStepB(opts: {
  stepA: StepAOutput;
  callModelOutline: (step: string, prompt: string, maxOutputTokens: number) => Promise<string>;
  callModelJson: (step: string, prompt: string, maxOutputTokens: number) => Promise<string>;
  modelOutline?: string;
  modelJson?: string;
  recordStage?: (entry: StepBStageDiagnostic) => void;
}): Promise<StepBCompileResult> {
  const recordStage = opts.recordStage;
  const modelJson = opts.modelJson;
  const stepAJson = JSON.stringify(opts.stepA, null, 2);
  const planStepAJson = JSON.stringify(buildStepAPlanSlim(opts.stepA), null, 2);
  const planPrompt = applyStudyGuidePromptTemplate(STUDY_GUIDE_STEP_B_PLAN_PROMPT, {
    "{{STEP_A_JSON}}": planStepAJson,
  });
  const planPromptStrict = [
    planPrompt,
    "",
    "STRICT_JSON_ONLY:",
    "Return ONLY a single JSON object. No markdown. No commentary.",
    "End immediately after the final }.",
    "Do not include extra keys.",
  ].join("\n");
  let plan: StepBPlan | null = null;
  const planAttempts = [
    {
      step: "B-plan",
      prompt: planPrompt,
      maxOutputTokens: MACHINE_STUDY_GUIDE_STEP_B_PLAN_MAX_OUTPUT_TOKENS,
    },
    {
      step: "B-plan-retry",
      prompt: planPromptStrict,
      maxOutputTokens: MACHINE_STUDY_GUIDE_STEP_B_PLAN_RETRY_MAX_OUTPUT_TOKENS,
    },
  ];
  for (const attempt of planAttempts) {
    let planRaw = "";
    try {
      planRaw = await opts.callModelJson(attempt.step, attempt.prompt, attempt.maxOutputTokens);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[machine.studyGuide] step=%s plan call failed", attempt.step, { error: msg });
      continue;
    }
    if (!planRaw.trim()) {
      console.warn("[machine.studyGuide] step=%s plan empty output", attempt.step);
      continue;
    }
    const extracted = extractFirstJsonObject(planRaw);
    if (!extracted) {
      console.warn("[machine.studyGuide] step=%s plan missing JSON object", attempt.step);
      continue;
    }
    try {
      plan = await parseStudyGuideJsonWithRepair<StepBPlan>(extracted, attempt.step, async (raw) => {
        const repairPrompt = `${STUDY_GUIDE_STEP_B_REPAIR_PROMPT}${raw}`;
        return opts.callModelJson(`${attempt.step}-repair`, repairPrompt, MACHINE_STUDY_GUIDE_STEP_B_REPAIR_MAX_OUTPUT_TOKENS);
      });
      recordStage?.({
        step: `${attempt.step}:parse`,
        model: modelJson,
        parse_ok: true,
      });
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordStage?.({
        step: `${attempt.step}:parse`,
        model: modelJson,
        parse_ok: false,
        exception: msg,
        stack: err instanceof Error ? err.stack : undefined,
      });
      console.warn("[machine.studyGuide] step=%s plan parse failed", attempt.step, { error: msg });
    }
  }
  if (!plan) {
    plan = buildFallbackPlanFromStepA(opts.stepA);
    recordStage?.({
      step: "B-plan-fallback",
      model: modelJson,
    });
    console.warn("[machine.studyGuide] step=B plan fallback used", { warnings: plan.warnings });
  }

  const fallbackStepB = buildFallbackStepBOutput(opts.stepA);
  const outlinePrompt = applyStudyGuidePromptTemplate(STUDY_GUIDE_STEP_B1_OUTLINE_PROMPT, {
    "{{STEP_A_PLAN_JSON}}": planStepAJson,
    "{{SECTION_COUNTS_JSON}}": JSON.stringify(plan.section_counts, null, 2),
    "{{COMPARE_TOPICS_JSON}}": JSON.stringify(plan.compare_topics, null, 2),
  });
  let outline = "";
  try {
    outline = await opts.callModelOutline(
      "B1-outline",
      outlinePrompt,
      MACHINE_STUDY_GUIDE_STEP_B1_OUTLINE_MAX_OUTPUT_TOKENS,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[machine.studyGuide] step=B1 outline failed; using fallback outline", { error: msg });
  }
  if (!outline.trim()) {
    outline = buildOutlineFromStepB(fallbackStepB);
  }

  const packPrompt = applyStudyGuidePromptTemplate(STUDY_GUIDE_STEP_B2_PACK_JSON_PROMPT, {
    "{{STEP_A_JSON}}": stepAJson,
    "{{STEP_B1_OUTLINE}}": outline,
  });

  let draft: StepBOutput;
  try {
    const draftRaw = await opts.callModelJson("B2-pack", packPrompt, MACHINE_STUDY_GUIDE_STEP_B_MAX_OUTPUT_TOKENS);
    draft = await parseStudyGuideJsonWithRepair<StepBOutput>(draftRaw, "B2-pack", async (raw) => {
      const repairPrompt = `${STUDY_GUIDE_STEP_B_REPAIR_PROMPT}${raw}`;
      return opts.callModelJson("B2-pack-repair", repairPrompt, MACHINE_STUDY_GUIDE_STEP_B_REPAIR_MAX_OUTPUT_TOKENS);
    });
    recordStage?.({
      step: "B2-pack:parse",
      model: modelJson,
      parse_ok: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordStage?.({
      step: "B2-pack:parse",
      model: modelJson,
      parse_ok: false,
      exception: msg,
      stack: err instanceof Error ? err.stack : undefined,
    });
    console.warn("[machine.studyGuide] step=B2 pack failed; coercing", { error: msg });
    const coercedFailures = validateStepB(opts.stepA, fallbackStepB, plan.selected_exam_atoms);
    return {
      plan,
      outline,
      draft: fallbackStepB,
      final: fallbackStepB,
      failures: [],
      finalFailures: coercedFailures,
      hadRewrite: false,
      coerced: true,
    };
  }

  const failures = validateStepB(opts.stepA, draft, plan.selected_exam_atoms);
  if (!failures.length) {
    return { plan, outline, draft, final: draft, failures, finalFailures: [], hadRewrite: false, coerced: false };
  }

  const failuresJson = JSON.stringify(failures, null, 2);
  const draftJson = JSON.stringify(draft, null, 2);
  const rewritePrompt = applyStudyGuidePromptTemplate(STUDY_GUIDE_STEP_B2_REWRITE_JSON_PROMPT, {
    "{{STEP_A_JSON}}": stepAJson,
    "{{STEP_B1_OUTLINE}}": outline,
    "{{STEP_B_DRAFT_JSON}}": draftJson,
    "{{STEP_B_FAILURES_JSON}}": failuresJson,
  });

  let final: StepBOutput;
  try {
    const rewriteRaw = await opts.callModelJson(
      "B2-rewrite",
      rewritePrompt,
      MACHINE_STUDY_GUIDE_STEP_B_QC_REWRITE_MAX_OUTPUT_TOKENS,
    );
    final = await parseStudyGuideJsonWithRepair<StepBOutput>(rewriteRaw, "B2-rewrite", async (raw) => {
      const repairPrompt = `${STUDY_GUIDE_STEP_B_REPAIR_PROMPT}${raw}`;
      return opts.callModelJson("B2-rewrite-repair", repairPrompt, MACHINE_STUDY_GUIDE_STEP_B_REPAIR_MAX_OUTPUT_TOKENS);
    });
    recordStage?.({
      step: "B2-rewrite:parse",
      model: modelJson,
      parse_ok: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordStage?.({
      step: "B2-rewrite:parse",
      model: modelJson,
      parse_ok: false,
      exception: msg,
      stack: err instanceof Error ? err.stack : undefined,
    });
    console.warn("[machine.studyGuide] step=B2 rewrite failed; coercing", { error: msg });
    const coercedFailures = validateStepB(opts.stepA, fallbackStepB, plan.selected_exam_atoms);
    return {
      plan,
      outline,
      draft,
      final: fallbackStepB,
      failures,
      finalFailures: coercedFailures,
      hadRewrite: true,
      coerced: true,
    };
  }

  const finalFailures = validateStepB(opts.stepA, final, plan.selected_exam_atoms);
  if (finalFailures.length) {
    console.warn("[machine.studyGuide] step=B2 rewrite failed validation; coercing", {
      failureCount: finalFailures.length,
    });
    const coercedFailures = validateStepB(opts.stepA, fallbackStepB, plan.selected_exam_atoms);
    return {
      plan,
      outline,
      draft,
      final: fallbackStepB,
      failures,
      finalFailures: coercedFailures,
      hadRewrite: true,
      coerced: true,
    };
  }

  return { plan, outline, draft, final, failures, finalFailures, hadRewrite: true, coerced: false };
}

type StepBSynthesisGateResult = {
  stepB: StepBOutput;
  failures: StepBSynthesisFailure[];
  hadRewrite: boolean;
  hadRedraft: boolean;
};

/**
 * Enforce minimum synthesis counts for Step B, with rewrites/redrafts.
 *
 * @param opts - Step A, initial Step B, plan, and model call helper.
 * @returns Gate result with possibly rewritten Step B output.
 * @remarks Side effects: model calls and diagnostic logging.
 */
export async function enforceStepBSynthesisMinimums(opts: {
  stepA: StepAOutput;
  stepB: StepBOutput;
  plan: StepBPlan;
  callModel: (step: string, prompt: string, maxOutputTokens: number) => Promise<string>;
}): Promise<StepBSynthesisGateResult> {
  const stepAJson = JSON.stringify(opts.stepA, null, 2);
  const planJson = JSON.stringify(opts.plan, null, 2);
  let failures = validateSynthesis(opts.stepB);
  if (!failures.length) {
    return { stepB: opts.stepB, failures, hadRewrite: false, hadRedraft: false };
  }

  console.warn("[machine.studyGuide] step=B synthesis=failures count=%s", failures.length);
  const failuresJson = JSON.stringify(failures, null, 2);
  const draftJson = JSON.stringify(opts.stepB, null, 2);
  const rewritePrompt = applyStudyGuidePromptTemplate(STUDY_GUIDE_STEP_B_SYNTHESIS_REWRITE_PROMPT, {
    "{{STEP_A_JSON}}": stepAJson,
    "{{STEP_B_PLAN_JSON}}": planJson,
    "{{STEP_B_DRAFT_JSON}}": draftJson,
    "{{STEP_B_FAILURES_JSON}}": failuresJson,
  });

  let rewritten: StepBOutput | null = null;
  try {
    const rewriteRaw = await opts.callModel(
      "B-synthesis-rewrite",
      rewritePrompt,
      MACHINE_STUDY_GUIDE_STEP_B_QC_REWRITE_MAX_OUTPUT_TOKENS,
    );
    rewritten = await parseStudyGuideJsonWithRepair<StepBOutput>(rewriteRaw, "B-synthesis-rewrite", async (raw) => {
      const repairPrompt = `${STUDY_GUIDE_STEP_B_REPAIR_PROMPT}${raw}`;
      return opts.callModel("B-synthesis-rewrite-repair", repairPrompt, MACHINE_STUDY_GUIDE_STEP_B_REPAIR_MAX_OUTPUT_TOKENS);
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[machine.studyGuide] step=B synthesis rewrite failed", { error: msg });
  }

  if (rewritten) {
    failures = validateSynthesis(rewritten);
    if (!failures.length) {
      return { stepB: rewritten, failures, hadRewrite: true, hadRedraft: false };
    }
  }

  const strictDraftPrompt = [
    applyStudyGuidePromptTemplate(STUDY_GUIDE_STEP_B_DRAFT_PROMPT, {
      "{{STEP_A_JSON}}": stepAJson,
      "{{STEP_B_PLAN_JSON}}": planJson,
    }),
    "",
    "STRICT_MINIMA:",
    "Do not output empty arrays for high_yield_summary, rapid_approach_table, or one_page_last_minute_review.",
    "Ensure high_yield_summary >= 8, rapid_approach_table >= 10 rows, one_page_last_minute_review >= 12.",
    "If material is sparse, compress and reuse Step A facts; still meet counts.",
  ].join("\n");

  const redraftRaw = await opts.callModel(
    "B-synthesis-redraft",
    strictDraftPrompt,
    MACHINE_STUDY_GUIDE_STEP_B_MAX_OUTPUT_TOKENS,
  );
  const redraft = await parseStudyGuideJsonWithRepair<StepBOutput>(redraftRaw, "B-synthesis-redraft", async (raw) => {
    const repairPrompt = `${STUDY_GUIDE_STEP_B_REPAIR_PROMPT}${raw}`;
    return opts.callModel("B-synthesis-redraft-repair", repairPrompt, MACHINE_STUDY_GUIDE_STEP_B_REPAIR_MAX_OUTPUT_TOKENS);
  });
  failures = validateSynthesis(redraft);
  if (!failures.length) {
    return { stepB: redraft, failures, hadRewrite: true, hadRedraft: true };
  }
  console.warn("[machine.studyGuide] step=B synthesis failed after retries; coercing to minima fallback", {
    failureCount: failures.length,
  });

  const coerced = buildFallbackStepBOutput(opts.stepA);
  const coercedFailures = validateSynthesis(coerced);
  return {
    stepB: coerced,
    failures: coercedFailures,
    hadRewrite: true,
    hadRedraft: true,
  };
}

/**
 * Call the Responses API for study guide steps with strict model gating.
 *
 * @param env - Worker environment with API credentials.
 * @param requestId - Request id for logging/diagnostics.
 * @param step - Step label for logging.
 * @param model - Model id to use (must be DEFAULT_TEXT_MODEL).
 * @param input - Prompt input text.
 * @param maxOutputTokens - Max tokens to request from the model.
 * @param opts - Optional JSON formatting enforcement.
 * @returns Model response text.
 * @throws When model is not allowed or the API call fails.
 */
export async function callStudyGuideResponses(
  env: Env,
  requestId: string,
  step: string,
  model: string,
  input: string,
  maxOutputTokens: number,
  opts?: { expectsJson?: boolean },
): Promise<string> {
  const rawPayload = buildStudyGuidePayload(model, input, maxOutputTokens) as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(rawPayload, "response")) {
    delete (rawPayload as Record<string, unknown>).response;
  }
  const payload = sanitizeResponsesPayload(rawPayload, model, env);
  if (opts?.expectsJson) {
    payload.text = { format: { type: "json_object" } };
  }
  if (Object.prototype.hasOwnProperty.call(payload, "response")) {
    delete (payload as Record<string, unknown>).response;
  }
  delete payload.max_completion_tokens;
  delete payload.max_tokens;
  const payloadModel = String(payload.model ?? "");
  const normalizedModel = payloadModel.toLowerCase();
  const isDefaultTextModel = normalizedModel === DEFAULT_TEXT_MODEL;
  if (!isDefaultTextModel) {
    throw new Error(`Model override detected. Only ${DEFAULT_TEXT_MODEL} is allowed for study guides.`);
  }
  const tokenLimit = typeof payload.max_output_tokens === "number" ? payload.max_output_tokens : maxOutputTokens;
  console.log(
    "[machine.studyGuide] step=%s model=%s payloadKeys=%o max_output_tokens=%s",
    step,
    payload.model,
    Object.keys(payload),
    tokenLimit,
  );
  try {
    const result = await callResponsesOnce(env, payload, `machine-study-guide:${requestId}:${step}`);
    const text = (result.text || "").trim();
    if (!text) {
      throw new Error(`Study guide step ${step} response was empty.`);
    }
    return text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as any)?.status;
    const bodyText = typeof (err as any)?.bodyText === "string" ? (err as any).bodyText : "";
    const tail = bodyText ? bodyText.slice(-800) : "";
    console.warn("[machine.studyGuide] step=%s upstream_error", step, {
      requestId,
      model,
      max_output_tokens: tokenLimit,
      status,
      message,
      body_tail: tail,
    });
    throw err;
  }
}

function buildStudyGuidePrompt(opts: {
  buildUtc: string;
  slideCount: number;
  slides: MachineSlide[];
  docText: string;
}) {
  const slideListJson = JSON.stringify(opts.slides, null, 2);
  const replacements = {
    "{{BUILD_UTC_LITERAL}}": opts.buildUtc,
    "{{SLIDE_COUNT_LITERAL}}": String(opts.slideCount),
    "{{JSON_OF_SLIDE_LIST}}": slideListJson,
    "{{DOC_TEXT}}": opts.docText,
  };
  return applyStudyGuidePromptTemplate(STUDY_GUIDE_CANONICAL_PROMPT, replacements);
}

function buildMaximalFactRewritePrompt(registry: { topics: unknown[]; spans: unknown[] }) {
  const registryJson = JSON.stringify(registry, null, 2);
  return applyStudyGuidePromptTemplate(STUDY_GUIDE_MAXIMAL_FACT_REWRITE_PROMPT, {
    "{{FACT_REGISTRY_JSON}}": registryJson,
  });
}

function sanitizeMachineDownloadFilename(name: string) {
  const cleaned = (name || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[\\/]+/g, "_")
    .replace(/"/g, "'")
    .trim();
  return cleaned || "lecture.txt";
}

function cleanLectureDisplayLabel(raw: string) {
  const value = (raw || "").trim();
  if (!value) return "";
  const leaf = value.split("/").pop() || value;
  let cleaned = leaf.trim();
  cleaned = cleaned.replace(/^\d+\s+/, "");
  cleaned = cleaned.replace(/^\d+[_-]+/, "");
  cleaned = cleaned.replace(/^[a-f0-9]{8,}[_-]+/i, "");
  cleaned = cleaned.replace(/\.pdf$/i, "");
  cleaned = cleaned.replace(/\.txt$/i, "");
  return cleaned.trim();
}

function buildLectureTxtDisplayName(raw: string) {
  const base = cleanLectureDisplayLabel(raw) || "Lecture";
  return base.toLowerCase().endsWith(".txt") ? base : `${base}.txt`;
}

async function handleMachineLectureToTxt(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return jsonNoStore({ ok: false, error: "Send JSON { docId, lectureTitle }." }, 400);
  }

  const docId = typeof (body as any).docId === "string" ? (body as any).docId.trim() : "";
  const lectureTitleInput = typeof (body as any).lectureTitle === "string" ? (body as any).lectureTitle.trim() : "";
  if (!docId) return jsonNoStore({ ok: false, error: "Missing docId." }, 400);

  const { bucket } = getLibraryBucket(env);
  let manifest: PdfManifest | null = null;
  try {
    manifest = await readManifest(bucket, docId);
  } catch {
    manifest = null;
  }

  const lectureTitle = lectureTitleInput || manifest?.title || docId;
  const displayName = buildLectureTxtDisplayName(lectureTitle);
  const filename = displayName;
  const storageTitle = lectureTitle.replace(/\.txt$/i, "");

  const candidateKeys = new Set<string>();
  if (manifest?.extractedKey) candidateKeys.add(manifest.extractedKey);
  candidateKeys.add(buildExtractedPath(docId));

  let extractedKey = "";
  let extractedText = "";
  for (const key of candidateKeys) {
    if (!key) continue;
    try {
      const object = await bucket.get(key);
      if (object && object.body) {
        extractedKey = key;
        extractedText = await object.text();
        break;
      }
    } catch {
      // ignore cache miss
    }
  }

  if (!extractedText.trim()) {
    return jsonNoStore(
      { ok: false, error: "Lecture not cached/primed yet. Prime the lecture first." },
      404,
    );
  }

  const pageCount = Number.isFinite(manifest?.pageCount) ? Number(manifest?.pageCount) : undefined;
  const machineText = sanitizeDocText(formatMachineTxtFromExtractedText(extractedText, pageCount));

  if (!machineText) {
    return jsonNoStore(
      { ok: false, error: "Lecture not cached/primed yet. Prime the lecture first." },
      404,
    );
  }

  const storedKey = buildMachineTxtKey(docId, storageTitle);
  await bucket.put(storedKey, machineText, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });

  const downloadUrl = `/api/machine/download?key=${encodeURIComponent(storedKey)}&filename=${encodeURIComponent(displayName)}`;
  const payload: Record<string, unknown> = {
    ok: true,
    filename,
    displayName,
    originalLectureTitle: lectureTitle,
    storedKey,
    downloadUrl,
    extractedKey,
  };
  if (machineText.length <= MACHINE_TEXT_JSON_LIMIT) {
    payload.text = machineText;
  } else {
    payload.text = "";
    payload.textLength = machineText.length;
  }

  return jsonNoStore(payload);
}

async function handleMachineGenerateStudyGuide(req: Request, env: Env): Promise<Response> {
  const requestId = `machine-study-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  const STUDY_GUIDE_JSON_MODEL = resolveModelId(DEFAULT_TEXT_MODEL, env);
  const STUDY_GUIDE_OUTLINE_MODEL = resolveModelId(DEFAULT_TEXT_MODEL, env);
  const diagnostics: StudyGuideDiagnostics = {
    requestId,
    stepBModel: STUDY_GUIDE_JSON_MODEL,
    stopTokens: [],
    stepBStages: [],
    errors: [],
    stepBStopTokenHit: false,
  };
  const diagnosticsKey = buildStudyGuideDiagnosticsKey(requestId);
  const debugEnabled = isOwenDebug(env);
  const sanitizeStudyGuideError = (value: unknown) => {
    if (typeof value !== "string") return value;
    return value.replace(/^[A-Z0-9_]+:\s*/, "");
  };
  const respond = async (payload: Record<string, unknown>, status = 200) => {
    if (typeof payload.error === "string") {
      payload.error = sanitizeStudyGuideError(payload.error);
    }
    if (typeof payload.message === "string") {
      payload.message = sanitizeStudyGuideError(payload.message);
    }
    payload.requestId = payload.requestId || requestId;
    payload.diagnosticsKey = diagnosticsKey;
    if (debugEnabled) {
      payload.diagnostics = diagnostics;
    }
    await saveStudyGuideDiagnostics(env, diagnosticsKey, diagnostics);
    return jsonNoStore(payload, status);
  };
  const recordDiagnosticsError = (stage: string, err: unknown, extra?: Record<string, unknown>) => {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    diagnostics.errors?.push({
      stage,
      message,
      stack,
      ...extra,
    });
  };
  const responseWarnings: string[] = [];
  let responsePartial = false;
  let responseCoverage: { processed: number; total: number } | null = null;
  let coverageSectionHtml = "";
  const addWarning = (message: string) => {
    const cleaned = (message || "").trim();
    if (!cleaned) return;
    if (responseWarnings.includes(cleaned)) return;
    responseWarnings.push(cleaned);
  };
  const applyStepACoverage = (result: StepAExtractionResult | null, modeLabel: string) => {
    if (!result) return;
    const processedRanges = result.processed
      .filter(entry => entry.status === "ok")
      .map(entry => ({ start: entry.start, end: entry.end }));
    const failedRanges = result.failures.map(entry => ({
      start: entry.start,
      end: entry.end,
      kind: entry.kind,
    }));
    const unprocessedRanges = result.unprocessed || [];
    const partial =
      result.failures.length > 0 || unprocessedRanges.length > 0 || result.timeBudgetHit;
    responsePartial = responsePartial || partial;
    const total = result.okChunks + result.failures.length + unprocessedRanges.length;
    responseCoverage = {
      processed: result.okChunks,
      total: total || result.totalChunks || result.okChunks,
    };
    if (partial) {
      coverageSectionHtml = buildStepACoverageSection({
        processed: processedRanges,
        failures: failedRanges,
        unprocessed: unprocessedRanges,
        timeBudgetHit: result.timeBudgetHit,
        docKey: result.docKey,
        mode: modeLabel,
        promptVersion: result.promptVersion,
      });
      if (result.timeBudgetHit || unprocessedRanges.length) {
        addWarning("Generation stopped early due to time limits; rerun to resume.");
      }
      if (result.failures.length) {
        addWarning("Some chunks could not be extracted; rerun to attempt remaining sections.");
      }
    }
  };
  const contentType = req.headers.get("content-type") || "";
  let lectureTitle = "";
  let docId = "";
  let buildUtc = "";
  let txt = "";
  let storedKeyInput = "";
  let storedFilename = "";
  let txtFile: File | null = null;
  let mode = "maximal";

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    lectureTitle = typeof form.get("lectureTitle") === "string" ? String(form.get("lectureTitle")).trim() : "";
    docId = typeof form.get("docId") === "string" ? String(form.get("docId")).trim() : "";
    buildUtc = typeof form.get("buildUtc") === "string" ? String(form.get("buildUtc")).trim() : "";
    mode = typeof form.get("mode") === "string" ? String(form.get("mode")).trim().toLowerCase() : "";
    const txtValue = form.get("txt");
    if (typeof txtValue === "string") {
      txt = txtValue;
    }
    const file = form.get("txtFile");
    if (file instanceof File) {
      txtFile = file;
    }
  } else {
    const body = await readRequestJsonBody(req);
    if (!body || typeof body !== "object") {
      return respond({ ok: false, error: "Send JSON { txt?, storedKey?, lectureTitle?, docId?, buildUtc? }." }, 400);
    }
    lectureTitle = typeof (body as any).lectureTitle === "string" ? (body as any).lectureTitle.trim() : "";
    docId = typeof (body as any).docId === "string" ? (body as any).docId.trim() : "";
    buildUtc = typeof (body as any).buildUtc === "string" ? (body as any).buildUtc.trim() : "";
    mode = typeof (body as any).mode === "string" ? (body as any).mode.trim().toLowerCase() : "";
    storedKeyInput = typeof (body as any).storedKey === "string" ? (body as any).storedKey.trim() : "";
    storedFilename = typeof (body as any).filename === "string" ? (body as any).filename.trim() : "";
    txt = typeof (body as any).txt === "string" ? (body as any).txt : "";
  }

  if (txtFile && txtFile.size > MACHINE_STUDY_GUIDE_MAX_BYTES) {
    return respond({ ok: false, error: "TXT too large; please upload a smaller file." }, 413);
  }

  if (txtFile?.name && !/\.txt$/i.test(txtFile.name)) {
    return respond({ ok: false, error: "TXT format invalid (expected a .txt file)." }, 400);
  }

  if (txtFile) {
    try {
      txt = await txtFile.text();
    } catch (err) {
      return respond({ ok: false, error: "Unable to read TXT file." }, 400);
    }
  }

  if (storedKeyInput) {
    try {
      txt = (await loadMachineTxtFromStorage(env, storedKeyInput)) || "";
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid storedKey.";
      return respond({ ok: false, error: msg }, 400);
    }
    if (!txt.trim()) {
      return respond({ ok: false, error: "Stored TXT not found." }, 404);
    }
  }

  if (!lectureTitle && txtFile?.name) {
    lectureTitle = txtFile.name.replace(/\.txt$/i, "").trim();
  }
  if (!lectureTitle && storedFilename) {
    lectureTitle = storedFilename.replace(/\.txt$/i, "").trim();
  }

  diagnostics.docId = docId || undefined;
  diagnostics.lectureTitle = lectureTitle || undefined;

  if (!txt || !txt.trim()) {
    return respond({ ok: false, error: "Please upload or generate a TXT first." }, 400);
  }

  mode = mode === "canonical" || mode === "enhanced" ? mode : "maximal";
  const isEnhanced = mode === "enhanced";
  const isMaximal = mode === "maximal";
  const stepJsonModel = isEnhanced ? STUDY_GUIDE_OUTLINE_MODEL : STUDY_GUIDE_JSON_MODEL;
  diagnostics.stepBModel = isMaximal ? STUDY_GUIDE_OUTLINE_MODEL : stepJsonModel;
  const sanitizedTxt = sanitizeDocText(txt);
  if (sanitizedTxt.length < 500) {
    return respond({ ok: false, error: "TXT too short after sanitization." }, 400);
  }
  console.log("[machine.studyGuide] sanitizedLength=%s mode=%s", sanitizedTxt.length, mode);

  const normalizedTxt = normalizeMachineTxtInput(sanitizedTxt);
  const byteLength = enc.encode(normalizedTxt).length;
  if (byteLength > MACHINE_STUDY_GUIDE_MAX_BYTES) {
    return respond({ ok: false, error: "TXT too large; please upload a smaller file." }, 413);
  }
  let sourceStoredKey = "";
  let sourceTxtHash = "";
  try {
    const stored = await ensureMachineTxtStored(env, normalizedTxt);
    sourceStoredKey = stored.storedKey;
    sourceTxtHash = stored.hash;
  } catch (err) {
    recordDiagnosticsError("txt_store", err);
    return respond({ ok: false, error: "Unable to store TXT for study guide generation." }, 500);
  }

  const parsed = parseMachineSlideListFromTxt(normalizedTxt);
  if (!parsed.slideCount) {
    return respond({ ok: false, error: "TXT format invalid (missing Slide N (p.N) headers)." }, 400);
  }

  const buildUtcLiteral = buildUtc || MACHINE_STUDY_GUIDE_DEFAULT_UTC;
  let html = "";
  if (mode === "canonical") {
    const canonicalPrompt = buildStudyGuidePrompt({
      buildUtc: buildUtcLiteral,
      slideCount: parsed.slideCount,
      slides: parsed.slides,
      docText: parsed.normalizedText,
    });
    try {
      html = await callStudyGuideResponses(
        env,
        requestId,
        "canonical",
        STUDY_GUIDE_JSON_MODEL,
        canonicalPrompt,
        MACHINE_STUDY_GUIDE_MAX_OUTPUT_TOKENS,
        { expectsJson: false },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Study guide generation failed.";
      recordDiagnosticsError("canonical", err);
      return respond({ ok: false, error: msg }, 502);
    }

    const truncated = truncateAtHtmlEnd(html);
    if (!truncated.ok) {
      const preview = (html || "").slice(0, 2000);
      console.warn("[MACHINE-STUDY] Missing </html> tag in response", { requestId, preview });
      recordDiagnosticsError("canonical_truncate", truncated.error, { preview });
      return respond({ ok: false, error: truncated.error }, 500);
    }
    html = truncated.html;

    if (!/<html/i.test(html)) {
      console.warn("[MACHINE-STUDY] Missing <html> tag in response", { requestId });
    }
  } else if (mode === "maximal") {
    const lectureTitleLiteral = lectureTitle || docId || "Lecture";
    const parsedBlocks = parseMachineSlideBlocksFromTxt(normalizedTxt);
    let inventory = extractTopicInventoryFromSlides(parsedBlocks.slides);
    try {
      ensureMaximalTopicClassification(inventory);
    } catch (err) {
      recordDiagnosticsError("maximal_topic_classification", err);
      inventory = sanitizeTopicInventory(inventory);
    }
    inventory = sanitizeTopicInventory(inventory);

    const docKey = sanitizeMachineSlug(docId || sourceTxtHash || "doc", "doc");
    const promptVersion = await sha256(
      `${STUDY_GUIDE_STEP_A_EXTRACT_PROMPT}::${MACHINE_STUDY_GUIDE_STEP_A_PIPELINE_VERSION}`,
    );

    const stepAChunks = buildAdaptiveStudyGuideStepAChunks(
      parsedBlocks.slides,
      MACHINE_STUDY_GUIDE_STEP_A_MAX_SLIDES,
      MACHINE_STUDY_GUIDE_STEP_A_MAX_CHARS,
    );
    if (!stepAChunks.length) {
      return jsonNoStore({ ok: false, error: "TXT format invalid (missing Slide N (p.N) headers)." }, 400);
    }

    let stepA: StepAOutput;
    let stepAResult: StepAExtractionResult | null = null;
    try {
      stepAResult = await extractStepAFromChunks({
        env,
        requestId,
        lectureTitle: lectureTitleLiteral,
        stepJsonModel: stepJsonModel,
        stepAChunks,
        docKey,
        mode,
        promptVersion,
        startedAt,
        timeBudgetMs: MACHINE_STUDY_GUIDE_STEP_A_TIME_BUDGET_MS,
      });
      stepA = stepAResult.stepA;
      diagnostics.stepAMethod = `chunked-extract:${stepAResult.okChunks}/${stepAResult.totalChunks}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Study guide step A failed.";
      console.warn("[machine.studyGuide] step=A json=error", { requestId, error: msg });
      recordDiagnosticsError("step_a", err);
      return respond(
        {
          ok: false,
          error: msg,
          errorStage: "step_a",
        },
        500,
      );
    }

    applyStepACoverage(stepAResult, mode);
    const stepAPartial = Boolean(
      stepAResult && (stepAResult.failures.length || stepAResult.unprocessed.length || stepAResult.timeBudgetHit),
    );

    const stepAJson = JSON.stringify(stepA, null, 2);
    diagnostics.stepACharCount = stepAJson.length;
    diagnostics.stepATextHash = hashString(stepAJson);
    diagnostics.stepAPreview = previewText(stepAJson, 300);
    diagnostics.stepAMethod = diagnostics.stepAMethod || `chunked-extract:${stepAChunks.length}`;

    const qaNotes: string[] = [];
    const stepAQuality = assessStepAQuality(stepA, parsedBlocks.slides, stepAJson.length);
    if (!stepAQuality.ok) {
      recordDiagnosticsError("step_a_quality", stepAQuality.message, { reason: stepAQuality.reason });
      responsePartial = true;
      addWarning(stepAQuality.message);
      qaNotes.push(stepAQuality.message);
    }

    const registry = buildFactRegistryFromStepA({
      stepA,
      inventory,
      slides: parsedBlocks.slides.map(slide => ({ n: slide.n, page: slide.page, text: slide.text || "" })),
    });
    let rewrittenRegistry = registry;
    const rewriteRegistry = async (label: string, hint?: string) => {
      const rewritePrompt = buildMaximalFactRewritePrompt(registry);
      const finalPrompt = hint ? `${rewritePrompt}\n\n${hint}` : rewritePrompt;
      const rewriteRaw = await callStudyGuideResponses(
        env,
        requestId,
        label,
        STUDY_GUIDE_OUTLINE_MODEL,
        finalPrompt,
        MACHINE_STUDY_GUIDE_STEP_A_MAX_OUTPUT_TOKENS,
        { expectsJson: true },
      );
      const rewritten = await parseStudyGuideJsonWithRepair<FactRegistry>(
        rewriteRaw,
        label,
        async (raw) => {
          const repairPrompt = `${STUDY_GUIDE_MAXIMAL_FACT_REWRITE_REPAIR_PROMPT}${raw}`;
          return callStudyGuideResponses(
            env,
            requestId,
            `${label}-repair`,
            STUDY_GUIDE_OUTLINE_MODEL,
            repairPrompt,
            MACHINE_STUDY_GUIDE_STEP_A_MAX_OUTPUT_TOKENS,
            { expectsJson: true },
          );
        },
        { strictExtraction: true },
      );
      return coerceFactRegistryRewrite(registry, rewritten);
    };
    try {
      rewrittenRegistry = await rewriteRegistry("maximal-facts");
    } catch (err) {
      recordDiagnosticsError("maximal_fact_rewrite", err);
    }

    const checkRegistryQuality = (candidate: FactRegistry): string | null => {
      try {
        ensureMaximalTopicDensity(candidate);
        ensureMaximalDrugCoverage(candidate);
        return null;
      } catch (err) {
        return summarizeRegistryQualityFailure(err);
      }
    };

    let qualityFailure = checkRegistryQuality(rewrittenRegistry);
    if (qualityFailure) {
      const retryHint = [
        "QUALITY_FAILURES:",
        qualityFailure,
        "Fix the gaps using ONLY existing span_id values.",
        "Do not add new topics or span_ids.",
      ].join("\n");
      try {
        rewrittenRegistry = await rewriteRegistry("maximal-facts-retry", retryHint);
        const retryFailure = checkRegistryQuality(rewrittenRegistry);
        if (retryFailure) {
          qualityFailure = retryFailure;
          recordDiagnosticsError("maximal_fact_quality", retryFailure);
        } else {
          qualityFailure = null;
        }
      } catch (err) {
        recordDiagnosticsError("maximal_fact_rewrite_retry", err);
      }
    }
    if (qualityFailure) {
      qaNotes.push(qualityFailure);
    }

    const mh7 = filterMh7Topics(rewrittenRegistry.topics, { requireDrugCoverage: true });

    html = renderMaximalStudyGuideHtml({
      lectureTitle: lectureTitleLiteral,
      buildUtc: buildUtcLiteral,
      slideCount: parsed.slideCount,
      slides: parsedBlocks.slides,
      inventory,
      registry: rewrittenRegistry,
      mh7: { omitted: mh7.omitted, minFacts: mh7.minFacts },
      stepA,
      qaNotes,
      partial: stepAPartial,
    });

    let needsRerender = false;
    const addQaNote = (note: string) => {
      const cleaned = (note || "").trim();
      if (!cleaned) return;
      if (qaNotes.includes(cleaned)) return;
      qaNotes.push(cleaned);
      needsRerender = true;
    };

    const styleCheck = validateStyleContract(html);
    if (!styleCheck.ok) {
      recordDiagnosticsError("maximal_style_contract", "style contract failed", { missing: styleCheck.missing });
      addQaNote("Style contract missing required classes.");
    }
    const structureCheck = validateMaximalStructure(html);
    if (!structureCheck.ok) {
      recordDiagnosticsError("maximal_structure", "structure validation failed", { missing: structureCheck.missing });
      addQaNote("Required maximal sections missing.");
    }
    try {
      ensureMaximalDiscriminatorColumns(html);
    } catch (err) {
      recordDiagnosticsError("maximal_discriminator_columns", err);
      addQaNote("Schema tables missing required columns.");
    }

    let placeholderCleaned = false;
    try {
      ensureMaximalPlaceholderQuality(html);
    } catch (err) {
      recordDiagnosticsError("maximal_placeholders", err);
      placeholderCleaned = true;
      addQaNote("Placeholder phrases removed from output.");
    }

    try {
      ensureMaximalCoverage(inventory, html);
    } catch (err) {
      recordDiagnosticsError("maximal_coverage", err);
      const missing = (err as any)?.missing as string[] | undefined;
      if (missing?.length) {
        addQaNote(`Coverage gaps: ${missing.join(", ")}`);
      } else {
        addQaNote("Coverage gaps detected in core sections.");
      }
    }

    if (needsRerender) {
      html = renderMaximalStudyGuideHtml({
        lectureTitle: lectureTitleLiteral,
        buildUtc: buildUtcLiteral,
        slideCount: parsed.slideCount,
        slides: parsedBlocks.slides,
        inventory,
        registry: rewrittenRegistry,
        mh7: { omitted: mh7.omitted, minFacts: mh7.minFacts },
        stepA,
        qaNotes,
        partial: stepAPartial,
      });
    }

    if (placeholderCleaned) {
      html = stripPlaceholderPhrasesFromHtml(html);
    }
  } else {
    const lectureTitleLiteral = lectureTitle || docId || "Lecture";
    const parsedBlocks = parseMachineSlideBlocksFromTxt(normalizedTxt);
    const stepAChunks = buildAdaptiveStudyGuideStepAChunks(
      parsedBlocks.slides,
      MACHINE_STUDY_GUIDE_STEP_A_MAX_SLIDES,
      MACHINE_STUDY_GUIDE_STEP_A_MAX_CHARS,
    );
    if (!stepAChunks.length) {
      return jsonNoStore({ ok: false, error: "TXT format invalid (missing Slide N (p.N) headers)." }, 400);
    }
    const sourceTextBySlide: Record<string, string> = {};
    for (const slide of parsedBlocks.slides) {
      sourceTextBySlide[String(slide.n)] = slide.text || "[NO TEXT]";
    }
    let stepA: StepAOutput;
    let stepAResult: StepAExtractionResult | null = null;
    let stepB: StepBOutput;
    let stepC: StepCOutput;
    try {
      const docKey = sanitizeMachineSlug(docId || sourceTxtHash || "doc", "doc");
      const promptVersion = await sha256(
        `${STUDY_GUIDE_STEP_A_EXTRACT_PROMPT}::${MACHINE_STUDY_GUIDE_STEP_A_PIPELINE_VERSION}`,
      );
      stepAResult = await extractStepAFromChunks({
        env,
        requestId,
        lectureTitle: lectureTitleLiteral,
        stepJsonModel,
        stepAChunks,
        docKey,
        mode,
        promptVersion,
        startedAt,
        timeBudgetMs: MACHINE_STUDY_GUIDE_STEP_A_TIME_BUDGET_MS,
      });
      stepA = stepAResult.stepA;
      diagnostics.stepAMethod = `chunked-extract:${stepAResult.okChunks}/${stepAResult.totalChunks}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Study guide step A failed.";
      console.warn("[machine.studyGuide] step=A json=error", { requestId, error: msg });
      recordDiagnosticsError("step_a", err);
      return respond(
        {
          ok: false,
          error: msg,
          errorStage: "step_a",
        },
        500,
      );
    }

    applyStepACoverage(stepAResult, mode);

    const stepAJson = JSON.stringify(stepA, null, 2);
    diagnostics.stepACharCount = stepAJson.length;
    diagnostics.stepATextHash = hashString(stepAJson);
    diagnostics.stepAPreview = previewText(stepAJson, 300);
    diagnostics.stepAMethod = diagnostics.stepAMethod || `chunked-extract:${stepAChunks.length}`;

    const stepAQuality = assessStepAQuality(stepA, parsedBlocks.slides, stepAJson.length);
    if (!stepAQuality.ok) {
      recordDiagnosticsError("step_a_quality", stepAQuality.message, { reason: stepAQuality.reason });
      responsePartial = true;
      addWarning(stepAQuality.message);
    }

    const recordStepBStage = (entry: StepBStageDiagnostic) => {
      diagnostics.stepBStages?.push(entry);
    };
    const callStepBWithModel = async (
      step: string,
      prompt: string,
      maxOutputTokens: number,
      modelId: string,
      expectsJson: boolean,
    ) => {
      const inputChars = prompt.length;
      const estimatedTokens = estimateTokenCount(prompt);
      diagnostics.stepBMaxTokens = Math.max(diagnostics.stepBMaxTokens || 0, maxOutputTokens);
      diagnostics.estimatedInputTokens = Math.max(diagnostics.estimatedInputTokens || 0, estimatedTokens);
      recordStepBStage({
        step,
        model: modelId,
        max_output_tokens: maxOutputTokens,
        input_chars: inputChars,
        estimated_input_tokens: estimatedTokens,
        stop_token_hit: false,
      });
      try {
        const text = await callStudyGuideResponses(
          env,
          requestId,
          step,
          modelId,
          prompt,
          maxOutputTokens,
          { expectsJson },
        );
        recordStepBStage({
          step: `${step}:output`,
          model: modelId,
          output_chars: text.length,
        });
        return text;
      } catch (err) {
        const status = (err as any)?.status;
        const providerError = err instanceof Error ? err.message : String(err);
        const bodyText = typeof (err as any)?.bodyText === "string" ? (err as any).bodyText : "";
        const bodyTail = bodyText ? bodyText.slice(-800) : "";
        recordStepBStage({
          step,
          model: modelId,
          provider_status: status,
          provider_error: providerError,
          exception: providerError,
          stack: err instanceof Error ? err.stack : undefined,
        });
        recordDiagnosticsError(step, err, { provider_status: status, provider_error: providerError, body_tail: bodyTail });
        throw err;
      }
    };
    const callStepBJsonModel = (step: string, prompt: string, maxOutputTokens: number) =>
      callStepBWithModel(step, prompt, maxOutputTokens, stepJsonModel, true);
    const callStepBTextModel = (step: string, prompt: string, maxOutputTokens: number) =>
      callStepBWithModel(step, prompt, maxOutputTokens, stepJsonModel, false);
    const callStepBOutlineModel = (step: string, prompt: string, maxOutputTokens: number) =>
      callStepBWithModel(step, prompt, maxOutputTokens, STUDY_GUIDE_OUTLINE_MODEL, false);

    diagnostics.stepBInputMethod = "full-stepA";
    if (isEnhanced) {
      const stepBPrompt = applyStudyGuidePromptTemplate(STUDY_GUIDE_STEP_B_ENHANCED_PROMPT, {
        "{{STEP_A_JSON}}": stepAJson,
      });
      let stepBDraft: StepBOutput;
      try {
        const stepBRaw = await callStepBWithModel(
          "B-enhanced",
          stepBPrompt,
          MACHINE_STUDY_GUIDE_STEP_B_MAX_OUTPUT_TOKENS,
          stepJsonModel,
          true,
        );
        stepBDraft = parseStudyGuideJson<StepBOutput>(stepBRaw, "B-enhanced");
      } catch (err) {
        diagnostics.stepBParseOk = false;
        const msg = err instanceof Error ? err.message : String(err);
        recordDiagnosticsError("step_b_enhanced", err);
        return respond({ ok: false, error: msg }, 500);
      }

      const synthesisFailures = validateSynthesis(stepBDraft);
      const validationFailures = validateStepB(stepA, stepBDraft);
      if (synthesisFailures.length || validationFailures.length) {
        const combinedFailures = [...synthesisFailures, ...validationFailures];
        recordDiagnosticsError("step_b_validation", "validator failures", { failures: combinedFailures });
        const rewritePrompt = applyStudyGuidePromptTemplate(STUDY_GUIDE_STEP_B_QC_REWRITE_PROMPT, {
          "{{STEP_A_JSON}}": stepAJson,
          "{{STEP_B_DRAFT_JSON}}": JSON.stringify(stepBDraft, null, 2),
          "{{STEP_B_FAILURES_JSON}}": JSON.stringify(combinedFailures, null, 2),
        });
        try {
          const rewriteRaw = await callStepBWithModel(
            "B-enhanced-rewrite",
            rewritePrompt,
            MACHINE_STUDY_GUIDE_STEP_B_QC_REWRITE_MAX_OUTPUT_TOKENS,
            stepJsonModel,
            true,
          );
          const rewritten = parseStudyGuideJson<StepBOutput>(rewriteRaw, "B-enhanced-rewrite");
          const rewriteSynthesisFailures = validateSynthesis(rewritten);
          const rewriteValidationFailures = validateStepB(stepA, rewritten);
          if (rewriteSynthesisFailures.length || rewriteValidationFailures.length) {
            const finalFailures = [...rewriteSynthesisFailures, ...rewriteValidationFailures];
            diagnostics.stepBParseOk = false;
            recordDiagnosticsError("step_b_validation_final", "validator failures after rewrite", {
              failures: finalFailures,
            });
            return respond({ ok: false, error: "Study guide step B failed validation." }, 500);
          }
          stepB = rewritten;
        } catch (err) {
          diagnostics.stepBParseOk = false;
          const msg = err instanceof Error ? err.message : String(err);
          recordDiagnosticsError("step_b_enhanced_rewrite", err);
          return respond({ ok: false, error: msg }, 500);
        }
      } else {
        stepB = stepBDraft;
      }
      diagnostics.stepBParseOk = true;
    } else {
      let stepAForStepB = stepA;
      if (stepAJson.length > MACHINE_STUDY_GUIDE_STEP_B_INPUT_MAX_CHARS) {
        diagnostics.stepBInputMethod = "condensed-stepA";
        try {
          const condensed = await condenseStepAForSynthesis({
            stepA,
            callModel: callStepBTextModel,
            maxChunkChars: MACHINE_STUDY_GUIDE_STEP_A_SUMMARY_CHUNK_CHARS,
            maxOutputTokens: MACHINE_STUDY_GUIDE_STEP_A_SUMMARY_MAX_OUTPUT_TOKENS,
          });
          stepAForStepB = condensed.stepA;
          diagnostics.stepAMethod = `condensed-summary:${condensed.chunkCount}`;
          if (condensed.usedFallback) {
            recordDiagnosticsError("step_a_condense", "Condense fallback used.");
          }
        } catch (err) {
          recordDiagnosticsError("step_a_condense", err);
          stepAForStepB = stepA;
          diagnostics.stepBInputMethod = "full-stepA";
        }
      }

      stepB = buildDefaultStepB();
      let stepBPlan: StepBPlan | null = null;
      try {
        const result = await compileStudyGuideStepB({
          stepA: stepAForStepB,
          callModelOutline: callStepBOutlineModel,
          callModelJson: callStepBJsonModel,
          modelOutline: STUDY_GUIDE_OUTLINE_MODEL,
          modelJson: stepJsonModel,
          recordStage: recordStepBStage,
        });
        stepB = result.final;
        stepBPlan = result.plan;
        const planAtoms = Array.isArray(result.plan.selected_exam_atoms) ? result.plan.selected_exam_atoms.length : 0;
        const compareTopics = Array.isArray(result.plan.compare_topics) ? result.plan.compare_topics.length : 0;
        console.log(
          "[machine.studyGuide] step=B plan atoms=%s counts=%o compare_topics=%s",
          planAtoms,
          result.plan.section_counts,
          compareTopics,
        );
        if (result.failures.length) {
          const failureCounts = result.failures.reduce<Record<string, number>>((acc, failure) => {
            acc[failure.code] = (acc[failure.code] || 0) + 1;
            return acc;
          }, {});
          console.warn(
            "[machine.studyGuide] step=B validation failures=%s rewrite=%s codes=%o",
            result.failures.length,
            result.hadRewrite,
            failureCounts,
          );
          recordDiagnosticsError("step_b_validation", "validator failures", {
            failures: result.failures,
          });
        } else {
          console.log("[machine.studyGuide] step=B validation=ok");
        }
        if (result.hadRewrite) {
          const finalCounts = result.finalFailures.reduce<Record<string, number>>((acc, failure) => {
            acc[failure.code] = (acc[failure.code] || 0) + 1;
            return acc;
          }, {});
          console.log(
            "[machine.studyGuide] step=B rewrite=done final_failures=%s codes=%o",
            result.finalFailures.length,
            finalCounts,
          );
          if (result.finalFailures.length) {
            recordDiagnosticsError("step_b_validation_final", "validator failures after rewrite", {
              failures: result.finalFailures,
            });
          }
        }
        if (result.coerced) {
          recordDiagnosticsError("step_b_coerced", "Step B output coerced after validation failure.");
          diagnostics.stepBParseOk = false;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[machine.studyGuide] step=B failed; coercing output", { requestId, error: msg });
        recordDiagnosticsError("step_b_compile", err);
        stepB = buildFallbackStepBOutput(stepA, {});
        stepBPlan = null;
        diagnostics.stepBParseOk = false;
      }
    }

    if (!diagnostics.fallbackUsed && diagnostics.stepBParseOk !== false) {
      diagnostics.stepBParseOk = true;
    }

    if (diagnostics.fallbackUsed) {
      const sourceKey = buildStudyGuideSourceKey(docId, lectureTitle);
      const sourceFilename = buildStudyGuideSourceFilename(lectureTitle);
      try {
        const { bucket } = getLibraryBucket(env);
        await bucket.put(sourceKey, normalizedTxt, {
          httpMetadata: { contentType: "text/plain; charset=utf-8" },
        });
        const sourceUrl = `/api/machine/download?key=${encodeURIComponent(sourceKey)}&filename=${encodeURIComponent(sourceFilename)}`;
        diagnostics.fallbackSourceTxtKey = sourceKey;
        diagnostics.fallbackSourceTxtUrl = sourceUrl;
        const glue = Array.isArray(stepB.supplemental_glue) ? stepB.supplemental_glue : [];
        stepB.supplemental_glue = [...glue, `Download source TXT: ${sourceUrl}`];
      } catch (err) {
        recordDiagnosticsError("fallback_source_store", err);
      }
      stepC = buildDefaultStepC(stepA, stepB, parsedBlocks.slideCount);
    } else {
      const stepCSummary = buildStepCSummary(stepA, stepB, parsedBlocks.slideCount);
      const stepCSummaryJson = JSON.stringify(stepCSummary, null, 2);
      const stepCPrompt = applyStudyGuidePromptTemplate(STUDY_GUIDE_STEP_C_QA_PROMPT, {
        "{{STEP_C_SUMMARY}}": stepCSummaryJson,
      });
      let stepCRaw = "";
      try {
        stepCRaw = await callStudyGuideResponses(
          env,
          requestId,
          "C",
          stepJsonModel,
          stepCPrompt,
          MACHINE_STUDY_GUIDE_STEP_C_MAX_OUTPUT_TOKENS,
          { expectsJson: true },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[machine.studyGuide] step=C call failed; using default QA", { requestId, error: msg });
        stepC = buildDefaultStepC(stepA, stepB, parsedBlocks.slideCount);
        stepCRaw = "";
      }
      if (!stepC) {
        const trimmed = (stepCRaw || "").trim();
        if (!trimmed) {
          console.warn("[machine.studyGuide] step=C empty; using default QA", { requestId });
          stepC = buildDefaultStepC(stepA, stepB, parsedBlocks.slideCount);
        } else {
          try {
            stepC = await parseStudyGuideJsonWithRepair<StepCOutput>(
              stepCRaw,
              "C",
              async (raw) => {
                const repairPrompt = `${STUDY_GUIDE_STEP_C_REPAIR_PROMPT}${raw}`;
                return callStudyGuideResponses(
                  env,
                  requestId,
                  "C-repair",
                  stepJsonModel,
                  repairPrompt,
                  MACHINE_STUDY_GUIDE_STEP_C_REPAIR_MAX_OUTPUT_TOKENS,
                  { expectsJson: true },
                );
              },
            );
            console.log("[machine.studyGuide] step=C json=ok");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn("[machine.studyGuide] step=C json invalid; using default QA", { requestId, error: msg });
            stepC = buildDefaultStepC(stepA, stepB, parsedBlocks.slideCount);
          }
        }
      }
      console.log("[machine.studyGuide] step=C final", {
        requestId,
        usedDefault: Boolean(
          stepC &&
            stepC.unparsed_items?.length === 0 &&
            stepC.omissions?.length === 0 &&
            stepC.conflicts?.length === 0,
        ),
        confidence: stepC.coverage_confidence,
      });
    }

    html = renderStudyGuideHtml({
      lectureTitle: stepA?.lecture_title || lectureTitle || docId || "Lecture",
      buildUtc: buildUtcLiteral,
      stepA,
      stepB,
      stepC,
      sourceTextBySlide,
    });
  }

  if (coverageSectionHtml) {
    html = injectCoverageQaSection(html, coverageSectionHtml);
  }

  const filename = buildStudyGuideFilename(lectureTitle);
  const storedKey = buildStudyGuideStoredKey(docId, lectureTitle);
  const { bucket } = getLibraryBucket(env);
  await bucket.put(storedKey, html, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
  if (env.DOCS_KV) {
    await env.DOCS_KV.delete(buildStudyGuideSourceMappingKey(storedKey));
  }

  const downloadUrl = `/api/machine/download?key=${encodeURIComponent(storedKey)}&filename=${encodeURIComponent(filename)}`;
  if (diagnostics.fallbackUsed) {
    responsePartial = true;
    addWarning("Study guide synthesis fallback was generated.");
  }
  const payload: Record<string, unknown> = {
    ok: true,
    filename,
    storedKey,
    sourceStoredKey,
    downloadUrl,
    partial: responsePartial,
    coverage: responseCoverage || undefined,
    warnings: responseWarnings.length ? responseWarnings : undefined,
    fallbackUsed: Boolean(diagnostics.fallbackUsed),
  };
  return respond(payload, 200);
}

async function handleMachineDownload(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const key = url.searchParams.get("key")?.trim() || "";
  if (!key) {
    return new Response("Missing key", { status: 400, headers: CORS_HEADERS });
  }
  if (!key.startsWith(`${MACHINE_TXT_PREFIX}/`) && !key.startsWith(`${MACHINE_STUDY_GUIDE_PREFIX}/`)) {
    return new Response("Invalid key", { status: 400, headers: CORS_HEADERS });
  }
  const filenameParam = url.searchParams.get("filename") || "";
  const filename = sanitizeMachineDownloadFilename(filenameParam || key.split("/").pop() || "lecture.txt");
  const { bucket } = getLibraryBucket(env);
  const object = await bucket.get(key);
  if (!object || !object.body) {
    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  }
  return new Response(object.body, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": object.httpMetadata?.contentType || "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

async function handlePublishStudyGuide(req: Request, env: Env): Promise<Response> {
  const auth = await requireFaculty(req, env, "study_guide_publish");
  if (!auth.ok) return auth.response;
  const actor = auth.context.session;
  const config = getAppConfig(env, req);
  const body = await readRequestJsonBody(req);
  if (!body || typeof body !== "object") {
    return jsonNoStore({ error: "Send JSON { storedKey, filename?, lectureTitle?, docId?, mode? }." }, 400);
  }

  const guidePayload = isPlainObject((body as any).studyGuide) ? (body as any).studyGuide as Record<string, unknown> : null;
  const storedKey =
    (typeof (body as any).storedKey === "string" ? (body as any).storedKey.trim() : "") ||
    (typeof (body as any).studyGuideKey === "string" ? (body as any).studyGuideKey.trim() : "") ||
    (typeof (body as any).key === "string" ? (body as any).key.trim() : "") ||
    (typeof guidePayload?.key === "string" ? guidePayload.key.trim() : "");
  if (!storedKey) {
    return jsonNoStore({ error: "Missing storedKey for study guide." }, 400);
  }

  const filenameInput =
    (typeof (body as any).filename === "string" ? (body as any).filename.trim() : "") ||
    (typeof (body as any).studyGuideFilename === "string" ? (body as any).studyGuideFilename.trim() : "") ||
    (typeof guidePayload?.filename === "string" ? guidePayload.filename.trim() : "");
  const lectureTitleRaw =
    typeof (body as any).lectureTitle === "string"
      ? (body as any).lectureTitle
      : typeof (body as any).title === "string"
        ? (body as any).title
        : "";
  const lectureTitle = normalizeLectureTitle(lectureTitleRaw);
  const docId =
    typeof (body as any).docId === "string"
      ? (body as any).docId.trim()
      : typeof (body as any).lectureId === "string"
        ? (body as any).lectureId.trim()
        : "";
  const mode = typeof (body as any).mode === "string" ? (body as any).mode.trim() : "";

  const existingPublish = await loadPublishedStudyGuideBySource(env, storedKey);
  if (existingPublish) {
    const existingDocId =
      docId ||
      (typeof existingPublish.manifest?.docId === "string" ? existingPublish.manifest.docId.trim() : "") ||
      (typeof existingPublish.manifest?.lectureId === "string" ? existingPublish.manifest.lectureId.trim() : "");
    if (existingDocId) {
      const publishedAt =
        typeof existingPublish.manifest?.publishedAt === "string"
          ? existingPublish.manifest.publishedAt
          : new Date().toISOString();
      const title =
        typeof existingPublish.manifest?.title === "string"
          ? existingPublish.manifest.title
          : lectureTitle;
      await persistStudyGuidePublishRecord(env, {
        docId: existingDocId,
        code: existingPublish.code,
        publishedAt,
        manifestKey: existingPublish.manifestKey,
        storedKey,
        title,
      });
    }
    await writeAuditEvent(env, req, getRequestId(req), {
      event: "artifact.publish.study_guide",
      outcome: "success",
      actor: buildAuditActor(actor),
      metadata: { code: existingPublish.code, docId: existingDocId || docId || null, mode, idempotent: true },
    });
    await recordMetricEvent(env, {
      name: "artifact_published",
      requestId: getRequestId(req),
      artifactType: "study_guide",
      artifactCode: existingPublish.code,
      institutionId: actor.institutionId || config.institutionId,
      lectureId: existingDocId || docId || undefined,
      userId: actor.userId,
      role: actor.role,
      metadata: { idempotent: true, mode },
    });
    return jsonNoStore(existingPublish);
  }

  const filename = sanitizeFilename(filenameInput || storedKey.split("/").pop() || "Study_Guide.html");

  const assets: StudyGuidePublishInput[] = [];
  const seenKeys = new Set<string>();
  const pushAsset = (asset: StudyGuidePublishInput) => {
    if (!asset.key || seenKeys.has(asset.key)) return;
    seenKeys.add(asset.key);
    assets.push(asset);
  };

  pushAsset({ kind: "study_guide", key: storedKey, filename });

  const ankiPayload = isPlainObject((body as any).anki) ? (body as any).anki as Record<string, unknown> : null;
  const ankiKey =
    (typeof (body as any).ankiKey === "string" ? (body as any).ankiKey.trim() : "") ||
    (typeof ankiPayload?.key === "string" ? ankiPayload.key.trim() : "");
  if (ankiKey) {
    const ankiFilename =
      (typeof (body as any).ankiFilename === "string" ? (body as any).ankiFilename.trim() : "") ||
      (typeof ankiPayload?.filename === "string" ? ankiPayload.filename.trim() : "") ||
      ankiKey.split("/").pop() ||
      "anki.apkg";
    pushAsset({ kind: "anki", key: ankiKey, filename: sanitizeFilename(ankiFilename) });
  }

  const extraAssets = Array.isArray((body as any).assets) ? (body as any).assets : [];
  extraAssets.forEach((entry: unknown) => {
    if (!isPlainObject(entry)) return;
    const key = typeof entry.key === "string" ? entry.key.trim() : "";
    if (!key) return;
    const kind = typeof entry.kind === "string" && entry.kind.trim() ? entry.kind.trim() : "asset";
    const entryFilename = typeof entry.filename === "string" && entry.filename.trim()
      ? entry.filename.trim()
      : key.split("/").pop() || "asset.bin";
    const contentType = typeof entry.contentType === "string" ? entry.contentType : undefined;
    pushAsset({ kind, key, filename: sanitizeFilename(entryFilename), contentType });
  });

  let code = "";
  try {
    code = await generateUniqueStudyGuideCode(env);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unable to generate a unique access code.";
    return jsonNoStore({ error: message }, 500);
  }

  const publishedAt = new Date().toISOString();
  const publishPrefix = buildStudyGuidePublishPrefix(code);
  const { bucket: sourceBucket } = getLibraryBucket(env);
  const { bucket: publishBucket } = getPublishBucket(env);
  const publishedAssets: StudyGuidePublishedAsset[] = [];
  const publishedPaths: string[] = [];

  for (const asset of assets) {
    const sourceObject = await sourceBucket.get(asset.key);
    if (!sourceObject || !sourceObject.body) {
      return jsonNoStore({ error: `Asset not found: ${asset.key}` }, 404);
    }
    const safeFilename = sanitizeFilename(asset.filename || asset.key.split("/").pop() || "asset.bin");
    const destKey = `${publishPrefix}/${safeFilename}`;
    const contentType = inferPublishedContentType(safeFilename, asset.contentType || sourceObject.httpMetadata?.contentType);
    const httpMetadata = { ...(sourceObject.httpMetadata || {}) };
    if (!httpMetadata.contentType) httpMetadata.contentType = contentType;
    await publishBucket.put(destKey, sourceObject.body, { httpMetadata });
    publishedAssets.push({
      kind: asset.kind,
      path: destKey,
      filename: safeFilename,
      contentType: httpMetadata.contentType || contentType,
      size: sourceObject.size,
    });
    publishedPaths.push(destKey);
  }

  const manifest: StudyGuideManifest = {
    code,
    title: lectureTitle,
    publishedAt,
    assets: publishedAssets,
    lifecycleStatus: "published",
    review: {
      status: "approved",
      reviewedAt: publishedAt,
      reviewedBy: {
        userId: actor.userId,
        email: actor.email,
        displayName: actor.displayName,
        role: actor.role,
      },
      notes: typeof (body as any).reviewNotes === "string" ? (body as any).reviewNotes.trim() || undefined : undefined,
    },
    provenance: {
      institutionId: actor.institutionId || config.institutionId,
      sourceStoredKey: storedKey,
      sourceLectureId: docId || undefined,
      sourceLectureTitle: lectureTitle || undefined,
      generatedFrom: "lecture_materials",
    },
    qualitySignals: {
      validationPassed: true,
      needsReview: false,
      missingSourceMapping: false,
      incompleteExtraction: false,
    },
  };
  if (docId) manifest.docId = docId;
  if (mode) manifest.mode = mode;

  const manifestKey = buildStudyGuideManifestKey(code);
  await publishBucket.put(manifestKey, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  publishedPaths.unshift(manifestKey);

  if (env.DOCS_KV) {
    await env.DOCS_KV.put(`studyguide:${code}`, JSON.stringify({ manifestKey, manifest }));
    await env.DOCS_KV.put(buildStudyGuideSourceMappingKey(storedKey), JSON.stringify({ code, manifestKey }));
  }

  if (docId) {
    await persistStudyGuidePublishRecord(env, {
      docId,
      code,
      publishedAt,
      manifestKey,
      storedKey,
      title: lectureTitle,
    });
    await upsertLibraryIndexRecord(env, {
      docId,
      institutionId: actor.institutionId || config.institutionId,
      ownerUserId: actor.userId,
      bucket: LIBRARY_BUCKET,
      key: storedKey,
      title: lectureTitle,
      hashBasis: storedKey,
      normalizedTokens: tokensFromTitle(lectureTitle || storedKey),
      studyGuideStatus: "published",
      studyGuideReviewedAt: publishedAt,
      studyGuideReviewedBy: actor.email,
    });
  }

  await writeAuditEvent(env, req, getRequestId(req), {
    event: "artifact.publish.study_guide",
    outcome: "success",
    actor: buildAuditActor(actor),
    metadata: { code, docId: docId || null, mode, storedKey, publishedPaths },
  });
  await recordMetricEvent(env, {
    name: "artifact_published",
    requestId: getRequestId(req),
    artifactType: "study_guide",
    artifactCode: code,
    institutionId: actor.institutionId || config.institutionId,
    lectureId: docId || undefined,
    userId: actor.userId,
    role: actor.role,
    metadata: {
      mode,
      storedKey,
      assetCount: publishedAssets.length,
      lifecycleStatus: manifest.lifecycleStatus,
    },
  });

  return jsonNoStore({ code, manifest, manifestKey, publishedPaths });
}

async function copyAnkiMediaAssets(bucket: R2Bucket, sourcePrefix: string, destPrefix: string) {
  const copied: string[] = [];
  const normalizedSource = sourcePrefix.replace(/\/+$/, "") + "/";
  const normalizedDest = destPrefix.replace(/\/+$/, "");
  let cursor: string | undefined;
  try {
    do {
      const page = await bucket.list({ prefix: normalizedSource, cursor, limit: 1000 });
      for (const obj of page.objects ?? []) {
        const key = obj.key || "";
        if (!key.startsWith(normalizedSource)) continue;
        const leaf = key.slice(normalizedSource.length);
        if (!leaf) continue;
        const sourceObj = await bucket.get(key);
        if (!sourceObj || !sourceObj.body) continue;
        const destKey = `${normalizedDest}/${leaf}`;
        await bucket.put(destKey, sourceObj.body, {
          httpMetadata: sourceObj.httpMetadata || undefined,
        });
        copied.push(destKey);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } catch {
    return copied;
  }
  return copied;
}

async function handlePublishAnki(req: Request, env: Env): Promise<Response> {
  const auth = await requireFaculty(req, env, "anki_publish");
  if (!auth.ok) return auth.response;
  const actor = auth.context.session;
  const config = getAppConfig(env, req);
  const body = await readRequestJsonBody(req);
  if (!body || typeof body !== "object") {
    return jsonNoStore({ error: "Send JSON { ankiKey, lectureTitle?, docId? }." }, 400);
  }

  const ankiPayload = isPlainObject((body as any).anki) ? (body as any).anki as Record<string, unknown> : null;
  const ankiKey =
    (typeof (body as any).ankiKey === "string" ? (body as any).ankiKey.trim() : "") ||
    (typeof (body as any).storedKey === "string" ? (body as any).storedKey.trim() : "") ||
    (typeof (body as any).key === "string" ? (body as any).key.trim() : "") ||
    (typeof ankiPayload?.key === "string" ? ankiPayload.key.trim() : "");
  if (!ankiKey) {
    return jsonNoStore({ error: "Missing ankiKey for Anki deck." }, 400);
  }
  if (!ankiKey.startsWith(`${ANKI_DECKS_PREFIX}/`)) {
    return jsonNoStore({ error: "Invalid ankiKey prefix." }, 400);
  }

  const lectureTitleRaw =
    typeof (body as any).lectureTitle === "string"
      ? (body as any).lectureTitle
      : typeof (body as any).title === "string"
        ? (body as any).title
        : "";
  const lectureTitle = normalizeLectureTitle(lectureTitleRaw);
  const docId =
    typeof (body as any).docId === "string"
      ? (body as any).docId.trim()
      : typeof (body as any).lectureId === "string"
        ? (body as any).lectureId.trim()
        : "";

  const existingPublish = await loadPublishedAnkiBySource(env, ankiKey);
  if (existingPublish) {
    const existingDocId =
      docId ||
      (typeof existingPublish.manifest?.lectureId === "string" ? existingPublish.manifest.lectureId.trim() : "");
    const publishedAt =
      typeof existingPublish.manifest?.publishedAt === "string"
        ? existingPublish.manifest.publishedAt
        : typeof existingPublish.manifest?.createdAt === "string"
          ? existingPublish.manifest.createdAt
          : new Date().toISOString();
    const title =
      typeof existingPublish.manifest?.lectureTitle === "string"
        ? existingPublish.manifest.lectureTitle
        : lectureTitle;
    const storedPublishedKey = typeof existingPublish.manifest?.ankiKey === "string"
      ? existingPublish.manifest.ankiKey
      : "";
    if (existingDocId && storedPublishedKey) {
      await persistAnkiPublishRecord(env, {
        docId: existingDocId,
        code: existingPublish.code,
        publishedAt,
        manifestKey: existingPublish.manifestKey,
        ankiKey: storedPublishedKey,
        storedKey: ankiKey,
        title,
      });
    }
    await writeAuditEvent(env, req, getRequestId(req), {
      event: "artifact.publish.anki",
      outcome: "success",
      actor: buildAuditActor(actor),
      metadata: { code: existingPublish.code, docId: existingDocId || docId || null, idempotent: true },
    });
    await recordMetricEvent(env, {
      name: "artifact_published",
      requestId: getRequestId(req),
      artifactType: "anki",
      artifactCode: existingPublish.code,
      institutionId: actor.institutionId || config.institutionId,
      lectureId: existingDocId || docId || undefined,
      userId: actor.userId,
      role: actor.role,
      metadata: { idempotent: true },
    });
    return jsonNoStore(existingPublish);
  }

  const { bucket } = getLibraryBucket(env);
  const sourceObject = await bucket.get(ankiKey);
  if (!sourceObject || !sourceObject.body) {
    return jsonNoStore({ error: "Missing Anki deck TSV." }, 404);
  }

  const sourceCode = extractAnkiCodeFromKey(ankiKey);
  const sourceManifest = sourceCode ? await loadAnkiManifest(env, sourceCode) : null;

  let code = "";
  try {
    code = await generateUniqueAnkiCode(env);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unable to generate a unique access code.";
    return jsonNoStore({ error: message }, 500);
  }

  const destKey = buildAnkiCardsKey(code);
  const httpMetadata = { ...(sourceObject.httpMetadata || {}) } as Record<string, string>;
  if (!httpMetadata.contentType) {
    httpMetadata.contentType = "text/tab-separated-values; charset=utf-8";
  }
  await bucket.put(destKey, sourceObject.body, { httpMetadata });

  const publishedPaths: string[] = [destKey];
  let mediaPrefix = "";
  if (sourceManifest?.mediaPrefix) {
    const copied = await copyAnkiMediaAssets(bucket, sourceManifest.mediaPrefix, buildAnkiMediaPrefix(code));
    if (copied.length) {
      mediaPrefix = buildAnkiMediaPrefix(code);
      publishedPaths.push(...copied);
    }
  }

  const publishedAt = new Date().toISOString();
  const manifest: AnkiManifest = {
    code,
    ankiKey: destKey,
    lectureTitle: lectureTitle || sourceManifest?.lectureTitle,
    lectureId: docId || sourceManifest?.lectureId,
    createdAt: sourceManifest?.createdAt || publishedAt,
    publishedAt,
    createdBy: resolveAnkiCreatedBy(req),
    imageCount: sourceManifest?.imageCount,
    hasBoldmap: sourceManifest?.hasBoldmap,
    hasClassmateDeck: sourceManifest?.hasClassmateDeck,
    mediaPrefix: mediaPrefix || undefined,
    lifecycleStatus: "published",
    review: {
      status: "approved",
      reviewedAt: publishedAt,
      reviewedBy: {
        userId: actor.userId,
        email: actor.email,
        displayName: actor.displayName,
        role: actor.role,
      },
      notes: typeof (body as any).reviewNotes === "string" ? (body as any).reviewNotes.trim() || undefined : undefined,
    },
    provenance: {
      institutionId: actor.institutionId || config.institutionId,
      sourceStoredKey: ankiKey,
      sourceLectureId: docId || sourceManifest?.lectureId,
      sourceLectureTitle: lectureTitle || sourceManifest?.lectureTitle,
      sourceManifestKey: sourceCode ? buildAnkiManifestKey(sourceCode) : undefined,
      generatedFrom: "lecture_materials",
    },
    qualitySignals: {
      validationPassed: true,
      needsReview: false,
      missingSourceMapping: false,
      incompleteExtraction: false,
    },
  };
  try {
    await persistAnkiManifest(env, manifest);
  } catch (err) {
    return jsonNoStore({ error: "Unable to store Anki manifest." }, 500);
  }
  const manifestKey = buildAnkiManifestKey(code);
  publishedPaths.unshift(manifestKey);

  if (env.DOCS_KV) {
    await env.DOCS_KV.put(buildAnkiSourceMappingKey(ankiKey), JSON.stringify({ code, manifestKey, ankiKey: destKey }));
  }

  if (docId) {
    await persistAnkiPublishRecord(env, {
      docId,
      code,
      publishedAt,
      manifestKey,
      ankiKey: destKey,
      storedKey: ankiKey,
      title: lectureTitle || sourceManifest?.lectureTitle,
    });
    await upsertLibraryIndexRecord(env, {
      docId,
      institutionId: actor.institutionId || config.institutionId,
      ownerUserId: actor.userId,
      bucket: LIBRARY_BUCKET,
      key: ankiKey,
      title: lectureTitle || sourceManifest?.lectureTitle || ankiKey,
      hashBasis: ankiKey,
      normalizedTokens: tokensFromTitle(lectureTitle || sourceManifest?.lectureTitle || ankiKey),
      ankiStatus: "published",
      ankiReviewedAt: publishedAt,
      ankiReviewedBy: actor.email,
    });
  }

  await writeAuditEvent(env, req, getRequestId(req), {
    event: "artifact.publish.anki",
    outcome: "success",
    actor: buildAuditActor(actor),
    metadata: { code, docId: docId || null, ankiKey, publishedPaths },
  });
  await recordMetricEvent(env, {
    name: "artifact_published",
    requestId: getRequestId(req),
    artifactType: "anki",
    artifactCode: code,
    institutionId: actor.institutionId || config.institutionId,
    lectureId: docId || undefined,
    userId: actor.userId,
    role: actor.role,
    metadata: {
      sourceAnkiKey: ankiKey,
      lifecycleStatus: manifest.lifecycleStatus,
      hasMedia: Boolean(mediaPrefix),
    },
  });

  return jsonNoStore({ code, manifest, manifestKey, publishedPaths });
}

async function loadStudyGuideManifest(env: Env, code: string): Promise<StudyGuideManifest | null> {
  if (!isStudyGuideCodeValid(code)) return null;
  if (env.DOCS_KV) {
    const cached = await env.DOCS_KV.get(`studyguide:${code}`, { type: "json" }) as any;
    if (cached && typeof cached === "object") {
      if (cached.manifest && typeof cached.manifest === "object") {
        return cached.manifest as StudyGuideManifest;
      }
      if (typeof cached.manifestKey === "string") {
        try {
          const { bucket } = getPublishBucket(env);
          const obj = await bucket.get(cached.manifestKey);
          if (obj && obj.body) {
            const text = await obj.text();
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === "object") return parsed as StudyGuideManifest;
          }
        } catch {}
      }
    }
  }
  try {
    const { bucket } = getPublishBucket(env);
    const obj = await bucket.get(buildStudyGuideManifestKey(code));
    if (!obj || !obj.body) return null;
    const text = await obj.text();
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed as StudyGuideManifest;
  } catch {
    return null;
  }
  return null;
}

function buildPublishedPathsFromManifest(code: string, manifest: StudyGuideManifest) {
  const manifestKey = buildStudyGuideManifestKey(code);
  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  const publishedPaths = [manifestKey, ...assets.map(asset => asset.path)];
  return { manifestKey, publishedPaths };
}

async function loadPublishedStudyGuideBySource(env: Env, storedKey: string) {
  if (!env.DOCS_KV) return null;
  const cached = await env.DOCS_KV.get(buildStudyGuideSourceMappingKey(storedKey), { type: "json" }) as any;
  const rawCode = typeof cached?.code === "string" ? cached.code : "";
  const code = normalizeStudyGuideCode(rawCode);
  if (!isStudyGuideCodeValid(code)) return null;
  const manifest = await loadStudyGuideManifest(env, code);
  if (!manifest) return null;
  const { manifestKey, publishedPaths } = buildPublishedPathsFromManifest(code, manifest);
  return { code, manifest, manifestKey, publishedPaths };
}

function buildPublishedDownloadUrl(asset: StudyGuidePublishedAsset) {
  const filename = asset.filename || asset.path.split("/").pop() || "download";
  const path = typeof asset.path === "string" ? asset.path : "";
  const parts = path.split("/");
  const code = parts.length > 1 ? (parts[1] || "") : "";
  return `/api/study-guides/asset?code=${encodeURIComponent(code)}&filename=${encodeURIComponent(filename)}`;
}

async function handleRetrieveStudyGuide(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const rawCode = url.searchParams.get("code") || "";
  const code = normalizeStudyGuideCode(rawCode);
  if (!isStudyGuideCodeValid(code)) {
    return jsonNoStore({ error: "Invalid access code." }, 400);
  }
  const manifest = await loadStudyGuideManifest(env, code);
  if (!manifest) {
    return jsonNoStore({ error: "Not found." }, 404);
  }
  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  const enrichedAssets = assets.map(asset => ({
    ...asset,
    downloadUrl: buildPublishedDownloadUrl(asset),
  }));
  return jsonNoStore({
    ...manifest,
    code,
    assets: enrichedAssets,
  });
}

async function handleStudyGuideAssetDownload(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const code = normalizeStudyGuideCode(url.searchParams.get("code") || "");
  const filename = sanitizeFilename(url.searchParams.get("filename") || "download");
  if (!isStudyGuideCodeValid(code)) {
    return jsonNoStore({ error: "Invalid access code." }, 400);
  }
  const manifest = await loadStudyGuideManifest(env, code);
  if (!manifest) {
    return jsonNoStore({ error: "Not found." }, 404);
  }
  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  const asset = assets.find(entry => entry.filename === filename) || assets.find(entry => entry.path.endsWith(`/${filename}`));
  if (!asset) {
    return jsonNoStore({ error: "Asset not found." }, 404);
  }
  const { bucket } = getPublishBucket(env);
  const object = await bucket.get(asset.path);
  if (!object || !object.body) {
    return jsonNoStore({ error: "Asset not found." }, 404);
  }
  await recordMetricEvent(env, {
    name: "artifact_opened",
    requestId: getRequestId(req),
    artifactType: "study_guide",
    artifactCode: code,
    institutionId: manifest.provenance?.institutionId,
    lectureId: manifest.docId || manifest.provenance?.sourceLectureId,
    metadata: {
      filename: asset.filename,
      contentType: asset.contentType || object.httpMetadata?.contentType,
    },
  });
  return new Response(object.body, {
    headers: {
      "Content-Type": asset.contentType || object.httpMetadata?.contentType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${sanitizeFilename(asset.filename || filename)}"`,
    },
  });
}

function normalizeAnkiCode(value: string) {
  return (value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isAnkiCodeValid(code: string) {
  if (!code) return false;
  if (code.length < 6 || code.length > 10) return false;
  for (const ch of code) {
    if (!ANKI_CODE_ALPHABET.includes(ch)) return false;
  }
  return true;
}

function buildAnkiDeckPrefix(code: string) {
  return `${ANKI_DECKS_PREFIX}/${code}`;
}

function buildAnkiCardsKey(code: string) {
  return `${buildAnkiDeckPrefix(code)}/${ANKI_CARDS_FILENAME}`;
}

function buildAnkiManifestKey(code: string) {
  return `${buildAnkiDeckPrefix(code)}/${ANKI_MANIFEST_FILENAME}`;
}

function buildAnkiMediaPrefix(code: string) {
  return `${buildAnkiDeckPrefix(code)}/${ANKI_MEDIA_PREFIX}`;
}

function buildAnkiManifestKvKey(code: string) {
  return `anki:${code}`;
}

function extractAnkiCodeFromKey(key: string) {
  if (!key) return "";
  const parts = key.split("/").filter(Boolean);
  if (parts.length < 2) return "";
  if (parts[0] !== ANKI_DECKS_PREFIX) return "";
  const code = normalizeAnkiCode(parts[1] || "");
  return isAnkiCodeValid(code) ? code : "";
}

function buildAnkiLectureId(lectureTitle: string) {
  const safeTitle = sanitizeMachineSlug(lectureTitle || "", "lecture");
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  return `01_${safeTitle}_${stamp}`;
}

function normalizeAnkiLectureId(raw: string, lectureTitle: string) {
  const cleaned = sanitizeMachineSlug(raw || "", "");
  if (cleaned) return cleaned;
  return buildAnkiLectureId(lectureTitle);
}

function buildHumanReadableAnkiLectureLabel(lectureTitle: string, lectureId: string) {
  const cleanedTitle = normalizeLectureTitle(lectureTitle || "");
  if (cleanedTitle && cleanedTitle !== "Lecture") return cleanedTitle;
  const humanized = (lectureId || "Lecture")
    .replace(/^\d+[_-]?/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\d{8,}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return humanized || "Lecture";
}

function buildAnkiPrompt(opts: {
  lectureSlug: string;
  lectureLabel: string;
  lectureTagRoot: string;
  targetCardCount: number;
}) {
  let prompt = ANKI_PROMPT_TEMPLATE;
  const replacements: Record<string, string> = {
    "{{LECTURE_SLUG}}": opts.lectureSlug,
    "{{LECTURE_LABEL}}": opts.lectureLabel,
    "{{LECTURE_TAG_ROOT}}": opts.lectureTagRoot,
    "{{TARGET_CARD_COUNT}}": String(opts.targetCardCount),
  };
  for (const [key, value] of Object.entries(replacements)) {
    prompt = prompt.split(key).join(value);
  }
  return prompt;
}

function coerceAnkiManifest(raw: unknown): AnkiManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const code = normalizeAnkiCode(typeof (raw as any).code === "string" ? (raw as any).code : "");
  if (!isAnkiCodeValid(code)) return null;
  const ankiKey = typeof (raw as any).ankiKey === "string" ? (raw as any).ankiKey.trim() : "";
  if (!ankiKey) return null;
  const createdAt = typeof (raw as any).createdAt === "string" ? (raw as any).createdAt : "";
  if (!createdAt) return null;
  const publishedAt = typeof (raw as any).publishedAt === "string" ? (raw as any).publishedAt : undefined;
  const lectureTitle = typeof (raw as any).lectureTitle === "string" ? (raw as any).lectureTitle : undefined;
  const lectureId = typeof (raw as any).lectureId === "string" ? (raw as any).lectureId : undefined;
  const createdBy = typeof (raw as any).createdBy === "string" ? (raw as any).createdBy : undefined;
  const imageCountRaw = Number((raw as any).imageCount);
  const imageCount = Number.isFinite(imageCountRaw) ? imageCountRaw : undefined;
  const hasBoldmap = typeof (raw as any).hasBoldmap === "boolean" ? (raw as any).hasBoldmap : undefined;
  const hasClassmateDeck =
    typeof (raw as any).hasClassmateDeck === "boolean" ? (raw as any).hasClassmateDeck : undefined;
  const mediaPrefix = typeof (raw as any).mediaPrefix === "string" ? (raw as any).mediaPrefix : undefined;
  return {
    code,
    ankiKey,
    lectureTitle,
    lectureId,
    createdAt,
    publishedAt,
    createdBy,
    imageCount,
    hasBoldmap,
    hasClassmateDeck,
    mediaPrefix,
  };
}

async function persistAnkiManifest(env: Env, manifest: AnkiManifest) {
  const code = normalizeAnkiCode(manifest.code || "");
  if (!isAnkiCodeValid(code)) return;
  const record: AnkiManifest = {
    ...manifest,
    code,
  };
  const { bucket } = getLibraryBucket(env);
  await bucket.put(buildAnkiManifestKey(code), JSON.stringify(record, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  if (env.DOCS_KV) {
    await env.DOCS_KV.put(buildAnkiManifestKvKey(code), JSON.stringify(record));
  }
}

async function loadAnkiManifest(env: Env, code: string): Promise<AnkiManifest | null> {
  if (!isAnkiCodeValid(code)) return null;
  if (env.DOCS_KV) {
    const cached = await env.DOCS_KV.get(buildAnkiManifestKvKey(code), { type: "json" }) as any;
    const parsed = coerceAnkiManifest(cached);
    if (parsed) return parsed;
  }
  try {
    const { bucket } = getLibraryBucket(env);
    const obj = await bucket.get(buildAnkiManifestKey(code));
    if (!obj || !obj.body) return null;
    const text = await obj.text();
    const parsed = coerceAnkiManifest(JSON.parse(text));
    if (!parsed) return null;
    if (env.DOCS_KV) {
      await env.DOCS_KV.put(buildAnkiManifestKvKey(code), JSON.stringify(parsed));
    }
    return parsed;
  } catch {
    return null;
  }
}

async function isAnkiCodeAvailable(env: Env, rawCode: string) {
  const code = normalizeAnkiCode(rawCode);
  if (!isAnkiCodeValid(code)) return false;
  if (env.DOCS_KV) {
    const existing = await env.DOCS_KV.get(buildAnkiManifestKvKey(code));
    if (existing) return false;
  }
  const { bucket } = getLibraryBucket(env);
  const head = await bucket.head(buildAnkiManifestKey(code));
  return !head;
}

async function generateUniqueAnkiCode(env: Env) {
  const lengths = [ANKI_CODE_LENGTH, ANKI_CODE_LENGTH + 2, ANKI_CODE_LENGTH + 4];
  for (const length of lengths) {
    for (let attempt = 0; attempt < ANKI_CODE_MAX_ATTEMPTS; attempt += 1) {
      const code = generateStudyGuideCode(length);
      if (await isAnkiCodeAvailable(env, code)) return code;
    }
  }
  throw new Error("Unable to generate a unique access code.");
}

type AnkiErrorStage = "parse_form" | "validate_type" | "preprocess" | "openai" | "package" | "respond";

function resolveAnkiRequestId(req: Request) {
  const header = req.headers.get("x-request-id") || req.headers.get("x-owen-request-id") || "";
  if (header && header.trim()) return header.trim();
  return getRequestId(req);
}

function logAnkiStage(requestId: string, stage: AnkiErrorStage, startMs: number, extra?: Record<string, unknown>) {
  const elapsedMs = Date.now() - startMs;
  console.log("[ANKI]", { requestId, stage, ms: elapsedMs, ...extra });
}

function ankiErrorResponse(
  requestId: string,
  stage: AnkiErrorStage,
  status: number,
  message: string,
  debugCode?: string,
  extra?: Record<string, unknown>,
) {
  const payload: Record<string, unknown> = { error: message, requestId, stage };
  if (debugCode) payload.debugCode = debugCode;
  if (extra && typeof extra === "object") {
    Object.assign(payload, extra);
  }
  return jsonNoStore(payload, status);
}

class AnkiInputError extends Error {
  status: number;
  debugCode: string;
  stage: AnkiErrorStage;
  details?: Record<string, unknown>;

  constructor(
    message: string,
    opts: { status?: number; debugCode: string; stage?: AnkiErrorStage; details?: Record<string, unknown> },
  ) {
    super(message);
    this.status = opts.status ?? 422;
    this.debugCode = opts.debugCode;
    this.stage = opts.stage ?? "validate_type";
    this.details = opts.details;
  }
}

type AnkiImageUploadFailureKind = "transient" | "permanent";
type AnkiImageUploadPhase = "openai_request" | "openai_parse";

class AnkiImageUploadError extends Error {
  kind: AnkiImageUploadFailureKind;
  status?: number;
  openaiRequestId?: string;
  attempt: number;
  elapsedMs: number;
  phase: AnkiImageUploadPhase;
  imageFilename?: string;

  constructor(
    message: string,
    opts: {
      kind: AnkiImageUploadFailureKind;
      status?: number;
      openaiRequestId?: string;
      attempt: number;
      elapsedMs: number;
      phase: AnkiImageUploadPhase;
      imageFilename?: string;
    },
  ) {
    super(message);
    this.kind = opts.kind;
    this.status = opts.status;
    this.openaiRequestId = opts.openaiRequestId;
    this.attempt = opts.attempt;
    this.elapsedMs = opts.elapsedMs;
    this.phase = opts.phase;
    this.imageFilename = opts.imageFilename;
  }
}

function isAnkiInputError(err: unknown): err is AnkiInputError {
  return err instanceof AnkiInputError;
}

function isAnkiImageUploadError(err: unknown): err is AnkiImageUploadError {
  return err instanceof AnkiImageUploadError;
}

class AnkiPipelineError extends Error {
  stage: AnkiErrorStage;
  status: number;
  debugCode: string;
  details?: Record<string, unknown>;

  constructor(
    message: string,
    opts: { stage: AnkiErrorStage; status: number; debugCode: string; details?: Record<string, unknown> },
  ) {
    super(message);
    this.stage = opts.stage;
    this.status = opts.status;
    this.debugCode = opts.debugCode;
    this.details = opts.details;
  }
}

function isAnkiPipelineError(err: unknown): err is AnkiPipelineError {
  return err instanceof AnkiPipelineError;
}

function summarizeAnkiUpload(file: File | null) {
  if (!file) return null;
  return {
    name: file.name || "file",
    type: file.type || "",
    size: typeof file.size === "number" ? file.size : 0,
  };
}

function buildAnkiReceivedDebug(opts: {
  pdfFile: File | null;
  slideImageEntries: unknown[];
  slideImageFiles: File[];
  transcriptFile: File | null;
  transcriptText?: string;
  contentTypeHeader: string;
  targetCardMinRaw?: string;
  targetCardMaxRaw?: string;
  targetCardOverrideRaw?: string;
  coverageModeRaw?: string;
  guaranteeCoverageRaw?: string;
}) {
  const firstImage = opts.slideImageFiles[0] || null;
  const transcriptText = typeof opts.transcriptText === "string" ? opts.transcriptText : "";
  return {
    slidesPdf: summarizeAnkiUpload(opts.pdfFile),
    slideImagesCount: opts.slideImageEntries.length,
    slideImagesFirst: summarizeAnkiUpload(firstImage),
    transcriptTxt: summarizeAnkiUpload(opts.transcriptFile),
    transcriptTextLength: transcriptText ? transcriptText.length : 0,
    targetCardMin: opts.targetCardMinRaw || "",
    targetCardMax: opts.targetCardMaxRaw || "",
    targetCardOverride: opts.targetCardOverrideRaw || "",
    coverageMode: opts.coverageModeRaw || "",
    guaranteeCoverage: opts.guaranteeCoverageRaw || "",
    contentTypeHeader: opts.contentTypeHeader,
  };
}

function ankiValidationError(
  requestId: string,
  status: number,
  message: string,
  debugCode: string,
  received: ReturnType<typeof buildAnkiReceivedDebug>,
) {
  return ankiErrorResponse(requestId, "validate_type", status, message, debugCode, { received });
}

type AnkiGenerationSettings = {
  targetCardMin?: number;
  targetCardMax?: number;
  targetCardOverride?: number;
  requestedRange: { min: number; max: number };
  coverageMode: AnkiCoverageMode;
  guaranteeCoverage: boolean;
};

type AnkiAttachmentIds = {
  classmateId: string;
  boldmapId: string;
  pdfId: string;
};

type AnkiRepairContext = {
  lectureId: string;
  lectureLabel: string;
  lectureTagRoot: string;
  numberedTranscript: string;
  slideLedgerText: string;
  attachments: AnkiAttachmentIds;
};

type AnkiGenerationPassResult = {
  cards: AnkiStructuredCard[];
  lintReport: AnkiLintReport;
  repairApplied: boolean;
  rawOutput: string;
  outputTextLength: number;
};

function parseOptionalAnkiIntegerField(
  raw: string,
  opts: { fieldLabel: string; debugCode: string; minimum: number; maximum: number },
) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return { value: undefined };
  if (!/^\d+$/.test(trimmed)) {
    return { error: `${opts.fieldLabel} must be an integer between ${opts.minimum} and ${opts.maximum}.`, debugCode: opts.debugCode };
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value) || value < opts.minimum || value > opts.maximum) {
    return { error: `${opts.fieldLabel} must be between ${opts.minimum} and ${opts.maximum}.`, debugCode: opts.debugCode };
  }
  return { value };
}

function parseBooleanishField(raw: string, opts: { fieldLabel: string; debugCode: string }) {
  const trimmed = (raw || "").trim().toLowerCase();
  if (!trimmed) return { value: false };
  if (["true", "1", "yes", "on"].includes(trimmed)) return { value: true };
  if (["false", "0", "no", "off"].includes(trimmed)) return { value: false };
  return { error: `${opts.fieldLabel} must be true or false.`, debugCode: opts.debugCode };
}

function parseAnkiGenerationSettings(opts: {
  targetCardMinRaw: string;
  targetCardMaxRaw: string;
  targetCardOverrideRaw: string;
  coverageModeRaw: string;
  guaranteeCoverageRaw: string;
}) {
  const minResult = parseOptionalAnkiIntegerField(opts.targetCardMinRaw, {
    fieldLabel: "targetCardMin",
    debugCode: "anki_target_card_min_invalid",
    minimum: ANKI_ABSOLUTE_CARD_MIN,
    maximum: ANKI_ABSOLUTE_CARD_MAX,
  });
  if (minResult.error) return minResult;
  const maxResult = parseOptionalAnkiIntegerField(opts.targetCardMaxRaw, {
    fieldLabel: "targetCardMax",
    debugCode: "anki_target_card_max_invalid",
    minimum: ANKI_ABSOLUTE_CARD_MIN,
    maximum: ANKI_ABSOLUTE_CARD_MAX,
  });
  if (maxResult.error) return maxResult;
  const overrideResult = parseOptionalAnkiIntegerField(opts.targetCardOverrideRaw, {
    fieldLabel: "targetCardOverride",
    debugCode: "anki_target_card_override_invalid",
    minimum: ANKI_ABSOLUTE_CARD_MIN,
    maximum: ANKI_ABSOLUTE_CARD_MAX,
  });
  if (overrideResult.error) return overrideResult;
  const coverageModeRaw = (opts.coverageModeRaw || "").trim().toLowerCase();
  let coverageMode: AnkiCoverageMode;
  if (coverageModeRaw === "full") {
    coverageMode = "full";
  } else if (coverageModeRaw === "" || coverageModeRaw === "balanced") {
    coverageMode = ANKI_DEFAULT_COVERAGE_MODE;
  } else {
    return {
      error: 'coverageMode must be "balanced" or "full".',
      debugCode: "anki_coverage_mode_invalid",
    };
  }
  const guaranteeResult = parseBooleanishField(opts.guaranteeCoverageRaw, {
    fieldLabel: "guaranteeCoverage",
    debugCode: "anki_guarantee_coverage_invalid",
  });
  if (guaranteeResult.error) return guaranteeResult;
  const targetCardMin = minResult.value;
  const targetCardMax = maxResult.value;
  const requestedRange = {
    min: targetCardMin ?? ANKI_DEFAULT_CARD_MIN,
    max: targetCardMax ?? ANKI_DEFAULT_CARD_MAX,
  };
  if (requestedRange.min > requestedRange.max) {
    return {
      error: "targetCardMin cannot exceed targetCardMax.",
      debugCode: "anki_target_card_range_invalid",
    };
  }
  const targetCardOverride = Number.isFinite(overrideResult.value)
    ? clampCardTargetToRange(Number(overrideResult.value), requestedRange)
    : undefined;
  const guaranteeCoverage = guaranteeResult.value ?? false;
  return {
    value: {
      targetCardMin,
      targetCardMax,
      targetCardOverride,
      requestedRange,
      coverageMode,
      guaranteeCoverage,
    } satisfies AnkiGenerationSettings,
  };
}

function buildAnkiRepairPrompt(opts: {
  lectureLabel: string;
  lectureTagRoot: string;
  failedNotes: Array<{ index: number; note: AnkiStructuredCard; issues: string[] }>;
  numberedTranscript: string;
  slideLedgerText: string;
}) {
  const failuresJson = JSON.stringify(
    opts.failedNotes.map(entry => ({
      index: entry.index,
      issues: entry.issues,
      note: entry.note,
    })),
    null,
    2,
  );
  return [
    "You are repairing Anki notes that failed backend lint.",
    "Return JSON only matching the strict anki_cards_v2 schema.",
    "Return exactly the same number of notes you received, in the same order.",
    "Keep the factual content whenever possible, but repair structure and formatting so every note passes lint.",
    `Every repaired note must use lectureId="${opts.lectureLabel}" and include tag root "${opts.lectureTagRoot}".`,
    "Required repairs:",
    "- declarative cloze text, not question-style",
    "- underline the anchor concept with <u>...</u>",
    "- every cloze must have a standardized non-leaking hint",
    "- max 2 clozes; default one contiguous cloze",
    "- source required and formatted as Page:Pn and/or Transcript:Lx-Ly",
    "- list cards must hide the list items, never only the number",
    "- difficulty must be easy, medium, or hard",
    "- ess must be an integer",
    "",
    "FAILED_NOTES_JSON:",
    failuresJson,
    "",
    "NUMBERED_TRANSCRIPT:",
    opts.numberedTranscript,
    "",
    "SLIDE_LEDGER:",
    opts.slideLedgerText,
  ].join("\n");
}

function buildAnkiQualityPayload(opts: {
  ledger: ReturnType<typeof buildSlideLedger>;
  lintReport: AnkiLintReport;
  notes: AnkiStructuredCard[];
  repairApplied: boolean;
  requestedTarget: number;
  targetDecision?: { B: number; S: number; N_final: number };
  coverageLimitedByMax: boolean;
  coverageFillAttempted: boolean;
  coverageFillSucceeded: boolean;
  coverageFillErrorStage?: string;
  coverageFillErrorCode?: string;
  coverageDegraded: boolean;
  coverageTelemetryAvailable: boolean;
  coverageTelemetryReason?: string;
  targetCardOverrideUsed: boolean;
  noTextFallbackTarget?: number;
  noTextBatchingUsed: boolean;
}) {
  const coverage = computeAnkiCoverageStats(opts.ledger, opts.notes);
  return {
    targetDecision: opts.targetDecision || opts.ledger.targetDecision,
    requestedRange: opts.ledger.requestedRange,
    requestedTarget: opts.requestedTarget,
    finalCardCount: opts.notes.length,
    autoTarget: opts.ledger.autoTarget,
    coverageFloor: opts.ledger.coverageFloor,
    blueprintObjectiveCoveragePercent: coverage.blueprintObjectiveCoveragePercent,
    objectivePagesDetected: coverage.objectivePagesDetected,
    objectivePagesCovered: coverage.objectivePagesCovered,
    substantivePagesDetected: coverage.substantivePagesDetected.length,
    substantivePagesCovered: coverage.substantivePagesCovered.length,
    substantivePageRefsDetected: coverage.substantivePagesDetected,
    substantivePageRefsCovered: coverage.substantivePagesCovered,
    substantiveCoveragePercent: coverage.substantiveCoveragePercent,
    uncitedSubstantivePages: coverage.uncitedSubstantivePages,
    coverageLimitedByMax: opts.coverageLimitedByMax,
    coverageFillAttempted: opts.coverageFillAttempted,
    coverageFillSucceeded: opts.coverageFillSucceeded,
    coverageFillErrorStage: opts.coverageFillErrorStage,
    coverageFillErrorCode: opts.coverageFillErrorCode,
    coverageDegraded: opts.coverageDegraded,
    coverageTelemetryAvailable: opts.coverageTelemetryAvailable,
    coverageTelemetryReason: opts.coverageTelemetryReason,
    targetCardOverrideUsed: opts.targetCardOverrideUsed,
    noTextFallbackTarget: opts.noTextFallbackTarget,
    noTextBatchingUsed: opts.noTextBatchingUsed,
    pagesSkipped: opts.ledger.skippedPages,
    lint: opts.lintReport.stats,
    repairApplied: opts.repairApplied,
  };
}

function pushUniqueAnkiWarning(warnings: string[], code: string) {
  if (!warnings.includes(code)) warnings.push(code);
}

function buildAnkiExistingCardIndex(notes: AnkiStructuredCard[]) {
  const existingCardIndex = notes
    .map((note, index) => {
      const preview = normalizePlainText(String(note.text || "")).slice(0, 180);
      return `${index + 1}. source=${note.source} | text=${preview}`;
    })
    .join("\n");
  return existingCardIndex || "[none]";
}

function buildAnkiCoverageFillPrompt(opts: {
  lectureSlug: string;
  lectureLabel: string;
  lectureTagRoot: string;
  targetCardCount: number;
  ledger: ReturnType<typeof buildSlideLedger>;
  uncoveredPages: number[];
  existingNotes: AnkiStructuredCard[];
}) {
  const uncoveredPageTargets = opts.uncoveredPages
    .map(pageNumber => opts.ledger.pages.find(page => page.page === pageNumber))
    .filter((page): page is (typeof opts.ledger.pages)[number] => Boolean(page))
    .map(page => {
      const emphasis = page.emphasisTerms.length ? page.emphasisTerms.join(" | ") : "[none]";
      return `${page.citation} | title=${page.title} | emphasis=${emphasis} | excerpt=${page.excerpt || "[no extracted text]"}`;
    })
    .join("\n");
  return [
    buildAnkiPrompt({
      lectureSlug: opts.lectureSlug,
      lectureLabel: opts.lectureLabel,
      lectureTagRoot: opts.lectureTagRoot,
      targetCardCount: opts.targetCardCount,
    }),
    "",
    "FILL_PASS=true",
    "You are expanding an existing deck only for uncovered in-scope lecture content.",
    "Generate cards only for the UNCOVERED_PAGE_TARGETS listed below.",
    "Prefer one additional card per uncovered page before adding a second card to any page.",
    "Do not recreate facts already covered in EXISTING_CARD_INDEX unless a later uncovered page introduces a distinct examinable nuance.",
    "Do not cover skipped, administrative, reference, or explicitly excluded pages.",
    "All cards MUST follow the OWEN house-style schema:",
    "- <u>anchor</u> in text",
    "- cloze with hint",
    "- hint must be one of: concept, finding, mechanism, drug, organism, lab, number, list, diagnosis, therapy, anatomy, risk",
    "- source citation required",
    "- lecture tag root required",
    "- difficulty must be easy|medium|hard",
    "- ess must be integer.",
    "",
    "UNCOVERED_PAGE_TARGETS:",
    uncoveredPageTargets || "[none]",
    "",
    "EXISTING_CARD_INDEX:",
    buildAnkiExistingCardIndex(opts.existingNotes),
  ].join("\n");
}

function buildAnkiNoTextBatchPrompt(opts: {
  lectureSlug: string;
  lectureLabel: string;
  lectureTagRoot: string;
  targetCardCount: number;
  desiredTarget: number;
  batchNumber: number;
  existingNotes: AnkiStructuredCard[];
}) {
  return [
    buildAnkiPrompt({
      lectureSlug: opts.lectureSlug,
      lectureLabel: opts.lectureLabel,
      lectureTagRoot: opts.lectureTagRoot,
      targetCardCount: opts.targetCardCount,
    }),
    "",
    "NO_TEXT_FALLBACK_BATCH=true",
    `NO_TEXT_BATCH_NUMBER=${opts.batchNumber}`,
    `NO_TEXT_TOTAL_TARGET=${opts.desiredTarget}`,
    "Server-readable PDF text was unavailable for this lecture.",
    "Use the transcript, slides.pdf, slide images, and any uploaded boldmap/classmate deck to broaden coverage across distinct examinable concepts.",
    "Prefer broad coverage across the lecture before writing a second card for the same concept family.",
    "Do not recreate facts already covered in EXISTING_CARD_INDEX unless the new card captures a distinct examinable nuance.",
    "",
    "EXISTING_CARD_INDEX:",
    buildAnkiExistingCardIndex(opts.existingNotes),
  ].join("\n");
}

function buildAnkiBasePromptContent(opts: {
  prompt: string;
  slideLedger: ReturnType<typeof buildSlideLedger>;
  numberedTranscriptText: string;
  attachments: AnkiAttachmentIds;
  planningLines: string[];
  imageUploadFailed: boolean;
}) {
  const baseContent: ResponsesInputContent[] = [
    { type: "input_text", text: opts.prompt },
    { type: "input_text", text: opts.planningLines.join("\n") },
    { type: "input_text", text: `NUMBERED_TRANSCRIPT:\n${opts.numberedTranscriptText}` },
    { type: "input_text", text: `SLIDE_LEDGER:\n${opts.slideLedger.contextText}` },
  ];
  if (!opts.attachments.boldmapId && opts.slideLedger.fallbackBoldmapCsv) {
    baseContent.push({ type: "input_text", text: `BOLDMAP_FALLBACK_CSV:\n${opts.slideLedger.fallbackBoldmapCsv}` });
  }
  if (opts.slideLedger.skippedPages.length) {
    const skipped = opts.slideLedger.skippedPages.map(page => `Page:P${page.page} -> ${page.reason}`).join("\n");
    baseContent.push({ type: "input_text", text: `PAGES_SKIPPED:\n${skipped}` });
  }
  pushAnkiAttachmentInputs(baseContent, opts.attachments);
  if (opts.imageUploadFailed) {
    baseContent.push({
      type: "input_text",
      text: "IMAGE_ENRICHMENT_FAILED=true\nDo not include image HTML; proceed without slide images.",
    });
  }
  return baseContent;
}

function buildAnkiInputWithImages(opts: {
  baseContent: ResponsesInputContent[];
  imageUploads: Array<{ fileId: string; filename: string }>;
  hasPdfAttachment: boolean;
}) {
  const input: Array<{ role: "user"; content: ResponsesInputContent[] }> = [
    { role: "user", content: [...opts.baseContent] },
  ];
  if (!opts.imageUploads.length) {
    return input;
  }
  for (let i = 0; i < opts.imageUploads.length; i += ANKI_IMAGE_BATCH_SIZE) {
    const batch = opts.imageUploads.slice(i, i + ANKI_IMAGE_BATCH_SIZE);
    const batchContent: ResponsesInputContent[] = [];
    batch.forEach(upload => {
      batchContent.push({ type: "input_text", text: `IMAGE_FILENAME: ${upload.filename}` });
      batchContent.push({ type: "input_image", file_id: upload.fileId, detail: "high" });
    });
    if (!opts.hasPdfAttachment && i + ANKI_IMAGE_BATCH_SIZE >= opts.imageUploads.length) {
      batchContent.push({ type: "input_text", text: "ALL_SLIDE_IMAGES_RECEIVED=true" });
    }
    input.push({ role: "user", content: batchContent });
  }
  return input;
}

function mergeAnkiRepairResults(
  notes: AnkiStructuredCard[],
  repairedNotes: AnkiStructuredCard[],
  failedIndices: number[],
) {
  const merged = [...notes];
  failedIndices.forEach((noteIndex, repairIndex) => {
    const repaired = repairedNotes[repairIndex];
    if (repaired) {
      merged[noteIndex] = repaired;
    }
  });
  return merged;
}

function pushAnkiAttachmentInputs(content: ResponsesInputContent[], attachments: AnkiAttachmentIds) {
  if (attachments.classmateId) content.push({ type: "input_file", file_id: attachments.classmateId });
  if (attachments.boldmapId) content.push({ type: "input_file", file_id: attachments.boldmapId });
  if (attachments.pdfId) content.push({ type: "input_file", file_id: attachments.pdfId });
}

async function repairAnkiNotesIfNeeded(
  env: Env,
  cards: AnkiStructuredCard[],
  styleContext: AnkiHouseStyleContext,
  repairContext: AnkiRepairContext,
): Promise<{ cards: AnkiStructuredCard[]; lintReport: AnkiLintReport; repairApplied: boolean }> {
  let lintReport = lintAnkiNotes(cards, styleContext);
  if (lintReport.ok) {
    return { cards, lintReport, repairApplied: false };
  }
  const failedNotes = (lintReport.notes || [])
    .filter(note => note.issues.length)
    .map(note => ({
      index: note.index,
      note: note.note,
      issues: note.issues.map(issue => issue.code),
    }));
  const repairContent: ResponsesInputContent[] = [
    {
      type: "input_text",
      text: buildAnkiRepairPrompt({
        lectureLabel: repairContext.lectureLabel,
        lectureTagRoot: repairContext.lectureTagRoot,
        failedNotes,
        numberedTranscript: repairContext.numberedTranscript,
        slideLedgerText: repairContext.slideLedgerText,
      }),
    },
  ];
  pushAnkiAttachmentInputs(repairContent, repairContext.attachments);
  const repairPayload = {
    model: ANKI_MODEL,
    input: [{ role: "user" as const, content: repairContent }],
    max_output_tokens: ANKI_MAX_OUTPUT_TOKENS,
    text: {
      format: {
        type: "json_schema" as const,
        name: "anki_cards_v2",
        strict: true,
        schema: ANKI_CARDS_SCHEMA_V2,
      },
    },
  };
  try {
    const repairResult = await callResponsesJson(env, repairPayload, `anki-repair:${repairContext.lectureId}`);
    const repairedRaw = extractOutputText(repairResult).trim();
    const repairedCards = normalizeAnkiNotes(parseAnkiOutput(repairedRaw), styleContext);
    const merged = mergeAnkiRepairResults(cards, repairedCards, lintReport.failedIndices || []);
    lintReport = lintAnkiNotes(merged, styleContext);
    return { cards: merged, lintReport, repairApplied: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to repair Anki notes.";
    throw new AnkiPipelineError(message, {
      stage: "openai",
      status: 502,
      debugCode: "anki_openai_repair",
    });
  }
}

async function runAnkiGenerationPass(
  env: Env,
  opts: {
    requestId: string;
    label: string;
    styleContext: AnkiHouseStyleContext;
    repairContext: AnkiRepairContext;
    input: Array<{ role: "user"; content: ResponsesInputContent[] }>;
    debugAnki: boolean;
  },
): Promise<AnkiGenerationPassResult> {
  const payload = {
    model: ANKI_MODEL,
    input: opts.input,
    max_output_tokens: ANKI_MAX_OUTPUT_TOKENS,
    text: {
      format: {
        type: "json_schema" as const,
        name: "anki_cards_v2",
        strict: true,
        schema: ANKI_CARDS_SCHEMA_V2,
      },
    },
  };
  if (opts.debugAnki) {
    console.log("[ANKI] openai-request", {
      requestId: opts.requestId,
      label: opts.label,
      format: "json_schema",
      schemaName: "anki_cards_v2",
      maxOutputTokens: ANKI_MAX_OUTPUT_TOKENS,
    });
  }
  let result: OpenAIJson;
  try {
    result = await callResponsesJson(env, payload, opts.label);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Anki generation failed.";
    throw new AnkiPipelineError(message, {
      stage: "openai",
      status: 502,
      debugCode: "anki_openai_generate",
    });
  }
  const rawOutput = extractOutputText(result).trim();
  const outputTextLength = extractOutputTextLength(result);
  if (opts.debugAnki) {
    console.log("[ANKI] openai-output", {
      requestId: opts.requestId,
      label: opts.label,
      outputTextLength,
      outputChars: rawOutput.length,
    });
  }
  let cards: AnkiStructuredCard[] = [];
  try {
    cards = normalizeAnkiNotes(parseAnkiOutput(rawOutput, { outputTextLength }), opts.styleContext);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to parse cards.tsv output.";
    const details = isAnkiParseError(err) ? err.details : undefined;
    throw new AnkiPipelineError(message, {
      stage: "package",
      status: 502,
      debugCode: "anki_parse_tsv",
      details: details ? { details } : undefined,
    });
  }
  const repaired = await repairAnkiNotesIfNeeded(env, cards, opts.styleContext, opts.repairContext);
  cards = repaired.cards;
  return {
    cards,
    lintReport: repaired.lintReport,
    repairApplied: repaired.repairApplied,
    rawOutput,
    outputTextLength,
  };
}

function buildAnkiDedupKey(note: AnkiStructuredCard) {
  const normalizedText = normalizePlainText(String(note.text || "")).toLowerCase();
  const normalizedSource = normalizePlainText(String(note.source || "")).toLowerCase();
  return `${normalizedSource}||${normalizedText}`;
}

export function mergeAnkiNotesForCoverage(
  existing: AnkiStructuredCard[],
  additions: AnkiStructuredCard[],
  maxCount: number,
) {
  const merged = [...existing];
  const seen = new Set(existing.map(buildAnkiDedupKey));
  for (const note of additions) {
    if (merged.length >= maxCount) break;
    const key = buildAnkiDedupKey(note);
    if (seen.has(key)) continue;
    merged.push(note);
    seen.add(key);
  }
  return merged;
}

function isPdfTypeErrorMessage(message: string) {
  const lowered = (message || "").toLowerCase();
  return lowered.includes("pdf") && (
    lowered.includes("file type") ||
    lowered.includes("not supported") ||
    lowered.includes("unsupported file type") ||
    lowered.includes("try again with a pdf") ||
    lowered.includes("only pdf") ||
    lowered.includes("upload a pdf")
  );
}

function getRequestIp(req: Request) {
  const header = req.headers.get("CF-Connecting-IP") || req.headers.get("x-forwarded-for") || "";
  return header.split(",")[0]?.trim() || "";
}

async function isFacultyRequest(req: Request, env: Env) {
  const config = getAppConfig(env, req);
  const session = await getAuthSession(req, env, config);
  const allowed = AuthorizationPolicy.canAccess(session, "library.download.internal");
  return Boolean(session && allowed.allowed);
}

async function checkAnkiRateLimit(env: Env, req: Request) {
  const ip = getRequestIp(req);
  if (!ip) return { allowed: true as const };
  if (env.DOCS_KV) {
    const key = `anki:rate:${ip}`;
    const currentRaw = await env.DOCS_KV.get(key);
    const current = Number.parseInt(currentRaw || "0", 10) || 0;
    if (current >= ANKI_RATE_LIMIT_MAX) {
      return { allowed: false as const, retryAfter: ANKI_RATE_LIMIT_WINDOW_SECONDS };
    }
    await env.DOCS_KV.put(key, String(current + 1), { expirationTtl: ANKI_RATE_LIMIT_WINDOW_SECONDS });
    return { allowed: true as const };
  }
  const now = Date.now();
  const entry = ankiRateLimitState.get(ip);
  if (!entry || entry.expiresAt <= now) {
    ankiRateLimitState.set(ip, { count: 1, expiresAt: now + ANKI_RATE_LIMIT_WINDOW_SECONDS * 1000 });
    return { allowed: true as const };
  }
  if (entry.count >= ANKI_RATE_LIMIT_MAX) {
    return { allowed: false as const, retryAfter: Math.max(1, Math.ceil((entry.expiresAt - now) / 1000)) };
  }
  entry.count += 1;
  ankiRateLimitState.set(ip, entry);
  return { allowed: true as const };
}

type PreparedAnkiImage = {
  filename: string;
  bytes: Uint8Array;
  page?: number;
  source: "pdf" | "upload";
  width?: number;
  height?: number;
  mimeType?: string;
};

function makeUniqueFilename(name: string, seen: Set<string>) {
  const safe = sanitizeFilename(name || "slide.jpg");
  const dot = safe.lastIndexOf(".");
  const base = dot > 0 ? safe.slice(0, dot) : safe || "slide";
  const ext = dot > 0 ? safe.slice(dot) : "";
  let candidate = safe;
  let idx = 1;
  while (seen.has(candidate)) {
    candidate = `${base}-${idx}${ext}`;
    idx += 1;
  }
  seen.add(candidate);
  return candidate;
}

async function renderPdfPageToJpegBytes(page: any) {
  if (typeof OffscreenCanvas === "undefined") {
    throw new Error("OffscreenCanvas is unavailable for PDF conversion.");
  }
  const baseViewport = page.getViewport({ scale: 1 });
  const baseMax = Math.max(baseViewport.width, baseViewport.height);
  let scale = ANKI_PDF_RENDER_MAX_DIMENSION / baseMax;
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;
  if (scale > 2.2) scale = 2.2;
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    throw new Error("OffscreenCanvas 2D context unavailable for PDF conversion.");
  }
  (ctx as any).fillStyle = "white";
  (ctx as any).fillRect(0, 0, width, height);
  const renderTask = page.render({ canvasContext: ctx, viewport });
  await renderTask.promise;
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: ANKI_JPEG_QUALITY });
  const ab = await blob.arrayBuffer();
  return { bytes: new Uint8Array(ab), width, height };
}

async function encodeBitmapToJpeg(bitmap: ImageBitmap, opts: { maxDimension: number; maxBytes: number }) {
  const baseMax = Math.max(bitmap.width, bitmap.height);
  const baseScale = baseMax > opts.maxDimension ? opts.maxDimension / baseMax : 1;
  const scaleSteps = [1, 1, 1, 0.85, 0.7];
  const qualitySteps = [ANKI_JPEG_QUALITY, 0.7, 0.6, 0.7, 0.6];

  for (let i = 0; i < scaleSteps.length; i += 1) {
    const scale = Math.max(0.1, baseScale * scaleSteps[i]);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) {
      throw new Error("OffscreenCanvas 2D context unavailable for image conversion.");
    }
    (ctx as any).fillStyle = "white";
    (ctx as any).fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: qualitySteps[i] });
    const ab = await blob.arrayBuffer();
    const bytes = new Uint8Array(ab);
    if (bytes.length <= opts.maxBytes) {
      return { bytes, width, height };
    }
  }

  throw new AnkiInputError(
    "Image too large after compression. Please upload smaller slides.",
    { debugCode: "anki_image_too_large" },
  );
}

async function convertPdfToJpegPages(pdfBytes: Uint8Array, lectureId: string) {
  if (!PDFJS_AVAILABLE) {
    throw new Error("PDF.js is unavailable; upload JPEGs instead.");
  }
  const task = pdfjs.getDocument({ data: pdfBytes, disableWorker: true });
  const doc = await task.promise;
  const pageCount = doc?.numPages || 0;
  if (!pageCount) {
    throw new Error("PDF has no pages.");
  }
  if (pageCount > ANKI_MAX_PAGES) {
    throw new Error(`PDF has ${pageCount} pages; max is ${ANKI_MAX_PAGES}.`);
  }
  const safeLectureId = sanitizeFilename(lectureId || "lecture");
  const images: PreparedAnkiImage[] = [];
  try {
    for (let pageNum = 1; pageNum <= pageCount; pageNum += 1) {
      const page = await doc.getPage(pageNum);
      const rendered = await renderPdfPageToJpegBytes(page);
      const filename = `${safeLectureId}_p${pageNum}_fig1.jpg`;
      const normalized = await normalizeImageToJpeg(rendered.bytes, "image/jpeg", filename);
      images.push({
        filename,
        bytes: normalized.bytes,
        page: pageNum,
        source: "pdf",
        width: normalized.width ?? rendered.width,
        height: normalized.height ?? rendered.height,
        mimeType: normalized.mimeType,
      });
      page.cleanup?.();
    }
  } finally {
    try {
      await doc.cleanup?.();
      await doc.destroy?.();
    } catch {}
  }
  return { images, pageCount };
}

async function normalizeImageToJpeg(bytes: Uint8Array, mimeType: string, label?: string) {
  const lowered = (mimeType || "").toLowerCase();
  const isJpeg = lowered.includes("jpeg") || lowered.includes("jpg");
  const canConvert = typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function";
  if (!canConvert) {
    if (isJpeg) {
      if (bytes.length > ANKI_IMAGE_MAX_BYTES) {
        throw new AnkiInputError(
          `Image ${label || "file"} is too large. Please upload smaller slides.`,
          { debugCode: "anki_image_too_large" },
        );
      }
      return { bytes, mimeType: "image/jpeg" };
    }
    throw new AnkiInputError(
      "Image conversion requires OffscreenCanvas; upload JPEGs instead.",
      { debugCode: "anki_image_conversion_unavailable" },
    );
  }
  const blob = new Blob([bytes], { type: mimeType || "application/octet-stream" });
  const bitmap = await createImageBitmap(blob);
  let result: { bytes: Uint8Array; width: number; height: number };
  try {
    result = await encodeBitmapToJpeg(bitmap, {
      maxDimension: ANKI_IMAGE_MAX_DIMENSION,
      maxBytes: ANKI_IMAGE_MAX_BYTES,
    });
  } finally {
    if (typeof (bitmap as any).close === "function") (bitmap as any).close();
  }
  return { bytes: result.bytes, width: result.width, height: result.height, mimeType: "image/jpeg" };
}

async function prepareAnkiImagesFromFiles(files: File[]) {
  const prepared: PreparedAnkiImage[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const name = file.name || "slide.jpg";
    const mime = file.type || guessImageMimeTypeFromFilename(name) || "application/octet-stream";
    const bytes = new Uint8Array(await file.arrayBuffer());
    const signature = detectImageSignature(bytes);
    const signatureAllowed = signature === "jpg" || signature === "png";
    if (!isAnkiAllowedImageFilename(name) && !isAnkiAllowedImageMimeType(mime) && !signatureAllowed) {
      throw new AnkiInputError(
        "Unsupported image type. Please upload JPG, PNG, or WebP images.",
        { debugCode: "anki_image_type" },
      );
    }
    const normalized = await normalizeImageToJpeg(bytes, mime, name);
    let filename = name;
    filename = filename.replace(/\.[^.]+$/, "") || "slide";
    filename = `${filename}.jpg`;
    filename = makeUniqueFilename(filename, seen);
    prepared.push({
      filename,
      bytes: normalized.bytes,
      source: "upload",
      width: normalized.width,
      height: normalized.height,
      mimeType: normalized.mimeType,
    });
  }
  return prepared;
}

async function promisePool<T>(items: T[], limit: number, iterator: (item: T) => Promise<void>) {
  const queue = [...items];
  const concurrency = Math.max(1, limit);
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (!item) return;
      await iterator(item);
    }
  });
  await Promise.all(workers);
}

function buildAnkiImageDiagnostics(images: PreparedAnkiImage[]) {
  let totalBytes = 0;
  let maxWidth = 0;
  let maxHeight = 0;
  const contentTypes = new Set<string>();
  for (const image of images) {
    totalBytes += image.bytes.length;
    if (typeof image.width === "number") maxWidth = Math.max(maxWidth, image.width);
    if (typeof image.height === "number") maxHeight = Math.max(maxHeight, image.height);
    const mime = (image.mimeType || guessMimeTypeFromFilename(image.filename) || "").toLowerCase();
    if (mime) contentTypes.add(mime);
  }
  return {
    imageCount: images.length,
    totalBytes,
    maxWidth: maxWidth || undefined,
    maxHeight: maxHeight || undefined,
    contentTypes: Array.from(contentTypes),
  };
}

function extractOpenAIRequestId(resp?: Response | null, data?: OpenAIJson) {
  const headerId = resp
    ? (
      resp.headers.get("x-request-id") ||
      resp.headers.get("openai-request-id") ||
      resp.headers.get("x-openai-request-id") ||
      resp.headers.get("request-id") ||
      ""
    )
    : "";
  const bodyId =
    data?.error?.request_id ||
    data?.error?.requestId ||
    data?.request_id ||
    data?.requestId ||
    "";
  return (headerId && headerId.trim()) || (typeof bodyId === "string" ? bodyId : "");
}

function isRetryableOpenAIImageError(status: number | undefined, message: string) {
  const lowered = (message || "").toLowerCase();
  if (lowered.includes("server had an error processing your request")) return true;
  return status === 500 || status === 502 || status === 503 || status === 504;
}

function mapAnkiImageUploadErrorMessage(message: string) {
  const lowered = (message || "").toLowerCase();
  if (
    lowered.includes("unsupported image") ||
    lowered.includes("unsupported file type") ||
    lowered.includes("invalid image") ||
    lowered.includes("image type")
  ) {
    return "Unsupported image type. Please upload JPG, PNG, or WebP images.";
  }
  if (lowered.includes("too large") || lowered.includes("image size")) {
    return "Image is too large. Please upload smaller slides.";
  }
  return "OpenAI rejected the image upload. Please check image size and type.";
}

function computeAnkiImageUploadDelay(attempt: number) {
  const exponent = Math.max(0, attempt - 1);
  const base = ANKI_IMAGE_UPLOAD_BASE_DELAY_MS * Math.pow(2, exponent);
  const jitter = Math.floor(Math.random() * ANKI_IMAGE_UPLOAD_JITTER_MS);
  return Math.min(ANKI_IMAGE_UPLOAD_MAX_DELAY_MS, base + jitter);
}

async function uploadAnkiImageWithRetry(env: Env, image: PreparedAnkiImage) {
  const mimeType = image.mimeType || guessMimeTypeFromFilename(image.filename) || "application/octet-stream";
  const base = env.OPENAI_API_BASE?.replace(/\/$/, "") || "https://api.openai.com/v1";
  const blobPart: BlobPart = image.bytes as unknown as BlobPart;

  for (let attempt = 0; attempt < ANKI_IMAGE_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await delay(computeAnkiImageUploadDelay(attempt));
    }
    const attemptStart = Date.now();
    let resp: Response;
    let data: OpenAIJson;
    try {
      const form = new FormData();
      form.append("purpose", "vision");
      form.append("file", new File([blobPart], image.filename, { type: mimeType }));
      resp = await fetch(`${base}/files`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: form,
      });
      data = await safeJson(resp);
    } catch (err) {
      const elapsedMs = Date.now() - attemptStart;
      const message = err instanceof Error ? err.message : "OpenAI image upload failed.";
      if (attempt >= ANKI_IMAGE_UPLOAD_MAX_ATTEMPTS - 1) {
        throw new AnkiImageUploadError(message, {
          kind: "transient",
          attempt: attempt + 1,
          elapsedMs,
          phase: "openai_request",
          imageFilename: image.filename,
        });
      }
      continue;
    }

    const elapsedMs = Date.now() - attemptStart;
    const openaiRequestId = extractOpenAIRequestId(resp, data);
    if (resp.ok) {
      const uploadedId = typeof data?.id === "string" ? data.id : "";
      if (!uploadedId) {
        throw new AnkiImageUploadError("OpenAI image upload returned no file id.", {
          kind: "permanent",
          status: resp.status,
          openaiRequestId,
          attempt: attempt + 1,
          elapsedMs,
          phase: "openai_parse",
          imageFilename: image.filename,
        });
      }
      return { fileId: uploadedId, openaiRequestId };
    }

    const message = data?.error?.message || resp.statusText || "OpenAI image upload failed.";
    const retryable = isRetryableOpenAIImageError(resp.status, message);
    if (!retryable || attempt >= ANKI_IMAGE_UPLOAD_MAX_ATTEMPTS - 1) {
      const kind: AnkiImageUploadFailureKind = retryable ? "transient" : "permanent";
      throw new AnkiImageUploadError(message, {
        kind,
        status: resp.status,
        openaiRequestId,
        attempt: attempt + 1,
        elapsedMs,
        phase: "openai_request",
        imageFilename: image.filename,
      });
    }
  }

  throw new AnkiImageUploadError("OpenAI image upload failed.", {
    kind: "transient",
    attempt: ANKI_IMAGE_UPLOAD_MAX_ATTEMPTS,
    elapsedMs: 0,
    phase: "openai_request",
    imageFilename: image.filename,
  });
}

async function uploadAnkiImages(env: Env, images: PreparedAnkiImage[]) {
  const results: Array<{ fileId: string; filename: string }> = new Array(images.length);
  const indexed = images.map((image, index) => ({ image, index }));
  for (let i = 0; i < indexed.length; i += ANKI_IMAGE_BATCH_SIZE) {
    const batch = indexed.slice(i, i + ANKI_IMAGE_BATCH_SIZE);
    await promisePool(batch, ANKI_IMAGE_UPLOAD_CONCURRENCY, async (entry) => {
      const uploaded = await uploadAnkiImageWithRetry(env, entry.image);
      results[entry.index] = { fileId: uploaded.fileId, filename: entry.image.filename };
    });
  }
  return results.filter(Boolean);
}

function resolveAnkiCreatedBy(req: Request) {
  const header =
    req.headers.get("x-owen-user") ||
    req.headers.get("x-user-email") ||
    req.headers.get("x-faculty-email") ||
    "";
  return header.trim() || "faculty";
}

async function handleAnkiGenerate(req: Request, env: Env): Promise<Response> {
  const requestId = resolveAnkiRequestId(req);
  const startMs = Date.now();
  const warnings: string[] = [];
  const debugAnki = isOwenDebug(env) || req.headers.get("x-debug-anki") === "1";
  try {
    const auth = await requireFaculty(req, env, "anki_generate");
    if (!auth.ok) return auth.response;
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return ankiErrorResponse(
        requestId,
        "parse_form",
        415,
        "Send multipart/form-data with slidesPdf, transcriptText (or transcriptTxt), slideImages[], boldmapCsv?, classmateDeckTsv?.",
        "anki_multipart_required",
      );
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch (err) {
      console.warn("[ANKI] Failed to parse form", { requestId, err });
      return ankiErrorResponse(requestId, "parse_form", 400, "Unable to parse upload.", "anki_parse_form");
    }
    logAnkiStage(requestId, "parse_form", startMs);

    const slidesPdfEntry = form.get("slidesPdf");
    const fallbackPdfEntry = slidesPdfEntry === null ? form.get("file") : null;
    const transcriptEntry = form.get("transcriptTxt");
    const transcriptTextEntry = form.get("transcriptText");
    const boldmapEntry = form.get("boldmapCsv");
    const classmateEntry = form.get("classmateDeckTsv");
    const targetCardMinEntry = form.get("targetCardMin");
    const targetCardMaxEntry = form.get("targetCardMax");
    const targetCardOverrideEntry = form.get("targetCardOverride");
    const coverageModeEntry = form.get("coverageMode");
    const guaranteeCoverageEntry = form.get("guaranteeCoverage");
    const slideImageEntries = [
      ...form.getAll("slideImages[]"),
      ...form.getAll("slideImages"),
    ];
    const lectureTitleRaw = typeof form.get("lectureTitle") === "string" ? form.get("lectureTitle") as string : "";
    const lectureIdRaw = typeof form.get("lectureId") === "string" ? form.get("lectureId") as string : "";

    const transcriptFile = transcriptEntry instanceof File ? transcriptEntry : null;
    const transcriptTextRaw = typeof transcriptTextEntry === "string" ? transcriptTextEntry : "";
    const transcriptTextFallback = typeof transcriptEntry === "string" ? transcriptEntry : "";
    const targetCardMinRaw = typeof targetCardMinEntry === "string" ? targetCardMinEntry : "";
    const targetCardMaxRaw = typeof targetCardMaxEntry === "string" ? targetCardMaxEntry : "";
    const targetCardOverrideRaw = typeof targetCardOverrideEntry === "string" ? targetCardOverrideEntry : "";
    const coverageModeRaw = typeof coverageModeEntry === "string" ? coverageModeEntry : "";
    const guaranteeCoverageRaw = typeof guaranteeCoverageEntry === "string" ? guaranteeCoverageEntry : "";
    let transcriptText = transcriptTextRaw || transcriptTextFallback;
    const boldmapFile = boldmapEntry instanceof File ? boldmapEntry : null;
    const classmateFile = classmateEntry instanceof File ? classmateEntry : null;
    const slideImageFiles = slideImageEntries.filter(entry => entry instanceof File) as File[];
    let pdfFile = slidesPdfEntry instanceof File
      ? slidesPdfEntry
      : fallbackPdfEntry instanceof File
        ? fallbackPdfEntry
        : null;
    const received = buildAnkiReceivedDebug({
      pdfFile,
      slideImageEntries,
      slideImageFiles,
      transcriptFile,
      transcriptText,
      contentTypeHeader: contentType,
      targetCardMinRaw,
      targetCardMaxRaw,
      targetCardOverrideRaw,
      coverageModeRaw,
      guaranteeCoverageRaw,
    });
    const formFields = Array.from(new Set(Array.from(form.keys())));
    const pdfSource = slidesPdfEntry !== null ? "slidesPdf" : fallbackPdfEntry !== null ? "file" : "none";
    if (debugAnki) {
      console.log("[ANKI] form", { requestId, fields: formFields, pdfSource, received });
      console.log("[ANKI] upload-meta", {
        requestId,
        pdfSource,
        files: {
          slidesPdf: summarizeAnkiUpload(pdfFile),
          transcriptTxt: summarizeAnkiUpload(transcriptFile),
          transcriptTextLength: transcriptText ? transcriptText.length : 0,
          boldmapCsv: summarizeAnkiUpload(boldmapFile),
          classmateDeckTsv: summarizeAnkiUpload(classmateFile),
          slideImages: slideImageFiles.map(file => summarizeAnkiUpload(file)),
        },
      });
    }

    if (slidesPdfEntry !== null && !(slidesPdfEntry instanceof File)) {
      return ankiValidationError(requestId, 400, "slidesPdf must be a file upload.", "anki_pdf_invalid_part", received);
    }
    if (slidesPdfEntry === null && fallbackPdfEntry !== null && !(fallbackPdfEntry instanceof File)) {
      return ankiValidationError(requestId, 400, "file must be a file upload.", "anki_file_invalid_part", received);
    }
    if (transcriptEntry !== null && !(transcriptEntry instanceof File) && typeof transcriptEntry !== "string") {
      return ankiValidationError(
        requestId,
        400,
        "transcriptTxt must be a file upload or transcriptText must be a text field.",
        "anki_transcript_invalid_part",
        received,
      );
    }
    if (transcriptTextEntry !== null && typeof transcriptTextEntry !== "string") {
      return ankiValidationError(
        requestId,
        400,
        "transcriptText must be a text field.",
        "anki_transcript_invalid_part",
        received,
      );
    }
    if (boldmapEntry !== null && !(boldmapEntry instanceof File)) {
      return ankiValidationError(
        requestId,
        400,
        "boldmapCsv must be a file upload.",
        "anki_boldmap_invalid_part",
        received,
      );
    }
    if (classmateEntry !== null && !(classmateEntry instanceof File)) {
      return ankiValidationError(
        requestId,
        400,
        "classmateDeckTsv must be a file upload.",
        "anki_classmate_invalid_part",
        received,
      );
    }
    if (targetCardMinEntry !== null && typeof targetCardMinEntry !== "string") {
      return ankiValidationError(
        requestId,
        400,
        "targetCardMin must be a text field.",
        "anki_target_card_min_part_invalid",
        received,
      );
    }
    if (targetCardMaxEntry !== null && typeof targetCardMaxEntry !== "string") {
      return ankiValidationError(
        requestId,
        400,
        "targetCardMax must be a text field.",
        "anki_target_card_max_part_invalid",
        received,
      );
    }
    if (targetCardOverrideEntry !== null && typeof targetCardOverrideEntry !== "string") {
      return ankiValidationError(
        requestId,
        400,
        "targetCardOverride must be a text field.",
        "anki_target_card_override_part_invalid",
        received,
      );
    }
    if (coverageModeEntry !== null && typeof coverageModeEntry !== "string") {
      return ankiValidationError(
        requestId,
        400,
        "coverageMode must be a text field.",
        "anki_coverage_mode_part_invalid",
        received,
      );
    }
    if (guaranteeCoverageEntry !== null && typeof guaranteeCoverageEntry !== "string") {
      return ankiValidationError(
        requestId,
        400,
        "guaranteeCoverage must be a text field.",
        "anki_guarantee_coverage_part_invalid",
        received,
      );
    }
    if (slideImageEntries.some(entry => !(entry instanceof File))) {
      return ankiValidationError(
        requestId,
        400,
        "slideImages[]/slideImages must be file uploads.",
        "anki_images_invalid_part",
        received,
      );
    }

    const generationSettingsResult = parseAnkiGenerationSettings({
      targetCardMinRaw,
      targetCardMaxRaw,
      targetCardOverrideRaw,
      coverageModeRaw,
      guaranteeCoverageRaw,
    });
    if ("error" in generationSettingsResult) {
      return ankiValidationError(
        requestId,
        400,
        generationSettingsResult.error,
        generationSettingsResult.debugCode,
        received,
      );
    }
    const generationSettings = generationSettingsResult.value;

    const imageFiles = slideImageFiles;

    const allFiles = [
      transcriptFile,
      boldmapFile,
      classmateFile,
      pdfFile,
      ...imageFiles,
    ].filter(Boolean) as File[];
    const totalBytes = allFiles.reduce((sum, file) => sum + (file.size || 0), 0);
    if (totalBytes > ANKI_UPLOAD_MAX_BYTES) {
      const maxMb = Math.round(ANKI_UPLOAD_MAX_BYTES / (1024 * 1024));
      return ankiErrorResponse(
        requestId,
        "parse_form",
        413,
        `Upload too large. Max ${maxMb}MB.`,
        "anki_upload_too_large",
      );
    }

    const pdfRequiredMessage = "Please load a PDF. JPEG/Transcript-only mode is not supported yet.";
    if (!pdfFile) {
      return ankiValidationError(requestId, 400, pdfRequiredMessage, "anki_pdf_required", received);
    }

    const pdfSniff = await sniffPdfHeader(pdfFile);
    const magic = Array.from(pdfSniff.header.slice(0, 4));
    if (debugAnki) {
      console.log("[ANKI] upload", {
        requestId,
        name: pdfFile.name,
        type: pdfFile.type,
        size: pdfFile.size,
        magic,
      });
    }
    if (pdfSniff.header.length < 4 || !pdfSniff.isPdf) {
      return ankiValidationError(requestId, 400, pdfRequiredMessage, "anki_pdf_required", received);
    }

    if (!transcriptText && !transcriptFile) {
      return ankiValidationError(
        requestId,
        400,
        "Transcript is required (.txt).",
        "anki_missing_transcript",
        received,
      );
    }
    if (!transcriptText && transcriptFile) {
      if (!(await isAnkiTranscriptFile(transcriptFile))) {
        return ankiValidationError(
          requestId,
          415,
          "Transcript file must be .txt.",
          "anki_transcript_type",
          received,
        );
      }
      transcriptText = await transcriptFile.text();
    }
    const transcriptTextTrimmed = (transcriptText || "").trim();
    if (!transcriptTextTrimmed) {
      return ankiValidationError(
        requestId,
        400,
        "Transcript text is empty.",
        "anki_empty_transcript",
        received,
      );
    }
    transcriptText = transcriptTextTrimmed;
    const transcriptSource = transcriptTextRaw || transcriptTextFallback ? "text" : transcriptFile ? "file" : "none";
    const numberedTranscript = buildNumberedTranscript(transcriptText);

    const imageChecks = await Promise.all(
      imageFiles.map(async (file) => ({ file, ok: await isAnkiImageFile(file) })),
    );
    const invalidImage = imageChecks.find(entry => !entry.ok);
    if (invalidImage) {
      return ankiValidationError(
        requestId,
        422,
        "Unsupported image type. Please upload JPG, PNG, or WebP images.",
        "anki_image_type",
        received,
      );
    }
    const validImageFiles = imageChecks.map(entry => entry.file);

    if (validImageFiles.length > ANKI_MAX_IMAGES) {
      return ankiValidationError(
        requestId,
        400,
        `Too many images (${validImageFiles.length}). Max is ${ANKI_MAX_IMAGES}.`,
        "anki_too_many_images",
        received,
      );
    }
    logAnkiStage(requestId, "validate_type", startMs, { totalBytes, imageCount: validImageFiles.length });

    const lectureTitle = normalizeLectureTitle(lectureTitleRaw || "");
    const lectureId = normalizeAnkiLectureId(lectureIdRaw, lectureTitle);
    const lectureLabel = buildHumanReadableAnkiLectureLabel(lectureTitle, lectureId);
    const lectureTagRoot = buildAnkiLectureTagRoot(lectureLabel);
    const ankiStyleContext: AnkiHouseStyleContext = {
      lectureLabel,
      lectureTagRoot,
      defaultDifficulty: "medium",
      defaultEss: 0,
    };

    let preparedImages: PreparedAnkiImage[] = [];
    let pdfBytes: Uint8Array | null = null;
    let pdfPageCount = 0;
    try {
      if (validImageFiles.length) {
        preparedImages = await prepareAnkiImagesFromFiles(validImageFiles);
      } else if (pdfFile) {
        pdfBytes = new Uint8Array(await pdfFile.arrayBuffer());
        const converted = await convertPdfToJpegPages(pdfBytes, lectureId);
        preparedImages = converted.images;
        pdfPageCount = converted.pageCount;
      }
    } catch (err) {
      if (isAnkiInputError(err)) {
        return ankiErrorResponse(
          requestId,
          err.stage,
          err.status,
          err.message,
          err.debugCode,
          err.details,
        );
      }
      const message = err instanceof Error ? err.message : "Failed to prepare slide images.";
      return ankiErrorResponse(requestId, "preprocess", 500, message, "anki_prepare_images");
    }

    if (!preparedImages.length) {
      return ankiErrorResponse(
        requestId,
        "preprocess",
        400,
        "No slide images available after processing.",
        "anki_no_images",
      );
    }
    if (preparedImages.length > ANKI_MAX_IMAGES) {
      return ankiErrorResponse(
        requestId,
        "preprocess",
        400,
        `Too many images (${preparedImages.length}). Max is ${ANKI_MAX_IMAGES}.`,
        "anki_too_many_images_prepared",
      );
    }
    logAnkiStage(requestId, "preprocess", startMs, { preparedImages: preparedImages.length });

    let boldmapText = "";
    if (boldmapFile) {
      try {
        boldmapText = await boldmapFile.text();
      } catch {}
    }

    if (!pdfBytes) {
      pdfBytes = new Uint8Array(await pdfFile.arrayBuffer());
    }

    let extractedPages: PageText[] = [];
    try {
      const extraction = await extractEmbeddedPagesForAnkiRequest(pdfBytes, {
        allowEarlyStop: false,
        maxPages: ANKI_MAX_PAGES,
      });
      extractedPages = extraction.pages;
      if (extraction.pageCount) {
        pdfPageCount = extraction.pageCount;
      }
    } catch (err) {
      console.warn("[ANKI] Embedded PDF extraction unavailable", {
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const slideLedger = buildSlideLedger({
      pages: extractedPages,
      pageCount: pdfPageCount,
      fallbackPageCount: preparedImages.length,
      boldmapCsvText: boldmapText,
      targetCardMin: generationSettings.targetCardMin,
      targetCardMax: generationSettings.targetCardMax,
      targetCardOverride: generationSettings.targetCardOverride,
      coverageMode: generationSettings.coverageMode,
      guaranteeCoverage: generationSettings.guaranteeCoverage,
    });
    const coverageTelemetryAvailable = extractedPages.length > 0 && slideLedger.substantivePages.length > 0;
    const coverageTelemetryReason = coverageTelemetryAvailable ? undefined : "no_server_readable_pdf_text";
    if (!coverageTelemetryAvailable) {
      pushUniqueAnkiWarning(warnings, "coverage_fill_skipped_no_pdf_text");
    }

    if (!env.OPENAI_API_KEY || !env.OPENAI_API_KEY.trim()) {
      return ankiErrorResponse(
        requestId,
        "openai",
        500,
        "OpenAI API key is not configured.",
        "anki_openai_missing_key",
      );
    }

    let boldmapId = "";
    let classmateId = "";
    let pdfId = "";
    try {
      if (boldmapFile) {
        const boldmapBytes = new Uint8Array(await boldmapFile.arrayBuffer());
        boldmapId = await uploadBytesToOpenAI(env, boldmapBytes, "boldmap.csv", "assistants", "text/csv") || "";
        if (!boldmapId) throw new Error("OpenAI upload failed for boldmap.csv.");
      }
      if (classmateFile) {
        const classmateBytes = new Uint8Array(await classmateFile.arrayBuffer());
        classmateId = await uploadBytesToOpenAI(
          env,
          classmateBytes,
          "classmate_deck.tsv",
          "assistants",
          "text/tab-separated-values",
        ) || "";
        if (!classmateId) throw new Error("OpenAI upload failed for classmate_deck.tsv.");
      }
      if (!pdfBytes) {
        pdfBytes = new Uint8Array(await pdfFile.arrayBuffer());
      }
      pdfId = await uploadBytesToOpenAI(env, pdfBytes, "slides.pdf", "assistants", "application/pdf") || "";
      if (!pdfId) throw new Error("OpenAI upload failed for slides.pdf.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to upload attachments to OpenAI.";
      if (isPdfTypeErrorMessage(message)) {
        return ankiErrorResponse(
          requestId,
          "openai",
          415,
          "Only PDF files are supported.",
          "anki_pdf_type",
        );
      }
      return ankiErrorResponse(requestId, "openai", 502, message, "anki_openai_upload");
    }

    const imageDiagnostics = buildAnkiImageDiagnostics(preparedImages);
    let imageUploads: Array<{ fileId: string; filename: string }> = [];
    let imageUploadFailed = false;
    try {
      imageUploads = await uploadAnkiImages(env, preparedImages);
    } catch (err) {
      if (isAnkiImageUploadError(err)) {
        console.warn("[ANKI] OpenAI image upload failed", {
          requestId,
          openaiRequestId: err.openaiRequestId,
          model: ANKI_MODEL,
          endpoint: "files",
          method: "files.upload",
          purpose: "vision",
          imageCount: imageDiagnostics.imageCount,
          totalBytes: imageDiagnostics.totalBytes,
          maxWidth: imageDiagnostics.maxWidth,
          maxHeight: imageDiagnostics.maxHeight,
          contentTypes: imageDiagnostics.contentTypes,
          streaming: false,
          attempt: err.attempt,
          elapsedMs: err.elapsedMs,
          status: err.status,
          phase: err.phase,
          imageFilename: err.imageFilename,
          message: err.message,
        });
        if (err.kind === "permanent") {
          const message = mapAnkiImageUploadErrorMessage(err.message);
          return ankiErrorResponse(requestId, "openai", 422, message, "anki_openai_images", {
            openaiRequestId: err.openaiRequestId,
            imageStage: err.phase,
          });
        }
        imageUploadFailed = true;
        warnings.push("image_enrichment_failed");
      } else {
        const message = err instanceof Error ? err.message : "Failed to upload slide images to OpenAI.";
        console.warn("[ANKI] OpenAI image upload failed", {
          requestId,
          model: ANKI_MODEL,
          endpoint: "files",
          method: "files.upload",
          purpose: "vision",
          imageCount: imageDiagnostics.imageCount,
          totalBytes: imageDiagnostics.totalBytes,
          maxWidth: imageDiagnostics.maxWidth,
          maxHeight: imageDiagnostics.maxHeight,
          contentTypes: imageDiagnostics.contentTypes,
          streaming: false,
          message,
        });
        return ankiErrorResponse(requestId, "openai", 502, message, "anki_openai_images", {
          imageStage: "openai_request",
        });
      }
    }

    const attachmentIds: AnkiAttachmentIds = {
      classmateId,
      boldmapId,
      pdfId,
    };
    const repairContext: AnkiRepairContext = {
      lectureId,
      lectureLabel,
      lectureTagRoot,
      numberedTranscript: numberedTranscript.numberedText,
      slideLedgerText: slideLedger.contextText,
      attachments: attachmentIds,
    };
    const targetCardOverrideUsed = Number.isFinite(generationSettings.targetCardOverride);
    const requestedTarget = coverageTelemetryAvailable
      ? slideLedger.requestedTarget
      : resolveNoTextFallbackTarget({
          requestedRange: generationSettings.requestedRange,
          coverageMode: generationSettings.coverageMode,
          guaranteeCoverage: generationSettings.guaranteeCoverage,
          targetCardOverride: generationSettings.targetCardOverride,
          fallbackPageCount: slideLedger.pageCount || preparedImages.length,
        });
    const noTextFallbackTarget = coverageTelemetryAvailable ? undefined : requestedTarget;
    const targetDecision = coverageTelemetryAvailable
      ? slideLedger.targetDecision
      : { ...slideLedger.targetDecision, N_final: requestedTarget };
    const noTextBatchingPlanned = !coverageTelemetryAvailable && requestedTarget > ANKI_SAFE_SINGLE_PASS_TARGET;
    if (debugAnki) {
      console.log("[ANKI] openai-input", {
        requestId,
        primary: pdfId ? "pdf" : "none",
        pdf: summarizeAnkiUpload(pdfFile),
        transcript: {
          source: transcriptSource,
          length: transcriptText.length,
          numberedLines: numberedTranscript.lines.length,
        },
        slidesZip: false,
        slideImagesCount: validImageFiles.length,
        slideImagesFirst: summarizeAnkiUpload(validImageFiles[0] || null),
        targetDecision,
        requestedRange: slideLedger.requestedRange,
        requestedTarget,
        targetCardOverrideUsed,
        noTextFallbackTarget,
        noTextBatchingPlanned,
        skippedPages: slideLedger.skippedPages.length,
      });
    }

    let cards: AnkiStructuredCard[] = [];
    let lintReport: AnkiLintReport | null = null;
    let repairApplied = false;
    let rawOutput = "";
    let outputTextLength = 0;
    let noTextBatchingUsed = false;
    try {
      if (coverageTelemetryAvailable) {
        const mainPassTarget = Math.min(requestedTarget, ANKI_SAFE_SINGLE_PASS_TARGET);
        const prompt = buildAnkiPrompt({
          lectureSlug: lectureId,
          lectureLabel,
          lectureTagRoot,
          targetCardCount: mainPassTarget,
        });
        const baseContent = buildAnkiBasePromptContent({
          prompt,
          slideLedger,
          numberedTranscriptText: numberedTranscript.numberedText,
          attachments: attachmentIds,
          planningLines: [
            "CARD_TARGET_DECISION",
            `B=${targetDecision.B}`,
            `S=${targetDecision.S}`,
            `N_final=${targetDecision.N_final}`,
            `AUTO_TARGET=${slideLedger.autoTarget}`,
            `COVERAGE_FLOOR=${slideLedger.coverageFloor}`,
            `REQUESTED_RANGE=${slideLedger.requestedRange.min}-${slideLedger.requestedRange.max}`,
            `REQUESTED_TARGET=${requestedTarget}`,
            `MAIN_PASS_TARGET=${mainPassTarget}`,
            `COVERAGE_MODE=${slideLedger.coverageMode}`,
            `GUARANTEE_COVERAGE=${slideLedger.guaranteeCoverage ? "true" : "false"}`,
            `TARGET_CARD_OVERRIDE_USED=${targetCardOverrideUsed ? "true" : "false"}`,
          ],
          imageUploadFailed,
        });
        const initialInput = buildAnkiInputWithImages({
          baseContent,
          imageUploads,
          hasPdfAttachment: Boolean(pdfId),
        });
        const initialPass = await runAnkiGenerationPass(env, {
          requestId,
          label: `anki:${lectureId}`,
          styleContext: ankiStyleContext,
          repairContext,
          input: initialInput,
          debugAnki,
        });
        cards = initialPass.cards;
        lintReport = initialPass.lintReport;
        repairApplied = initialPass.repairApplied;
        rawOutput = initialPass.rawOutput;
        outputTextLength = initialPass.outputTextLength;
      } else {
        const batchingEnabled = requestedTarget > ANKI_SAFE_SINGLE_PASS_TARGET;
        noTextBatchingUsed = batchingEnabled;
        const maxBatchCount = batchingEnabled ? ANKI_NO_TEXT_MAX_BATCHES : 1;
        let batchNumber = 0;
        while (cards.length < requestedTarget && batchNumber < maxBatchCount) {
          const remaining = requestedTarget - cards.length;
          const batchTarget = batchingEnabled
            ? Math.min(remaining, ANKI_NO_TEXT_SAFE_BATCH_TARGET)
            : remaining;
          batchNumber += 1;
          const prompt = buildAnkiNoTextBatchPrompt({
            lectureSlug: lectureId,
            lectureLabel,
            lectureTagRoot,
            targetCardCount: batchTarget,
            desiredTarget: requestedTarget,
            batchNumber,
            existingNotes: cards,
          });
          const batchContent = buildAnkiBasePromptContent({
            prompt,
            slideLedger,
            numberedTranscriptText: numberedTranscript.numberedText,
            attachments: attachmentIds,
            planningLines: [
              "CARD_TARGET_DECISION",
              `B=${targetDecision.B}`,
              `S=${targetDecision.S}`,
              `N_final=${targetDecision.N_final}`,
              `AUTO_TARGET=${slideLedger.autoTarget}`,
              `COVERAGE_FLOOR=${slideLedger.coverageFloor}`,
              `REQUESTED_RANGE=${slideLedger.requestedRange.min}-${slideLedger.requestedRange.max}`,
              `REQUESTED_TARGET=${requestedTarget}`,
              `MAIN_PASS_TARGET=${batchTarget}`,
              `COVERAGE_MODE=${slideLedger.coverageMode}`,
              `GUARANTEE_COVERAGE=${slideLedger.guaranteeCoverage ? "true" : "false"}`,
              `TARGET_CARD_OVERRIDE_USED=${targetCardOverrideUsed ? "true" : "false"}`,
              `NO_TEXT_FALLBACK_TARGET=${requestedTarget}`,
              `NO_TEXT_BATCH_NUMBER=${batchNumber}`,
              `NO_TEXT_BATCHING=${batchingEnabled ? "true" : "false"}`,
            ],
            imageUploadFailed,
          });
          const batchInput = buildAnkiInputWithImages({
            baseContent: batchContent,
            imageUploads,
            hasPdfAttachment: Boolean(pdfId),
          });
          const batchPass = await runAnkiGenerationPass(env, {
            requestId,
            label: `anki-no-text:${lectureId}:batch-${batchNumber}`,
            styleContext: ankiStyleContext,
            repairContext,
            input: batchInput,
            debugAnki,
          });
          const mergedCards = mergeAnkiNotesForCoverage(cards, batchPass.cards, requestedTarget);
          const addedCount = mergedCards.length - cards.length;
          cards = mergedCards;
          lintReport = batchPass.lintReport;
          repairApplied = repairApplied || batchPass.repairApplied;
          rawOutput = `${rawOutput}\n${batchPass.rawOutput}`.trim();
          outputTextLength += batchPass.outputTextLength;
          if (addedCount <= 0) {
            break;
          }
        }
        const finalizedNoText = await repairAnkiNotesIfNeeded(env, cards, ankiStyleContext, repairContext);
        cards = finalizedNoText.cards;
        lintReport = finalizedNoText.lintReport;
        repairApplied = repairApplied || finalizedNoText.repairApplied;
      }
    } catch (err) {
      if (isAnkiPipelineError(err)) {
        return ankiErrorResponse(requestId, err.stage, err.status, err.message, err.debugCode, err.details);
      }
      const message = err instanceof Error ? err.message : "Anki generation failed.";
      return ankiErrorResponse(requestId, "openai", 502, message, "anki_openai_generate");
    }

    let coverageStats = computeAnkiCoverageStats(slideLedger, cards);
    let coverageLimitedByMax = false;
    let coverageFillAttempted = false;
    let coverageFillSucceeded = false;
    let coverageFillErrorStage: string | undefined;
    let coverageFillErrorCode: string | undefined;
    let coverageDegraded = !coverageTelemetryAvailable;
    if (coverageTelemetryAvailable && coverageStats.uncitedSubstantivePages.length) {
      const remainingCapacity = Math.max(0, slideLedger.requestedRange.max - cards.length);
      if (remainingCapacity > 0) {
        const fillTarget = Math.min(
          remainingCapacity,
          Math.max(
            coverageStats.uncitedSubstantivePages.length,
            slideLedger.requestedTarget - cards.length,
          ),
        );
        if (fillTarget > 0) {
          const fillContent: ResponsesInputContent[] = [
            {
              type: "input_text",
              text: buildAnkiCoverageFillPrompt({
                lectureSlug: lectureId,
                lectureLabel,
                lectureTagRoot,
                targetCardCount: fillTarget,
                ledger: slideLedger,
                uncoveredPages: coverageStats.uncitedSubstantivePages,
                existingNotes: cards,
              }),
            },
            { type: "input_text", text: `NUMBERED_TRANSCRIPT:\n${numberedTranscript.numberedText}` },
            { type: "input_text", text: `SLIDE_LEDGER:\n${slideLedger.contextText}` },
          ];
          if (!boldmapId && slideLedger.fallbackBoldmapCsv) {
            fillContent.push({ type: "input_text", text: `BOLDMAP_FALLBACK_CSV:\n${slideLedger.fallbackBoldmapCsv}` });
          }
          if (slideLedger.skippedPages.length) {
            const skipped = slideLedger.skippedPages.map(page => `Page:P${page.page} -> ${page.reason}`).join("\n");
            fillContent.push({ type: "input_text", text: `PAGES_SKIPPED:\n${skipped}` });
          }
          pushAnkiAttachmentInputs(fillContent, attachmentIds);
          if (imageUploadFailed) {
            fillContent.push({
              type: "input_text",
              text: "IMAGE_ENRICHMENT_FAILED=true\nDo not include image HTML; proceed without slide images.",
            });
          }
          coverageFillAttempted = true;
          try {
            const fillPass = await runAnkiGenerationPass(env, {
              requestId,
              label: `anki-fill:${lectureId}`,
              styleContext: ankiStyleContext,
              repairContext,
              input: [{ role: "user", content: fillContent }],
              debugAnki,
            });
            const repairedFill = await repairAnkiNotesIfNeeded(env, fillPass.cards, ankiStyleContext, repairContext);
            const mergedCards = mergeAnkiNotesForCoverage(
              cards,
              repairedFill.cards,
              slideLedger.requestedRange.max,
            );
            const mergedRepair = await repairAnkiNotesIfNeeded(env, mergedCards, ankiStyleContext, repairContext);
            cards = mergedRepair.cards;
            lintReport = mergedRepair.lintReport;
            repairApplied = repairApplied || fillPass.repairApplied || repairedFill.repairApplied || mergedRepair.repairApplied;
            rawOutput = `${rawOutput}\n${fillPass.rawOutput}`.trim();
            outputTextLength += fillPass.outputTextLength;
            coverageStats = computeAnkiCoverageStats(slideLedger, cards);
            coverageFillSucceeded = true;
            coverageFillErrorStage = undefined;
            coverageFillErrorCode = undefined;
          } catch (err) {
            const fillFailure = isAnkiPipelineError(err)
              ? {
                  stage: err.stage,
                  code: err.debugCode,
                  message: err.message,
                  details: err.details,
                }
              : {
                  stage: "openai",
                  code: "anki_openai_generate",
                  message: err instanceof Error ? err.message : "Failed to generate coverage fill notes.",
                  details: undefined,
                };
            coverageFillSucceeded = false;
            coverageFillErrorStage = fillFailure.stage;
            coverageFillErrorCode = fillFailure.code;
            coverageDegraded = true;
            pushUniqueAnkiWarning(warnings, "coverage_fill_failed");
            console.warn("[ANKI] Coverage fill pass failed; delivering initial deck", {
              requestId,
              stage: fillFailure.stage,
              debugCode: fillFailure.code,
              message: fillFailure.message,
              details: fillFailure.details,
            });
          }
        }
      } else {
        coverageLimitedByMax = true;
      }
    }

    if (coverageStats.uncitedSubstantivePages.length && cards.length >= slideLedger.requestedRange.max) {
      coverageLimitedByMax = true;
    }

    if (!lintReport?.ok) {
      if (!cards.length) {
        return ankiErrorResponse(
          requestId,
          "package",
          502,
          "Generated notes failed house-style lint.",
          "anki_note_lint",
          {
            failedNotes: (lintReport?.notes || [])
              .filter(note => note.issues.length)
              .map(note => ({ index: note.index, issues: note.issues.map(issue => issue.code) })),
            lint: lintReport?.stats,
          },
        );
      }
      console.warn("[ANKI] lint warning, returning repaired deck", {
        requestId,
        lint: lintReport?.stats,
        failedNotes: (lintReport?.notes || [])
          .filter(note => note.issues.length)
          .map(note => ({ index: note.index, issues: note.issues.map(issue => issue.code) })),
      });
    }

    const cardsTsv = buildAnkiTsv(cards);
    const quality = buildAnkiQualityPayload({
      ledger: slideLedger,
      lintReport,
      notes: cards,
      repairApplied,
      requestedTarget,
      targetDecision,
      coverageLimitedByMax,
      coverageFillAttempted,
      coverageFillSucceeded,
      coverageFillErrorStage,
      coverageFillErrorCode,
      coverageDegraded,
      coverageTelemetryAvailable,
      coverageTelemetryReason,
      targetCardOverrideUsed,
      noTextFallbackTarget,
      noTextBatchingUsed,
    });
    if (debugAnki) {
      console.log("[ANKI] parse-result", {
        requestId,
        cardsCount: cards.length,
        repairApplied,
        coverageStats,
        coverageFillAttempted,
        coverageFillSucceeded,
        coverageDegraded,
        coverageTelemetryAvailable,
        requestedTarget,
        targetCardOverrideUsed,
        noTextFallbackTarget,
        noTextBatchingUsed,
        lint: lintReport.stats,
      });
    }
    logAnkiStage(requestId, "openai", startMs, {
      outputChars: rawOutput.length,
      outputTextLength,
      cardsCount: cards.length,
      repairApplied,
      coverageLimitedByMax,
      coverageFillAttempted,
      coverageFillSucceeded,
      coverageFillErrorStage,
      coverageFillErrorCode,
      coverageDegraded,
      coverageTelemetryAvailable,
      coverageTelemetryReason,
      requestedTarget,
      targetCardOverrideUsed,
      noTextFallbackTarget,
      noTextBatchingUsed,
      uncitedSubstantivePages: coverageStats.uncitedSubstantivePages,
    });

    let code = "";
    try {
      code = await generateUniqueAnkiCode(env);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to generate a unique access code.";
      return ankiErrorResponse(requestId, "package", 500, message, "anki_code_generation");
    }

    const ankiKey = buildAnkiCardsKey(code);
    const { bucket } = getLibraryBucket(env);
    try {
      await bucket.put(ankiKey, cardsTsv, {
        httpMetadata: { contentType: "text/tab-separated-values; charset=utf-8" },
      });
    } catch (err) {
      console.error("[ANKI] Failed to store cards.tsv", { requestId, err });
      return ankiErrorResponse(requestId, "package", 502, "Failed to store cards.tsv.", "anki_store_tsv");
    }

    let mediaPrefix = "";
    if (preparedImages.length) {
      mediaPrefix = buildAnkiMediaPrefix(code);
      try {
        await promisePool(preparedImages, ANKI_IMAGE_UPLOAD_CONCURRENCY, async (image) => {
          const key = `${mediaPrefix}/${image.filename}`;
          await bucket.put(key, image.bytes, { httpMetadata: { contentType: "image/jpeg" } });
        });
      } catch (err) {
        console.warn("[ANKI] Failed to store media assets", err);
        mediaPrefix = "";
      }
    }

    const manifest: AnkiManifest = {
      code,
      ankiKey,
      lectureTitle,
      lectureId,
      createdAt: new Date().toISOString(),
      createdBy: resolveAnkiCreatedBy(req),
      imageCount: preparedImages.length,
      hasBoldmap: Boolean(boldmapFile),
      hasClassmateDeck: Boolean(classmateFile),
      mediaPrefix: mediaPrefix || undefined,
    };
    try {
      await persistAnkiManifest(env, manifest);
    } catch (err) {
      console.warn("[ANKI] Failed to persist manifest", { requestId, err });
    }

    logAnkiStage(requestId, "package", startMs, { cardsBytes: cardsTsv.length });
    logAnkiStage(requestId, "respond", startMs, { code });

    const downloadUrl = `/api/anki/download?code=${encodeURIComponent(code)}`;
    const responsePayload: Record<string, unknown> = {
      requestId,
      code,
      ankiKey,
      downloadUrl,
      lectureTitle,
      lectureId,
      quality,
    };
    if (warnings.length) {
      responsePayload.warnings = warnings;
    }
    await recordMetricEvent(env, {
      name: "artifact_generated",
      requestId,
      artifactType: "anki",
      artifactCode: code,
      lectureId,
      userId: auth.context.session.userId,
      role: auth.context.session.role,
      institutionId: auth.context.session.institutionId,
      metadata: {
        cardsCount: cards.length,
        requestedTarget,
        repairApplied,
        coverageDegraded,
        coverageTelemetryAvailable,
        warnings,
      },
    });
    return jsonNoStore(responsePayload);
  } catch (err) {
    console.error("[ANKI] Unhandled error", { requestId, err });
    return ankiErrorResponse(requestId, "respond", 500, "Unexpected error. Please retry.", "anki_unhandled");
  }
}

async function handleAnkiDownload(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const rawCode = url.searchParams.get("code") || "";
  const code = normalizeAnkiCode(rawCode);
  if (!isAnkiCodeValid(code)) {
    return jsonNoStore({ error: "Invalid code." }, 400);
  }
  const isFaculty = await isFacultyRequest(req, env);
  if (!isFaculty) {
    const limit = await checkAnkiRateLimit(env, req);
    if (!limit.allowed) {
      return jsonNoStore({ error: "Too many attempts. Try again later." }, 429);
    }
  }
  const manifest = await loadAnkiManifest(env, code);
  if (!manifest) {
    return jsonNoStore({ error: "Invalid code." }, 404);
  }
  const { bucket } = getLibraryBucket(env);
  const object = await bucket.get(manifest.ankiKey);
  if (!object || !object.body) {
    return jsonNoStore({ error: "Invalid code." }, 404);
  }
  await recordMetricEvent(env, {
    name: "artifact_opened",
    requestId: getRequestId(req),
    artifactType: "anki",
    artifactCode: code,
    lectureId: manifest.lectureId,
    metadata: {
      lectureTitle: manifest.lectureTitle,
      isFaculty,
      hasMedia: Boolean(manifest.mediaPrefix),
    },
  });
  return new Response(object.body, {
    headers: {
      ...CORS_HEADERS,
      ...NO_STORE_HEADERS,
      "Content-Type": object.httpMetadata?.contentType || "text/tab-separated-values; charset=utf-8",
      "Content-Disposition": `attachment; filename=\"${ANKI_CARDS_FILENAME}\"`,
    },
  });
}

async function handleGenerateFile(req: Request, env: Env): Promise<Response> {
  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return json({ error: "Send a JSON object body." }, 400);
  }

  const payload = raw as Partial<GenerateFileRequest>;
  const normalizedMessages = normalizeChatMessagesPreservingImages(payload.messages);
  if (!normalizedMessages.length) {
    return json({ error: "messages must include at least one non-empty entry." }, 400);
  }

  const agent = resolveAgent(typeof payload.agentId === "string" ? payload.agentId : undefined);
  const defaultAgent = resolveAgent(null);
  const desiredType = typeof payload.desiredFileType === "string" ? payload.desiredFileType : "txt";
  const ext = desiredType.replace(/^\./, "").toLowerCase() || "txt";
  const mime = mimeFromExtension(ext);
  const model = resolveModelId(DEFAULT_TEXT_MODEL, env);
  const fileSystemPrompt = `
You are OWEN, generating a single ${ext} file as output.
Rules:
Output ONLY the file contents, no explanations, no backticks, no surrounding markdown fences.
The user will download this text as a .${ext} file.
Do not include any commentary, only the raw file data.
`.trim();

  const userContent = normalizedMessages
    .map((message) => `${message.role.toUpperCase()}: ${messageContentToPlainText(message.content)}`)
    .filter((line) => line.trim().length > 0)
    .join("\n\n");

  const openAIPayload = {
    model,
    messages: [
      { role: "system", content: fileSystemPrompt },
      { role: "user", content: userContent },
    ],
  };
  const result = await sendOpenAIWithUnsupportedParamRetry<{ completion: OpenAIJson }>({
    payload: openAIPayload,
    endpoint: "chat_completions",
    env,
    label: "generate-file",
    send: async (attemptPayload) => {
      const upstream = await fetch(`${env.OPENAI_API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(attemptPayload),
      });
      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => "Unable to contact OpenAI.");
        return { ok: false, errorText: errText, status: upstream.status || 502 };
      }
      const completion = await upstream.json().catch(() => null);
      return { ok: true, value: { completion } };
    },
  });

  if (!result.ok) {
    return json({ error: result.errorText }, result.status || 502);
  }

  const completion = result.value.completion;
  const content = extractChatCompletionContent(completion);
  const targetBucketName = agent.defaultBuckets?.[0] || defaultAgent.defaultBuckets?.[0] || "OWEN_UPLOADS";
  const bucketLookup = lookupBucket(env, targetBucketName);
  if (!bucketLookup) {
    return json({ error: `Bucket ${targetBucketName} is not configured.` }, 500);
  }

  const key = `${Date.now()}-owen.${ext || "txt"}`;
  await bucketLookup.bucket.put(key, content, {
    httpMetadata: { contentType: mime },
  });

  return json({ bucket: bucketLookup.name, key });
}

async function handleExtract(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return json({ error: "Send JSON { file_id }." }, 400);
  }
  console.log("extract endpoint: stripping attachment metadata");
  delete (body as any).attachments;
  delete (body as any).files;
  delete (body as any).fileRefs;
  const fileId = typeof (body as any).file_id === "string" ? (body as any).file_id.trim() : "";
  if (!fileId) {
    return json({ error: "Missing file_id." }, 400);
  }
  const filename = typeof (body as any).filename === "string" ? (body as any).filename : undefined;
  const model = resolveModelId(DEFAULT_TEXT_MODEL, env);

  const prompt = [
    "You are a code interpreter assistant.",
    "Open the attached document, extract the text, and produce a concise summary.",
    "Respond strictly in JSON with keys:",
    `"summary" (<=200 words), "key_points" (array of short bullet strings),`,
    `"raw_excerpt" (first ~800 characters of raw text).`,
  ].join(" ");

  const payload = {
    model,
    text: { format: { type: "json_object" as const } },
    input: [
      {
        role: "user" as const,
        content: [
          { type: "input_file" as const, file_id: fileId },
          { type: "input_text" as const, text: prompt },
        ],
      },
    ],
    max_output_tokens: 800,
  };

  let text = "";
  try {
    const result = await callResponsesOnce(env, payload, `extract:${filename || fileId}`);
    text = result.text || "";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message || "Unable to contact OpenAI." }, 502);
  }
  let parsed: any = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed.summary = text;
  }

  // Some models occasionally nest the JSON as a string; unwrap it when detected.
  if (typeof parsed.summary === "string") {
    try {
      const nested = JSON.parse(parsed.summary);
      if (nested && typeof nested === "object") {
        if (typeof nested.summary === "string") parsed.summary = nested.summary;
        if (Array.isArray(nested.key_points)) parsed.key_points = nested.key_points;
        if (typeof nested.raw_excerpt === "string") parsed.raw_excerpt = nested.raw_excerpt;
        if (typeof nested.filename === "string" && !parsed.filename) parsed.filename = nested.filename;
      }
    } catch {}
  }

  return json({
    summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
    key_points: Array.isArray(parsed.key_points) ? parsed.key_points.filter((point: unknown): point is string => typeof point === "string") : [],
    raw_excerpt: typeof parsed.raw_excerpt === "string" ? parsed.raw_excerpt : undefined,
    filename,
  });
}

async function performDocumentTextExtraction(env: Env, opts: { fileId: string; visionFileId?: string | null; filename: string; mimeType?: string | null }) {
  const { fileId, visionFileId, filename, mimeType } = opts;
  const kind = inferIngestKind(filename, mimeType);
  // Prefer direct vision OCR for images when available.
  if (kind === "image" && visionFileId) {
    try {
      const visionText = await requestVisionTextExtraction(env, visionFileId, filename);
      if (visionText.trim()) {
        console.log("Vision OCR succeeded", { filename, textLength: visionText.length });
        return `[OCR]\n${visionText.trim()}`;
      }
    } catch (err) {
      console.warn("Vision OCR failed, falling back to doc extraction", { filename, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const defaultTextModelId = resolveModelId(DEFAULT_TEXT_MODEL, env);
  const failures: Array<{ model: string; message: string }> = [];
  try {
    console.log("[PDF] Attempting OCR extraction via /responses", { filename, kind });
    const text = await requestDocumentTextExtraction(env, fileId, filename);
    let cleaned = (text || "").trim();
    const failurePhrases = [
      "unable to open files directly",
      "can't read the pdf",
      "cant read the pdf",
      "cannot read the pdf",
      "please re-upload the file",
      "could not read the file",
    ];
    if (failurePhrases.some(phrase => cleaned.toLowerCase().includes(phrase))) {
      cleaned = "";
    }
    if (cleaned) {
      // If PDF extraction is suspiciously short, attempt a vision OCR fallback when possible.
      if (kind === "pdf" && cleaned.length < 500 && visionFileId) {
        try {
          console.log("[PDF] Extraction is short; trying vision OCR fallback", { filename });
          const visionText = await requestVisionTextExtraction(env, visionFileId, filename);
          if (visionText.trim()) {
            return `[OCR]\n${visionText.trim()}`;
          }
        } catch (visionErr) {
          const msg = visionErr instanceof Error ? visionErr.message : String(visionErr);
          failures.push({ model: `${defaultTextModelId}(vision)`, message: msg });
          console.warn("[PDF] Vision OCR fallback failed", { filename, message: msg });
        }
      }
      console.log("[PDF] OCR extraction succeeded", { model: defaultTextModelId, textLength: cleaned.length });
      return cleaned.slice(0, MAX_OCR_TEXT_LENGTH);
    } else if (!cleaned && visionFileId) {
      try {
        console.log("[PDF] Primary OCR empty; trying vision OCR fallback", { filename });
        const visionText = await requestVisionTextExtraction(env, visionFileId, filename);
        if (visionText.trim()) {
          return `[OCR]\n${visionText.trim()}`;
        }
      } catch (visionErr) {
        const msg = visionErr instanceof Error ? visionErr.message : String(visionErr);
        failures.push({ model: `${defaultTextModelId}(vision)`, message: msg });
        console.warn("[PDF] Vision OCR fallback after empty result failed", { filename, message: msg });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push({ model: defaultTextModelId, message });
    console.warn("OCR extraction failed", { model: defaultTextModelId, message });
  }
  const detail = failures.length
    ? failures.map(entry => `[${entry.model}] ${entry.message}`).join("; ")
    : "No OCR models available.";
  throw new Error(`OCR request failed: ${detail}`);
}

type IngestKind = "text" | "pdf" | "image" | "office" | "other";

function inferIngestKind(filename: string, mimeType?: string | null): IngestKind {
  const name = (filename || "").toLowerCase();
  const mime = (mimeType || "").toLowerCase();
  if (mime.startsWith("image/") || isLikelyImageFilename(name)) return "image";
  if (mime.includes("pdf") || isLikelyPdfFilename(name)) return "pdf";
  if (mime.startsWith("text/") || isTextKeyByExtension(name)) return "text";
  if (mime.includes("msword") || mime.includes("officedocument") || mime.includes("powerpoint")) return "office";
  return "other";
}

type OcrPrimitiveOptions = { label?: string; maxOutputTokens?: number };

async function callResponsesOcr(
  env: Env,
  content: ResponsesInputContent[],
  opts: OcrPrimitiveOptions = {},
): Promise<string> {
  const base = env.OPENAI_API_BASE?.replace(/\/$/, "") || "https://api.openai.com/v1";
  const maxTokens = Math.min(OCR_MAX_OUTPUT_TOKENS, Math.max(200, opts.maxOutputTokens ?? OCR_MAX_OUTPUT_TOKENS));
  const payload = {
    model: resolveModelId(DEFAULT_TEXT_MODEL, env),
    input: [
      {
        role: "user" as const,
        content,
      },
    ],
    max_output_tokens: maxTokens,
  };

  console.log("[OCR] Sending /responses request", {
    label: opts.label || "ocr",
    contentTypes: content.map(part => part.type),
  });

  let raw = "";
  try {
    const result = await callResponsesOnce(env, payload, opts.label || "ocr");
    raw = result.text || "";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[OCR] OpenAI error", { label: opts.label || "ocr", message });
    throw new Error(message || "OCR request failed.");
  }
  return raw.slice(0, MAX_OCR_TEXT_LENGTH);
}

async function requestVisionTextExtraction(env: Env, visionFileId: string, filename: string) {
  const prompt = [
    "You are an OCR service helping Owen answer questions.",
    "Read the attached image carefully and transcribe all visible text.",
    "Preserve layout where possible: headings, bullets, table cells.",
    "If multi-page, prepend each page with markers like [Page 1], [Page 2].",
    "Use ? for uncertain characters; do not invent text.",
    'Respond strictly as JSON: { "pages": [ { "page": "<label or number>", "text": "<clean text>" } ] } and include at least one entry.',
  ].join(" ");

  const raw = await callResponsesOcr(
    env,
    [
      { type: "input_text", text: prompt },
      { type: "input_image", file_id: visionFileId, detail: "high" as const },
    ],
    { label: `vision-file:${filename}` },
  );
  if (!raw) return "";

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.pages)) {
      const formatted = formatExtractedPages(parsed.pages);
      if (formatted) return formatted;
    }
    if (typeof parsed?.text === "string" && parsed.text.trim()) {
      return parsed.text.trim().slice(0, MAX_OCR_TEXT_LENGTH);
    }
  } catch {
    // fall through to raw handling
  }
  return raw.slice(0, MAX_OCR_TEXT_LENGTH);
}

async function requestDocumentTextExtraction(env: Env, fileId: string, filename: string) {
  const prompt = [
    `You are a document ingestion (text extraction + OCR) service helping OWEN answer questions.`,
    `Open the attached file (${filename || "Document"}). The file may be text-based or scanned.`,
    `For text-based PDFs: extract embedded text. For scanned PDFs/images: render pages (if needed) and OCR.`,
    `Extract full text in reading order. Preserve headings, bullet points, and table cell contents.`,
    `If the document has pages or slides, prepend each section with markers like [Page 1] or [Slide 2].`,
    `Do NOT summarize. Do NOT fabricate text. Use ? for uncertain characters.`,
    `Respond strictly as JSON: { "pages": [ { "page": "<label or number>", "text": "<clean text>" } ] } and include at least one entry.`,
  ].join(" ");

  const raw = await callResponsesOcr(
    env,
    [
      {
        type: "input_text",
        text: prompt,
      },
      {
        type: "input_file",
        file_id: fileId,
      },
    ],
    { label: `doc-file:${filename}` },
  );
  if (!raw) return "";

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (Array.isArray(parsed?.pages)) {
    const formatted = formatExtractedPages(parsed.pages);
    if (formatted) return formatted;
  }
  if (typeof parsed?.text === "string" && parsed.text.trim()) {
    return parsed.text.trim().slice(0, MAX_OCR_TEXT_LENGTH);
  }
  return raw.slice(0, MAX_OCR_TEXT_LENGTH);
}

function formatExtractedPages(pages: any[]): string {
  let buffer = "";
  for (const entry of pages) {
    if (!entry || typeof entry !== "object") continue;
    const rawNumber = "page" in entry ? entry.page : entry.page_number ?? entry.number;
    const pageNumber = typeof rawNumber === "number" ? rawNumber : Number(rawNumber);
    const label =
      typeof rawNumber === "string" && rawNumber.trim()
        ? rawNumber.trim()
        : Number.isFinite(pageNumber)
          ? `Page ${pageNumber}`
          : "Page";
    const text = typeof entry.text === "string" ? entry.text.trim() : "";
    const normalizedText = text || NO_TEXT_PLACEHOLDER;
    const block = `[${label}] ${normalizedText}\n\n`;
    buffer += block;
    if (buffer.length >= MAX_OCR_TEXT_LENGTH) {
      return buffer.slice(0, MAX_OCR_TEXT_LENGTH);
    }
  }
  const trimmed = buffer.trim();
  return trimmed.slice(0, MAX_OCR_TEXT_LENGTH);
}

const MIN_PDF_TEXT_LENGTH_FOR_EMBEDDED = 200;
const OCR_IMAGE_DETAIL: InputImageDetail = "high";
const OCR_PDF_RENDER_MAX_DIMENSION = 1600;
const OCR_PDF_RENDER_BASE_SCALE = 2;
const OCR_BATCH_IMAGE_COUNT = 3;

type TranscriptIngestResult = { text: string; source: "ocr" | "original" };
type ImageSignature = "png" | "jpg" | "unknown";
type PreparedOcrImage =
  | {
      ok: true;
      dataUrl: string;
      mimeType: string;
      signature: ImageSignature;
      head: string;
      byteLength: number;
    }
  | {
      ok: false;
      mimeType: string;
      signature: ImageSignature;
      head: string;
      byteLength: number;
    };

function isLikelyPdfFilename(name: string) {
  return /\.pdf$/i.test(name || "");
}

function isLikelyTxtFilename(name: string) {
  return /\.txt$/i.test(name || "");
}

function isTranscriptMimeType(mimeType: string) {
  const lowered = (mimeType || "").toLowerCase();
  return lowered === "text/plain" || lowered.startsWith("text/plain");
}

async function readFileHeaderBytes(file: File, length: number) {
  const slice = file.slice(0, length);
  const ab = await slice.arrayBuffer();
  return new Uint8Array(ab);
}

function bytesMatch(bytes: Uint8Array, signature: number[]) {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

function isPdfSignature(bytes: Uint8Array) {
  return bytesMatch(bytes, [0x25, 0x50, 0x44, 0x46]); // %PDF
}

async function sniffPdfHeader(file: File) {
  const header = await readFileHeaderBytes(file, ANKI_SNIFF_HEADER_BYTES);
  return { header, isPdf: isPdfSignature(header) };
}

function isJpegSignature(bytes: Uint8Array) {
  return bytesMatch(bytes, [0xff, 0xd8, 0xff]);
}

function isPngSignature(bytes: Uint8Array) {
  return bytesMatch(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

function isLikelyPrintableByte(byte: number) {
  if (byte === 9 || byte === 10 || byte === 13) return true;
  if (byte >= 32 && byte <= 126) return true;
  return false;
}

async function isProbablyTextFile(file: File) {
  const header = await readFileHeaderBytes(file, ANKI_TEXT_SNIFF_BYTES);
  if (!header.length) return false;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    decoder.decode(header);
  } catch {
    return false;
  }
  let printable = 0;
  for (const byte of header) {
    if (isLikelyPrintableByte(byte)) printable += 1;
  }
  const ratio = printable / header.length;
  return ratio >= ANKI_TEXT_PRINTABLE_THRESHOLD;
}

/**
 * Detect whether a File looks like a PDF based on header bytes.
 *
 * @param file - File object to inspect.
 * @returns True when the file signature matches PDF.
 */
export async function isAnkiPdfFile(file: File) {
  const { isPdf } = await sniffPdfHeader(file);
  return isPdf;
}

const ANKI_ALLOWED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function isAnkiAllowedImageMimeType(mimeType: string) {
  return ANKI_ALLOWED_IMAGE_MIME_TYPES.has((mimeType || "").toLowerCase());
}

function isAnkiAllowedImageFilename(name: string) {
  return /\.(png|jpe?g|webp)$/i.test(name || "");
}

async function isAnkiImageFile(file: File) {
  if (isAnkiAllowedImageFilename(file.name) || isAnkiAllowedImageMimeType(file.type)) return true;
  const header = await readFileHeaderBytes(file, ANKI_SNIFF_HEADER_BYTES);
  return isJpegSignature(header) || isPngSignature(header);
}

async function isAnkiTranscriptFile(file: File) {
  if (isTranscriptMimeType(file.type) || isLikelyTxtFilename(file.name)) return true;
  if (!file.type || file.type.toLowerCase() === "application/octet-stream") {
    return isLikelyTxtFilename(file.name);
  }
  return isProbablyTextFile(file);
}

function isLikelyImageFilename(name: string) {
  return /\.(png|jpe?g|gif|webp|bmp|tiff?|heic)$/i.test(name || "");
}

function isPdfMimeType(mimeType: string) {
  return (mimeType || "").toLowerCase().includes("pdf");
}

function isImageMimeType(mimeType: string) {
  return (mimeType || "").toLowerCase().startsWith("image/");
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

/**
 * Guess a MIME type from a filename extension.
 *
 * @param name - Filename or path string.
 * @returns MIME type string (defaults to application/octet-stream).
 */
export function guessMimeTypeFromFilename(name: string): string {
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

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x2000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function detectImageSignature(bytes: Uint8Array): ImageSignature {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpg";
  }
  return "unknown";
}

function normalizeOcrImageMime(mimeType: string, signature: ImageSignature): string {
  if (signature === "png") return "image/png";
  if (signature === "jpg") return "image/jpeg";
  if ((mimeType || "").toLowerCase().startsWith("image/")) return mimeType;
  return "application/octet-stream";
}

function prepareOcrImageInput(bytes: Uint8Array, mimeType: string): PreparedOcrImage {
  const signature = detectImageSignature(bytes);
  const normalizedMime = normalizeOcrImageMime(mimeType, signature);
  const base64 = bytesToBase64(bytes);
  const head = base64.slice(0, 12);
  if (signature === "unknown") {
    return {
      ok: false,
      mimeType: normalizedMime,
      signature,
      head,
      byteLength: bytes.length,
    };
  }
  const dataUrl = `data:${normalizedMime};base64,${base64}`;
  return {
    ok: true,
    dataUrl,
    mimeType: normalizedMime,
    signature,
    head,
    byteLength: bytes.length,
  };
}

function inspectDataUrlMeta(dataUrl: string): { mimeType: string; head: string; signature: ImageSignature; byteLength?: number } {
  const match = /^data:([^;]+);base64,([a-zA-Z0-9+/=]+)/.exec(dataUrl) || [];
  const mimeType = match[1] || "";
  const b64 = match[2] || "";
  const head = b64.slice(0, 12);
  let signature: ImageSignature = "unknown";
  try {
    const sliceLen = Math.min(Math.max(8, head.length), b64.length);
    const padded = b64.slice(0, sliceLen);
    const padLength = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4);
    const decoded = atob(padded.padEnd(padded.length + padLength, "="));
    const probe = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i += 1) {
      probe[i] = decoded.charCodeAt(i);
    }
    signature = detectImageSignature(probe);
  } catch {
    signature = "unknown";
  }
  const byteLength = b64 ? Math.floor((b64.length * 3) / 4) : undefined;
  return { mimeType, head, signature, byteLength };
}

function logOcrInputDebug(meta: { key?: string; head?: string; mimeType?: string; signature?: ImageSignature; byteLength?: number }) {
  console.log("[OCR_INPUT]", {
    key: meta.key || "unknown",
    head: (meta.head || "").slice(0, 12),
    mime: meta.mimeType || "unknown",
    sig: meta.signature || "unknown",
    len: meta.byteLength ?? 0,
  });
}

function invalidImagePayload(extra: Record<string, unknown> = {}) {
  return {
    ok: false,
    error: { code: "invalid_image_bytes" },
    answer: "OCR input was not a valid image.",
    ...extra,
  };
}

function normalizeExtractedText(value: string): string {
  let text = normalizePlainText(value);
  if (!text) return text;

  // Ensure page markers are separated and spaced
  text = text.replace(/([a-z])(?=page\s*\d+)/gi, "$1 ");
  text = text.replace(/(---\s*page\s*\d+\s*---)(?=\S)/gi, "$1\n");
  text = text.replace(/(page\s*\d+)(?=\S)/gi, "$1 ");

  // Remove obvious OCR junk lines
  const junkLines = new Set(["dh", "r", "met"]);
  const lines = text.split("\n");
  const cleanedLines: string[] = [];
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      cleanedLines.push("");
      return;
    }
    const lower = trimmed.toLowerCase();
    if (junkLines.has(lower)) return;
    if (/^kcu[-\s]?com/i.test(trimmed)) return;
    if (/^dr\./i.test(trimmed) && trimmed === trimmed.toUpperCase()) return;
    cleanedLines.push(line);
  });

  text = cleanedLines.join("\n");

  // Repair hyphenation artifacts lightly
  text = text.replace(/-\s*\n\s*/g, "");
  text = text.replace(/\s{3,}/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return normalizePlainText(text);
}

async function ingestBinaryForTranscript(
  env: Env,
  {
    bytes,
    filename,
    mimeType,
    sourceKey,
  }: {
    bytes: Uint8Array;
    filename: string;
    mimeType: string;
    sourceKey?: string;
  },
): Promise<TranscriptIngestResult | null> {
  const name = filename || "document";
  const mime = mimeType || "";

  if (isTextKeyByExtension(name) || isTextContentType(mime)) {
    try {
      const decoded = new TextDecoder().decode(bytes);
      const normalized = normalizeExtractedText(decoded);
      if (!normalized) return null;
      return { text: normalized.slice(0, MAX_OCR_TEXT_LENGTH), source: "original" };
    } catch {
      // fall through
    }
  }

  if (isLikelyPdfFilename(name) || isPdfMimeType(mime)) {
    if (PDFJS_AVAILABLE) {
      try {
        const embedded = await extractEmbeddedTextFromPdf(bytes);
        if (embedded.length >= MIN_PDF_TEXT_LENGTH_FOR_EMBEDDED) {
          return { text: embedded.slice(0, MAX_OCR_TEXT_LENGTH), source: "original" };
        }
      } catch (err) {
        console.warn("Embedded PDF extraction failed; continuing to OCR fallback", {
          filename: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      console.log("PDF.js unavailable in Worker; skipping embedded extraction.", { filename: name });
    }
    // If pdfjs is not available, return null to let the legacy CI extraction path run.
    return null;
  }

  if (isLikelyImageFilename(name) || isImageMimeType(mime)) {
    try {
      const inferredMime = isImageMimeType(mime) ? mime : guessImageMimeTypeFromFilename(name) || "image/png";
      const prepared = prepareOcrImageInput(bytes, inferredMime);
      if (!prepared.ok) {
        console.warn("Image OCR ingestion blocked due to invalid bytes", {
          filename: name,
          key: sourceKey,
          head: prepared.head,
          mimeType: prepared.mimeType,
        });
        return null;
      }
      const extracted = await requestVisionOcrFromImages(
        env,
        [
          {
            label: "Image OCR",
            dataUrl: prepared.dataUrl,
            sourceKey: sourceKey || name,
            mimeType: prepared.mimeType,
            signature: prepared.signature,
            byteLength: prepared.byteLength,
            head: prepared.head,
          },
        ],
        name,
      );
      if (!extracted) return null;
      const tagged = `[OCR]\n${extracted}`.slice(0, MAX_OCR_TEXT_LENGTH);
      return { text: tagged, source: "ocr" };
    } catch (err) {
      console.warn("Image OCR ingestion failed; allowing fallback", {
        filename: name,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  return null;
}

function buildSamplePageNumbers(pageCount: number, target = PDF_SAMPLE_PAGE_TARGET): number[] {
  const total = Math.max(1, Math.min(pageCount, target));
  if (total >= pageCount) {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }
  const pages = new Set<number>();
  pages.add(1);
  pages.add(pageCount);
  for (let i = 0; pages.size < total; i += 1) {
    const ratio = (i + 1) / (total + 1);
    const page = Math.max(1, Math.min(pageCount, Math.round(pageCount * ratio)));
    pages.add(page);
  }
  return Array.from(pages).sort((a, b) => a - b);
}

async function extractPdfPageText(doc: any, pageNum: number): Promise<string> {
  const page = await doc.getPage(pageNum);
  const content = await page.getTextContent();
  let buffer = "";
  for (const item of content.items as any[]) {
    const str = typeof item?.str === "string" ? item.str : "";
    if (!str) continue;
    buffer += str;
    buffer += item?.hasEOL ? "\n" : " ";
  }
  try {
    await page.cleanup?.();
  } catch {}
  return normalizePlainText(buffer);
}

async function extractEmbeddedPagesFromPdf(
  pdfBytes: Uint8Array,
  opts: { sampleOnly?: boolean; allowEarlyStop?: boolean; maxPages?: number; sampleCount?: number } = {},
): Promise<{ pages: PageText[]; pageCount: number; sampleTextLength: number; sampledPagesWithText: number; scanned: boolean }> {
  if (!PDFJS_AVAILABLE) {
    console.warn("PDF.js unavailable; skipping embedded text extraction.");
    return { pages: [], pageCount: 0, sampleTextLength: 0, sampledPagesWithText: 0, scanned: true };
  }
  const task = pdfjs.getDocument({
    data: pdfBytes,
    disableWorker: true,
  });
  const doc = await task.promise;
  const pageCount = doc?.numPages || 0;
  if (!pageCount) {
    return { pages: [], pageCount: 0, sampleTextLength: 0, sampledPagesWithText: 0, scanned: true };
  }
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? MAX_EXTRACT_PAGES, pageCount || MAX_EXTRACT_PAGES));
  const samplePages = buildSamplePageNumbers(pageCount, opts.sampleCount ?? PDF_SAMPLE_PAGE_TARGET);
  const seen = new Set<number>();
  const pages: PageText[] = [];
  let sampleTextLength = 0;
  let sampledPagesWithText = 0;

  try {
    for (const pageNum of samplePages) {
      const normalized = await extractPdfPageText(doc, pageNum);
      if (normalized) {
        pages.push({ pageIndex: pageNum - 1, text: normalized });
        sampleTextLength += normalized.length;
        sampledPagesWithText += 1;
      }
      seen.add(pageNum);
    }

    const treatAsEmbedded = sampleTextLength >= MIN_EMBEDDED_PDF_CHARS || sampledPagesWithText >= 3;
    if (opts.sampleOnly || (!treatAsEmbedded && opts.allowEarlyStop !== false)) {
      return { pages, pageCount, sampleTextLength, sampledPagesWithText, scanned: !treatAsEmbedded };
    }

    for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
      if (seen.has(pageNum)) continue;
      const normalized = await extractPdfPageText(doc, pageNum);
      if (normalized) {
        pages.push({ pageIndex: pageNum - 1, text: normalized });
      }
    }
    pages.sort((a, b) => a.pageIndex - b.pageIndex);

    return { pages, pageCount, sampleTextLength, sampledPagesWithText, scanned: false };
  } finally {
    try {
      await doc.cleanup?.();
      await doc.destroy?.();
    } catch {}
  }
}

async function extractEmbeddedTextFromPdf(pdfBytes: Uint8Array): Promise<string> {
  const result = await extractEmbeddedPagesFromPdf(pdfBytes, { allowEarlyStop: false, sampleCount: PDF_SAMPLE_PAGE_TARGET });
  const normalized = normalizePages(result.pages);
  return normalized.text;
}

async function renderPdfPageToPngDataUrl(page: any): Promise<string> {
  if (typeof OffscreenCanvas === "undefined") {
    throw new Error("OffscreenCanvas is unavailable in this runtime; skipping PDF render OCR path.");
  }
  const baseViewport = page.getViewport({ scale: 1 });
  const baseMax = Math.max(baseViewport.width, baseViewport.height);
  let scale = OCR_PDF_RENDER_BASE_SCALE;
  if (baseMax * scale > OCR_PDF_RENDER_MAX_DIMENSION) {
    scale = OCR_PDF_RENDER_MAX_DIMENSION / baseMax;
  }
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;

  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    throw new Error("OffscreenCanvas 2D context unavailable (required for PDF OCR rendering).");
  }

  (ctx as any).fillStyle = "white";
  (ctx as any).fillRect(0, 0, width, height);

  const renderTask = page.render({ canvasContext: ctx, viewport });
  await renderTask.promise;

  const blob = await canvas.convertToBlob({ type: "image/png" });
  const ab = await blob.arrayBuffer();
  const b64 = bytesToBase64(new Uint8Array(ab));
  return `data:image/png;base64,${b64}`;
}

async function ocrPdfBytesWithVision(env: Env, pdfBytes: Uint8Array, filename: string): Promise<string> {
  console.warn("[PDF] OCR render path is disabled in Worker runtime.");
  return "";
}

async function requestVisionOcrFromImages(
  env: Env,
  pages: Array<{
    label: string;
    dataUrl: string;
    sourceKey?: string;
    mimeType?: string;
    signature?: ImageSignature;
    byteLength?: number;
    head?: string;
  }>,
  filename: string,
): Promise<string> {
  const prompt = [
    "You are an OCR transcription service.",
    "Extract all readable text verbatim from EACH provided image.",
    "Preserve headings, bullets, tables, and line breaks as best as possible.",
    "If a character is unclear, replace it with '?'.",
    `Return strictly JSON: { "pages": [ { "page": "<label>", "text": "<text>" } ] }.`,
    "Use the label provided immediately before each image as the page value.",
  ].join(" ");

  const content: ResponsesInputContent[] = [{ type: "input_text", text: prompt }];
  const validatedPages: Array<{
    label: string;
    dataUrl: string;
    sourceKey?: string;
    mimeType: string;
    signature: ImageSignature;
    byteLength?: number;
    head?: string;
  }> = [];

  for (const page of pages) {
    const inspected = inspectDataUrlMeta(page.dataUrl);
    const signature = page.signature || inspected.signature;
    const mimeType = page.mimeType || inspected.mimeType || "application/octet-stream";
    const head = page.head || inspected.head;
    const byteLength = page.byteLength ?? inspected.byteLength;
    if (signature === "unknown") {
      console.warn("[OCR-PREP] Invalid image signature for OCR", {
        key: page.sourceKey || page.label || filename,
        head,
        mimeType,
        signature,
      });
      return "";
    }
    validatedPages.push({ ...page, mimeType, signature, byteLength, head });
    content.push({ type: "input_text", text: `LABEL: ${page.label}` });
    content.push({ type: "input_image", image_url: page.dataUrl, detail: OCR_IMAGE_DETAIL });
  }

  validatedPages.forEach(page =>
    logOcrInputDebug({
      key: page.sourceKey || page.label || filename,
      head: page.head,
      mimeType: page.mimeType,
      signature: page.signature,
      byteLength: page.byteLength,
    }),
  );

  const raw = await callResponsesOcr(env, content, { label: `vision-batch:${filename}` });
  if (!raw) return "";

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.pages)) {
      return formatExtractedPages(parsed.pages);
    }
    if (typeof parsed?.text === "string" && parsed.text.trim()) {
      return parsed.text.trim().slice(0, MAX_OCR_TEXT_LENGTH);
    }
  } catch {
    // fall through
  }

  return raw.slice(0, MAX_OCR_TEXT_LENGTH);
}

async function requestVisionOcrFromFileId(
  env: Env,
  visionFileId: string,
  label: string,
): Promise<string> {
  const prompt = [
    "You are an OCR transcription service.",
    "Extract all readable text verbatim from the attached image/PDF file.",
    "Preserve headings, bullets, tables, and line breaks as best as possible.",
    "If a character is unclear, replace it with '?'.",
    "Return strictly JSON: { \"pages\": [ { \"page\": \"<label>\", \"text\": \"<text>\" } ] }.",
  ].join(" ");

  const raw = await callResponsesOcr(
    env,
    [
      { type: "input_text" as const, text: prompt },
      { type: "input_text" as const, text: `LABEL: ${label || "Page"}` },
      { type: "input_image" as const, file_id: visionFileId, detail: "high" as InputImageDetail },
    ],
    { label: `vision-file:${label}` },
  );
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.pages)) {
      return formatExtractedPages(parsed.pages);
    }
    if (typeof parsed?.text === "string" && parsed.text.trim()) {
      return parsed.text.trim().slice(0, MAX_OCR_TEXT_LENGTH);
    }
  } catch {
    // fall through
  }
  return raw.slice(0, MAX_OCR_TEXT_LENGTH);
}

function shouldAttemptTextExtraction(filename: string, mime: string) {
  const loweredName = (filename || "").toLowerCase();
  const loweredMime = (mime || "").toLowerCase();
  const docExts = [".pdf", ".doc", ".docx", ".ppt", ".pptx", ".pptm", ".docm", ".rtf", ".odt", ".odp"];
  const imageExts = [".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".gif", ".webp", ".heic"];
  if (docExts.some(ext => loweredName.endsWith(ext))) return true;
  if (imageExts.some(ext => loweredName.endsWith(ext))) return true;
  if (loweredMime.includes("pdf")) return true;
  if (loweredMime.startsWith("image/")) return true;
  if (loweredMime.includes("msword") || loweredMime.includes("officedocument") || loweredMime.includes("powerpoint")) {
    return true;
  }
  return false;
}

function resolveBucket(env: Env, choice: FormDataEntryValue | null) {
  const requested = typeof choice === "string" ? choice : null;
  if ((requested || "").trim().toLowerCase() === "library") {
    return getLibraryBucket(env);
  }
  const defaultBinding = BUCKET_BINDINGS[DEFAULT_BUCKET];
  const lookup =
    lookupBucket(env, requested) ??
    lookupBucket(env, defaultBinding) ??
    lookupBucket(env, DEFAULT_BUCKET);
  if (!lookup) {
    throw new Error("No matching R2 bucket binding configured.");
  }
  return lookup;
}

function resolveBucketKey(bindingName: string) {
  const entry = Object.entries(BUCKET_BINDINGS).find(([, binding]) => binding === bindingName);
  return entry ? entry[0] : bindingName;
}

function resolveUploadPrefix(choice: FormDataEntryValue | null): string {
  const value = typeof choice === "string" ? choice : "";
  if (!value) return "";
  switch (value) {
    case "anki_decks":
      return "Anki Decks/";
    case "study_guides":
      return "Study Guides/";
    case "library":
      return "library/";
    default:
      return "";
  }
}

function getBucketByName(env: Env, name: string) {
  const lookup = lookupBucket(env, name);
  if (!lookup) throw new Error(`Unknown bucket ${name}`);
  return lookup.bucket;
}

async function handleFile(req: Request, env: Env): Promise<Response> {
  const auth = await requireFaculty(req, env, "file_download");
  if (!auth.ok) return auth.response;
  const url = new URL(req.url);
  const searchKey = url.searchParams.get("key");
  if (!searchKey) return json({ error: "Missing key parameter" }, 400);
  const requestedBucket = url.searchParams.get("bucket");
  const candidates = requestedBucket
    ? [requestedBucket]
    : Object.keys(BUCKET_BINDINGS);

  let object: R2ObjectBody | null = null;
  let bucketUsed: string | null = null;
  let matchedKey = searchKey;

  for (const name of candidates) {
    try {
      const bucket = getBucketByName(env, name);
      const match = await findObjectInBucket(bucket, searchKey);
      if (match) {
        object = match.object;
        bucketUsed = name;
        matchedKey = match.key;
        break;
      }
    } catch {
      continue;
    }
  }
  if (!object || !object.body) {
    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  }
  await writeAuditEvent(env, req, getRequestId(req), {
    event: "storage.object.read",
    outcome: "success",
    actor: buildAuditActor(auth.context.session),
    metadata: { bucket: bucketUsed, key: matchedKey },
  });
  const headers = new Headers(CORS_HEADERS);
  const contentType = object.httpMetadata?.contentType || "application/octet-stream";
  headers.set("content-type", contentType);
  const filenameParam = url.searchParams.get("filename");
  const filename = sanitizeFilename(filenameParam || matchedKey.split("/").pop() || "download.bin");
  headers.set("content-disposition", `attachment; filename="${filename}"`);
  if (bucketUsed) headers.set("x-owen-bucket", bucketUsed);
  return new Response(object.body, { headers });
}

async function handleDownload(req: Request, env: Env): Promise<Response> {
  const auth = await requireFaculty(req, env, "file_download");
  if (!auth.ok) return auth.response;
  const url = new URL(req.url);
  const bucketName = url.searchParams.get("bucket");
  const key = url.searchParams.get("key");
  if (!bucketName || !key) {
    return new Response("Missing bucket or key", { status: 400, headers: CORS_HEADERS });
  }
  const lookup = lookupBucket(env, bucketName);
  if (!lookup) {
    return new Response("Unknown bucket", { status: 400, headers: CORS_HEADERS });
  }
  const object = await lookup.bucket.get(key);
  if (!object || !object.body) {
    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  }
  await writeAuditEvent(env, req, getRequestId(req), {
    event: "storage.object.read",
    outcome: "success",
    actor: buildAuditActor(auth.context.session),
    metadata: { bucket: bucketName, key },
  });
  return new Response(object.body, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${key}"`,
    },
  });
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS, ...NO_STORE_HEADERS },
  });
}

function jsonResponse(obj: unknown, status = 200) {
  return jsonNoStore(obj, status);
}

function jsonNoStore(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS, ...NO_STORE_HEADERS },
  });
}

function mimeFromExtension(ext: string) {
  switch (ext) {
    case "md":
      return "text/markdown";
    case "json":
      return "application/json";
    case "csv":
      return "text/csv";
    case "txt":
    default:
      return "text/plain";
  }
}

function extractChatCompletionContent(payload: any) {
  const message = payload?.choices?.[0]?.message;
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  return "";
}

function encodeSSE({ event, data }: { event: string; data: string }) {
  return enc.encode(`event: ${event}\ndata: ${data}\n\n`);
}

function sanitizeKey(input: string | null, fallback: string) {
  if (!input) return fallback;
  const safe = input
    .trim()
    .replace(/\\/g, "/")
    .replace(/[^a-zA-Z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^\.+/, "");
  return safe || fallback;
}

function sanitizeFilename(name: string) {
  return name.replace(/[^\w.\-]+/g, "_");
}

async function findObjectInBucket(bucket: R2Bucket, candidateKey: string) {
  const attempts = new Set<string>();
  const trimmed = candidateKey.trim();
  if (trimmed) attempts.add(trimmed);
  const sanitized = sanitizeKey(trimmed, trimmed);
  if (sanitized) attempts.add(sanitized);

  for (const key of attempts) {
    try {
      const obj = await bucket.get(key);
      if (obj && obj.body) return { object: obj, key };
    } catch {}
  }

  for (const prefix of attempts) {
    if (!prefix) continue;
    try {
      const list = await bucket.list({ prefix });
      const match = list.objects?.[0];
      if (match) {
        const obj = await bucket.get(match.key);
        if (obj && obj.body) return { object: obj, key: match.key };
      }
    } catch {}
  }

  try {
    const list = await bucket.list();
    const match = list.objects?.find(obj =>
      Array.from(attempts).some(val => val && obj.key.endsWith(val)),
    );
    if (match) {
      const obj = await bucket.get(match.key);
      if (obj && obj.body) return { object: obj, key: match.key };
    }
  } catch {}

  return null;
}

function lookupBucket(env: Env, identifier?: string | null) {
  if (!identifier) return null;
  const trimmed = identifier.trim();
  if (!trimmed) return null;
  const envRecord = env as unknown as Record<string, unknown>;

  const direct = envRecord[trimmed];
  if (isR2BucketLike(direct)) {
    return { bucket: direct as R2Bucket, name: trimmed };
  }

  const upper = trimmed.toUpperCase();
  if (upper !== trimmed) {
    const upperMatch = envRecord[upper];
    if (isR2BucketLike(upperMatch)) {
      return { bucket: upperMatch as R2Bucket, name: upper };
    }
  }

  const lower = trimmed.toLowerCase();
  if (lower in BUCKET_BINDINGS) {
    const bindingName = BUCKET_BINDINGS[lower as keyof typeof BUCKET_BINDINGS];
    const bindingBucket = envRecord[bindingName];
    if (isR2BucketLike(bindingBucket)) {
      return { bucket: bindingBucket as R2Bucket, name: bindingName };
    }
  }

  return null;
}

function isR2BucketLike(value: unknown): value is R2Bucket {
  return Boolean(value) &&
    typeof (value as R2Bucket).put === "function" &&
    typeof (value as R2Bucket).get === "function";
}

async function loadFileTextFromBucket(bucket: R2Bucket, file: FileReference) {
  const candidates = buildTextKeyCandidates(file);
  console.log("Building OCR candidates for", {
    bucket: file.bucket,
    key: file.key,
    textKey: file.textKey,
    candidateKeys: candidates.map(candidate => candidate.key),
  });
  for (const candidate of candidates) {
    try {
      console.log("Attempting to load candidate", candidate);
      const object = await bucket.get(candidate.key);
      if (!object) {
        console.log("Candidate missing from bucket", { key: candidate.key });
        continue;
      }
      const contentType = object.httpMetadata?.contentType || "";
      const treatAsText = candidate.source === "ocr" || isTextKeyByExtension(candidate.key);
      if (!treatAsText && !isTextContentType(contentType)) {
        console.log("Skipping non-text candidate", { key: candidate.key, contentType });
        continue;
      }
      const text = await object.text();
      if (!text.trim()) {
        console.log("Candidate produced empty text", { key: candidate.key });
        continue;
      }
      console.log("OCR load success:", { key: candidate.key, textLength: text.length, source: candidate.source });
      return { text, source: candidate.source as "ocr" | "original", key: candidate.key };
    } catch (err) {
      console.warn(`Failed to load ${candidate.key} for ${file.bucket}/${file.key}`, err);
      continue;
    }
  }
  console.log("OCR load failure for all candidates", {
    bucket: file.bucket,
    key: file.key,
    textKey: file.textKey,
    candidates: candidates.map(candidate => candidate.key),
  });
  return null;
}

function buildTextKeyCandidates(file: FileReference) {
  const seen = new Set<string>();
  const candidates: Array<{ key: string; source: "ocr" | "original" }> = [];
  const addCandidate = (key: string, source: "ocr" | "original") => {
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ key, source });
  };

  for (const key of buildOcrCandidateKeys(file)) {
    addCandidate(key, "ocr");
  }
  for (const key of buildOriginalTextCandidates(file)) {
    addCandidate(key, "original");
  }
  return candidates;
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
  const candidates: Array<string | null> = [
    isTextKeyByExtension(trimmedKey) ? trimmedKey : null,
    isTextKeyByExtension(trimmedTextKey) ? trimmedTextKey : null,
    base ? `${base}.txt` : null,
    trimmedKey ? `${trimmedKey}.txt` : null,
  ];
  return uniqueStrings(candidates);
}

function stripExtensions(value?: string | null) {
  if (!value) return "";
  return value
    .replace(/\.ocr\.txt$/i, "")
    .replace(/\.txt$/i, "")
    .replace(/\.pdf$/i, "");
}

function uniqueStrings(values: Array<string | null | undefined>) {
  const set = new Set<string>();
  const results: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (set.has(key)) continue;
    set.add(key);
    results.push(trimmed);
  }
  return results;
}

function isTextContentType(contentType: string) {
  const lowered = contentType.toLowerCase();
  if (!lowered) return false;
  return lowered.startsWith("text/") ||
    lowered.includes("json") ||
    lowered.includes("csv") ||
    lowered.includes("xml");
}

function isTextKeyByExtension(key: string) {
  return /\.(txt|csv|json|xml|md|markdown|html|log)$/i.test(key);
}

async function attachFileToVectorStore(env: Env, storeId: string, fileId: string) {
  await openAIJsonFetch(env, `/vector_stores/${storeId}/files`, {
    method: "POST",
    json: { file_id: fileId },
  });
  return waitForVectorStoreFile(env, storeId, fileId);
}

async function waitForVectorStoreFile(env: Env, storeId: string, fileId: string) {
  const deadline = Date.now() + VECTOR_POLL_TIMEOUT_MS;
  let lastStatus = "queued";
  while (Date.now() < deadline) {
    const record = await fetchVectorStoreFileStatus(env, storeId, fileId);
    if (record.status === "completed") {
      return "completed";
    }
    if (record.status === "failed") {
      const message = record.last_error || "Vector store indexing failed.";
      throw new Error(message);
    }
    lastStatus = record.status || lastStatus;
    await delay(VECTOR_POLL_INTERVAL_MS);
  }
  return lastStatus || "processing";
}

async function fetchVectorStoreFileStatus(env: Env, storeId: string, fileId: string) {
  const data = await openAIJsonFetch(env, `/vector_stores/${storeId}/files/${fileId}`, { method: "GET" });
  return {
    status: typeof data?.status === "string" ? data.status : undefined,
    last_error: typeof data?.last_error?.message === "string" ? data.last_error.message : undefined,
  };
}

async function getPersistedVectorStoreId(env: Env) {
  if (env.VECTOR_STORE_ID?.trim()) return env.VECTOR_STORE_ID.trim();
  if (inMemoryVectorStoreId) return inMemoryVectorStoreId;
  if (env.DOCS_KV) {
    const stored = await env.DOCS_KV.get(VECTOR_STORE_CACHE_KEY);
    if (stored) {
      inMemoryVectorStoreId = stored;
      return stored;
    }
  }
  return null;
}

async function getOrCreateVectorStoreId(env: Env, label?: string) {
  const existing = await getPersistedVectorStoreId(env);
  if (existing) return existing;
  const now = new Date().toISOString();
  const name = label ? `OWEN • ${label}` : "OWEN Knowledge Base";
  const store = await openAIJsonFetch(env, "/vector_stores", {
    method: "POST",
    json: {
      name: name.slice(0, 60),
      metadata: { created_at: now },
    },
  });
  const storeId = typeof store?.id === "string" ? store.id : "";
  if (!storeId) throw new Error("OpenAI did not return a vector_store id.");
  inMemoryVectorStoreId = storeId;
  if (env.DOCS_KV) {
    await env.DOCS_KV.put(VECTOR_STORE_CACHE_KEY, storeId);
  }
  return storeId;
}

type OpenAIFetchOptions = RequestInit & { json?: unknown };

async function openAIJsonFetch(env: Env, path: string, options: OpenAIFetchOptions = {}) {
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

function delay(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

async function retryOpenAI(fn: (attempt: number) => Promise<Response>, label: string): Promise<Response> {
  let lastResp: Response | null = null;
  for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
    if (i > 0) {
      const delayMs = RETRY_DELAYS_MS[i] ?? 0;
      await delay(delayMs);
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

function formatDocumentSummaries(list: DocSummary[]) {
  return list
    .map(item => {
      const title = item.filename || item.file_id || "Attachment";
      const points = Array.isArray(item.key_points) && item.key_points.length
        ? `Key Points:\n- ${item.key_points.join("\n- ")}`
        : "";
      const summary = item.summary ? `Summary: ${item.summary}` : "";
      const excerpt = item.raw_excerpt ? `Excerpt: ${item.raw_excerpt}` : "";
      return [`Document: ${title}`, summary, points, excerpt].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

function extractOutputText(payload: any): string {
  if (!payload) return "";
  const stringifyContent = (content: any[]): string => {
    return content
      .map((part: any) => {
        if (typeof part?.text === "string") return part.text;
        if (part && typeof part.json === "object") return JSON.stringify(part.json);
        return "";
      })
      .filter(Boolean)
      .join("");
  };

  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }
  if (Array.isArray(payload.output_text)) {
    const joined = payload.output_text.filter(Boolean).join("\n");
    if (joined.trim()) return joined;
  }
  if (typeof payload.response?.output_text === "string") {
    if (payload.response.output_text.trim()) return payload.response.output_text;
  }
  if (Array.isArray(payload.response?.output_text)) {
    const joined = payload.response.output_text.filter(Boolean).join("\n");
    if (joined.trim()) return joined;
  }
  if (Array.isArray(payload.output)) {
    const joined = payload.output
      .map((item: any) =>
        Array.isArray(item?.content)
          ? stringifyContent(item.content)
          : "",
      )
      .filter(Boolean)
      .join("\n");
    if (joined.trim()) return joined;
  }
  if (Array.isArray(payload.response?.output)) {
    const joined = payload.response.output
      .map((item: any) =>
        Array.isArray(item?.content) ? stringifyContent(item.content) : "",
      )
      .filter(Boolean)
      .join("\n");
    if (joined.trim()) return joined;
  }
  return "";
}

function extractOutputTextLength(payload: any): number {
  if (!payload) return 0;
  const outputText = payload.output_text ?? payload.response?.output_text;
  if (typeof outputText === "string") return outputText.length;
  if (Array.isArray(outputText)) {
    return outputText.filter(Boolean).join("\n").length;
  }
  const extracted = extractOutputText(payload);
  return extracted.length;
}

function extractOutputItems(payload: any): any[] {
  if (Array.isArray(payload?.response?.output)) return payload.response.output;
  if (Array.isArray(payload?.output)) return payload.output;
  return [];
}

function normalizeUrlCitation(raw: any): UrlCitationAnnotation | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.type && raw.type !== "url_citation") return null;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  const start = Number(raw.start_index ?? raw.startIndex ?? raw.start);
  const end = Number(raw.end_index ?? raw.endIndex ?? raw.end);
  if (!url || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end <= start) return null;
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

function extractWebSearchSources(payload: any): unknown[] {
  const output = extractOutputItems(payload);
  const sources: unknown[] = [];
  output.forEach((item: any) => {
    if (item?.type !== "web_search_call") return;
    const list = Array.isArray(item?.action?.sources) ? item.action.sources : [];
    list.forEach((entry: unknown) => sources.push(entry));
  });
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

type WebSearchSource = {
  url: string;
  title?: string;
  domain: string;
  key: string;
  snippet?: string;
  retrievedAt?: number;
};

function normalizeSourceKey(value: string): string {
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

function normalizeWebSearchSources(rawSources: unknown[]): WebSearchSource[] {
  const map = new Map<string, WebSearchSource>();
  (rawSources || []).forEach(entry => {
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
    const retrievedAt = typeof (entry as any).retrieved_at === "number"
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
    if (existing && !existing.title && title) {
      existing.title = title;
    }
    if (existing && !existing.snippet && snippetCandidate) {
      existing.snippet = snippetCandidate;
    }
    if (existing && !existing.retrievedAt && retrievedAt) {
      existing.retrievedAt = retrievedAt;
    }
  });
  return Array.from(map.values());
}

function mergeCitationSources(
  citationSources: CitationSource[],
  searchSources: WebSearchSource[],
): CitationSource[] {
  if (!citationSources.length) return [];
  const lookup = new Map(searchSources.map(source => [normalizeSourceKey(source.url), source]));
  return citationSources.map(source => {
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

function buildFallbackSources(searchSources: WebSearchSource[]): CitationSource[] {
  return searchSources.map((source, index) => ({
    id: index + 1,
    url: source.url,
    title: source.title,
    domain: source.domain,
    snippet: source.snippet,
    retrievedAt: source.retrievedAt,
  }));
}

/**
 * Split text into segments with inline citation markers for UI rendering.
 *
 * @param text - Answer text to segment.
 * @param urlCitations - Citation spans with URL + index offsets.
 * @param state - Optional state maps to preserve ids across calls.
 * @returns Segments plus updated citation maps and next id counter.
 */
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

  citations.forEach(cite => {
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

function stripRenderedSourcesSectionText(text: string): string {
  const lines = (text || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = (lines[index] || "").trim();
    if (/^(#{1,6}\s*)?(sources|references)\s*:?\s*$/i.test(trimmed)) {
      return lines.slice(0, index).join("\n").trim();
    }
  }
  return (text || "").trim();
}

function splitTrailingInlineUrlPunctuation(rawUrl: string): { url: string; trailing: string } {
  const trimmed = rawUrl.replace(/[),.;:!?]+$/g, "");
  return {
    url: trimmed || rawUrl,
    trailing: rawUrl.slice((trimmed || rawUrl).length),
  };
}

function extractInlineUrlCitations(text: string, verifiedUrlKeys: Set<string>): UrlCitationAnnotation[] {
  const citations: UrlCitationAnnotation[] = [];
  const re = /https?:\/\/[^\s<>()]+/gi;
  for (const match of text.matchAll(re)) {
    const rawUrl = match[0];
    const normalized = splitTrailingInlineUrlPunctuation(rawUrl);
    const start = match.index ?? -1;
    if (start < 0) continue;
    if (verifiedUrlKeys.size && !verifiedUrlKeys.has(normalizeSourceKey(normalized.url))) continue;
    citations.push({
      start_index: start,
      end_index: start + normalized.url.length,
      url: normalized.url,
    });
  }
  return citations;
}

function buildCitedAnswerPayload(payload: any): {
  answerSegments: AnswerSegment[];
  sources: CitationSource[];
  consultedSources?: unknown[];
  answerText: string;
} {
  const consultedSources = extractWebSearchSources(payload);
  const normalizedSources = normalizeWebSearchSources(consultedSources);
  const verifiedUrlKeys = new Set(normalizedSources.map(source => normalizeSourceKey(source.url)));
  const parts = extractOutputTextPartsWithCitations(payload);
  if (!parts.length) {
    const text = stripRenderedSourcesSectionText(extractOutputText(payload).trim());
    const inlineCitations = extractInlineUrlCitations(text, verifiedUrlKeys);
    if (inlineCitations.length) {
      const result = segmentWithCitationPills(text, inlineCitations);
      const sources = mergeCitationSources(buildCitationSources(result.urlToId, result.urlMeta), normalizedSources);
      return {
        answerSegments: result.segments,
        sources,
        consultedSources,
        answerText: result.segments.map(segment => (segment.type === "text" ? segment.text : "")).join("").trim(),
      };
    }
    return {
      answerSegments: text ? [{ type: "text", text }] : [],
      sources: [],
      consultedSources,
      answerText: text,
    };
  }

  const state = { urlToId: new Map<string, number>(), urlMeta: new Map<string, { title?: string }>(), nextId: 1 };
  const answerSegments: AnswerSegment[] = [];
  let answerText = "";

  parts.forEach(part => {
    const text = stripRenderedSourcesSectionText(part.text);
    const citations = part.citations.length ? part.citations : extractInlineUrlCitations(text, verifiedUrlKeys);
    const result = segmentWithCitationPills(text, citations, state);
    answerSegments.push(...result.segments);
    state.nextId = result.nextId;
    answerText += text;
  });

  return {
    answerSegments,
    sources: mergeCitationSources(buildCitationSources(state.urlToId, state.urlMeta), normalizedSources),
    consultedSources,
    answerText: answerText.trim(),
  };
}

async function appendMetaTags(env: Env, tags: string[]) {
  if (!env.DOCS_KV) return;
  const normalized = normalizeTags(tags);
  if (!normalized.length) return;
  const key = "meta_tags";
  let existing: string[] = [];
  try {
    const raw = await env.DOCS_KV.get(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.tags)) {
        existing = parsed.tags.map((tag: unknown) => (typeof tag === "string" ? tag : "")).filter(Boolean);
      }
    }
  } catch {}
  const union = new Set(existing);
  normalized.forEach(tag => union.add(tag));
  const finalTags = Array.from(union).slice(-500);
  await env.DOCS_KV.put(key, JSON.stringify({ tags: finalTags, updated_at: new Date().toISOString() }));
  const timelineKey = `meta_tags:${Date.now()}`;
  await env.DOCS_KV.put(timelineKey, JSON.stringify({ tags: normalized, ts: new Date().toISOString() }), {
    expirationTtl: 60 * 60 * 24 * 30,
  });
}

function coerceLectureTags(raw: unknown) {
  const counts = new Map<string, number>();
  if (!Array.isArray(raw)) return [];
  raw.forEach((entry) => {
    if (typeof entry === "string") {
      const normalized = normalizeTags([entry]);
      const tag = normalized.length ? normalized[0] : "";
      if (tag) counts.set(tag, (counts.get(tag) || 0) + 1);
      return;
    }
    if (entry && typeof entry === "object") {
      const tagRaw = typeof (entry as any).tag === "string" ? (entry as any).tag : "";
      const normalized = normalizeTags([tagRaw]);
      const tag = normalized.length ? normalized[0] : "";
      const count = typeof (entry as any).count === "number" ? Math.max(1, Math.floor((entry as any).count)) : 1;
      if (tag) counts.set(tag, (counts.get(tag) || 0) + count);
    }
  });
  return Array.from(counts.entries()).map(([tag, count]) => ({ tag, count }));
}

async function loadLectureAnalytics(env: Env, docId: string): Promise<LectureAnalytics> {
  const fallback = { docId, strings: [], updated_at: "" };
  try {
    if (!env.OWEN_ANALYTICS) return fallback;
    const aggregate = await aggregateLectureAnalytics({
      bucket: env.OWEN_ANALYTICS,
      lectureId: docId,
      days: 365,
    });
    const questionsAgg = await loadTopQuestionsForLecture({
      bucket: env.OWEN_ANALYTICS,
      lectureId: docId,
      limit: 10,
    });
    const updates = [aggregate.lastUpdated, questionsAgg?.lastUpdated].filter(Boolean) as string[];
    const lastUpdated = updates.sort().slice(-1)[0] || "";
    return {
      docId,
      strings: aggregate.strings,
      topics: aggregate.topics || [],
      last_question: aggregate.lastQuestion || "",
      last_cleaned_question: aggregate.lastCleanedQuestion || "",
      updated_at: lastUpdated,
      questions: questionsAgg?.top ?? [],
      lastUpdated: lastUpdated || undefined,
    };
  } catch (err) {
    console.error("[ANALYTICS_READ_FAILED]", { docId, error: err instanceof Error ? err.message : String(err) });
    return fallback;
  }
}

async function handleLectureAnalyticsRead(req: Request, env: Env): Promise<Response> {
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
  const record = await loadLectureAnalytics(env, docId);
  return jsonNoStore(record);
}

async function appendLectureAnalytics(env: Env, docId: string): Promise<LectureAnalytics> {
  return loadLectureAnalytics(env, docId);
}

function normalizeTags(tags: string[]) {
  return tags
    .map(tag => tag.trim())
    .map(tag => (tag.startsWith("#") ? tag : `#${tag}`))
    .map(tag => tag.replace(/[^#a-z0-9_-]/gi, "").toLowerCase())
    .filter(Boolean);
}

function buildOcrKey(file: FileReference) {
  const base = stripExtensions(file.textKey?.trim() || file.key);
  return base ? `${base}.ocr.txt` : `${file.key}.ocr.txt`;
}

async function mirrorBucketObjectToOpenAI(bucket: R2Bucket, key: string, env: Env) {
  const object = await bucket.get(key);
  if (!object || !object.body) {
    throw new Error("Object not found in bucket for OCR mirroring.");
  }
  const contentType = object.httpMetadata?.contentType || "application/octet-stream";
  const filename = sanitizeFilename(key.split("/").pop() || "upload.bin");
  const buffer = await object.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  // Assistants upload for text/OCR
  const assistantsFile = new File([buffer], filename, { type: contentType });
  const form = new FormData();
  form.append("purpose", "assistants");
  form.append("file", assistantsFile, filename);
  const resp = await fetch(`${env.OPENAI_API_BASE}/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form,
  });
  const data = await safeJson(resp);
  if (!resp.ok) {
    const message = data?.error?.message || "OpenAI Files upload failed for OCR fallback.";
    throw new Error(message);
  }
  const uploadedId = typeof data?.id === "string" ? data.id : "";
  if (!uploadedId) {
    throw new Error("OpenAI did not return a file id during OCR fallback upload.");
  }

  // Vision upload (best effort for images)
  let visionFileId: string | undefined;
  const wantsVision = contentType.toLowerCase().startsWith("image/") || isLikelyImageFilename(filename);
  const imageSignature = detectImageSignature(bytes);
  const imageHead = bytesToBase64(bytes.subarray(0, Math.min(48, bytes.length))).slice(0, 12);
  if (wantsVision) {
    if (imageSignature === "unknown") {
      console.warn("Vision mirror upload skipped: invalid image signature", {
        key,
        head: imageHead,
        mimeType: contentType,
      });
    } else {
      try {
        const visionMime = normalizeOcrImageMime(contentType, imageSignature);
        logOcrInputDebug({
          key,
          head: imageHead,
          mimeType: visionMime,
          signature: imageSignature,
          byteLength: bytes.length,
        });
        const visionFile = new File([buffer], filename, { type: visionMime });
        const visionForm = new FormData();
        visionForm.append("purpose", "vision");
        visionForm.append("file", visionFile, filename);
        const visionResp = await fetch(`${env.OPENAI_API_BASE}/files`, {
          method: "POST",
          headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
          body: visionForm,
        });
        const visionData = await safeJson(visionResp);
        if (visionResp.ok && typeof visionData?.id === "string") {
          visionFileId = visionData.id;
        } else {
          const msg = visionData?.error?.message || visionData?.message || visionResp.statusText || "Vision upload failed.";
          console.warn("Vision mirror upload failed (non-fatal).", { key, msg });
        }
      } catch (err) {
        console.warn("Vision mirror upload threw (non-fatal).", { key, err: String(err) });
      }
    }
  }

  return { fileId: uploadedId, visionFileId, filename };
}

async function storeConversationTags(env: Env, scope: string, conversationId: string, tags: string[]) {
  if (!env.DOCS_KV) return;
  const normalized = normalizeTags(tags);
  if (!normalized.length) return;
  const kvKey = `conv:${scope}:${conversationId}:tags`;
  const payload = {
    conversation_id: conversationId,
    tags: normalized,
    updated_at: new Date().toISOString(),
  };
  await env.DOCS_KV.put(kvKey, JSON.stringify(payload));
}

async function handleMetaTagsRequest(req: Request, env: Env): Promise<Response> {
  if (!env.DOCS_KV) {
    return json({ tags: [] });
  }
  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversation_id");
  if (!conversationId) {
    return json({ error: "conversation_id required" }, 400);
  }
  const context = await getConversationRequestContext(req, env);
  const record = await loadConversationTags(env, context.scope, conversationId);
  return appendSetCookie(json(record), context.setCookie);
}

async function handleConversationList(req: Request, env: Env): Promise<Response> {
  if (!env.DOCS_KV) {
    return jsonNoStore({ conversations: [] });
  }
  const context = await getConversationRequestContext(req, env);
  const index = await loadConversationIndex(env, context.scope);
  index.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return appendSetCookie(jsonNoStore({ conversations: index }), context.setCookie);
}

async function handleConversationGet(req: Request, conversationId: string, env: Env): Promise<Response> {
  if (!conversationId) {
    return jsonNoStore({ error: "conversation_id required" }, 400);
  }
  if (!env.DOCS_KV) {
    return jsonNoStore({ error: "storage_unavailable" }, 503);
  }
  const context = await getConversationRequestContext(req, env);
  const record = await loadConversationRecord(env, context.scope, conversationId);
  if (!record) {
    return appendSetCookie(jsonNoStore({ conversation: null, error: "not_found" }), context.setCookie);
  }
  return appendSetCookie(jsonNoStore({ conversation: record }), context.setCookie);
}

async function handleConversationUpsert(req: Request, env: Env): Promise<Response> {
  if (!env.DOCS_KV) {
    return jsonNoStore({ error: "storage_unavailable" }, 503);
  }
  const body = await readRequestJsonBody(req);
  if (!body || typeof body !== "object") {
    return jsonNoStore({ error: "Send JSON { conversation }." }, 400);
  }
  const rawConversation = isPlainObject(body.conversation) ? body.conversation : body;
  const context = await getConversationRequestContext(req, env);
  const result = await upsertConversationRecord(env, context.scope, rawConversation);
  if (!result) {
    return jsonNoStore({ error: "invalid_conversation" }, 400);
  }
  return appendSetCookie(jsonNoStore({ ok: true, conversation: result.record, index: result.index }), context.setCookie);
}

async function handleConversationDelete(req: Request, conversationId: string, env: Env): Promise<Response> {
  if (!conversationId) {
    return jsonNoStore({ error: "conversation_id required" }, 400);
  }
  if (!env.DOCS_KV) {
    return jsonNoStore({ error: "storage_unavailable" }, 503);
  }
  const context = await getConversationRequestContext(req, env);
  await env.DOCS_KV.delete(conversationRecordKey(context.scope, conversationId));
  const index = await loadConversationIndex(env, context.scope);
  const nextIndex = index.filter(entry => entry.id !== conversationId);
  await saveConversationIndex(env, context.scope, nextIndex);
  return appendSetCookie(jsonNoStore({ ok: true }), context.setCookie);
}

function debugFormatLog(message: string, payload?: Record<string, unknown>) {
  if (!DEBUG_FORMATTING) return;
  console.log(`[FORMAT] ${message}`, payload || {});
}

function finalizeAssistantText(rawText: string, formattedText: string, fallbackPreview?: string): string {
  const formatted = (formattedText || "").trim();
  if (formatted) return formatted;
  const raw = (rawText || "").trim();
  if (raw) return raw;
  if (fallbackPreview) return `(empty assistant message — showing preview)\n\n${fallbackPreview}`;
  return "(empty assistant message — formatting fallback engaged)";
}

/**
 * Compatibility Durable Object export retained to satisfy prior production migrations.
 * This class is intentionally inert and can be removed only after a delete-class migration.
 */
export class ActiveUsersRoom {
  constructor(_state: DurableObjectState, _env: Env) {}

  async fetch(): Promise<Response> {
    return new Response("ActiveUsersRoom has been retired.", { status: 410 });
  }
}
