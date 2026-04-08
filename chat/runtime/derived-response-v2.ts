import type { CitationSource } from "../types";
import type { ChatResponseSegment, ChatResponseStopReason, ChatResponseV2 } from "../response_contract";
import { buildSourceRegistry } from "./source_registry";
import { collectMarkdownTable, isTableAlignmentRow, looksLikeTableRow } from "./markdown-table";

const DEFAULT_SECTION_ID = "section-1";
const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const LIST_RE = /^(?:[-*•]\s+|\d+[.)]\s+)/;
const ORDERED_LIST_RE = /^\d+[.)]\s+/;
const STANDALONE_LABEL_MAX_WORDS = 8;
const STANDALONE_LABEL_MAX_CHARS = 80;

type DeriveSegmentsResult = {
  segments: ChatResponseSegment[];
  nextSegmentIndex: number;
  lossless: boolean;
  streamSafe: boolean;
};

function normalizeText(text: string): string {
  return String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function buildSegmentId(index: number): string {
  return `seg-${index}`;
}

function isBlankLine(line: string): boolean {
  return !(line || "").trim();
}

function isFenceLine(line: string): boolean {
  return /^(```|~~~)/.test((line || "").trim());
}

function parseFenceLine(line: string): { marker: string; language?: string } | null {
  const match = (line || "").trim().match(/^(```|~~~)\s*([A-Za-z0-9_+-]*)\s*$/);
  if (!match) return null;
  return {
    marker: match[1]!,
    language: match[2] || undefined,
  };
}

function isHeadingLine(line: string): boolean {
  return HEADING_RE.test((line || "").trim());
}

function isListLine(line: string): boolean {
  return LIST_RE.test((line || "").trim());
}

function stripListMarker(line: string): string {
  return (line || "").trim().replace(LIST_RE, "").trim();
}

function stripSemanticDecoration(line: string): string {
  return (line || "")
    .trim()
    .replace(LIST_RE, "")
    .replace(/^\*{1,2}(.*?)\*{1,2}$/, "$1")
    .trim();
}

export function isStandaloneLabelLine(line: string): boolean {
  if (isListLine(line)) return false;
  const stripped = stripSemanticDecoration(line).replace(/:$/, "").trim();
  if (!stripped) return false;
  if (looksLikeTableRow(stripped) || isTableAlignmentRow(stripped)) return false;
  if (isFenceLine(stripped) || isHeadingLine(stripped)) return false;
  if (stripped.length > STANDALONE_LABEL_MAX_CHARS) return false;
  const words = stripped.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > STANDALONE_LABEL_MAX_WORDS) return false;
  if (/[.!?]$/.test(stripped)) return false;
  if (/[;)]/.test(stripped)) return false;
  return true;
}

export function isDetachedLabelContentLine(line: string): boolean {
  if (isListLine(line)) {
    const content = stripListMarker(line);
    return Boolean(content) && !content.includes(":");
  }

  const content = stripSemanticDecoration(line);
  if (!content || content.includes(":")) return false;
  if (looksLikeTableRow(content) || isTableAlignmentRow(content)) return false;
  if (isFenceLine(content) || isHeadingLine(content)) return false;
  return content.length > 35 || /[,;()]/.test(content);
}

export function tryZipTrailingLabels(
  lines: string[],
  opts: { requireExactPairs?: boolean } = {},
): string[] | null {
  const trimmed = lines.map((line) => line.trim()).filter(Boolean);
  if (trimmed.length < 4) return null;

  let cursor = trimmed.length - 1;
  const labels: string[] = [];
  while (cursor >= 0 && labels.length < STANDALONE_LABEL_MAX_WORDS && isStandaloneLabelLine(trimmed[cursor] || "")) {
    labels.unshift(stripSemanticDecoration(trimmed[cursor] || "").replace(/:$/, "").trim());
    cursor -= 1;
  }

  if (labels.length < 2) return null;
  const preceding = trimmed.slice(0, cursor + 1);
  if (preceding.length < labels.length) return null;

  const contentLines = opts.requireExactPairs
    ? preceding
    : preceding.slice(preceding.length - labels.length);
  if (contentLines.length !== labels.length) return null;
  if (!contentLines.every(isDetachedLabelContentLine)) return null;
  if (opts.requireExactPairs && preceding.length !== labels.length) return null;

  const extraLines = preceding.slice(0, preceding.length - contentLines.length);
  if (extraLines.length) return null;
  if (extraLines.some((line) => isStandaloneLabelLine(line) || looksLikeTableRow(line) || isTableAlignmentRow(line))) {
    return null;
  }

  return labels.map((label, index) => `${label}: ${stripListMarker(contentLines[index] || "").trim()}`);
}

