import { getAppConfig } from "../../app/config";
import { NO_STORE_HEADERS } from "../../http/security";
import { AuthorizationPolicy } from "../../auth/policy";
import {
  buildAuthLogoutCookie,
  getAuthSession,
  readAuthToken,
  revokeAuthSession,
} from "../../auth/session";
import { beginOidcLogin, completeOidcLogin, listPublicAuthProviders, loginWithDevProvider } from "../../auth/provider";
import { buildAuditActor, getRequestId, writeAuditEvent } from "../../observability/audit";
import type { Env } from "../../types";
import { jsonNoStore } from "../runtime/http";
import { logFacultyAuthAttempt } from "../runtime/authz";

export async function handleAuthProvidersRoute(req: Request, env: Env): Promise<Response> {
  const config = getAppConfig(env, req);
  return jsonNoStore({
    appEnv: config.appEnv,
    institutionId: config.institutionId,
    institutionName: config.institutionName,
    providers: listPublicAuthProviders(config),
  });
}

export async function handleAuthLoginRoute(req: Request, env: Env): Promise<Response> {
  const config = getAppConfig(env, req);
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return jsonNoStore({ error: "Send JSON { provider, email, sharedSecret? }." }, 400);
  }
  const provider =
    typeof (body as any).provider === "string" && (body as any).provider.trim()
      ? (body as any).provider.trim().toLowerCase()
      : "dev";
  try {
    if (provider !== "dev") {
      return jsonNoStore({ error: "Interactive SSO must start from /api/auth/oidc/start." }, 400);
    }
    const login = await loginWithDevProvider(req, env, config, body as Record<string, unknown>);
    await writeAuditEvent(env, req, getRequestId(req), {
      event: "auth.login",
      outcome: "success",
      actor: buildAuditActor(login.record),
      metadata: { provider: "dev" },
    });
    const headers = new Headers({
      "content-type": "application/json; charset=utf-8",
      ...NO_STORE_HEADERS,
    });
    headers.append("Set-Cookie", login.cookie);
    return new Response(JSON.stringify({ ok: true, user: login.record }), { status: 200, headers });
  } catch (error) {
    await writeAuditEvent(env, req, getRequestId(req), {
      event: "auth.login",
      outcome: "failure",
      metadata: {
        provider,
        reason: error instanceof Error ? error.message : "login_failed",
      },
    });
    return jsonNoStore({ error: error instanceof Error ? error.message : "Login failed." }, 401);
  }
}

export async function handleAuthSessionRoute(req: Request, env: Env): Promise<Response> {
  const config = getAppConfig(env, req);
  const session = await getAuthSession(req, env, config);
  if (!session) {
    return jsonNoStore({ ok: false, error: "unauthorized" }, 401);
  }
  return jsonNoStore({ ok: true, user: session });
}

export async function handleAuthLogoutRoute(req: Request, env: Env): Promise<Response> {
  const config = getAppConfig(env, req);
  const session = await getAuthSession(req, env, config);
  await revokeAuthSession(req, env);
  await writeAuditEvent(env, req, getRequestId(req), {
    event: "auth.logout",
    outcome: "success",
    actor: buildAuditActor(session),
  });
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    ...NO_STORE_HEADERS,
  });
  headers.append("Set-Cookie", buildAuthLogoutCookie(req));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

export async function handleAuthOidcStartRoute(req: Request, env: Env): Promise<Response> {
  try {
    const config = getAppConfig(env, req);
    const redirectUrl = await beginOidcLogin(req, env, config);
    return Response.redirect(redirectUrl, 302);
  } catch (error) {
    return jsonNoStore({ error: error instanceof Error ? error.message : "Unable to start OIDC login." }, 400);
  }
}

export async function handleAuthOidcCallbackRoute(req: Request, env: Env): Promise<Response> {
  try {
    const config = getAppConfig(env, req);
    const result = await completeOidcLogin(req, env, config);
    await writeAuditEvent(env, req, getRequestId(req), {
      event: "auth.login",
      outcome: "success",
      actor: buildAuditActor(result.record),
      metadata: { provider: "oidc" },
    });
    const redirectTo = new URL(result.returnTo || "/faculty/pipeline", config.baseUrl);
    const resp = Response.redirect(redirectTo.toString(), 302);
    resp.headers.append("Set-Cookie", result.cookie);
    return resp;
  } catch (error) {
    await writeAuditEvent(env, req, getRequestId(req), {
      event: "auth.login",
      outcome: "failure",
      metadata: {
        provider: "oidc",
        reason: error instanceof Error ? error.message : "oidc_callback_failed",
      },
    });
    return jsonNoStore({ error: error instanceof Error ? error.message : "OIDC callback failed." }, 401);
  }
}

export function handleFacultyLoginRoute(req: Request, env: Env): Promise<Response> {
  return handleAuthLoginRoute(req, env);
}

export async function handleFacultySessionRoute(req: Request, env: Env): Promise<Response> {
  const config = getAppConfig(env, req);
  const { source, hasCookie, hasHeader } = readAuthToken(req);
  const session = await getAuthSession(req, env, config);
  const allowed = AuthorizationPolicy.canAccess(session, "library.download.internal");
  logFacultyAuthAttempt({
    req,
    label: "faculty_session",
    source,
    hasCookie,
    hasHeader,
    ok: allowed.allowed && Boolean(session),
    reason: allowed.allowed ? undefined : allowed.reason,
  });
  if (!session || !allowed.allowed) {
    return jsonNoStore({ error: "unauthorized" }, 401);
  }
  return jsonNoStore({ ok: true, user: session });
}

export function handleFacultyLogoutRoute(req: Request, env: Env): Promise<Response> {
  return handleAuthLogoutRoute(req, env);
}
