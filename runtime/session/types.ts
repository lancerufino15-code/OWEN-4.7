import type { ConversationSummary } from "../conversation/compaction";

export type ChatRole = "system" | "user" | "assistant";

export type ConversationTags = {
  conversation_id: string;
  tags: string[];
  updated_at: string;
};

export type ConversationMessageMetadata = {
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
  responseMode?: "auto" | "instant" | "thinking";
  resolvedResponseMode?: "instant" | "thinking";
};

export type ConversationMessageRecord = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  metadata?: ConversationMessageMetadata;
};

export type ConversationRecord = {
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

export type ConversationIndexEntry = {
  id: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  selectedDocId?: string | null;
  selectedDocTitle?: string;
  messageCount?: number;
};

export type SessionBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; toolId: string; toolName?: string; input?: unknown }
  | { type: "tool_result"; toolId: string; output?: unknown; error?: string }
  | { type: "model_call"; model?: string; provider?: string; metadata?: Record<string, unknown> }
  | {
      type: "model_result";
      model?: string;
      provider?: string;
      finishReason?: string;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        cacheCreationInputTokens?: number;
        cacheReadInputTokens?: number;
        totalTokens?: number;
      } | null;
      metadata?: Record<string, unknown>;
    }
  | { type: "summary"; text: string };

export type SessionMessage = {
  id: string;
  role: ChatRole;
  createdAt: number;
  blocks: SessionBlock[];
  metadata?: ConversationMessageMetadata;
};

export type SessionResumeState = {
  resumeCount: number;
  lastResumedAt?: string;
  lastMessageCount?: number;
  lastMessageId?: string;
};

export type SessionV2 = {
  v: 2;
  sessionId: string;
  conversationId: string;
  scope: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  selectedDocId?: string | null;
  selectedDocTitle?: string;
  truncated?: boolean;
  summary?: ConversationSummary;
  messages: SessionMessage[];
  legacyMessageCount: number;
  metadata?: {
    source?: "legacy_migration" | "conversation_dual_write" | "runtime_completion" | "resume_update";
    lastRequestId?: string;
  };
  resume?: SessionResumeState;
};
