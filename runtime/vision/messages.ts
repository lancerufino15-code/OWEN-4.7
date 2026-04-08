import type { VisionChatContentPart, VisionChatMessage, VisionTextPart } from "./types";
import { normalizeInlineImagePart } from "./ingest";

function normalizeTextPart(part: unknown): VisionTextPart | null {
  if (!part || typeof part !== "object") return null;
  const source = part as Record<string, unknown>;
  const type = typeof source.type === "string" ? source.type : undefined;
  if (type && type !== "text") return null;
  const text = typeof source.text === "string" ? source.text.trim() : "";
  return text ? { type: "text", text } : null;
}

function normalizeMessageContent(content: unknown): string | VisionChatContentPart[] | null {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed || null;
  }
  if (!Array.isArray(content)) return null;

  const parts: VisionChatContentPart[] = [];
  for (const part of content) {
    const source = part as Record<string, unknown> | null;
    if (!source || typeof source !== "object") continue;
    const type = typeof source.type === "string" ? source.type : undefined;
    if (!type || type === "text") {
      const textPart = normalizeTextPart(source);
      if (textPart) parts.push(textPart);
      continue;
    }
    if (type === "image") {
      parts.push(normalizeInlineImagePart(source));
    }
  }

  return parts.length ? parts : null;
}

export function normalizeChatMessagesPreservingImages(messages: unknown): VisionChatMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((message): VisionChatMessage | null => {
      if (!message || typeof message !== "object") return null;
      const role = (message as Record<string, unknown>).role;
      if (role !== "system" && role !== "user" && role !== "assistant") return null;
      const normalized = normalizeMessageContent((message as Record<string, unknown>).content);
      if (!normalized) return null;
      return { role, content: normalized };
    })
    .filter((message): message is VisionChatMessage => Boolean(message));
}

export function messageHasInlineImages(message: VisionChatMessage): boolean {
  return Array.isArray(message.content) && message.content.some((part) => part.type === "image");
}

export function messagesHaveInlineImages(messages: VisionChatMessage[]): boolean {
  return messages.some(messageHasInlineImages);
}

export function messageContentToPlainText(content: string | VisionChatContentPart[]): string {
  if (typeof content === "string") return content.trim();
  return content
    .filter((part): part is VisionTextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}
