import type { VisionChatContentPart, VisionChatMessage, VisionMode } from "../runtime/vision/types";

export type ChatRole = VisionChatMessage["role"];
export type ChatContentPart = VisionChatContentPart;
export type ChatMessage = VisionChatMessage;

export type ResponseMode = "auto" | "instant" | "thinking";
export type ResolvedResponseMode = "instant" | "thinking";

export type ChatContinuation = {
  text: string;
  reason?: string;
  attempt?: number;
};

export interface FileReference {
  bucket: string;
  key: string;
  textKey?: string;
  displayName?: string;
  fileId?: string;
  visionFileId?: string;
}

export interface ChatRequestBody {
  messages: ChatMessage[];
  agentId?: string;
  model?: string;
  stream?: boolean;
  files?: FileReference[];
  attachments?: FileReference[];
  fileRefs?: FileReference[];
  responseMode?: ResponseMode;
  visionMode?: VisionMode;
  conversation_id?: string;
  meta_tags?: string[];
  continuation?: ChatContinuation;
}

export type UrlCitationAnnotation = {
  start_index: number;
  end_index: number;
  url: string;
  title?: string;
};

export type AnswerSegment =
  | { type: "text"; text: string }
  | { type: "citation"; id: number; url: string; title?: string };

export type CitationSource = {
  id: number;
  url: string;
  title?: string;
  domain?: string;
  snippet?: string;
  retrievedAt?: number;
};

export type FreeResponseWarning = {
  code: "INSUFFICIENT_SOURCES" | "NO_WEB_SOURCES" | "EMPTY_RESPONSE_FALLBACK";
  message: string;
  details?: Record<string, number>;
};
