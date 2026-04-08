import type { Env } from "../../../types";
import { uploadBytesToOpenAI } from "../openai";
import type { VisionImageDetail, VisionImagePart, VisionImageSource } from "./types";

export const DEFAULT_VISION_INLINE_MAX_BYTES = 1024 * 1024;

type ImageSignature = "png" | "jpeg" | "webp" | "unknown";

type NormalizedDataUrl = {
  dataUrl: string;
  mimeType: string;
  byteLength: number;
  bytes: Uint8Array;
  signature: Exclude<ImageSignature, "unknown">;
};

type VisionInputImage = {
  type: "input_image";
  image_url?: string;
  file_id?: string;
  detail?: VisionImageDetail;
};

const SUPPORTED_INLINE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export class VisionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisionInputError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeDetail(value: unknown): VisionImageDetail | undefined {
  if (value === "low" || value === "high" || value === "auto") return value;
  if (value === undefined || value === null || value === "") return undefined;
  throw new VisionInputError("Image detail must be one of low, high, or auto.");
}

function normalizeSource(value: unknown): VisionImageSource | undefined {
  if (value === "upload" || value === "paste" || value === "url") return value;
  if (value === undefined || value === null || value === "") return undefined;
  throw new VisionInputError("Image source must be upload, paste, or url.");
}

function trimOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x2000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    throw new VisionInputError("Malformed base64 image data URL.");
  }
}

function detectImageSignature(bytes: Uint8Array): ImageSignature {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "webp";
  }
  return "unknown";
}

function normalizeInlineMimeType(mimeType: string | undefined, signature?: ImageSignature): string {
  const lowered = (mimeType || "").trim().toLowerCase();
  if (signature === "png") return "image/png";
  if (signature === "jpeg") return "image/jpeg";
  if (signature === "webp") return "image/webp";
  if (!lowered) {
    throw new VisionInputError("Inline image MIME type is required.");
  }
  const normalized = lowered === "image/jpg" ? "image/jpeg" : lowered;
  if (!SUPPORTED_INLINE_MIME_TYPES.has(normalized)) {
    throw new VisionInputError("Unsupported inline image MIME type. Use PNG, JPEG, or WebP.");
  }
  return normalized;
}

function normalizeHttpsImageUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new VisionInputError("Image URL must be a valid https URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new VisionInputError("Image URL must use https.");
  }
  return parsed.toString();
}

function extensionFromMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    default:
      return "bin";
  }
}

function sanitizeFilenameStem(value?: string): string {
  const sanitized = (value || "inline-image")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "inline-image";
}

export function decodeBase64DataUrl(dataUrl: string): NormalizedDataUrl {
  const match = /^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl || "");
  if (!match) {
    throw new VisionInputError("Inline images must be base64 data URLs.");
  }
  const rawMimeType = (match[1] || "").trim().toLowerCase();
  const base64 = (match[2] || "").replace(/\s+/g, "");
  const bytes = base64ToBytes(base64);
  const signature = detectImageSignature(bytes);
  if (signature === "unknown") {
    throw new VisionInputError("Unsupported inline image bytes. Use PNG, JPEG, or WebP.");
  }
  const mimeType = normalizeInlineMimeType(rawMimeType, signature);
  return {
    dataUrl: `data:${mimeType};base64,${bytesToBase64(bytes)}`,
    mimeType,
    byteLength: bytes.length,
    bytes,
    signature,
  };
}

export function normalizePastedDataUrl(dataUrl: string, mimeType?: string): NormalizedDataUrl {
  const normalized = decodeBase64DataUrl(dataUrl);
  if (mimeType) {
    normalizeInlineMimeType(mimeType, normalized.signature);
  }
  return normalized;
}

export function normalizeInlineImagePart(input: unknown): VisionImagePart {
  if (!isPlainObject(input)) {
    throw new VisionInputError("Image parts must be objects.");
  }

  const label = trimOptionalString(input.label);
  const detail = normalizeDetail(input.detail);
  const source = normalizeSource(input.source);
  const visionFileId = trimOptionalString(input.visionFileId);
  const fileId = trimOptionalString(input.fileId) || trimOptionalString(input.file_id);

  if (visionFileId) {
    return { type: "image", label, detail, source: source || "upload", visionFileId };
  }
  if (fileId) {
    return { type: "image", label, detail, source: source || "upload", fileId };
  }

  const dataUrl = trimOptionalString(input.dataUrl) || trimOptionalString(input.image_data_url);
  if (dataUrl) {
    const normalized = normalizePastedDataUrl(dataUrl, trimOptionalString(input.mimeType));
    return {
      type: "image",
      label,
      detail,
      source: source || "paste",
      mimeType: normalized.mimeType,
      dataUrl: normalized.dataUrl,
    };
  }

  const imageUrl = trimOptionalString(input.imageUrl) || trimOptionalString(input.image_url);
  if (imageUrl) {
    return {
      type: "image",
      label,
      detail,
      source: source || "url",
      imageUrl: normalizeHttpsImageUrl(imageUrl),
      mimeType: trimOptionalString(input.mimeType),
    };
  }

  throw new VisionInputError("Image parts must include visionFileId, fileId, dataUrl, or https imageUrl.");
}

export function shouldInlineDataUrl(byteLength: number, maxBytes = DEFAULT_VISION_INLINE_MAX_BYTES): boolean {
  return byteLength <= Math.max(1, maxBytes);
}

export async function prepareVisionInputFromPart(
  env: Env,
  part: VisionImagePart,
  opts: { inlineMaxBytes?: number; filenamePrefix?: string } = {},
): Promise<VisionInputImage> {
  const normalized = normalizeInlineImagePart(part);
  const detail = normalized.detail ?? "auto";

  if (normalized.visionFileId) {
    return { type: "input_image", file_id: normalized.visionFileId, detail };
  }
  if (normalized.fileId) {
    return { type: "input_image", file_id: normalized.fileId, detail };
  }
  if (normalized.imageUrl) {
    return { type: "input_image", image_url: normalized.imageUrl, detail };
  }
  if (!normalized.dataUrl) {
    throw new VisionInputError("Image input could not be prepared.");
  }

  const prepared = normalizePastedDataUrl(normalized.dataUrl, normalized.mimeType);
  if (shouldInlineDataUrl(prepared.byteLength, opts.inlineMaxBytes)) {
    return { type: "input_image", image_url: prepared.dataUrl, detail };
  }

  const stem = sanitizeFilenameStem(opts.filenamePrefix || normalized.label);
  const filename = `${stem}.${extensionFromMimeType(prepared.mimeType)}`;
  const uploadedId = await uploadBytesToOpenAI(env, prepared.bytes, filename, "vision", prepared.mimeType);
  if (!uploadedId) {
    throw new VisionInputError("OpenAI vision upload returned no file id.");
  }
  return { type: "input_image", file_id: uploadedId, detail };
}
