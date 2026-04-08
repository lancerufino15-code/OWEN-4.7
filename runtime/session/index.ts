import { getAppConfig } from "../../../app/config";
import { createRuntimeSessionStore } from "../../../runtime/session-store";
import type { Env } from "../../../types";
import { appendSetCookie, jsonNoStore } from "../http";
import { inspectLatestRuntimeSession, inspectRuntimeSession, resumeRuntimeSession } from "./resume";

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

function getSessionIdFromPath(req: Request): string {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const runtimeIndex = parts.indexOf("runtime");
  const sessionIndex = parts.indexOf("session");
  const idIndex = sessionIndex >= 0 ? sessionIndex + 1 : runtimeIndex >= 0 ? runtimeIndex + 2 : -1;
  return decodeURIComponent(idIndex >= 0 ? parts[idIndex] || "" : "");
}

export async function handleRuntimeSessionRoute(req: Request, env: Env): Promise<Response> {
  const context = await getConversationRequestContext(req, env);
  const url = new URL(req.url);
  const requestedId = getSessionIdFromPath(req) || url.searchParams.get("session_id") || "";
  const result = requestedId
    ? await inspectRuntimeSession(env, context.scope, requestedId)
    : await inspectLatestRuntimeSession(env, context.scope);
  if (!result) {
    return appendSetCookie(jsonNoStore({ error: "not_found", session: null, conversation: null }, 404), context.setCookie);
  }
  return appendSetCookie(jsonNoStore(result), context.setCookie);
}

export async function handleRuntimeSessionResumeRoute(req: Request, env: Env): Promise<Response> {
  const context = await getConversationRequestContext(req, env);
  const sessionId = getSessionIdFromPath(req);
  if (!sessionId) {
    return appendSetCookie(jsonNoStore({ error: "session_id_required" }, 400), context.setCookie);
  }
  const result = await resumeRuntimeSession(env, context.scope, sessionId);
  if (!result) {
    return appendSetCookie(jsonNoStore({ error: "not_found", session: null, conversation: null }, 404), context.setCookie);
  }
  return appendSetCookie(jsonNoStore(result), context.setCookie);
}

export * from "./types";
export * from "./migration";
export * from "./persistence";
export * from "./resume";
