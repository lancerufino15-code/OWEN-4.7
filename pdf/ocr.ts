import { DEFAULT_TEXT_MODEL } from "../../model_defaults";
import type { Env } from "../../types";
import { safeJson, json } from "../runtime/http";
import { getExtractionBucket } from "../runtime/storage";
import { buildExtractedKeyForHash, readManifest, writeManifest, type PdfManifest } from "./cache";

const MAX_OCR_TEXT_LENGTH = 900_000;
const OCR_MAX_OUTPUT_TOKENS = 1_800;
const OCR_PAGE_OUTPUT_TOKENS = 1_200;
const ONE_SHOT_PREVIEW_LIMIT = 1_200;
const NO_TEXT_PLACEHOLDER = "[NO TEXT]";

type ImageSignature = "png" | "jpg" | "unknown";

type PreparedOcrImage =
  | { ok: true; dataUrl: string; mimeType: string; signature: ImageSignature; head: string; byteLength: number }
  | { ok: false; mimeType: string; signature: ImageSignature; head: string; byteLength: number };

function extractOutputText(payload: any): string {
  if (!payload) return "";
  const stringifyContent = (content: any[]): string =>
    content
      .map((part: any) => {
        if (typeof part?.text === "string") return part.text;
        if (part && typeof part.json === "object") return JSON.stringify(part.json);
        return "";
      })
      .filter(Boolean)
      .join("");

  if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text;
  if (Array.isArray(payload.output_text)) {
    const joined = payload.output_text.filter(Boolean).join("\n");
    if (joined.trim()) return joined;
  }
  if (typeof payload.response?.output_text === "string" && payload.response.output_text.trim()) {
    return payload.response.output_text;
  }
  if (Array.isArray(payload.output)) {
    const joined = payload.output
      .map((item: any) => (Array.isArray(item?.content) ? stringifyContent(item.content) : ""))
      .filter(Boolean)
      .join("\n");
    if (joined.trim()) return joined;
  }
  if (Array.isArray(payload.response?.output)) {
    const joined = payload.response.output
      .map((item: any) => (Array.isArray(item?.content) ? stringifyContent(item.content) : ""))
      .filter(Boolean)
      .join("\n");
    if (joined.trim()) return joined;
  }
  return "";
}

