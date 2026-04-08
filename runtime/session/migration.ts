import { normalizeResolvedResponseMode, normalizeResponseMode } from "../../chat/response-mode";
import type {
  ConversationIndexEntry,
  ConversationMessageMetadata,
  ConversationMessageRecord,
  ConversationRecord,
  SessionBlock,
  SessionMessage,
  SessionV2,
} from "./types";
import { normalizeConversationSummary } from "../conversation/compaction";
import { isPlainObject } from "../http";

const MAX_CONVERSATION_MESSAGES = 400;
const MAX_CONVERSATION_CHARS = 600_000;
const MAX_CONVERSATION_MESSAGE_CHARS = 120_000;
const MAX_CONVERSATION_META_LIST = 50;
const MAX_CONVERSATION_TOPICS = 20;

export function generateConversationMessageId(): string {
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

export function normalizeConversationMetadata(raw: Record<string, unknown>): ConversationMessageMetadata | undefined {
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

export function normalizeConversationMessage(raw: unknown): ConversationMessageRecord | null {
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
  messages.forEach((msg) => {
    if (!msg || !msg.id) return;
    if (byId.has(msg.id)) {
      const idx = ordered.findIndex((entry) => entry.id === msg.id);
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

export function normalizeConversationIndexEntry(raw: Record<string, unknown>): ConversationIndexEntry | null {
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

export function normalizeConversationRecord(
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

function normalizeSessionBlock(raw: unknown): SessionBlock | null {
  if (!isPlainObject(raw) || typeof raw.type !== "string") return null;
  if (raw.type === "text") {
    return typeof raw.text === "string" ? { type: "text", text: raw.text } : null;
  }
  if (raw.type === "tool_use") {
    return typeof raw.toolId === "string"
      ? { type: "tool_use", toolId: raw.toolId, toolName: typeof raw.toolName === "string" ? raw.toolName : undefined, input: raw.input }
      : null;
  }
  if (raw.type === "tool_result") {
    return typeof raw.toolId === "string"
      ? {
          type: "tool_result",
          toolId: raw.toolId,
          output: raw.output,
          error: typeof raw.error === "string" ? raw.error : undefined,
        }
      : null;
  }
  if (raw.type === "model_call") {
    return {
      type: "model_call",
      model: typeof raw.model === "string" ? raw.model : undefined,
      provider: typeof raw.provider === "string" ? raw.provider : undefined,
      metadata: isPlainObject(raw.metadata) ? raw.metadata : undefined,
    };
  }
  if (raw.type === "model_result") {
    return {
      type: "model_result",
      model: typeof raw.model === "string" ? raw.model : undefined,
      provider: typeof raw.provider === "string" ? raw.provider : undefined,
      finishReason: typeof raw.finishReason === "string" ? raw.finishReason : undefined,
      usage: isPlainObject(raw.usage) ? {
        inputTokens: typeof raw.usage.inputTokens === "number" ? raw.usage.inputTokens : undefined,
        outputTokens: typeof raw.usage.outputTokens === "number" ? raw.usage.outputTokens : undefined,
        cacheCreationInputTokens: typeof raw.usage.cacheCreationInputTokens === "number" ? raw.usage.cacheCreationInputTokens : undefined,
        cacheReadInputTokens: typeof raw.usage.cacheReadInputTokens === "number" ? raw.usage.cacheReadInputTokens : undefined,
        totalTokens: typeof raw.usage.totalTokens === "number" ? raw.usage.totalTokens : undefined,
      } : raw.usage === null ? null : undefined,
      metadata: isPlainObject(raw.metadata) ? raw.metadata : undefined,
    };
  }
  if (raw.type === "summary") {
    return typeof raw.text === "string" ? { type: "summary", text: raw.text } : null;
  }
  return null;
}

function normalizeSessionMessage(raw: unknown): SessionMessage | null {
  if (!isPlainObject(raw)) return null;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : generateConversationMessageId();
  const role = raw.role === "assistant" ? "assistant" : raw.role === "system" ? "system" : "user";
  const createdAt = typeof raw.createdAt === "number" ? raw.createdAt : Date.now();
  const blocks = Array.isArray(raw.blocks)
    ? raw.blocks.map(normalizeSessionBlock).filter((entry): entry is SessionBlock => Boolean(entry))
    : [];
  if (!blocks.length && typeof raw.content === "string") {
    blocks.push({ type: "text", text: clampConversationMessageContent(raw.content) });
  }
  return {
    id,
    role,
    createdAt,
    blocks: blocks.length ? blocks : [{ type: "text", text: "" }],
    metadata: normalizeConversationMetadata(raw),
  };
}

export function normalizeSessionV2(raw: unknown): SessionV2 | null {
  if (!isPlainObject(raw)) return null;
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId.trim() : "";
  const conversationId = typeof raw.conversationId === "string" ? raw.conversationId.trim() : sessionId;
  const scope = typeof raw.scope === "string" ? raw.scope.trim() : "";
  if (!sessionId || !conversationId || !scope) return null;
  const messages = Array.isArray(raw.messages)
    ? raw.messages.map(normalizeSessionMessage).filter((entry): entry is SessionMessage => Boolean(entry))
    : [];
  const metadata = isPlainObject(raw.metadata) ? raw.metadata as Record<string, unknown> : null;
  return {
    v: 2,
    sessionId,
    conversationId,
    scope,
    title: typeof raw.title === "string" ? raw.title : "Conversation",
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
    selectedDocId: raw.selectedDocId === null ? null : typeof raw.selectedDocId === "string" ? raw.selectedDocId : null,
    selectedDocTitle: typeof raw.selectedDocTitle === "string" ? raw.selectedDocTitle : "",
    truncated: Boolean(raw.truncated),
    summary: normalizeConversationSummary(raw.summary) || undefined,
    messages,
    legacyMessageCount: typeof raw.legacyMessageCount === "number" ? raw.legacyMessageCount : messages.length,
    metadata: metadata ? {
      source: typeof metadata.source === "string" ? metadata.source as NonNullable<SessionV2["metadata"]>["source"] : undefined,
      lastRequestId: typeof metadata.lastRequestId === "string" ? metadata.lastRequestId : undefined,
    } : undefined,
    resume: isPlainObject(raw.resume) ? {
      resumeCount: typeof raw.resume.resumeCount === "number" ? Math.max(0, Math.floor(raw.resume.resumeCount)) : 0,
      lastResumedAt: typeof raw.resume.lastResumedAt === "string" ? raw.resume.lastResumedAt : undefined,
      lastMessageCount: typeof raw.resume.lastMessageCount === "number" ? Math.max(0, Math.floor(raw.resume.lastMessageCount)) : undefined,
      lastMessageId: typeof raw.resume.lastMessageId === "string" ? raw.resume.lastMessageId : undefined,
    } : undefined,
  };
}

function messageBlocksFromConversationMessage(message: ConversationMessageRecord): SessionBlock[] {
  const blocks: SessionBlock[] = [];
  if (message.content) {
    blocks.push({ type: "text", text: message.content });
  }
  return blocks.length ? blocks : [{ type: "text", text: "" }];
}

export function migrateConversationRecordToSession(
  record: ConversationRecord,
  scope: string,
  metadata: SessionV2["metadata"] = { source: "legacy_migration" },
): SessionV2 {
  return {
    v: 2,
    sessionId: record.id,
    conversationId: record.id,
    scope,
    title: record.title || "Conversation",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    selectedDocId: record.selectedDocId ?? null,
    selectedDocTitle: record.selectedDocTitle || "",
    truncated: Boolean(record.truncated),
    summary: record.summary,
    messages: record.messages.map((message) => ({
      id: message.id,
      role: message.role,
      createdAt: message.createdAt,
      blocks: messageBlocksFromConversationMessage(message),
      metadata: message.metadata,
    })),
    legacyMessageCount: record.messages.length,
    metadata,
  };
}

function extractPrimaryText(blocks: SessionBlock[]): string {
  return blocks
    .filter((block): block is Extract<SessionBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

export function convertSessionToConversationRecord(session: SessionV2): ConversationRecord {
  return {
    id: session.conversationId,
    title: session.title || "Conversation",
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    selectedDocId: session.selectedDocId ?? null,
    selectedDocTitle: session.selectedDocTitle || "",
    truncated: Boolean(session.truncated),
    summary: session.summary,
    messages: session.messages.map((message) => ({
      id: message.id,
      role: message.role,
      createdAt: message.createdAt,
      content: clampConversationMessageContent(extractPrimaryText(message.blocks)),
      metadata: message.metadata,
    })),
  };
}
