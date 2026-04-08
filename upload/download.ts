import { buildAuditActor, getRequestId, writeAuditEvent } from "../../observability/audit";
import type { Env } from "../../types";
import { requireFaculty } from "../runtime/authz";
import { RUNTIME_CORS_HEADERS, json } from "../runtime/http";
import {
  findObjectInBucket,
  getBucketByName,
  sanitizeFilename,
  lookupBucket,
  BUCKET_BINDINGS,
} from "../runtime/storage";

export async function handleFileRoute(request: Request, env: Env): Promise<Response> {
  const auth = await requireFaculty(request, env, "file_download");
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const searchKey = url.searchParams.get("key");
  if (!searchKey) return json({ error: "Missing key parameter" }, 400);

  const requestedBucket = url.searchParams.get("bucket");
  const candidates = requestedBucket ? [requestedBucket] : Object.keys(BUCKET_BINDINGS);

  let object: R2ObjectBody | null = null;
  let bucketUsed: string | null = null;
  let matchedKey = searchKey;

  for (const name of candidates) {
    try {
      const bucket = getBucketByName(env, name);
      const match = await findObjectInBucket(bucket, searchKey);
      if (match) {
        object = match.object;
        bucketUsed = name;
        matchedKey = match.key;
        break;
      }
    } catch {
      // try the next candidate bucket
    }
  }

  if (!object || !object.body) {
    return new Response("Not found", { status: 404, headers: RUNTIME_CORS_HEADERS });
  }

  await writeAuditEvent(env, request, getRequestId(request), {
    event: "storage.object.read",
    outcome: "success",
    actor: buildAuditActor(auth.context.session),
    metadata: { bucket: bucketUsed, key: matchedKey },
  });

  const headers = new Headers(RUNTIME_CORS_HEADERS);
  headers.set("content-type", object.httpMetadata?.contentType || "application/octet-stream");
  const filenameParam = url.searchParams.get("filename");
  const filename = sanitizeFilename(filenameParam || matchedKey.split("/").pop() || "download.bin");
  headers.set("content-disposition", `attachment; filename="${filename}"`);
  if (bucketUsed) headers.set("x-owen-bucket", bucketUsed);
  return new Response(object.body, { headers });
}

export async function handleDownloadRoute(request: Request, env: Env): Promise<Response> {
  const auth = await requireFaculty(request, env, "file_download");
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const bucketName = url.searchParams.get("bucket");
  const key = url.searchParams.get("key");
  if (!bucketName || !key) {
    return new Response("Missing bucket or key", { status: 400, headers: RUNTIME_CORS_HEADERS });
  }

  const lookup = lookupBucket(env, bucketName);
  if (!lookup) {
    return new Response("Unknown bucket", { status: 400, headers: RUNTIME_CORS_HEADERS });
  }

  const object = await lookup.bucket.get(key);
  if (!object || !object.body) {
    return new Response("Not found", { status: 404, headers: RUNTIME_CORS_HEADERS });
  }

  await writeAuditEvent(env, request, getRequestId(request), {
    event: "storage.object.read",
    outcome: "success",
    actor: buildAuditActor(auth.context.session),
    metadata: { bucket: bucketName, key },
  });

  return new Response(object.body, {
    headers: {
      ...RUNTIME_CORS_HEADERS,
      "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${key}"`,
    },
  });
}