async function callResponsesOcr(
  env: Env,
  content: Array<Record<string, unknown>>,
  opts: { label?: string; maxOutputTokens?: number } = {},
): Promise<string> {
  const base = env.OPENAI_API_BASE?.replace(/\/$/, "") || "https://api.openai.com/v1";
  const maxTokens = Math.min(OCR_MAX_OUTPUT_TOKENS, Math.max(200, opts.maxOutputTokens ?? OCR_MAX_OUTPUT_TOKENS));
  const payload = {
    model: env.DEFAULT_TEXT_MODEL?.trim() || DEFAULT_TEXT_MODEL,
    input: [
      {
        role: "user",
        content,
      },
    ],
    max_output_tokens: maxTokens,
  };

  console.log("[OCR] Sending /responses request", {
    label: opts.label || "ocr",
    contentTypes: content.map((part) => part.type),
  });

  const resp = await fetch(`${base}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json",
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify(payload),
  });
  const data = await safeJson(resp);
  if (!resp.ok) {
    const message = (data as any)?.error?.message || resp.statusText || "OCR request failed.";
    console.error("[OCR] OpenAI error", { label: opts.label || "ocr", message });
    throw new Error(message);
  }
  return extractOutputText(data).slice(0, MAX_OCR_TEXT_LENGTH);
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x2000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function detectImageSignature(bytes: Uint8Array): ImageSignature {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpg";
  }
  return "unknown";
}

function normalizeOcrImageMime(mimeType: string, signature: ImageSignature): string {
  if (signature === "png") return "image/png";
  if (signature === "jpg") return "image/jpeg";
  if ((mimeType || "").toLowerCase().startsWith("image/")) return mimeType;
  return "application/octet-stream";
}

function prepareOcrImageInput(bytes: Uint8Array, mimeType: string): PreparedOcrImage {
  const signature = detectImageSignature(bytes);
  const normalizedMime = normalizeOcrImageMime(mimeType, signature);
  const base64 = bytesToBase64(bytes);
  const head = base64.slice(0, 12);
  if (signature === "unknown") {
    return { ok: false, mimeType: normalizedMime, signature, head, byteLength: bytes.length };
  }
  return {
    ok: true,
    dataUrl: `data:${normalizedMime};base64,${base64}`,
    mimeType: normalizedMime,
    signature,
    head,
    byteLength: bytes.length,
  };
}

function logOcrInputDebug(meta: { key?: string; head?: string; mimeType?: string; signature?: ImageSignature; byteLength?: number }) {
  console.log("[OCR_INPUT]", {
    key: meta.key || "unknown",
    head: (meta.head || "").slice(0, 12),
    mime: meta.mimeType || "unknown",
    sig: meta.signature || "unknown",
    len: meta.byteLength ?? 0,
  });
}

function invalidImagePayload(extra: Record<string, unknown> = {}) {
  return {
    ok: false,
    error: { code: "invalid_image_bytes" },
    answer: "OCR input was not a valid image.",
    ...extra,
  };
}

function normalizeExtractedText(value: string): string {
  let text = (value || "").replace(/\r\n/g, "\n").trim();
  if (!text) return text;
  text = text.replace(/([a-z])(?=page\s*\d+)/gi, "$1 ");
  text = text.replace(/(---\s*page\s*\d+\s*---)(?=\S)/gi, "$1\n");
  text = text.replace(/(page\s*\d+)(?=\S)/gi, "$1 ");
  const junkLines = new Set(["dh", "r", "met"]);
  const cleanedLines: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      cleanedLines.push("");
      continue;
    }
    const lower = trimmed.toLowerCase();
    if (junkLines.has(lower)) continue;
    if (/^kcu[-\s]?com/i.test(trimmed)) continue;
    if (/^dr\./i.test(trimmed) && trimmed === trimmed.toUpperCase()) continue;
    cleanedLines.push(line);
  }
  text = cleanedLines.join("\n");
  text = text.replace(/([A-Za-z])-\s*\n\s*([A-Za-z])/g, "$1$2");
  text = text.replace(/\s{3,}/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function buildRangesFromPages(pageIndices: number[]) {
  const sorted = Array.from(new Set(pageIndices.map((idx) => Number(idx) + 1).filter((n) => Number.isFinite(n)))).sort((a, b) => a - b);
  const ranges: Array<{ start: number; end: number }> = [];
  if (!sorted.length) return ranges;
  let start = sorted[0]!;
  let end = sorted[0]!;
  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i]!;
    if (current === end + 1) {
      end = current;
    } else {
      ranges.push({ start, end });
      start = current;
      end = current;
    }
  }
  ranges.push({ start, end });
  return ranges;
}

function mergeRanges(ranges: Array<{ start: number; end: number }>) {
  const cleaned = ranges
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end))
    .map((range) => (range.start <= range.end ? { start: range.start, end: range.end } : { start: range.end, end: range.start }))
    .sort((a, b) => a.start - b.start);
  if (!cleaned.length) return [];
  const merged: Array<{ start: number; end: number }> = [cleaned[0]!];
  for (let i = 1; i < cleaned.length; i += 1) {
    const current = cleaned[i]!;
    const last = merged[merged.length - 1]!;
    if (current.start <= last.end + 1) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ start: current.start, end: current.end });
    }
  }
  return merged;
}

function parseNormalizedPagesFromText(text: string) {
  const map = new Map<number, string>();
  const parts = (text || "").split(/---\s*Page\s+(\d+)\s*---/i);
  for (let i = 1; i < parts.length; i += 2) {
    const pageNumber = Number(parts[i]);
    const pageText = parts[i + 1] || "";
    if (Number.isFinite(pageNumber)) {
      map.set(pageNumber - 1, pageText.trim());
    }
  }
  return map;
}

export async function handleOcrPageRoute(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return json({ error: "Send multipart/form-data with fields: fileId, pageIndex, image" }, 400);
  }

  const form = await request.formData();
  const fileId = typeof form.get("fileId") === "string" ? String(form.get("fileId")).trim() : "";
  const fileHash = typeof form.get("fileHash") === "string" ? String(form.get("fileHash")).trim() : "";
  const rawIndex = form.get("pageIndex");
  const pageIndex = typeof rawIndex === "string" ? Number(rawIndex) : Number(rawIndex);
  const image = form.get("image");

  if (!fileId && !fileHash) return json({ error: "Missing fileId or fileHash." }, 400);
  if (!Number.isFinite(pageIndex)) return json({ error: "Invalid pageIndex." }, 400);
  if (!(image instanceof File)) return json({ error: "Missing image file." }, 400);

  try {
    const mimeType = image.type || "image/png";
    const bytes = new Uint8Array(await image.arrayBuffer());
    const prepared = prepareOcrImageInput(bytes, mimeType);
    if (!prepared.ok) {
      console.warn("[OCR-PAGE] Invalid image bytes", {
        fileHash: fileHash || fileId,
        pageIndex,
        head: prepared.head,
        mimeType: prepared.mimeType,
      });
      return json(invalidImagePayload({ pageIndex }), 422);
    }

    logOcrInputDebug({
      key: fileHash || fileId || "ocr-page",
      head: prepared.head,
      mimeType: prepared.mimeType,
      signature: prepared.signature,
      byteLength: prepared.byteLength,
    });

    const label = Number.isFinite(pageIndex) ? `Page ${Number(pageIndex) + 1}` : "Page";
    const prompt = "You are an OCR service. Transcribe every readable character from the page image. Return plain text only.";
    const text = await callResponsesOcr(
      env,
      [
        { type: "input_text", text: prompt },
        { type: "input_image", image_url: prepared.dataUrl, detail: "high" },
      ],
      { label: `ocr-page:${fileHash || fileId}:${pageIndex}`, maxOutputTokens: OCR_PAGE_OUTPUT_TOKENS },
    );
    const normalized = normalizeExtractedText(text).slice(0, MAX_OCR_TEXT_LENGTH);
    if (!normalized) {
      return json({ pageIndex: Number(pageIndex), text: NO_TEXT_PLACEHOLDER, blank: true, status: "blank" });
    }
    return json({ pageIndex: Number(pageIndex), text: normalized });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[OCR-PAGE] Failed", { fileHash: fileHash || fileId, pageIndex, error: message });
    return json({ error: "ocr_failed", details: message }, 502);
  }
}

export async function handleOcrFinalizeRoute(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return json({ error: "Send JSON { fileId?, fileHash?, pages: [{ pageIndex, text }] }." }, 400);
  }

  const fileId = typeof (body as any).fileId === "string" ? (body as any).fileId.trim() : "";
  const fileHash = typeof (body as any).fileHash === "string" ? (body as any).fileHash.trim() : "";
  const filename = typeof (body as any).filename === "string" ? (body as any).filename : undefined;
  const pages = Array.isArray((body as any).pages) ? (body as any).pages : [];
  const totalPages = Number((body as any).totalPages);
  const reset = Boolean((body as any).reset);
  if (!fileId && !fileHash) return json({ error: "Missing fileId or fileHash." }, 400);
  if (!pages.length) return json({ error: "No pages provided." }, 400);

  const normalizedPages = pages
    .map((entry: any): { pageIndex: number; text: string } | null => {
      const idxRaw = typeof entry?.pageIndex === "number" ? entry.pageIndex : Number(entry?.pageIndex);
      const text = typeof entry?.text === "string" ? entry.text : "";
      const blank = entry?.blank === true || entry?.status === "blank";
      if (!Number.isFinite(idxRaw)) return null;
      const clean = normalizeExtractedText(text);
      return {
        pageIndex: Number(idxRaw),
        text: blank || !clean ? NO_TEXT_PLACEHOLDER : clean,
      };
    })
    .filter((page): page is { pageIndex: number; text: string } => Boolean(page))
    .sort((a, b) => a.pageIndex - b.pageIndex);

  if (!normalizedPages.length) {
    return json({ error: "No valid OCR pages to finalize." }, 422);
  }

  const { bucket } = getExtractionBucket(env);
  const extractedKey = fileHash ? buildExtractedKeyForHash(fileHash) : `extracted/${fileId.replace(/[^a-z0-9]/gi, "") || "file"}.txt`;
  const existingPages = new Map<number, string>();
  let manifest: PdfManifest | null = null;
  if (fileHash) {
    manifest = await readManifest(bucket, fileHash);
  }
  if (!reset) {
    try {
      const existing = await bucket.get(extractedKey);
      if (existing && existing.body) {
        const existingText = normalizeExtractedText(await existing.text());
        parseNormalizedPagesFromText(existingText).forEach((text, pageIdx) => existingPages.set(pageIdx, text));
      }
    } catch {
      // ignore missing prior extraction
    }
  }

  normalizedPages.forEach((page: { pageIndex: number; text: string }) => {
    existingPages.set(page.pageIndex, page.text.trim() || NO_TEXT_PLACEHOLDER);
  });

  const rebuilt = Array.from(existingPages.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([pageIndex, text]) => `--- Page ${pageIndex + 1} ---\n${text || NO_TEXT_PLACEHOLDER}`)
    .join("\n\n");

  const normalizedFinal = normalizeExtractedText(rebuilt).slice(0, MAX_OCR_TEXT_LENGTH);
  try {
    await bucket.put(extractedKey, normalizedFinal, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });
    const preview = normalizedFinal.slice(0, ONE_SHOT_PREVIEW_LIMIT);
    if (fileHash) {
      const currentRanges = buildRangesFromPages(normalizedPages.map((page) => page.pageIndex));
      const newRanges = reset ? currentRanges : mergeRanges([...(manifest?.ranges || []), ...currentRanges]);
      const pagesProcessed = newRanges.reduce((total, range) => total + (range.end - range.start + 1), 0);
      const nextManifest: PdfManifest = {
        fileHash,
        filename: manifest?.filename || filename,
        method: "ocr",
        ocrStatus: "finalized",
        pagesProcessed,
        pageCount: Number.isFinite(totalPages) ? Number(totalPages) : manifest?.pageCount,
        ranges: newRanges,
        createdAt: manifest?.createdAt || new Date().toISOString(),
        preview,
        extractedKey,
        updatedAt: new Date().toISOString(),
      };
      await writeManifest(bucket, nextManifest);
    }
    return json({
      extractionStatus: "ok",
      method: "ocr",
      extractedKey,
      preview,
      fileId,
      fileHash,
      pageCount: Number.isFinite(totalPages) ? Number(totalPages) : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[OCR-FINALIZE] Failed to persist OCR text", { fileId: fileHash || fileId, error: message });
    return json({ error: "persist_failed", details: message }, 500);
  }
}
