import { normalizePlainText } from "../../pdf/normalize";

type MachineSlide = { n: number; title: string; page: number };
type MachineSlideBlock = { n: number; page: number; text: string };

const MACHINE_TXT_PREFIX = "machine/txt";
const FACULTY_UPLOADED_TXT_FILENAME = "faculty-upload.txt";

function parseNormalizedPagesFromText(text: string): Map<number, string> {
  const map = new Map<number, string>();
  const parts = (text || "").split(/---\s*Page\s+(\d+)\s*---/i);
  for (let i = 1; i < parts.length; i += 2) {
    const pageNumber = Number(parts[i]);
    const pageText = parts[i + 1] || "";
    if (Number.isFinite(pageNumber)) {
      map.set(pageNumber - 1, normalizePlainText(pageText));
    }
  }
  return map;
}

function cleanMachinePageText(text: string): string {
  if (!text) return "";
  const normalized = normalizePlainText(text);
  if (!normalized) return "";
  return normalized
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

function formatMachineTxtFromPageMap(pageMap: Map<number, string>, pageCount?: number): string {
  const pageIndices = Array.from(pageMap.keys()).filter((n) => Number.isFinite(n));
  const maxIndex = pageIndices.length ? Math.max(...pageIndices) : -1;
  const inferredCount = maxIndex >= 0 ? maxIndex + 1 : 0;
  const totalPages = Math.max(
    Number.isFinite(pageCount as number) ? Number(pageCount) : 0,
    inferredCount,
  );
  const blocks: string[] = [];
  for (let i = 0; i < totalPages; i += 1) {
    const pageNumber = i + 1;
    const cleaned = cleanMachinePageText(pageMap.get(i) || "");
    if (cleaned) {
      blocks.push(`Slide ${pageNumber} (p.${pageNumber}):\n${cleaned}`);
    } else {
      blocks.push(`Slide ${pageNumber} (p.${pageNumber}): [NO TEXT]`);
    }
  }
  return blocks.join("\n\n");
}

export function formatMachineTxtFromExtractedText(extractedText: string, pageCount?: number): string {
  const normalized = normalizePlainText(extractedText || "");
  const pageMap = parseNormalizedPagesFromText(normalized);
  if (!pageMap.size && normalized) {
    pageMap.set(0, normalized);
  }
  return formatMachineTxtFromPageMap(pageMap, pageCount);
}

function normalizeMachineTxtInput(text: string): string {
  const normalized = (text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  return normalized.replace(/\s+$/g, "");
}

export function parseMachineSlideListFromTxt(text: string): {
  slides: MachineSlide[];
  slideCount: number;
  normalizedText: string;
} {
  const normalized = normalizeMachineTxtInput(text);
  const regex = /^Slide\s+(\d+)\s+\(p\.(\d+)\):/gim;
  const slides: Array<MachineSlide & { order: number }> = [];
  let match: RegExpExecArray | null;
  let order = 0;
  while ((match = regex.exec(normalized))) {
    const n = Number(match[1]);
    const pageRaw = Number(match[2]);
    if (!Number.isFinite(n)) continue;
    const page = Number.isFinite(pageRaw) ? pageRaw : n;
    slides.push({ n, page, title: "", order });
    order += 1;
  }
  const sorted = slides
    .sort((a, b) => (a.n - b.n) || (a.order - b.order))
    .map(({ order: _order, ...rest }) => rest);
  return { slides: sorted, slideCount: slides.length, normalizedText: normalized };
}

export function parseMachineSlideBlocksFromTxt(text: string): {
  slides: MachineSlideBlock[];
  slideCount: number;
  normalizedText: string;
} {
  const normalized = normalizeMachineTxtInput(text);
  const regex = /^Slide\s+(\d+)\s+\(p\.(\d+)\):.*$/gim;
  const matches = Array.from(normalized.matchAll(regex));
  const slides: Array<MachineSlideBlock & { order: number }> = [];
  let order = 0;

  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    if (!match || typeof match.index !== "number") continue;
    const n = Number(match[1]);
    const pageRaw = Number(match[2]);
    if (!Number.isFinite(n)) continue;
    const page = Number.isFinite(pageRaw) ? pageRaw : n;
    const headerEnd = match.index + match[0].length;
    const nextMatch = i + 1 < matches.length ? matches[i + 1] : undefined;
    const nextIndex = nextMatch && typeof nextMatch.index === "number" ? nextMatch.index : normalized.length;
    let body = normalized.slice(headerEnd, nextIndex);
    if (body.startsWith("\n")) body = body.slice(1);
    const cleaned = body.replace(/\s+$/g, "").trim();
    slides.push({ n, page, text: cleaned || "[NO TEXT]", order });
    order += 1;
  }

  const sorted = slides
    .sort((a, b) => (a.n - b.n) || (a.order - b.order))
    .map(({ order: _order, ...rest }) => rest);
  return { slides: sorted, slideCount: slides.length, normalizedText: normalized };
}

export function sanitizeMachineSlug(input: string, fallback: string) {
  const cleaned = (input || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || fallback;
}

export function buildMachineTxtKey(docId: string, lectureTitle: string) {
  const safeDocId = sanitizeMachineSlug(docId, "doc");
  const safeTitle = sanitizeMachineSlug(lectureTitle, "lecture");
  return `${MACHINE_TXT_PREFIX}/${safeDocId}/${safeTitle}.txt`;
}

export function buildFacultyUploadedMachineTxtKey(docId: string) {
  const safeDocId = sanitizeMachineSlug(docId, "doc");
  return `${MACHINE_TXT_PREFIX}/${safeDocId}/${FACULTY_UPLOADED_TXT_FILENAME}`;
}

export function cleanLectureDisplayLabel(raw: string) {
  const value = (raw || "").trim();
  if (!value) return "";
  const leaf = value.split("/").pop() || value;
  let cleaned = leaf.trim();
  cleaned = cleaned.replace(/^\d+\s+/, "");
  cleaned = cleaned.replace(/^\d+[_-]+/, "");
  cleaned = cleaned.replace(/^[a-f0-9]{8,}[_-]+/i, "");
  cleaned = cleaned.replace(/\.pdf$/i, "");
  cleaned = cleaned.replace(/\.txt$/i, "");
  return cleaned.trim();
}

export function buildLectureTxtDisplayName(raw: string) {
  const base = cleanLectureDisplayLabel(raw) || "Lecture";
  return base.toLowerCase().endsWith(".txt") ? base : `${base}.txt`;
}

function isMachineTxtKey(key: string) {
  return (key || "").startsWith(`${MACHINE_TXT_PREFIX}/`);
}

function isFacultyUploadedMachineTxtKey(key: string) {
  return (key || "").endsWith(`/${FACULTY_UPLOADED_TXT_FILENAME}`);
}

type MachineTxtObjectInfo = {
  key: string;
  uploaded?: Date;
  size?: number;
};

function pickPreferredMachineTxtObject(
  candidate: MachineTxtObjectInfo,
  existing: MachineTxtObjectInfo | null,
): MachineTxtObjectInfo {
  if (!existing) return candidate;
  const candidateUploaded = isFacultyUploadedMachineTxtKey(candidate.key);
  const existingUploaded = isFacultyUploadedMachineTxtKey(existing.key);
  if (candidateUploaded !== existingUploaded) {
    return candidateUploaded ? candidate : existing;
  }
  const candidateTime = candidate.uploaded instanceof Date ? candidate.uploaded.getTime() : 0;
  const existingTime = existing.uploaded instanceof Date ? existing.uploaded.getTime() : 0;
  if (candidateTime !== existingTime) {
    return candidateTime > existingTime ? candidate : existing;
  }
  return candidate.key.localeCompare(existing.key) > 0 ? candidate : existing;
}

async function resolveObjectHead(bucket: R2Bucket, key: string) {
  if (!key) return { exists: false as const };
  try {
    const head = typeof bucket.head === "function"
      ? await bucket.head(key)
      : await bucket.get(key, { range: { offset: 0, length: 0 } as any });
    if (!head) return { exists: false as const };
    return {
      exists: true as const,
      uploaded: (head as any).uploaded instanceof Date ? (head as any).uploaded : undefined,
      size: (head as any).size,
    };
  } catch {
    return { exists: false as const };
  }
}

export async function resolvePreferredMachineTxtKey(
  bucket: R2Bucket,
  docId: string,
  lectureTitle?: string,
): Promise<string> {
  const uploadedKey = buildFacultyUploadedMachineTxtKey(docId);
  const uploadedHead = await resolveObjectHead(bucket, uploadedKey);
  if (uploadedHead.exists) return uploadedKey;

  const canonicalKey = buildMachineTxtKey(docId, lectureTitle || docId);
  const canonicalHead = await resolveObjectHead(bucket, canonicalKey);
  if (canonicalHead.exists) return canonicalKey;

  const prefix = `${MACHINE_TXT_PREFIX}/${sanitizeMachineSlug(docId, "doc")}/`;
  let cursor: string | undefined;
  let preferred: MachineTxtObjectInfo | null = null;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const obj of page.objects ?? []) {
      const key = obj.key || "";
      if (!key || !/\.txt$/i.test(key)) continue;
      preferred = pickPreferredMachineTxtObject(
        {
          key,
          uploaded: obj.uploaded instanceof Date ? obj.uploaded : undefined,
          size: obj.size,
        },
        preferred,
      );
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return preferred?.key || "";
}

export function isMachineTxtStorageKey(key: string) {
  return isMachineTxtKey(key);
}
