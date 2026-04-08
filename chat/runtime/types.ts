import type { AllowedModel } from "../../runtime/model-selection";
import type { RuntimePermissionMode, ToolDecision } from "../../runtime/permissions";
import type { AnswerSegment, CitationSource, ChatMessage, FileReference, ResponseMode, ResolvedResponseMode } from "../types";
import type { RenderHints, UaoClassification, UaoStrategySelection } from "../../../universal_answer_orchestrator";
import type { VisionMode } from "../../runtime/vision/types";
import type { ChatResponseSegment, ChatResponseStopReason, ChatResponseV2, SectionDescriptor, SourceRef } from "../response_contract";

export type StreamBlockType = "paragraph" | "heading" | "list_item" | "code" | "other";

export type ResponsesInputContent =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url?: string; file_id?: string; detail?: "low" | "high" | "auto" }
  | { type: "input_file"; file_id: string };

export type ResponsesInputMessage = { role: "system" | "user" | "assistant"; content: ResponsesInputContent[] };

export type ChatStreamEvent =
  | { event: "message_start"; conversationId?: string; resolvedResponseMode?: ResolvedResponseMode; model?: string }
  | { event: "context_ready"; attachmentCount: number; estimatedContextChars?: number; compacted?: boolean }
  | { event: "retrieval_plan"; retrieval: RetrievalPlan }
  | {
      event: "response.start";
      plan?: {
        sectionPlan?: Array<Pick<SectionDescriptor, "id" | "title"> & { allowedTypes?: ChatResponseSegment["type"][] }>;
      };
      conversationId?: string;
      resolvedResponseMode?: ResolvedResponseMode;
      model?: string;
    }
  | ({ event: "section.add" } & SectionDescriptor)
  | ({ event: "source.add" } & SourceRef)
  | ({ event: "segment.add" } & ChatResponseSegment)
  | {
      event: "response.complete";
      stopReason: ChatResponseStopReason;
      truncated: boolean;
    }
  | {
      event: "response.error";
      code?: string;
      message: string;
    }
  | {
      event: "message_delta";
      delta: {
        text: string;
        blockType?: StreamBlockType;
        isStable?: boolean;
        rawOffsetStart?: number;
        rawOffsetEnd?: number;
      };
    }
  | {
      event: "format_state";
      state: {
        blockType: StreamBlockType;
        inCodeFence: boolean;
        rawOffset: number;
      };
    }
  | { event: "citation"; citation: CitationSource }
  | {
      event: "final";
      content: string;
      answerSegments: AnswerSegment[];
      sources: CitationSource[];
      responseV2?: ChatResponseV2;
      consultedSources?: unknown[];
      renderHints?: RenderHints;
      finishReason?: string;
      incompleteReason?: string;
      truncated?: boolean;
      resolvedResponseMode?: ResolvedResponseMode;
    }
  | { event: "message_stop"; finishReason?: string; incompleteReason?: string; truncated?: boolean }
  | { event: "error"; error: string }
  | { event: "done" };

export interface RetrievalPlan {
  required: boolean;
  mode: "none" | "attachments" | "web_search";
  maxChunks: number;
  contextCharBudget: number;
  minSources: number;
  selectedDocBias: string[];
  sourceDiversity: boolean;
}

export interface CompactedTranscript {
  triggered: boolean;
  estimatedTokens: number;
  summary: string;
  systemMessages: ChatMessage[];
  preservedMessages: ChatMessage[];
  resumeInstruction?: string;
  recentTurnCount: number;
}

export interface ConversationState {
  intent?: string;
  topic?: string;
  activeDocIds: string[];
  keyEntities: string[];
  rollingSummary: string;
  responseModeBias?: ResolvedResponseMode | ResponseMode;
  updatedAt: string;
}

export interface ChatTelemetry {
  firstTokenMs?: number;
  totalMs?: number;
  retrievalMs?: number;
  qaMs?: number;
  compactionTriggered: boolean;
  sourceCount: number;
  modelUsed: string;
  continuationAttempts: number;
  truncated: boolean;
}

export interface FileContextRecord {
  displayName: string;
  source: "ocr" | "original";
  text: string;
  bucket: string;
  resolvedBucket: string;
  originalKey: string;
  resolvedKey: string;
  textKey?: string;
}

export interface ExecutionPlan {
  requestKind: "instant" | "image" | "chat" | "continuation";
  stream: boolean;
  explicitJson: boolean;
  legacyMode: boolean;
  permissionMode: RuntimePermissionMode;
  allowedBuckets: string[];
  allowedRuntimeCapabilities: string[];
  conversationId?: string;
  conversationScope: string;
  agentId: string;
  requestedModel?: string;
  modelKey: AllowedModel;
  modelId: string;
  providerMode: "responses" | "chat_completions";
  responseMode: ResponseMode;
  resolvedResponseMode: ResolvedResponseMode;
  classification: UaoClassification;
  strategy: UaoStrategySelection;
  retrieval: RetrievalPlan;
  runQa: boolean;
  allowRewrite: boolean;
  messages: ChatMessage[];
  lastUserPrompt: string;
  files: FileReference[];
  visionFiles: FileReference[];
  hasInlineImages: boolean;
  visionMode: VisionMode;
  continuationText?: string;
  tags: string[];
  conversationState: ConversationState | null;
  compactedTranscript: CompactedTranscript;
  baseSystemPrompt: string;
  toolDecisions?: ToolDecision[];
}

export interface ChatExecutionResult {
  answerText: string;
  answerSegments: AnswerSegment[];
  sources: CitationSource[];
  responseV2?: ChatResponseV2;
  consultedSources?: unknown[];
  renderHints?: RenderHints;
  finishReason?: string;
  incompleteReason?: string;
  truncated?: boolean;
  resolvedResponseMode: ResolvedResponseMode;
  telemetry: ChatTelemetry;
}
