export type ConversationSummary = {
  raw: string;
  formatted: string;
  continuationMessage: string;
  updatedAt: string;
  removedMessageCount: number;
};

type ConversationMessageMetadata = {
  docId?: string;
  docTitle?: string;
  extractedKey?: string;
  requestId?: string;
  topics?: string[];
};

type CompactableConversationMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  metadata?: ConversationMessageMetadata;
};

type CompactableConversationRecord = {
  messages: CompactableConversationMessage[];
  summary?: ConversationSummary;
};

export interface ConversationCompactionConfig {
  enabled?: boolean;
  maxEstimatedTokens: number;
  preserveRecentMessages: number;
}

const PENDING_HINT_PATTERN = /\b(todo|next|pending|follow up|remaining)\b/i;
const FILE_PATH_PATTERN = /\b(?:[A-Za-z]:\\|\/)?(?:[\w.-]+[\\/])+[\w.-]+\b/g;
const MAX_RECENT_USER_REQUESTS = 3;
const MAX_PENDING_HINTS = 5;
const MAX_TIMELINE_LINES = 10;
const MAX_REFERENCED_PATHS = 10;
const CONTINUATION_PREAMBLE =
  "This conversation includes a compacted summary of earlier messages. Use it as prior context.";
const CONTINUATION_RESUME =
  "Continue directly from the latest user request. Do not mention that prior context was compacted.";

