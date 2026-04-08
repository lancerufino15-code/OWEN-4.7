import { getAppConfig } from "../../app/config";
import { AuthorizationPolicy } from "../../auth/policy";
import { buildAuditActor, getRequestId, writeAuditEvent } from "../../observability/audit";
import type { Env } from "../../types";
import { requireFaculty } from "../runtime/authz";
import { RUNTIME_CORS_HEADERS, jsonNoStore } from "../runtime/http";
import { getBucketByName, getLibraryBucket, sanitizeFilename } from "../runtime/storage";
import {
  buildExtractedPath,
  buildIndexKeyForDoc,
  buildManifestPath,
  isPdfKey,
  readIndex,
  titleFromKey,
} from "./index";
import { buildLectureTxtDisplayName, resolvePreferredMachineTxtKey } from "./machine-txt";
import {
  buildStudyGuideFilename,
  buildStudyGuideSourceFilename,
  buildStudyGuideSourceKey,
  buildStudyGuideStoredKey,
} from "../study-guide/files";

function resolveLectureTitle(record: { title?: string; key?: string; docId: string }) {
  const raw = (record.title || "").trim();
  if (raw) return raw;
  if (record.key) return titleFromKey(record.key);
  return record.docId;
}

export async function handleLibraryDownloadRoute(request: Request, env: Env): Promise<Response> {
  const auth = await requireFaculty(request, env, "library_download");
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const lectureId = url.searchParams.get("lectureId") || url.searchParams.get("docId") || "";
  const type = (url.searchParams.get("type") || "").toLowerCase();
  if (!lectureId) {
    return jsonNoStore({ error: "Missing lectureId." }, 400);
  }

  const allowed = new Set(["pdf", "txt", "ocr", "guide", "guide_source", "guide-source", "manifest", "index"]);
  if (!allowed.has(type)) {
    return jsonNoStore({ error: "Invalid type." }, 400);
  }

  const { bucket: libraryBucket } = getLibraryBucket(env);
  const indexRecords = await readIndex(libraryBucket);
  const record = indexRecords.find((entry) => entry.docId === lectureId);
  if (!record) {
    return jsonNoStore({ error: "Lecture not found." }, 404);
  }

  const config = getAppConfig(env, request);
  const access = AuthorizationPolicy.canAccess(auth.context.session, "library.download.internal", {
    institutionId: record.institutionId || config.institutionId,
    courseId: record.courseId ?? null,
    ownerUserId: record.ownerUserId ?? null,
  });
  if (!access.allowed) {
    return jsonNoStore({ error: "forbidden" }, 403);
  }

  const lectureTitle = resolveLectureTitle(record);
  let bucket: R2Bucket = libraryBucket;
  let key = "";
  let filename = "";

  if (type === "pdf") {
    if (!isPdfKey(record.key || "")) {
      return jsonNoStore({ error: "PDF not found for this lecture." }, 404);
    }
    bucket = getBucketByName(env, record.bucket);
    key = record.key;
    filename = key.split("/").pop() || `${lectureTitle}.pdf`;
  } else if (type === "ocr") {
    key = record.extractedKey || buildExtractedPath(record.docId);
    filename = `${buildLectureTxtDisplayName(lectureTitle).replace(/\.txt$/i, "")}_ocr.txt`;
  } else if (type === "txt") {
    key = await resolvePreferredMachineTxtKey(libraryBucket, record.docId, lectureTitle);
    filename = buildLectureTxtDisplayName(lectureTitle);
  } else if (type === "guide") {
    key = buildStudyGuideStoredKey(record.docId, lectureTitle);
    filename = buildStudyGuideFilename(lectureTitle);
  } else if (type === "guide_source" || type === "guide-source") {
    key = buildStudyGuideSourceKey(record.docId, lectureTitle);
    filename = buildStudyGuideSourceFilename(lectureTitle);
  } else if (type === "manifest") {
    key = record.manifestKey || buildManifestPath(record.docId);
    filename = `manifest_${lectureTitle}.json`;
  } else {
    key = buildIndexKeyForDoc(record.docId);
    filename = `index_${record.docId}.json`;
  }

  if (!key) {
    return jsonNoStore({ error: "Missing artifact key." }, 404);
  }

  const object = await bucket.get(key);
  if (!object || !object.body) {
    return new Response("Not found", { status: 404, headers: RUNTIME_CORS_HEADERS });
  }

  await writeAuditEvent(env, request, getRequestId(request), {
    event: "library.asset.download",
    outcome: "success",
    actor: buildAuditActor(auth.context.session),
    metadata: { lectureId, type, bucket: record.bucket, key },
  });

  const safeFilename = sanitizeFilename(filename || key.split("/").pop() || "download");
  return new Response(object.body, {
    headers: {
      ...RUNTIME_CORS_HEADERS,
      "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${safeFilename}"`,
    },
  });
}

export function handleMachineLectureDownloadRoute(request: Request, env: Env): Promise<Response> {
  return handleLibraryDownloadRoute(request, env);
}
