import type { ChatMessage } from "../types";
import { messageContentToPlainText } from "../../runtime/vision/messages";
import type { CompactedTranscript, ConversationState } from "./types";

const DEFAULT_MAX_ESTIMATED_TOKENS = 10_000;
const DEFAULT_RECENT_TURNS = 4;
const DEFAULT_MAX_VERBATIM_MESSAGES = 12;
const CONTINUATION_PREAMBLE =
  "This conversation is continuing from earlier context that has been compacted. Use the summary below as prior context.";
const RESUME_INSTRUCTION =
  "Continue directly from the latest user request. Do not recap the summary, and do not mention that context was compacted.";

function messageText(message: ChatMessage): string {
  return messageContentToPlainText(message.content);
}

export function estimateTranscriptTokens(messages: ChatMessage[]): number {
  const chars = messages.reduce((total, message) => total + messageText(message).length, 0);
  return Math.ceil(chars / 4);
}

function summarizeOlderMessages(messages: ChatMessage[]): string {
  const lines = messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      const text = messageText(message).replace(/\s+/g, " ").trim();
      if (!text) return "";
      return `- ${message.role}: ${text.slice(0, 220)}`;
    })
    .filter(Boolean)
    .slice(-12);
  return lines.join("\n").slice(0, 2600);
}

export function compactChatHistory(
  messages: ChatMessage[],
  conversationState: ConversationState | null,
  opts: { preserveRecentTurns?: number; maxEstimatedTokens?: number; maxVerbatimMessages?: number } = {},
): CompactedTranscript {
  const preserveRecentTurns = Math.max(1, opts.preserveRecentTurns ?? DEFAULT_RECENT_TURNS);
  const maxEstimatedTokens = Math.max(1000, opts.maxEstimatedTokens ?? DEFAULT_MAX_ESTIMATED_TOKENS);
  const maxVerbatimMessages = Math.max(4, opts.maxVerbatimMessages ?? DEFAULT_MAX_VERBATIM_MESSAGES);
  const estimatedTokens = estimateTranscriptTokens(messages);
  const nonSystemMessages = messages.filter((message) => message.role !== "system");
  const preserveCount = Math.min(nonSystemMessages.length, preserveRecentTurns * 2);
  const preserveFrom = Math.max(0, nonSystemMessages.length - preserveCount);
  const olderMessages = nonSystemMessages.slice(0, preserveFrom);
  const preservedMessages = nonSystemMessages.slice(preserveFrom);
  const triggered =
    nonSystemMessages.length > maxVerbatimMessages ||
    (olderMessages.length > 0 && estimatedTokens >= maxEstimatedTokens);

  if (!triggered) {
    return {
      triggered: false,
      estimatedTokens,
      summary: conversationState?.rollingSummary || "",
      systemMessages: [],
      preservedMessages: messages,
      recentTurnCount: Math.ceil(preservedMessages.length / 2),
    };
  }

  const summary = [conversationState?.rollingSummary || "", summarizeOlderMessages(olderMessages)]
    .filter(Boolean)
    .join("\n")
    .trim();

  return {
    triggered: true,
    estimatedTokens,
    summary,
    systemMessages: [
      {
        role: "system",
        content: `${CONTINUATION_PREAMBLE}\n\n${summary || "(No prior summary available.)"}\n\n${RESUME_INSTRUCTION}`,
      },
    ],
    preservedMessages,
    resumeInstruction: RESUME_INSTRUCTION,
    recentTurnCount: Math.ceil(preservedMessages.length / 2),
  };
}
