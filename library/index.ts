/**
 * Library indexing helpers for R2-backed document storage.
 *
 * Used by: `src/index.ts` ingestion and retrieval flows to persist metadata and
 * locate extracted text/manifests.
 *
 * Key exports:
 * - `LibraryIndexRecord`: JSONL record shape stored in R2.
 * - `LIBRARY_*` constants: canonical key prefixes and index paths.
 * - Hash/title helpers for stable ids and tokenized search.
 * - `readIndex`/`writeIndex` for JSONL index I/O.
 *
 * Assumptions:
 * - Index is stored at `LIBRARY_INDEX_KEY` as newline-delimited JSON.
 * - WebCrypto (`crypto.subtle`) is available in the Worker runtime.
 */
import { normalizePlainText } from "../../pdf/normalize";

/**
 * Serialized metadata for a document stored in the library index.
 */
export type LibraryIndexRecord = {
  docId: string;
  institutionId?: string;
  ownerUserId?: string | null;
  bucket: string;
  key: string;
  title: string;
  normalizedTokens: string[];
  hashBasis: string;
  hashFieldsUsed?: string[];
  etag?: string | null;
  size?: number;
  uploaded?: string;
  status?: "ready" | "missing" | "needs_browser_ocr";
  ingestionType?: "doc_upload";
  preview?: string;
  manifestKey?: string;
  extractedKey?: string;
  yearId?: LibraryYearId;
  categoryId?: LibraryCategoryId;
  categoryLabel?: string;
  courseId?: string | null;
  /** Exam number within the course (1-3). */
  examId?: LibraryExamId | null;
  hasStoredQbank?: boolean;
  storedQbankCount?: number;
  storedQbankUploadedAt?: string;
  storedQbankKey?: string;
  studyGuideStatus?: "draft" | "in_review" | "approved" | "published" | "archived";
  studyGuideReviewedAt?: string;
  studyGuideReviewedBy?: string;
  ankiStatus?: "draft" | "in_review" | "approved" | "published" | "archived";
  ankiReviewedAt?: string;
  ankiReviewedBy?: string;
};

export type LibraryCategoryId = string;
export type LibraryYearId = LibraryCategoryId;
export type LibraryExamId = 1 | 2 | 3;

export type LibraryCategory = {
  id: LibraryCategoryId;
  label: string;
  sortOrder?: number;
  createdAt?: string;
  updatedAt?: string;
};

export type LibraryCourse = {
  id: string;
  yearId: LibraryCategoryId;
  categoryId?: LibraryCategoryId;
  categoryLabel?: string;
  name: string;
  sortOrder?: number;
  createdAt?: string;
  updatedAt?: string;
};

/** JSONL file that contains the full library index. */
export const LIBRARY_INDEX_KEY = "library/index.jsonl";
/** JSON file that contains the course list. */
export const LIBRARY_COURSES_KEY = "library/courses.json";
/** JSON file that contains the category list. */
export const LIBRARY_CATEGORIES_KEY = "library/categories.json";
/** Prefix used for per-document index entries. */
export const LIBRARY_INDEX_PREFIX = "index/";
/** Prefix used for queued scan events. */
export const LIBRARY_QUEUE_PREFIX = "queue/scanned/";
/** Prefix for extracted plain-text files in R2. */
export const EXTRACTED_PREFIX = "extracted/";
/** Prefix for PDF processing manifests in R2. */
export const MANIFEST_PREFIX = "manifests/";
/** Prefix for stored lecture qbanks in R2. */
export const STORED_QBANK_PREFIX = "qbank/";

const enc = new TextEncoder();

function toHex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compute a hex-encoded SHA-256 digest for a string.
 *
 * @param value - Input string to hash.
 * @returns Hex string of the digest.
 * @throws If WebCrypto is unavailable in the runtime.
 */
export async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(value));
  return toHex(digest);
}

/**
 * Build a stable hash basis string for a document based on metadata.
 *
 * @param bucket - Source bucket name.
 * @param key - Object key within the bucket.
 * @param meta - Metadata used to build the hash basis.
 * @returns Basis string + which fields were used + normalized upload timestamp.
 */
export function computeHashBasis(
  bucket: string,
  key: string,
  meta: { etag?: string | null; size?: number; uploaded?: string | Date | null; lastModified?: string | Date | null },
) {
  const uploaded =
    meta.uploaded instanceof Date
      ? meta.uploaded.toISOString()
      : typeof meta.uploaded === "string"
        ? meta.uploaded
        : meta.lastModified instanceof Date
          ? meta.lastModified.toISOString()
          : typeof meta.lastModified === "string"
            ? meta.lastModified
            : "";
  const basis = [bucket, key, meta.etag || "", meta.size ?? "", uploaded].join(":");
  const fieldsUsed = meta.etag ? ["etag"] : ["size", "uploaded"];
  return { basis, fieldsUsed, uploaded };
}

/**
 * Compute a deterministic document id from metadata and object identifiers.
 *
 * @param bucket - Source bucket name.
 * @param key - Object key within the bucket.
 * @param meta - Metadata used to build the hash basis.
 * @returns The docId plus basis info to persist alongside the record.
 */
export async function computeDocId(
  bucket: string,
  key: string,
  meta: { etag?: string | null; size?: number; uploaded?: string | Date | null; lastModified?: string | Date | null },
) {
  const { basis, fieldsUsed, uploaded } = computeHashBasis(bucket, key, meta);
  const docId = await sha256(basis);
  return { docId, basis, fieldsUsed, uploaded };
}