function buildParagraphSegment(
  text: string,
  sectionId: string,
  segmentIndex: number,
): ChatResponseSegment {
  return {
    id: buildSegmentId(segmentIndex),
    sectionId,
    type: "paragraph",
    text: text.trim(),
  };
}

function deriveFenceSegment(
  lines: string[],
  startIndex: number,
  sectionId: string,
  segmentIndex: number,
): { segment: ChatResponseSegment; nextIndex: number } | null {
  const opening = parseFenceLine(lines[startIndex] || "");
  if (!opening) return null;

  let cursor = startIndex + 1;
  while (cursor < lines.length) {
    const current = lines[cursor] || "";
    if (new RegExp(`^${opening.marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`).test(current.trim())) {
      return {
        segment: {
          id: buildSegmentId(segmentIndex),
          sectionId,
          type: "code",
          language: opening.language,
          code: lines.slice(startIndex + 1, cursor).join("\n").trimEnd(),
        },
        nextIndex: cursor + 1,
      };
    }
    cursor += 1;
  }

  return null;
}

function deriveHeadingSegment(
  line: string,
  sectionId: string,
  segmentIndex: number,
): ChatResponseSegment | null {
  const match = (line || "").trim().match(HEADING_RE);
  if (!match) return null;
  return {
    id: buildSegmentId(segmentIndex),
    sectionId,
    type: "header",
    text: match[2]!.trim(),
  };
}

function deriveListSegment(
  lines: string[],
  startIndex: number,
  sectionId: string,
  segmentIndex: number,
): { segment: ChatResponseSegment; nextIndex: number } | null {
  if (!isListLine(lines[startIndex] || "")) return null;

  const items: string[] = [];
  let cursor = startIndex;
  let ordered = true;

  while (cursor < lines.length) {
    const line = lines[cursor] || "";
    if (!isListLine(line)) break;
    ordered = ordered && ORDERED_LIST_RE.test(line.trim());
    let item = stripListMarker(line);
    cursor += 1;

    while (cursor < lines.length) {
      const continuation = lines[cursor] || "";
      if (isBlankLine(continuation)) break;
      if (isListLine(continuation) || isHeadingLine(continuation) || isFenceLine(continuation)) break;
      if (looksLikeTableRow(continuation) && isTableAlignmentRow(lines[cursor + 1] || "")) break;
      item += `\n${continuation.trim()}`;
      cursor += 1;
    }

    if (item.trim()) {
      items.push(item.trim());
    }

    if (isBlankLine(lines[cursor] || "")) break;
  }

  if (!items.length) return null;
  return {
    segment: {
      id: buildSegmentId(segmentIndex),
      sectionId,
      type: "list",
      style: ordered ? "ordered" : "bullet",
      items,
    },
    nextIndex: cursor,
  };
}

