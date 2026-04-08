import { NO_STORE_HEADERS } from "../../http/security";
import { sanitizeFilename, sanitizeKey } from "./storage";

const requestJsonBodyCache = new WeakMap<Request, string>();
const enc = new TextEncoder();

export const RUNTIME_CORS_HEADERS: Record<string, string> = {};

export function last<T>(arr: T[]): T | undefined {
  return arr.length ? arr[arr.length - 1] : undefined;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function readRequestJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  const cached = requestJsonBodyCache.get(req);
  if (typeof cached === "string") {
    try {
      return JSON.parse(cached) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (req.bodyUsed) return null;
  const text = await req.text().catch(() => "");
  requestJsonBodyCache.set(req, text);
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function safeJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return await response.text();
  }
}

export function appendSetCookie(resp: Response, cookie: string | undefined): Response {
  if (!cookie) return resp;
  const headers = new Headers(resp.headers);
  headers.append("Set-Cookie", cookie);
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

export function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...RUNTIME_CORS_HEADERS,
      ...NO_STORE_HEADERS,
    },
  });
}

export function jsonResponse(obj: unknown, status = 200): Response {
  return jsonNoStore(obj, status);
}

export function jsonNoStore(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...RUNTIME_CORS_HEADERS,
      ...NO_STORE_HEADERS,
    },
  });
}

export function mimeFromExtension(ext: string) {
  switch ((ext || "").toLowerCase()) {
    case "html":
      return "text/html; charset=utf-8";
    case "js":
      return "application/javascript; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "txt":
      return "text/plain; charset=utf-8";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

export function encodeSSE({ event, data }: { event: string; data: string }) {
  return enc.encode(`event: ${event}\ndata: ${data}\n\n`);
}

export { sanitizeFilename, sanitizeKey };
