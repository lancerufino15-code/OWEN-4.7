import type { TrafficSnapshot } from "../../durable/presence-room";
import { sha256 } from "../library";
import { readRequestJsonBody, jsonNoStore } from "../runtime/http";
import type { Env } from "../../types";

type TrafficRole = "student" | "faculty";

const TRAFFIC_ID_SALT = "owen-traffic-v1";

function isTrafficRole(value: unknown): value is TrafficRole {
  return value === "student" || value === "faculty";
}

function sanitizeTrafficUserId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-f0-9]{5}$/.test(raw) ? raw : "";
}

function sanitizeTrafficTabId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9_-]{6,48}$/.test(raw) ? raw : "";
}

function getTrafficRequestIp(req: Request): string {
  const direct = (req.headers.get("cf-connecting-ip") || "").trim();
  if (direct) return direct;
  const forwarded = (req.headers.get("x-forwarded-for") || "").split(",")[0]?.trim() || "";
  if (forwarded) return forwarded;
  return "0.0.0.0";
}

async function buildTrafficAnonId(req: Request): Promise<string> {
  const ip = getTrafficRequestIp(req);
  const userAgent = (req.headers.get("user-agent") || "").trim();
  const hash = await sha256(`${ip}${userAgent}${TRAFFIC_ID_SALT}`);
  return hash.slice(0, 5).toLowerCase();
}

function shouldLogTrafficDev(req: Request): boolean {
  const hostname = new URL(req.url).hostname.trim().toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".local");
}

function getPresenceStub(env: Env) {
  const id = env.PRESENCE_ROOM.idFromName("global-presence");
  return env.PRESENCE_ROOM.get(id);
}

function isTrafficSnapshot(value: unknown): value is TrafficSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.activeStudents === "number" &&
    Number.isFinite(candidate.activeStudents) &&
    typeof candidate.activeFaculty === "number" &&
    Number.isFinite(candidate.activeFaculty) &&
    typeof candidate.activeTotal === "number" &&
    Number.isFinite(candidate.activeTotal) &&
    Array.isArray(candidate.users) &&
    Array.isArray(candidate.series) &&
    typeof candidate.updatedAt === "string"
  );
}

async function fetchPresenceSnapshot(
  env: Env,
  path: "/ping" | "/snapshot",
  init?: RequestInit,
): Promise<TrafficSnapshot | null> {
  const stub = getPresenceStub(env);
  const resp = await stub.fetch(`https://presence${path}`, init);
  if (!resp.ok) return null;
  const payload = await resp.json().catch(() => null);
  if (!isTrafficSnapshot(payload)) return null;
  return payload;
}

async function resolveTrafficUserId(req: Request, provided: unknown): Promise<string> {
  const normalized = sanitizeTrafficUserId(provided);
  if (normalized) return normalized;
  return buildTrafficAnonId(req);
}

export async function handleTrafficPingRoute(req: Request, env: Env): Promise<Response> {
  const body = await readRequestJsonBody(req);
  if (!body || typeof body !== "object") {
    return jsonNoStore({ error: "Send JSON { userId?, role, timestamp?, tabId? }." }, 400);
  }
  const roleRaw = typeof body.role === "string" ? body.role.trim().toLowerCase() : "";
  if (!isTrafficRole(roleRaw)) {
    return jsonNoStore({ error: "role must be student or faculty." }, 400);
  }
  const userId = await resolveTrafficUserId(req, body.userId);
  const tabId = sanitizeTrafficTabId(body.tabId);
  const snapshot = await fetchPresenceSnapshot(env, "/ping", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userId,
      role: roleRaw,
      tabId: tabId || undefined,
      ts: Date.now(),
    }),
  });
  if (!snapshot) {
    return jsonNoStore({ error: "presence_unavailable" }, 503);
  }
  if (shouldLogTrafficDev(req)) {
    console.log("Active users:", snapshot.activeTotal);
  }
  return jsonNoStore({
    ok: true,
    userId,
    tabId: tabId || undefined,
    role: roleRaw,
    activeStudents: snapshot.activeStudents,
    activeFaculty: snapshot.activeFaculty,
    users: snapshot.users.map((user) => ({ id: user.id, role: user.role })),
    updatedAt: snapshot.updatedAt,
    snapshot,
  });
}

export async function handleTrafficSnapshotRoute(req: Request, env: Env): Promise<Response> {
  const snapshot = await fetchPresenceSnapshot(env, "/snapshot");
  if (!snapshot) {
    return jsonNoStore({ error: "presence_unavailable" }, 503);
  }
  if (shouldLogTrafficDev(req)) {
    console.log("Active users:", snapshot.activeTotal);
  }
  return jsonNoStore({
    activeStudents: snapshot.activeStudents,
    activeFaculty: snapshot.activeFaculty,
    users: snapshot.users.map((user) => ({ id: user.id, role: user.role })),
    series: snapshot.series,
    updatedAt: snapshot.updatedAt,
    snapshot,
  });
}
