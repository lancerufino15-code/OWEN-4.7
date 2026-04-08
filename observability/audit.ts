import type { AuthSessionRecord } from "../auth/session";
import type { Env } from "../types";
import { generateOpaqueId } from "../utils/ids";

export interface AuditActor {
  sessionId?: string;
  userId?: string;
  email?: string;
  role?: string;
  institutionId?: string;
}

export interface AuditEvent {
  event: string;
  outcome: "success" | "failure" | "denied";
  actor?: AuditActor;
  requestId: string;
  path: string;
  method: string;
  ip?: string;
  metadata?: Record<string, unknown>;
  ts: string;
}

function getAuditKv(env: Env): KVNamespace | undefined {
  return env.OWEN_DIAG_KV || env.DOCS_KV;
}

export function getRequestId(req: Request): string {
  return (
    req.headers.get("x-request-id") ||
    req.headers.get("cf-ray") ||
    generateOpaqueId("req")
  );
}

export function getRequestIp(req: Request): string {
  const direct = (req.headers.get("cf-connecting-ip") || "").trim();
  if (direct) return direct;
  const forwarded = (req.headers.get("x-forwarded-for") || "").split(",")[0]?.trim() || "";
  return forwarded;
}

export function buildAuditActor(session: AuthSessionRecord | null | undefined): AuditActor | undefined {
  if (!session) return undefined;
  return {
    sessionId: session.sessionId,
    userId: session.userId,
    email: session.email,
    role: session.role,
    institutionId: session.institutionId,
  };
}

export async function writeAuditEvent(
  env: Env,
  req: Request,
  requestId: string,
  event: Omit<AuditEvent, "requestId" | "path" | "method" | "ip" | "ts">,
): Promise<void> {
  const payload: AuditEvent = {
    ...event,
    requestId,
    path: new URL(req.url).pathname,
    method: req.method,
    ip: getRequestIp(req),
    ts: new Date().toISOString(),
  };
  console.info("[OWEN_AUDIT]", JSON.stringify(payload));
  const kv = getAuditKv(env);
  if (!kv) return;
  const auditKey = `audit:${payload.ts}:${requestId}:${generateOpaqueId("audit")}`;
  await kv.put(auditKey, JSON.stringify(payload), { expirationTtl: 60 * 60 * 24 * 30 });
}