function deriveTrailingLabelBlockSegment(
  lines: string[],
  startIndex: number,
  sectionId: string,
  segmentIndex: number,
): { segment: ChatResponseSegment; nextIndex: number; lossless: boolean; streamSafe: boolean } | null {
  if (!isListLine(lines[startIndex] || "")) return null;

  let cursor = startIndex;
  while (cursor < lines.length) {
    const line = lines[cursor] || "";
    if (isBlankLine(line)) break;
    if (cursor > startIndex) {
      if (isHeadingLine(line) || isFenceLine(line)) break;
      if (looksLikeTableRow(line) && isTableAlignmentRow(lines[cursor + 1] || "")) break;
    }
    cursor += 1;
  }

  const blockLines = lines.slice(startIndex, cursor);
  const hasDetachedLabels = blockLines.some((line, index) => index > 0 && isStandaloneLabelLine(line));
  if (!hasDetachedLabels) return null;

  const repairedItems = tryZipTrailingLabels(blockLines);
  if (repairedItems?.length) {
    return {
      segment: {
        id: buildSegmentId(segmentIndex),
        sectionId,
        type: "list",
        style: "bullet",
        items: repairedItems,
      },
      nextIndex: cursor,
      lossless: false,
      streamSafe: true,
    };
  }

  return {
    segment: buildParagraphSegment(blockLines.join("\n").trim(), sectionId, segmentIndex),
    nextIndex: cursor,
    lossless: false,
    streamSafe: false,
  };
}

function deriveTableSegment(
  lines: string[],
  startIndex: number,
  sectionId: string,
  segmentIndex: number,
): { segment: ChatResponseSegment; nextIndex: number } | null {
  const directTable = collectMarkdownTable(lines, startIndex);
  if (directTable) {
    return {
      segment: {
        id: buildSegmentId(segmentIndex),
        sectionId,
        type: "table",
        columns: directTable.columns,
        rows: directTable.rows,
      },
      nextIndex: directTable.nextIndex,
    };
  }

  const caption = (lines[startIndex] || "").trim();
  if (!caption || isHeadingLine(caption) || isListLine(caption) || isFenceLine(caption)) return null;
  const captionTable = collectMarkdownTable(lines, startIndex + 1);
  if (!captionTable) return null;

  return {
    segment: {
      id: buildSegmentId(segmentIndex),
      sectionId,
      type: "table",
      caption,
      columns: captionTable.columns,
      rows: captionTable.rows,
    },
    nextIndex: captionTable.nextIndex,
  };
}

function deriveParagraphLikeSegment(
  lines: string[],
  startIndex: number,
  sectionId: string,
  segmentIndex: number,
): { segment: ChatResponseSegment; nextIndex: number; lossless: boolean; streamSafe: boolean } | null {
  let cursor = startIndex;
  while (cursor < lines.length) {
    const line = lines[cursor] || "";
    if (isBlankLine(line)) break;
    if (cursor > startIndex) {
      if (isHeadingLine(line) || isFenceLine(line) || isListLine(line)) break;
      if (deriveTableSegment(lines, cursor, sectionId, segmentIndex)) break;
    }
    cursor += 1;
  }

  const blockLines = lines.slice(startIndex, cursor);
  const inlineLabelItems = blockLines
    .map((line) => {
      const content = stripSemanticDecoration(line);
      const match = content.match(/^([^:]{1,80}):\s+(.+)$/);
      if (!match) return null;
      const label = match[1]!.trim();
      const body = match[2]!.trim();
      if (!label || !body || !isStandaloneLabelLine(label)) return null;
      return `${label}: ${body}`;
    })
    .filter((item): item is string => Boolean(item));
  if (inlineLabelItems.length === blockLines.length && inlineLabelItems.length > 0) {
    return {
      segment: {
        id: buildSegmentId(segmentIndex),
        sectionId,
        type: "list",
        style: "bullet",
        items: inlineLabelItems,
      },
      nextIndex: cursor,
      lossless: false,
      streamSafe: true,
    };
  }

  const repairedItems = tryZipTrailingLabels(blockLines);
  if (repairedItems?.length) {
    return {
      segment: {
        id: buildSegmentId(segmentIndex),
        sectionId,
        type: "list",
        style: "bullet",
        items: repairedItems,
      },
      nextIndex: cursor,
      lossless: false,
      streamSafe: true,
    };
  }

  const text = blockLines.join("\n").trim();
  if (!text) return null;
  const containsDetachedLabels = blockLines.some((line) => isStandaloneLabelLine(line));
  const containsTableLikeContent = blockLines.some((line) => looksLikeTableRow(line) || isTableAlignmentRow(line));
  const streamSafe = !containsDetachedLabels && !containsTableLikeContent;
  return {
    segment: buildParagraphSegment(text, sectionId, segmentIndex),
    nextIndex: cursor,
    lossless: streamSafe,
    streamSafe,
  };
}

