import { getAppConfig } from "../../app/config";
import { AuthorizationPolicy, type PolicyAction } from "../../auth/policy";
import { getAuthSession, readAuthToken, type AuthSessionRecord } from "../../auth/session";
import { buildAuditActor, getRequestId, writeAuditEvent } from "../../observability/audit";
import type { Env } from "../../types";
import { jsonNoStore } from "./http";
import type { UsageQueryFilters } from "./usage/types";

function mapLegacyFacultyAction(label: string): PolicyAction {
  switch (label) {
    case "library_category_create":
      return "library.category.create";
    case "library_course_create":
      return "library.course.create";
    case "library_course_rename":
      return "library.course.rename";
    case "library_course_delete":
      return "library.course.delete";
    case "library_lecture_update":
      return "library.lecture.update";
    case "library_txt_upload":
      return "library.txt.upload";
    case "library_qbank_upload":
      return "library.qbank.upload";
    case "library_delete":
      return "library.delete";
    case "study_guide_publish":
      return "study-guide.publish";
    case "anki_publish":
      return "anki.publish";
    case "anki_generate":
      return "anki.generate";
    default:
      return "library.download.internal";
  }
}

export function logFacultyAuthAttempt(details: {
  req: Request;
  label: string;
  source: "cookie" | "header" | "none";
  hasCookie: boolean;
  hasHeader: boolean;
  ok: boolean;
  reason?: string;
}) {
  const { req, label, source, hasCookie, hasHeader, ok, reason } = details;
  const url = new URL(req.url);
  const payload = {
    label,
    path: url.pathname,
    method: req.method,
    source,
    cookie: hasCookie,
    header: hasHeader,
    ok,
    reason: ok ? undefined : reason || "unauthorized",
  };
  if (ok) {
    console.info("[FACULTY_AUTH]", payload);
  } else {
    console.warn("[FACULTY_AUTH]", payload);
  }
}

export async function requireFaculty(
  req: Request,
  env: Env,
  label: string,
): Promise<{ ok: true; context: { isFaculty: true; session: AuthSessionRecord } } | { ok: false; response: Response }> {
  const config = getAppConfig(env, req);
  const { source, hasCookie, hasHeader } = readAuthToken(req);
  const session = await getAuthSession(req, env, config);
  const decision = AuthorizationPolicy.canAccess(session, mapLegacyFacultyAction(label));
  if (!decision.allowed || !session) {
    logFacultyAuthAttempt({
      req,
      label,
      source,
      hasCookie,
      hasHeader,
      ok: false,
      reason: decision.reason || "unauthorized",
    });
    await writeAuditEvent(env, req, getRequestId(req), {
      event: "authz.denied",
      outcome: "denied",
      actor: buildAuditActor(session),
      metadata: { label, reason: decision.reason || "unauthorized" },
    });
    return { ok: false, response: jsonNoStore({ error: "unauthorized" }, 401) };
  }
  logFacultyAuthAttempt({
    req,
    label,
    source,
    hasCookie,
    hasHeader,
    ok: true,
  });
  return { ok: true, context: { isFaculty: true, session } };
}

export async function requireLectureAnalyticsRead(
  req: Request,
  env: Env,
  label: string,
): Promise<{ ok: true; session: AuthSessionRecord } | { ok: false; response: Response }> {
  const config = getAppConfig(env, req);
  const { source, hasCookie, hasHeader } = readAuthToken(req);
  const session = await getAuthSession(req, env, config);
  const decision = AuthorizationPolicy.canAccess(session, "lecture.analytics.read");
  if (!decision.allowed || !session) {
    logFacultyAuthAttempt({
      req,
      label,
      source,
      hasCookie,
      hasHeader,
      ok: false,
      reason: decision.reason || "unauthorized",
    });
    await writeAuditEvent(env, req, getRequestId(req), {
      event: "authz.denied",
      outcome: "denied",
      actor: buildAuditActor(session),
      metadata: { label, reason: decision.reason || "unauthorized" },
    });
    return { ok: false, response: jsonNoStore({ error: "unauthorized" }, 401) };
  }
  logFacultyAuthAttempt({
    req,
    label,
    source,
    hasCookie,
    hasHeader,
    ok: true,
  });
  return { ok: true, session };
}

export async function requireAdmin(
  req: Request,
  env: Env,
  label: string,
): Promise<{ ok: true; session: AuthSessionRecord } | { ok: false; response: Response }> {
  const config = getAppConfig(env, req);
  const session = await getAuthSession(req, env, config);
  const action: PolicyAction = req.method === "POST" ? "admin.analytics.write" : "admin.analytics.read";
  const decision = AuthorizationPolicy.canAccess(session, action);
  if (!session || !decision.allowed) {
    await writeAuditEvent(env, req, getRequestId(req), {
      event: "authz.denied",
      outcome: "denied",
      actor: buildAuditActor(session),
      metadata: { label, reason: decision.reason || "admin_required" },
    });
    return { ok: false, response: jsonNoStore({ error: "unauthorized" }, 401) };
  }
  return { ok: true, session };
}

function buildUsageResource(filters: UsageQueryFilters) {
  return {
    institutionId: filters.institutionId || undefined,
    courseId: filters.courseId || undefined,
  };
}

async function requireAuthorizedSession(
  req: Request,
  env: Env,
  label: string,
  action: PolicyAction,
  resource: { institutionId?: string | null; courseId?: string | null } = {},
): Promise<{ ok: true; session: AuthSessionRecord } | { ok: false; response: Response }> {
  const config = getAppConfig(env, req);
  const session = await getAuthSession(req, env, config);
  const decision = AuthorizationPolicy.canAccess(session, action, resource);
  if (!session || !decision.allowed) {
    await writeAuditEvent(env, req, getRequestId(req), {
      event: "authz.denied",
      outcome: "denied",
      actor: buildAuditActor(session),
      metadata: { label, reason: decision.reason || "unauthorized", action },
    });
    return { ok: false, response: jsonNoStore({ error: "unauthorized" }, 401) };
  }
  return { ok: true, session };
}

export async function requireUsageCostRead(
  req: Request,
  env: Env,
  filters: UsageQueryFilters,
): Promise<{ ok: true; session: AuthSessionRecord } | { ok: false; response: Response }> {
  return requireAuthorizedSession(req, env, "usage_cost_read", "usage.cost.read", buildUsageResource(filters));
}

export async function requireUsageCostExport(
  req: Request,
  env: Env,
  filters: UsageQueryFilters,
): Promise<{ ok: true; session: AuthSessionRecord } | { ok: false; response: Response }> {
  return requireAuthorizedSession(req, env, "usage_cost_export", "usage.cost.export", buildUsageResource(filters));
}

export async function requireAdminCostRead(
  req: Request,
  env: Env,
  label: string,
): Promise<{ ok: true; session: AuthSessionRecord } | { ok: false; response: Response }> {
  return requireAuthorizedSession(req, env, label, "admin.cost.read");
}

export async function requireRuntimeConfigRead(
  req: Request,
  env: Env,
  label: string,
): Promise<{ ok: true; session: AuthSessionRecord } | { ok: false; response: Response }> {
  return requireAuthorizedSession(req, env, label, "admin.cost.read");
}