/**
 * Derive a human-readable title from an object key.
 *
 * @param key - R2 object key or filename.
 * @returns Normalized title string with extension removed.
 */
export function titleFromKey(key: string) {
  const leaf = key.split("/").pop() || key;
  const withoutExt = leaf.replace(/\.[^.]+$/, "");
  const normalized = withoutExt.replace(/[_\-]+/g, " ").trim();
  return normalized || leaf || key;
}

/**
 * Tokenize a title for lightweight text search.
 *
 * @param title - Title or filename.
 * @returns Deduplicated, lowercased tokens (length > 1).
 */
export function tokensFromTitle(title: string) {
  const tokens = (title || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map(tok => tok.trim())
    .filter(tok => tok.length > 1);
  return Array.from(new Set(tokens));
}

/**
 * Check whether an R2 object key looks like a PDF.
 *
 * @param key - Object key or filename.
 * @returns True when the key ends with ".pdf" (case-insensitive).
 */
export function isPdfKey(key: string) {
  return /\.pdf$/i.test(key || "");
}

/**
 * Build the per-document index key for a given doc id.
 *
 * @param docId - Document id (hex string).
 * @returns R2 key for the per-doc index entry.
 */
export function buildIndexKeyForDoc(docId: string) {
  const safe = (docId || "").replace(/[^a-z0-9]/gi, "");
  return `${LIBRARY_INDEX_PREFIX}${safe}.json`;
}

/**
 * Build the extracted text object key for a document.
 *
 * @param docId - Document id (hex string).
 * @returns R2 key for extracted plain text.
 */
export function buildExtractedPath(docId: string) {
  const safe = (docId || "").replace(/[^a-z0-9]/gi, "");
  return `${EXTRACTED_PREFIX}${safe}.txt`;
}

/**
 * Build the manifest object key for a document.
 *
 * @param docId - Document id (hex string).
 * @returns R2 key for the PDF processing manifest.
 */
export function buildManifestPath(docId: string) {
  const safe = (docId || "").replace(/[^a-z0-9]/gi, "");
  return `${MANIFEST_PREFIX}${safe}.json`;
}

/**
 * Build the raw TSV storage key for a lecture qbank.
 *
 * @param docId - Document id (hex string).
 * @returns R2 key for the uploaded TSV source.
 */
export function buildStoredQbankSourcePath(docId: string) {
  const safe = (docId || "").replace(/[^a-z0-9]/gi, "");
  return `${STORED_QBANK_PREFIX}${safe}/source.tsv`;
}

/**
 * Build the normalized JSON storage key for a lecture qbank.
 *
 * @param docId - Document id (hex string).
 * @returns R2 key for normalized questions JSON.
 */
export function buildStoredQbankQuestionsPath(docId: string) {
  const safe = (docId || "").replace(/[^a-z0-9]/gi, "");
  return `${STORED_QBANK_PREFIX}${safe}/questions.json`;
}

/**
 * Load the library index from R2 and parse JSONL records.
 *
 * @param bucket - R2 bucket storing the index.
 * @returns Parsed records (empty array when missing or malformed).
 * @remarks Side effects: performs an R2 `get` call.
 */
export async function readIndex(bucket: R2Bucket): Promise<LibraryIndexRecord[]> {
  try {
    const object = await bucket.get(LIBRARY_INDEX_KEY);
    if (!object || !object.body) return [];
    const text = await object.text();
    return text
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed.docId === "string") {
            parsed.normalizedTokens = Array.isArray(parsed.normalizedTokens)
              ? parsed.normalizedTokens
              : tokensFromTitle(parsed.title || "");
            return parsed as LibraryIndexRecord;
          }
        } catch {
          // ignore malformed lines
        }
        return null;
      })
      .filter((r): r is LibraryIndexRecord => Boolean(r));
  } catch {
    return [];
  }
}

/**
 * Persist the library index back to R2 as JSONL.
 *
 * @param bucket - R2 bucket storing the index.
 * @param records - Records to serialize and write.
 * @remarks Side effects: performs an R2 `put` call.
 */
export async function writeIndex(bucket: R2Bucket, records: LibraryIndexRecord[]) {
  const lines = records
    .map(rec => JSON.stringify(rec))
    .join("\n");
  await bucket.put(LIBRARY_INDEX_KEY, lines, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

/**
 * Score and rank library records against a text query.
 *
 * @param query - User query string.
 * @param records - Candidate records to score.
 * @param limit - Max number of results to return.
 * @returns Top-ranked records ordered by heuristic score.
 */
export function scoreRecords(query: string, records: LibraryIndexRecord[], limit = 10) {
  const tokens = tokensFromTitle(query);
  const qLower = (query || "").toLowerCase();
  const scored = records.map(rec => {
    let score = 0;
    const tokenSet = new Set(rec.normalizedTokens || []);
    tokens.forEach(tok => {
      if (tokenSet.has(tok)) score += 3;
      else if (rec.normalizedTokens?.some(rt => rt.startsWith(tok))) score += 2;
      else if ((rec.title || "").toLowerCase().includes(tok)) score += 1;
    });
    if ((rec.title || "").toLowerCase().includes(qLower)) {
      score += 1;
    }
    return { rec, score };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(entry => entry.rec);
}

/**
 * Normalize and truncate preview text for UI display.
 *
 * @param text - Raw extracted text.
 * @returns A cleaned preview string (max 280 chars).
 */
export function normalizePreview(text?: string) {
  if (!text) return "";
  return normalizePlainText(text).slice(0, 280);
}
