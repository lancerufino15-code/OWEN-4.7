/**
 * R2-backed caching helpers for PDF extraction artifacts.
 *
 * Used by: `src/index.ts` to read/write manifest metadata and extracted text
 * during ingestion and OCR flows.
 *
 * Key exports:
 * - `PdfManifest` schema and key-building helpers.
 * - `readManifest`, `writeManifest`, `loadCachedExtraction` for R2 I/O.
 *
 * Assumptions:
 * - R2 buckets store JSON manifests under `manifests/` and text under `extracted/`.
 */
import { normalizePlainText } from "./normalize";

/**
 * Extraction method used to populate a PDF manifest.
 */
export type PdfManifestMethod = "embedded" | "ocr" | "cache" | "partial";

/**
 * Manifest metadata for an extracted PDF.
 */
export type PdfManifest = {
  fileHash: string;
  filename?: string;
  method: PdfManifestMethod;
  pagesProcessed: number;
  ocrStatus?: string;
  pageCount?: number;
  ranges?: Array<{ start: number; end: number }>;
  createdAt: string;
  updatedAt?: string;
  preview?: string;
  extractedKey?: string;
  bucket?: string;
  key?: string;
  docId?: string;
  hashBasis?: string;
  hashFieldsUsed?: string[];
  extractionMethod?: PdfManifestMethod;
  title?: string;
};

/**
 * Build the extracted text key for a given file hash.
 *
 * @param fileHash - Hash of the input PDF bytes.
 * @returns R2 key for the extracted text file.
 */
export function buildExtractedKeyForHash(fileHash: string) {
  const safe = (fileHash || "").replace(/[^a-z0-9]/gi, "");
  const id = safe || "file";
  return `extracted/${id}.txt`;
}

/**
 * Build the manifest key for a given file hash.
 *
 * @param fileHash - Hash of the input PDF bytes.
 * @returns R2 key for the manifest JSON.
 */
export function buildManifestKeyForHash(fileHash: string) {
  const safe = (fileHash || "").replace(/[^a-z0-9]/gi, "");
  const id = safe || "file";
  return `manifests/${id}.json`;
}

/**
 * Read a manifest from R2 if it exists.
 *
 * @param bucket - R2 bucket containing manifests.
 * @param fileHash - Hash of the PDF content.
 * @returns Manifest object or null on cache miss.
 * @remarks Side effects: performs an R2 `get` call.
 */
export async function readManifest(bucket: R2Bucket, fileHash: string): Promise<PdfManifest | null> {
  try {
    const manifestKey = buildManifestKeyForHash(fileHash);
    const record = await bucket.get(manifestKey);
    if (!record || !record.body) return null;
    const json = await record.json<PdfManifest>().catch(() => null);
    if (json && typeof json === "object" && typeof json.fileHash === "string") {
      return json;
    }
  } catch {
    // ignore parse errors; treat as cache miss
  }
  return null;
}

/**
 * Write a manifest back to R2 with updated timestamp.
 *
 * @param bucket - R2 bucket containing manifests.
 * @param manifest - Manifest data to persist.
 * @remarks Side effects: performs an R2 `put` call.
 */
export async function writeManifest(bucket: R2Bucket, manifest: PdfManifest) {
  const payload: PdfManifest = {
    ...manifest,
    updatedAt: new Date().toISOString(),
  };
  const manifestKey = buildManifestKeyForHash(manifest.fileHash);
  await bucket.put(manifestKey, JSON.stringify(payload), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

/**
 * Load cached extracted text and manifest for a PDF hash.
 *
 * @param bucket - R2 bucket storing extracted text and manifests.
 * @param fileHash - Hash of the PDF content.
 * @returns Extracted text (if any), manifest, and extracted key.
 */
export async function loadCachedExtraction(bucket: R2Bucket, fileHash: string) {
  const extractedKey = buildExtractedKeyForHash(fileHash);
  let manifest: PdfManifest | null = null;
  try {
    manifest = await readManifest(bucket, fileHash);
  } catch {
    // ignore
  }
  try {
    const object = await bucket.get(extractedKey);
    if (!object || !object.body) {
      return { extractedKey, manifest, text: null };
    }
    const raw = await object.text();
    const text = normalizePlainText(raw);
    return { extractedKey, manifest, text };
  } catch {
    return { extractedKey, manifest, text: null };
  }
}
