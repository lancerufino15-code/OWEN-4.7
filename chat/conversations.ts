import { getAppConfig } from "../../app/config";
import { createRuntimeSessionStore } from "../../runtime/session-store";
import type { Env } from "../../types";
import { appendSetCookie, isPlainObject, jsonNoStore, readRequestJsonBody } from "../runtime/http";
import {
  deleteConversationArtifacts,
  loadConversationIndex,
  loadConversationRecord,
  saveConversationIndex,
  upsertConversationRecord,
  type ConversationTags,
} from "../runtime/session";

function normalizeTags(tags: string[]): string[] {
  return tags
    .map((tag) => tag.trim())
    .map((tag) => (tag.startsWith("#") ? tag : `#${tag}`))
    .map((tag) => tag.replace(/[^#a-z0-9_-]/gi, "").toLowerCase())
    .filter(Boolean);
}

async function getConversationRequestContext(req: Request, env: Env): Promise<{ scope: string; setCookie?: string }> {
  if (!env.DOCS_KV || typeof env.DOCS_KV.put !== "function") {
    return { scope: "anonymous" };
  }
  const sessionStore = createRuntimeSessionStore(env, getAppConfig(env, req));
  const { scope, browserSession } = await sessionStore.resolveConversationScope(req);
  return {
    scope,
    setCookie: browserSession.cookie,
  };
}

export async function saveConversationTags(env: Env, scope: string, conversationId: string, rawTags: unknown): Promise<void> {
  if (!conversationId || !env.DOCS_KV) return;
  const tags: string[] = Array.isArray(rawTags)
    ? [...new Set(
        rawTags
          .map((tag) => String(tag).trim())
          .filter(Boolean)
          .map((tag) => (tag.startsWith("#") ? tag.toLowerCase() : `#${tag.toLowerCase()}`)),
      )]
    : [];
  if (!tags.length) return;
  const kvKey = `conv:${scope}:${conversationId}:tags`;
  const existing = await env.DOCS_KV.get(kvKey, { type: "json" }) as ConversationTags | null;
  const mergedTags = existing
    ? [...new Set([...(existing.tags || []), ...tags])]
    : tags;
  const record: ConversationTags = {
    conversation_id: conversationId,
    tags: mergedTags,
    updated_at: new Date().toISOString(),
  };
  await env.DOCS_KV.put(kvKey, JSON.stringify(record));
}

export async function storeConversationTags(env: Env, scope: string, conversationId: string, tags: string[]): Promise<void> {
  if (!env.DOCS_KV) return;
  const normalized = normalizeTags(tags);
  if (!normalized.length) return;
  const kvKey = `conv:${scope}:${conversationId}:tags`;
  await env.DOCS_KV.put(kvKey, JSON.stringify({
    conversation_id: conversationId,
    tags: normalized,
    updated_at: new Date().toISOString(),
  }));
}

export async function appendMetaTags(env: Env, tags: string[]): Promise<void> {
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
  normalized.forEach((tag) => union.add(tag));
  const finalTags = Array.from(union).slice(-500);
  await env.DOCS_KV.put(key, JSON.stringify({ tags: finalTags, updated_at: new Date().toISOString() }));
  const timelineKey = `meta_tags:${Date.now()}`;
  await env.DOCS_KV.put(timelineKey, JSON.stringify({ tags: normalized, ts: new Date().toISOString() }), {
    expirationTtl: 60 * 60 * 24 * 30,
  });
}

export async function handleMetaTagsRoute(req: Request, env: Env): Promise<Response> {
  if (!env.DOCS_KV) {
    return jsonNoStore({ tags: [] });
  }
  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversation_id");
  if (!conversationId) {
    const raw = await env.DOCS_KV.get("meta_tags");
    if (!raw) return jsonNoStore({ tags: [] });
    try {
      const parsed = JSON.parse(raw);
      const tags = Array.isArray(parsed?.tags) ? parsed.tags.filter((tag: unknown) => typeof tag === "string") : [];
      return jsonNoStore({ tags });
    } catch {
      return jsonNoStore({ tags: [] });
    }
  }
  const context = await getConversationRequestContext(req, env);
  const stored = await env.DOCS_KV.get(`conv:${context.scope}:${conversationId}:tags`, { type: "json" }) as ConversationTags | null;
  return appendSetCookie(jsonNoStore({ tags: Array.isArray(stored?.tags) ? stored.tags : [] }), context.setCookie);
}

function resolveConversationIdFromPath(request: Request): string {
  return decodeURIComponent(new URL(request.url).pathname.split("/").pop() || "");
}

async function handleConversationItemById(request: Request, env: Env, conversationId: string): Promise<Response> {
  if (!conversationId) {
    return jsonNoStore({ error: "conversation_id required" }, 400);
  }
  if (!env.DOCS_KV) {
    return jsonNoStore({ error: "storage_unavailable" }, 503);
  }
  const context = await getConversationRequestContext(request, env);
  const record = await loadConversationRecord(env, context.scope, conversationId);
  if (!record) {
    return appendSetCookie(jsonNoStore({ conversation: null, error: "not_found" }), context.setCookie);
  }
  return appendSetCookie(jsonNoStore({ conversation: record }), context.setCookie);
}

async function handleConversationDelete(request: Request, env: Env, conversationId: string): Promise<Response> {
  if (!conversationId) {
    return jsonNoStore({ error: "conversation_id required" }, 400);
  }
  if (!env.DOCS_KV) {
    return jsonNoStore({ error: "storage_unavailable" }, 503);
  }
  const context = await getConversationRequestContext(request, env);
  await deleteConversationArtifacts(env, context.scope, conversationId);
  const index = await loadConversationIndex(env, context.scope);
  await saveConversationIndex(env, context.scope, index.filter((entry) => entry.id !== conversationId));
  return appendSetCookie(jsonNoStore({ ok: true }), context.setCookie);
}

export async function handleConversationCollectionRoute(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const conversationId = url.searchParams.get("conversation_id") || "";
    if (conversationId) {
      return handleConversationItemById(request, env, conversationId);
    }
    if (!env.DOCS_KV) {
      return jsonNoStore({ conversations: [] });
    }
    const context = await getConversationRequestContext(request, env);
    const index = await loadConversationIndex(env, context.scope);
    index.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return appendSetCookie(jsonNoStore({ conversations: index }), context.setCookie);
  }
  if (request.method === "POST") {
    if (!env.DOCS_KV) {
      return jsonNoStore({ error: "storage_unavailable" }, 503);
    }
    const body = await readRequestJsonBody(request);
    if (!body || typeof body !== "object") {
      return jsonNoStore({ error: "Send JSON { conversation }." }, 400);
    }
    const rawConversation = isPlainObject(body.conversation) ? body.conversation : body;
    const context = await getConversationRequestContext(request, env);
    const result = await upsertConversationRecord(env, context.scope, rawConversation);
    if (!result) {
      return jsonNoStore({ error: "invalid_conversation" }, 400);
    }
    return appendSetCookie(jsonNoStore({ ok: true, conversation: result.record, index: result.index }), context.setCookie);
  }
  if (request.method === "DELETE") {
    const conversationId = url.searchParams.get("conversation_id") || "";
    return handleConversationDelete(request, env, conversationId);
  }
  return new Response("Method not allowed", { status: 405 });
}

export async function handleConversationItemRoute(request: Request, env: Env): Promise<Response> {
  const conversationId = resolveConversationIdFromPath(request);
  if (request.method === "GET") {
    return handleConversationItemById(request, env, conversationId);
  }
  if (request.method === "DELETE") {
    return handleConversationDelete(request, env, conversationId);
  }
  return new Response("Method not allowed", { status: 405 });
}
