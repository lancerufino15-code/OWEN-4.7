import type { Env } from "../../../types";
import type { ChatMessage } from "../types";
import { messageContentToPlainText } from "../../runtime/vision/messages";
import type { ConversationState } from "./types";

function conversationStateKey(scope: string, conversationId: string): string {
  return `conversation:state:${scope}:${conversationId}`;
}

function normalizeState(raw: unknown): ConversationState | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  return {
    intent: typeof source.intent === "string" ? source.intent : undefined,
    topic: typeof source.topic === "string" ? source.topic : undefined,
    activeDocIds: Array.isArray(source.activeDocIds) ? source.activeDocIds.filter((item): item is string => typeof item === "string") : [],
    keyEntities: Array.isArray(source.keyEntities) ? source.keyEntities.filter((item): item is string => typeof item === "string") : [],
    rollingSummary: typeof source.rollingSummary === "string" ? source.rollingSummary : "",
    responseModeBias: typeof source.responseModeBias === "string" ? source.responseModeBias as ConversationState["responseModeBias"] : undefined,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : new Date().toISOString(),
  };
}

function extractEntities(text: string): string[] {
  const matches = text.match(/\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,2})\b/g) || [];
  const unique = new Set<string>();
  matches.forEach((match) => unique.add(match.trim()));
  return Array.from(unique).slice(0, 12);
}

function buildRollingSummary(messages: ChatMessage[], fallback = ""): string {
  const summaryLines = messages
    .filter((message) => message.role !== "system")
    .slice(-8)
    .map((message) => {
      const normalized = messageContentToPlainText(message.content).replace(/\s+/g, " ").trim();
      if (!normalized) return "";
      return `${message.role}: ${normalized.slice(0, 220)}`;
    })
    .filter(Boolean);
  return (summaryLines.join("\n") || fallback).slice(0, 2200);
}

export async function loadConversationState(
  env: Env,
  scope: string,
  conversationId?: string,
): Promise<ConversationState | null> {
  if (!conversationId || !env.DOCS_KV) return null;
  const stored = await env.DOCS_KV.get(conversationStateKey(scope, conversationId), { type: "json" });
  return normalizeState(stored);
}

export async function saveConversationState(
  env: Env,
  scope: string,
  conversationId: string | undefined,
  state: ConversationState,
): Promise<void> {
  if (!conversationId || !env.DOCS_KV) return;
  await env.DOCS_KV.put(conversationStateKey(scope, conversationId), JSON.stringify(state));
}

export function deriveConversationState(opts: {
  priorState: ConversationState | null;
  messages: ChatMessage[];
  lastUserPrompt: string;
  intent?: string;
  topic?: string;
  activeDocIds?: string[];
  responseModeBias?: ConversationState["responseModeBias"];
  rollingSummary?: string;
}): ConversationState {
  const lastPrompt = opts.lastUserPrompt.replace(/\s+/g, " ").trim();
  const topic = opts.topic || opts.priorState?.topic || lastPrompt.slice(0, 140) || "Conversation";
  const entitySource = [opts.priorState?.topic || "", topic, lastPrompt].filter(Boolean).join(" ");
  return {
    intent: opts.intent || opts.priorState?.intent,
    topic,
    activeDocIds: Array.from(new Set([...(opts.priorState?.activeDocIds || []), ...(opts.activeDocIds || [])])).slice(0, 12),
    keyEntities: Array.from(new Set([...(opts.priorState?.keyEntities || []), ...extractEntities(entitySource)])).slice(0, 20),
    rollingSummary: opts.rollingSummary || buildRollingSummary(opts.messages, opts.priorState?.rollingSummary || ""),
    responseModeBias: opts.responseModeBias || opts.priorState?.responseModeBias,
    updatedAt: new Date().toISOString(),
  };
}
