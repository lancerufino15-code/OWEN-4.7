import { getAppConfig } from "../../app/config";
import { AuthorizationPolicy } from "../../auth/policy";
import { getAuthSession } from "../../auth/session";
import { getRequestId, getRequestIp } from "../../observability/audit";
import { recordMetricEvent } from "../../observability/metrics";
import type { Env } from "../../types";
import { NO_STORE_HEADERS } from "../../http/security";
import { RUNTIME_CORS_HEADERS, jsonNoStore } from "../runtime/http";
import { getLibraryBucket } from "../runtime/storage";

const ANKI_DECKS_PREFIX = "Anki Decks";
const ANKI_CARDS_FILENAME = "cards.tsv";
const ANKI_MANIFEST_FILENAME = "manifest.json";
const ANKI_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ANKI_RATE_LIMIT_MAX = 20;
const ANKI_RATE_LIMIT_WINDOW_SECONDS = 10 * 60;

const ankiRateLimitState = new Map<string, { count: number; expiresAt: number }>();

type AnkiManifest = {
  code: string;
  ankiKey: string;
  lectureTitle?: string;
  lectureId?: string;
  createdAt: string;
  publishedAt?: string;
  createdBy?: string;
  imageCount?: number;
  hasBoldmap?: boolean;
  hasClassmateDeck?: boolean;
  mediaPrefix?: string;
};

