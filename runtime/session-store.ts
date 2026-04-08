import type { AppConfig } from "../app/config";
import {
  buildAuthLogoutCookie,
  createAuthSession,
  ensureBrowserSession,
  getAuthSession,
  getBrowserConversationScope,
  revokeAuthSession,
  type AuthSessionRecord,
  type BrowserSessionRecord,
} from "../auth/session";
import type { Env } from "../types";

export interface RuntimeSessionStore {
  getAuthSession: (request: Request) => Promise<AuthSessionRecord | null>;
  createAuthSession: typeof createAuthSession;
  revokeAuthSession: (request: Request) => Promise<string | null>;
  buildLogoutCookie: (request: Request) => string;
  ensureBrowserSession: (request: Request) => Promise<{ token: string; record: BrowserSessionRecord; cookie?: string }>;
  resolveConversationScope: (request: Request) => Promise<{
    authSession: AuthSessionRecord | null;
    browserSession: { token: string; record: BrowserSessionRecord; cookie?: string };
    scope: string;
  }>;
}

export function createRuntimeSessionStore(env: Env, config: AppConfig): RuntimeSessionStore {
  return {
    getAuthSession: (request) => getAuthSession(request, env, config),
    createAuthSession: (runtimeEnv, request, runtimeConfig, input) => createAuthSession(runtimeEnv, request, runtimeConfig, input),
    revokeAuthSession: (request) => revokeAuthSession(request, env),
    buildLogoutCookie: (request) => buildAuthLogoutCookie(request),
    ensureBrowserSession: (request) => ensureBrowserSession(request, env, config),
    async resolveConversationScope(request) {
      const [authSession, browserSession] = await Promise.all([
        getAuthSession(request, env, config),
        ensureBrowserSession(request, env, config),
      ]);
      return {
        authSession,
        browserSession,
        scope: authSession?.sessionId ? `auth:${authSession.sessionId}` : getBrowserConversationScope(browserSession.token),
      };
    },
  };
}
