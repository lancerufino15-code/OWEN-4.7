import type { Env } from "../../../types";
import { getRuntimeFeatures } from "../config/runtime-features";
import {
  compactConversationRecord,
  type ConversationSummary,
} from "../conversation/compaction";
import { runRuntimeHooks } from "../hooks/runtime-hooks";
import { isPlainObject } from "../http";
import {
  convertSessionToConversationRecord,
  migrateConversationRecordToSession,
  normalizeConversationIndexEntry,
  normalizeConversationRecord,
  normalizeSessionV2,
} from "./migration";
import type {
  ConversationIndexEntry,
  ConversationRecord,
  SessionV2,
} from "./types";

const CONVERSATION_INDEX_KEY = "conversation:index";
const CONVERSATION_RECORD_PREFIX = "conversation:record:";
const SESSION_RECORD_PREFIX = "session:v2:";

export type UpsertConversationResult = {
  record: ConversationRecord;
  index: ConversationIndexEntry;
  session?: SessionV2 | null;
};

export function conversationIndexKey(scope: string): string {
  return `${CONVERSATION_INDEX_KEY}:${scope}`;
}

export function conversationRecordKey(scope: string, id: string): string {
  return `${CONVERSATION_RECORD_PREFIX}${scope}:${id}`;
}

export function sessionRecordKey(scope: string, id: string): string {
  return `${SESSION_RECORD_PREFIX}${scope}:${id}`;
}

export async function loadConversationRecord(env: Env, scope: string, conversationId: string): Promise<ConversationRecord | null> {
  if (!conversationId || !env.DOCS_KV) return null;
  const raw = await env.DOCS_KV.get(conversationRecordKey(scope, conversationId), { type: "json" });
  if (!raw || typeof raw !== "object") return null;
  return normalizeConversationRecord(raw, null, { preserveUpdatedAt: true });
}

export async function loadConversationIndex(env: Env, scope: string): Promise<ConversationIndexEntry[]> {
  if (!env.DOCS_KV) return [];
  const raw = await env.DOCS_KV.get(conversationIndexKey(scope), { type: "json" });
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => normalizeConversationIndexEntry(entry as Record<string, unknown>))
    .filter((entry): entry is ConversationIndexEntry => Boolean(entry));
}

export async function saveConversationIndex(env: Env, scope: string, entries: ConversationIndexEntry[]): Promise<void> {
  if (!env.DOCS_KV) return;
  await env.DOCS_KV.put(conversationIndexKey(scope), JSON.stringify((entries || []).slice(0, 200)));
}

export async function loadSessionV2(env: Env, scope: string, sessionId: string): Promise<SessionV2 | null> {
  if (!env.DOCS_KV || !sessionId) return null;
  const raw = await env.DOCS_KV.get(sessionRecordKey(scope, sessionId), { type: "json" });
  return normalizeSessionV2(raw);
}

export async function saveSessionV2(env: Env, session: SessionV2): Promise<void> {
  if (!env.DOCS_KV) return;
  await env.DOCS_KV.put(sessionRecordKey(session.scope, session.sessionId), JSON.stringify(session));
}

async function syncConversationToSession(
  env: Env,
  scope: string,
  record: ConversationRecord,
  metadata: SessionV2["metadata"] = { source: "conversation_dual_write" },
): Promise<SessionV2 | null> {
  const features = getRuntimeFeatures(env);
  if (!features.session.v2Enabled) return null;
  const session = migrateConversationRecordToSession(record, scope, metadata);
  await saveSessionV2(env, session);
  return session;
}

export async function loadRuntimeSession(env: Env, scope: string, sessionId: string): Promise<SessionV2 | null> {
  if (!sessionId) return null;
  const features = getRuntimeFeatures(env);
  if (features.session.v2Enabled) {
    const typed = await loadSessionV2(env, scope, sessionId);
    if (typed) return typed;
  }
  const legacy = await loadConversationRecord(env, scope, sessionId);
  if (!legacy) return null;
  const migrated = migrateConversationRecordToSession(legacy, scope, { source: "legacy_migration" });
  if (features.session.v2Enabled) {
    await saveSessionV2(env, migrated);
  }
  return migrated;
}

export async function loadLatestRuntimeSession(env: Env, scope: string): Promise<SessionV2 | null> {
  const index = await loadConversationIndex(env, scope);
  const latest = [...index].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  if (!latest?.id) return null;
  return loadRuntimeSession(env, scope, latest.id);
}

export async function upsertConversationRecord(
  env: Env,
  scope: string,
  raw: unknown,
): Promise<UpsertConversationResult | null> {
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
  const nextIndex = index.filter((entry) => entry.id !== normalized.id);
  nextIndex.unshift(indexEntry);
  await saveConversationIndex(env, scope, nextIndex);
  const session = await syncConversationToSession(env, scope, record);
  return { record, index: indexEntry, session };
}

export async function saveRuntimeSessionFromConversation(
  env: Env,
  scope: string,
  record: ConversationRecord,
  metadata: SessionV2["metadata"] = { source: "runtime_completion" },
): Promise<SessionV2 | null> {
  return syncConversationToSession(env, scope, record, metadata);
}

export async function saveRuntimeSession(
  env: Env,
  session: SessionV2,
): Promise<SessionV2 | null> {
  if (!getRuntimeFeatures(env).session.v2Enabled) return null;
  await saveSessionV2(env, session);
  return session;
}

export async function deleteConversationArtifacts(env: Env, scope: string, conversationId: string): Promise<void> {
  if (!env.DOCS_KV || !conversationId) return;
  await env.DOCS_KV.delete(conversationRecordKey(scope, conversationId));
  await env.DOCS_KV.delete(sessionRecordKey(scope, conversationId));
}

export function buildConversationIndexEntry(record: ConversationRecord): ConversationIndexEntry {
  return {
    id: record.id,
    title: record.title || "Conversation",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    selectedDocId: record.selectedDocId ?? null,
    selectedDocTitle: record.selectedDocTitle || "",
    messageCount: record.messages.length,
  };
}

export function buildConversationRecordFromSession(session: SessionV2): ConversationRecord {
  return convertSessionToConversationRecord(session);
}

export type { ConversationRecord, ConversationIndexEntry, SessionV2, ConversationSummary };