function normalizeText(value: string, maxLength = 220): string {
  const normalized = (value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function collapseBlankLines(value: string): string {
  return value.replace(/\n{3,}/g, "\n\n").trim();
}

function collectRoleCounts(messages: CompactableConversationMessage[]): Record<string, number> {
  const counts = { system: 0, user: 0, assistant: 0 };
  for (const message of messages) {
    counts[message.role] += 1;
  }
  return counts;
}

function collectRecentUserRequests(messages: CompactableConversationMessage[]): string[] {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => normalizeText(message.content))
    .filter(Boolean)
    .slice(-MAX_RECENT_USER_REQUESTS);
}

function collectPendingHints(messages: CompactableConversationMessage[]): string[] {
  const seen = new Set<string>();
  const hints: string[] = [];
  for (const message of messages) {
    const text = normalizeText(message.content);
    if (!text || !PENDING_HINT_PATTERN.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hints.push(text);
    if (hints.length >= MAX_PENDING_HINTS) break;
  }
  return hints;
}

function collectReferencedPaths(messages: CompactableConversationMessage[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];

  const push = (value: string | undefined) => {
    const normalized = normalizeText(value || "", 160);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    paths.push(normalized);
  };

  for (const message of messages) {
    const matches = message.content.match(FILE_PATH_PATTERN) || [];
    for (const match of matches) {
      push(match);
      if (paths.length >= MAX_REFERENCED_PATHS) return paths;
    }
    push(message.metadata?.docId);
    push(message.metadata?.docTitle);
    push(message.metadata?.extractedKey);
    if (Array.isArray(message.metadata?.topics)) {
      for (const topic of message.metadata?.topics || []) {
        push(topic);
        if (paths.length >= MAX_REFERENCED_PATHS) return paths;
      }
    }
  }

  return paths;
}

function buildTimeline(messages: CompactableConversationMessage[]): string[] {
  return messages
    .map((message) => `${message.role}: ${normalizeText(message.content)}`)
    .filter((line) => !/^(system|user|assistant):\s*$/.test(line))
    .slice(-MAX_TIMELINE_LINES);
}

function buildSummarySections(messages: CompactableConversationMessage[]): string[] {
  const counts = collectRoleCounts(messages);
  const sections = [
    `Conversation summary for ${messages.length} earlier messages.`,
    `Role counts: user=${counts.user}, assistant=${counts.assistant}, system=${counts.system}.`,
  ];

  const recentRequests = collectRecentUserRequests(messages);
  if (recentRequests.length) {
    sections.push("Recent user requests:");
    sections.push(...recentRequests.map((request) => `- ${request}`));
  }

  const pendingHints = collectPendingHints(messages);
  if (pendingHints.length) {
    sections.push("Pending work hints:");
    sections.push(...pendingHints.map((hint) => `- ${hint}`));
  }

  const referencedPaths = collectReferencedPaths(messages);
  if (referencedPaths.length) {
    sections.push("Referenced files or paths:");
    sections.push(...referencedPaths.map((path) => `- ${path}`));
  }

  const timeline = buildTimeline(messages);
  if (timeline.length) {
    sections.push("Timeline:");
    sections.push(...timeline.map((entry) => `- ${entry}`));
  }

  return sections;
}

function formatSummary(raw: string): string {
  return collapseBlankLines(raw);
}

function mergeSummaryRaw(existing: ConversationSummary | undefined, nextRaw: string): string {
  if (!existing?.raw.trim()) return nextRaw;
  const lines = [
    "Previously compacted context:",
    existing.formatted || formatSummary(existing.raw),
    "",
    "Newly compacted context:",
    nextRaw,
  ];
  return collapseBlankLines(lines.join("\n"));
}

export function buildConversationContinuationMessage(summary: Pick<ConversationSummary, "formatted">): string {
  const formatted = formatSummary(summary.formatted || "");
  if (!formatted) {
    return `${CONTINUATION_PREAMBLE}\n\n${CONTINUATION_RESUME}`;
  }
  return `${CONTINUATION_PREAMBLE}\n\n${formatted}\n\n${CONTINUATION_RESUME}`;
}

export function normalizeConversationSummary(raw: unknown): ConversationSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const formatted = typeof source.formatted === "string" ? formatSummary(source.formatted) : "";
  const value: ConversationSummary = {
    raw: typeof source.raw === "string" ? source.raw : formatted,
    formatted,
    continuationMessage:
      typeof source.continuationMessage === "string"
        ? source.continuationMessage
        : buildConversationContinuationMessage({ formatted }),
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : new Date().toISOString(),
    removedMessageCount:
      typeof source.removedMessageCount === "number" && Number.isFinite(source.removedMessageCount)
        ? Math.max(0, Math.floor(source.removedMessageCount))
        : 0,
  };
  if (!value.raw && !value.formatted) return undefined;
  if (!value.formatted) value.formatted = formatSummary(value.raw);
  if (!value.raw) value.raw = value.formatted;
  return value;
}

export function estimateConversationTokens(messages: CompactableConversationMessage[]): number {
  const totalChars = (messages || []).reduce((sum, message) => {
    const content = typeof message?.content === "string" ? message.content.length : 0;
    const metadataText = [
      message?.metadata?.docId,
      message?.metadata?.docTitle,
      message?.metadata?.extractedKey,
      ...(message?.metadata?.topics || []),
    ]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .length;
    return sum + content + metadataText;
  }, 0);
  return Math.ceil(totalChars / 4);
}

export function shouldCompactConversation(
  record: CompactableConversationRecord,
  config: ConversationCompactionConfig,
): boolean {
  if (!config.enabled) return false;
  const preserveRecentMessages = Math.max(1, config.preserveRecentMessages);
  if ((record.messages || []).length <= preserveRecentMessages) return false;
  return estimateConversationTokens(record.messages) >= Math.max(1, config.maxEstimatedTokens);
}

export function compactConversationRecord<T extends CompactableConversationRecord>(
  record: T,
  config: ConversationCompactionConfig,
): T {
  if (!shouldCompactConversation(record, config)) {
    return record;
  }

  const preserveRecentMessages = Math.max(1, config.preserveRecentMessages);
  const keepFrom = Math.max(0, record.messages.length - preserveRecentMessages);
  const compactedMessages = record.messages.slice(0, keepFrom);
  const preservedMessages = record.messages.slice(keepFrom);
  if (!compactedMessages.length) return record;

  const nextRaw = buildSummarySections(compactedMessages).join("\n");
  const raw = mergeSummaryRaw(record.summary, nextRaw);
  const formatted = formatSummary(raw);
  const summary: ConversationSummary = {
    raw,
    formatted,
    continuationMessage: buildConversationContinuationMessage({ formatted }),
    updatedAt: new Date().toISOString(),
    removedMessageCount: compactedMessages.length + (record.summary?.removedMessageCount || 0),
  };

  return {
    ...record,
    messages: preservedMessages,
    summary,
  };
}