function normalizeAnkiCode(value: string) {
  return (value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isAnkiCodeValid(code: string) {
  if (!code) return false;
  if (code.length < 6 || code.length > 10) return false;
  for (const ch of code) {
    if (!ANKI_CODE_ALPHABET.includes(ch)) return false;
  }
  return true;
}

function buildAnkiDeckPrefix(code: string) {
  return `${ANKI_DECKS_PREFIX}/${code}`;
}

function buildAnkiManifestKey(code: string) {
  return `${buildAnkiDeckPrefix(code)}/${ANKI_MANIFEST_FILENAME}`;
}

function buildAnkiManifestKvKey(code: string) {
  return `anki:${code}`;
}

function coerceAnkiManifest(raw: unknown): AnkiManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const code = normalizeAnkiCode(typeof (raw as any).code === "string" ? (raw as any).code : "");
  if (!isAnkiCodeValid(code)) return null;
  const ankiKey = typeof (raw as any).ankiKey === "string" ? (raw as any).ankiKey.trim() : "";
  const createdAt = typeof (raw as any).createdAt === "string" ? (raw as any).createdAt : "";
  if (!ankiKey || !createdAt) return null;
  return {
    code,
    ankiKey,
    createdAt,
    lectureTitle: typeof (raw as any).lectureTitle === "string" ? (raw as any).lectureTitle : undefined,
    lectureId: typeof (raw as any).lectureId === "string" ? (raw as any).lectureId : undefined,
    publishedAt: typeof (raw as any).publishedAt === "string" ? (raw as any).publishedAt : undefined,
    createdBy: typeof (raw as any).createdBy === "string" ? (raw as any).createdBy : undefined,
    imageCount: Number.isFinite(Number((raw as any).imageCount)) ? Number((raw as any).imageCount) : undefined,
    hasBoldmap: typeof (raw as any).hasBoldmap === "boolean" ? (raw as any).hasBoldmap : undefined,
    hasClassmateDeck: typeof (raw as any).hasClassmateDeck === "boolean" ? (raw as any).hasClassmateDeck : undefined,
    mediaPrefix: typeof (raw as any).mediaPrefix === "string" ? (raw as any).mediaPrefix : undefined,
  };
}

async function loadAnkiManifest(env: Env, code: string): Promise<AnkiManifest | null> {
  if (!isAnkiCodeValid(code)) return null;
  if (env.DOCS_KV) {
    const cached = await env.DOCS_KV.get(buildAnkiManifestKvKey(code), { type: "json" }) as any;
    const parsed = coerceAnkiManifest(cached);
    if (parsed) return parsed;
  }
  try {
    const { bucket } = getLibraryBucket(env);
    const obj = await bucket.get(buildAnkiManifestKey(code));
    if (!obj || !obj.body) return null;
    const text = await obj.text();
    const parsed = coerceAnkiManifest(JSON.parse(text));
    if (!parsed) return null;
    if (env.DOCS_KV) {
      await env.DOCS_KV.put(buildAnkiManifestKvKey(code), JSON.stringify(parsed));
    }
    return parsed;
  } catch {
    return null;
  }
}

async function isFacultyRequest(req: Request, env: Env) {
  const config = getAppConfig(env, req);
  const session = await getAuthSession(req, env, config);
  const allowed = AuthorizationPolicy.canAccess(session, "library.download.internal");
  return Boolean(session && allowed.allowed);
}

async function checkAnkiRateLimit(env: Env, req: Request) {
  const ip = getRequestIp(req);
  if (!ip) return { allowed: true as const };
  if (env.DOCS_KV) {
    const key = `anki:rate:${ip}`;
    const currentRaw = await env.DOCS_KV.get(key);
    const current = Number.parseInt(currentRaw || "0", 10) || 0;
    if (current >= ANKI_RATE_LIMIT_MAX) {
      return { allowed: false as const, retryAfter: ANKI_RATE_LIMIT_WINDOW_SECONDS };
    }
    await env.DOCS_KV.put(key, String(current + 1), { expirationTtl: ANKI_RATE_LIMIT_WINDOW_SECONDS });
    return { allowed: true as const };
  }
  const now = Date.now();
  const entry = ankiRateLimitState.get(ip);
  if (!entry || entry.expiresAt <= now) {
    ankiRateLimitState.set(ip, { count: 1, expiresAt: now + ANKI_RATE_LIMIT_WINDOW_SECONDS * 1000 });
    return { allowed: true as const };
  }
  if (entry.count >= ANKI_RATE_LIMIT_MAX) {
    return { allowed: false as const, retryAfter: Math.max(1, Math.ceil((entry.expiresAt - now) / 1000)) };
  }
  entry.count += 1;
  ankiRateLimitState.set(ip, entry);
  return { allowed: true as const };
}

export async function handleAnkiDownloadRoute(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const rawCode = url.searchParams.get("code") || "";
  const code = normalizeAnkiCode(rawCode);
  if (!isAnkiCodeValid(code)) {
    return jsonNoStore({ error: "Invalid code." }, 400);
  }

  const isFaculty = await isFacultyRequest(request, env);
  if (!isFaculty) {
    const limit = await checkAnkiRateLimit(env, request);
    if (!limit.allowed) {
      return jsonNoStore({ error: "Too many attempts. Try again later." }, 429);
    }
  }

  const manifest = await loadAnkiManifest(env, code);
  if (!manifest) {
    return jsonNoStore({ error: "Invalid code." }, 404);
  }

  const { bucket } = getLibraryBucket(env);
  const object = await bucket.get(manifest.ankiKey);
  if (!object || !object.body) {
    return jsonNoStore({ error: "Invalid code." }, 404);
  }

  await recordMetricEvent(env, {
    name: "artifact_opened",
    requestId: getRequestId(request),
    artifactType: "anki",
    artifactCode: code,
    lectureId: manifest.lectureId,
    metadata: {
      lectureTitle: manifest.lectureTitle,
      isFaculty,
      hasMedia: Boolean(manifest.mediaPrefix),
    },
  });

  return new Response(object.body, {
    headers: {
      ...RUNTIME_CORS_HEADERS,
      ...NO_STORE_HEADERS,
      "Content-Type": object.httpMetadata?.contentType || "text/tab-separated-values; charset=utf-8",
      "Content-Disposition": `attachment; filename=\"${ANKI_CARDS_FILENAME}\"`,
    },
  });
}
