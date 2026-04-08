import type { AnswerSegment } from "../types";
import { collectMarkdownTable, isTableAlignmentRow, looksLikeTableRow, splitTableRow } from "./markdown-table";

const CITATION_TOKEN_PREFIX = "__OWEN_CITATION_";
const CITATION_TOKEN_SUFFIX = "__";
const CITATION_TOKEN_RE = /__OWEN_CITATION_(\d+)__/g;
const SOURCES_HEADING_RE = /^(?:#{1,6}\s*)?(sources|references)\s*:?\s*$/i;
const SOURCES_INLINE_RE = /^(?:#{1,6}\s*)?(sources|references)\s*:\s+\S.+$/i;

function mergeAdjacentTextSegments(segments: AnswerSegment[]): AnswerSegment[] {
  const merged: AnswerSegment[] = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (segment.type === "text" && last?.type === "text") {
      last.text += segment.text;
      continue;
    }
    merged.push(segment);
  }
  return merged;
}

function isFenceLine(line: string): boolean {
  const trimmed = (line || "").trim();
  return trimmed.startsWith("```") || trimmed.startsWith("~~~");
}

function renderTableAsStructuredSections(headers: string[], rows: string[][]): string {
  const normalizedHeaders = headers.map((header, index) => header || `Column ${index + 1}`);

  if (!rows.length) {
    return normalizedHeaders.map((header) => `- ${header}`).join("\n");
  }

  return rows
    .map((row) => {
      const pairs = normalizedHeaders.map((header, index) => [header, row[index] ?? ""] as const);
      const title = pairs[0]?.[1].trim() || pairs[0]?.[0] || "Item";
      const rest = pairs
        .slice(1)
        .filter(([, value]) => value.trim().length > 0)
        .map(([header, value]) => `- ${header}: ${value}`);

      return [`\n${title}`, ...rest].join("\n");
    })
    .join("\n");
}

function convertMarkdownTablesToLists(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const output: string[] = [];
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    if (isFenceLine(lines[index] || "")) {
      inFence = !inFence;
      output.push(lines[index] || "");
      continue;
    }
    if (inFence) {
      output.push(lines[index] || "");
      continue;
    }
    const headerLine = lines[index] || "";
    const alignmentLine = lines[index + 1] || "";
    if (!looksLikeTableRow(headerLine) || !isTableAlignmentRow(alignmentLine)) {
      output.push(headerLine);
      continue;
    }

    const table = collectMarkdownTable(lines, index);
    if (!table) {
      output.push(headerLine);
      continue;
    }

    output.push(renderTableAsStructuredSections(table.columns, table.rows));
    index = table.nextIndex - 1;
  }

  return output.join("\n");
}

function looksLikeOrphanPipeRow(line: string): boolean {
  if (isTableAlignmentRow(line)) return false;
  return looksLikeTableRow(line);
}

function stripResidualTableSyntax(markdown: string): string {
  let inFence = false;
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      if (isFenceLine(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      if (isTableAlignmentRow(line)) return "";
      if (looksLikeOrphanPipeRow(line)) {
        const cells = splitTableRow(line);
        if (cells.length >= 2) {
          return `- ${cells.join(" · ")}`;
        }
      }
      return line;
    })
    .join("\n");
}

function collapseExcessBlankLines(markdown: string): string {
  return markdown.replace(/\n{3,}/g, "\n\n");
}

function isSourceTailLine(line: string): boolean {
  const trimmed = (line || "").trim();
  if (!trimmed) return true;
  if (/^(?:[-*+]\s+|\d+[.)]\s+|\[\d+\]\s+|https?:\/\/|www\.)/i.test(trimmed)) return true;
  if (/^[^\s].+\s+[–—-]\s+https?:\/\//i.test(trimmed)) return true;
  return false;
}

export function stripTrailingSourcesSection(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  let lastNonEmpty = lines.length - 1;
  while (lastNonEmpty >= 0 && !(lines[lastNonEmpty] || "").trim()) {
    lastNonEmpty -= 1;
  }
  if (lastNonEmpty < 0) return "";

  for (let index = lastNonEmpty; index >= 0; index -= 1) {
    const line = (lines[index] || "").trim();
    if (!line) continue;

    if (SOURCES_INLINE_RE.test(line)) {
      if (lines.slice(index + 1, lastNonEmpty + 1).every(isSourceTailLine)) {
        return lines.slice(0, index).join("\n").trim();
      }
      continue;
    }

    if (!SOURCES_HEADING_RE.test(line)) continue;
    const tail = lines.slice(index + 1, lastNonEmpty + 1);
    if (!tail.length) continue;
    if (tail.every(isSourceTailLine)) {
      return lines.slice(0, index).join("\n").trim();
    }
  }

  return markdown.trim();
}

export function sanitizeMarkdownForChat(markdown: string, opts: { stripTrailingSourcesSection?: boolean } = {}): string {
  if (!markdown.trim()) return "";

  let output = convertMarkdownTablesToLists(markdown);
  output = stripResidualTableSyntax(output);
  if (opts.stripTrailingSourcesSection) {
    output = stripTrailingSourcesSection(output);
  }
  output = collapseExcessBlankLines(output);
  return output.trim();
}

export function sanitizeChatAnswerSegments(
  segments: AnswerSegment[],
  opts: { stripTrailingSourcesSection?: boolean } = {},
): { answerSegments: AnswerSegment[]; answerText: string } {
  const citations: AnswerSegment[] = [];
  let markdown = "";

  for (const segment of segments || []) {
    if (!segment) continue;
    if (segment.type === "text") {
      markdown += segment.text;
      continue;
    }
    const token = `${CITATION_TOKEN_PREFIX}${citations.length}${CITATION_TOKEN_SUFFIX}`;
    citations.push({ ...segment });
    markdown += token;
  }

  const sanitized = sanitizeMarkdownForChat(markdown, opts);
  const rebuilt: AnswerSegment[] = [];
  let cursor = 0;

  sanitized.replace(CITATION_TOKEN_RE, (match, rawIndex, offset) => {
    const index = Number(rawIndex);
    const start = Number(offset);
    if (start > cursor) {
      rebuilt.push({ type: "text", text: sanitized.slice(cursor, start) });
    }
    const citation = citations[index];
    if (citation && citation.type === "citation") {
      rebuilt.push(citation);
    } else {
      rebuilt.push({ type: "text", text: match });
    }
    cursor = start + match.length;
    return match;
  });

  if (cursor < sanitized.length) {
    rebuilt.push({ type: "text", text: sanitized.slice(cursor) });
  }

  const answerSegments = mergeAdjacentTextSegments(rebuilt);
  const answerText = answerSegments
    .map((segment) => (segment.type === "text" ? segment.text : ""))
    .join("")
    .trim();

  return { answerSegments, answerText };
}