export function deriveResponseSegmentsFromText(params: {
  text: string;
  sectionId?: string;
  startIndex?: number;
}): DeriveSegmentsResult {
  const normalized = normalizeText(params.text).trim();
  if (!normalized) {
    return {
      segments: [],
      nextSegmentIndex: params.startIndex ?? 1,
      lossless: true,
      streamSafe: true,
    };
  }

  const sectionId = params.sectionId || DEFAULT_SECTION_ID;
  const lines = normalized.split("\n");
  const segments: ChatResponseSegment[] = [];
  let cursor = 0;
  let segmentIndex = params.startIndex ?? 1;
  let lossless = true;
  let streamSafe = true;

  while (cursor < lines.length) {
    if (isBlankLine(lines[cursor] || "")) {
      cursor += 1;
      continue;
    }

    const code = deriveFenceSegment(lines, cursor, sectionId, segmentIndex);
    if (code) {
      segments.push(code.segment);
      cursor = code.nextIndex;
      segmentIndex += 1;
      continue;
    }

    const heading = deriveHeadingSegment(lines[cursor] || "", sectionId, segmentIndex);
    if (heading) {
      segments.push(heading);
      cursor += 1;
      segmentIndex += 1;
      continue;
    }

    const table = deriveTableSegment(lines, cursor, sectionId, segmentIndex);
    if (table) {
      segments.push(table.segment);
      cursor = table.nextIndex;
      segmentIndex += 1;
      lossless = false;
      streamSafe = streamSafe && true;
      continue;
    }

    const trailingLabelBlock = deriveTrailingLabelBlockSegment(lines, cursor, sectionId, segmentIndex);
    if (trailingLabelBlock) {
      segments.push(trailingLabelBlock.segment);
      cursor = trailingLabelBlock.nextIndex;
      segmentIndex += 1;
      lossless = false;
      streamSafe = streamSafe && trailingLabelBlock.streamSafe;
      continue;
    }

    const list = deriveListSegment(lines, cursor, sectionId, segmentIndex);
    if (list) {
      segments.push(list.segment);
      cursor = list.nextIndex;
      segmentIndex += 1;
      continue;
    }

    const paragraph = deriveParagraphLikeSegment(lines, cursor, sectionId, segmentIndex);
    if (paragraph) {
      segments.push(paragraph.segment);
      cursor = paragraph.nextIndex;
      segmentIndex += 1;
      lossless = lossless && paragraph.lossless;
      streamSafe = streamSafe && paragraph.streamSafe;
      continue;
    }

    cursor += 1;
  }

  return {
    segments,
    nextSegmentIndex: segmentIndex,
    lossless,
    streamSafe,
  };
}

export function buildDerivedResponseV2(params: {
  text: string;
  sources?: CitationSource[];
  sectionTitle: string;
  stopReason?: ChatResponseStopReason;
  truncated?: boolean;
}): ChatResponseV2 | null {
  const sectionTitle = (params.sectionTitle || "").trim() || "Answer";
  const derived = deriveResponseSegmentsFromText({
    text: params.text,
    sectionId: DEFAULT_SECTION_ID,
    startIndex: 1,
  });
  if (!derived.segments.length) return null;

  return {
    version: 2,
    sections: [{ id: DEFAULT_SECTION_ID, title: sectionTitle, order: 1 }],
    segments: derived.segments,
    sources: buildSourceRegistry((params.sources || []).map((source) => ({
      url: source.url,
      title: source.title,
      domain: source.domain,
      snippet: source.snippet,
    }))),
    stopReason: params.stopReason || (params.truncated ? "max_tokens" : "complete"),
    truncated: Boolean(params.truncated),
  };
}
