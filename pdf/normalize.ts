/**
 * PDF text normalization utilities.
 *
 * Used by: PDF extraction pipeline in `src/index.ts` to clean page text and
 * remove repeated headers/footers.
 *
 * Key exports:
 * - `PageText` for page-indexed text records.
 * - `normalizePlainText`, `normalizePages` for cleanup and concatenation.
 *
 * Assumptions:
 * - `pageIndex` values are zero-based and comparable for ordering.
 * - Input text originates from PDF.js extraction and may include headers/footers.
 */
export type PageText = { pageIndex: number; text: string };

const HEADER_FOOTER_THRESHOLD = 0.6;

/**
 * Normalize raw text by fixing line endings, nulls, and excess whitespace.
 *
 * @param value - Raw text content.
 * @returns Cleaned text with normalized whitespace.
 */
export function normalizePlainText(value: string): string {
  return (value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Normalize and combine page text while removing repeated headers/footers.
 *
 * @param pages - Page-indexed text blocks.
 * @returns Combined text, processed page count, and removed header/footer lines.
 */
export function normalizePages(pages: PageText[]): { text: string; pagesProcessed: number; removedHeaders: string[] } {
  if (!Array.isArray(pages) || !pages.length) {
    return { text: "", pagesProcessed: 0, removedHeaders: [] };
  }

  const cleaned = pages
    .map(page => {
      if (!page || typeof page.pageIndex !== "number") return null;
      const normalized = normalizePlainText(page.text);
      if (!normalized) return null;
      return { pageIndex: page.pageIndex, text: normalized };
    })
    .filter((p): p is PageText => Boolean(p))
    .sort((a, b) => a.pageIndex - b.pageIndex);

  if (!cleaned.length) {
    return { text: "", pagesProcessed: 0, removedHeaders: [] };
  }

  const pageCount = cleaned.length;
  const firstLineCounts = new Map<string, number>();
  const lastLineCounts = new Map<string, number>();

  cleaned.forEach(page => {
    const lines = splitMeaningfulLines(page.text);
    if (lines.first) {
      const key = lines.first;
      firstLineCounts.set(key, (firstLineCounts.get(key) || 0) + 1);
    }
    if (lines.last) {
      const key = lines.last;
      lastLineCounts.set(key, (lastLineCounts.get(key) || 0) + 1);
    }
  });

  const repeatedHeaders = new Set<string>(
    Array.from(firstLineCounts.entries())
      .filter(([, count]) => count / pageCount >= HEADER_FOOTER_THRESHOLD)
      .map(([line]) => line),
  );
  const repeatedFooters = new Set<string>(
    Array.from(lastLineCounts.entries())
      .filter(([, count]) => count / pageCount >= HEADER_FOOTER_THRESHOLD)
      .map(([line]) => line),
  );

  const removedHeaders: string[] = [];
  repeatedHeaders.forEach(line => removedHeaders.push(line));
  repeatedFooters.forEach(line => removedHeaders.push(line));

  const combined = cleaned
    .map(page => {
      const lines = page.text.split("\n").map(l => l.trim());
      while (lines.length && repeatedHeaders.has(lines[0])) {
        lines.shift();
      }
      while (lines.length && repeatedFooters.has(lines[lines.length - 1])) {
        lines.pop();
      }
      const body = normalizePlainText(lines.join("\n"));
      const pageLabel = page.pageIndex + 1;
      return `--- Page ${pageLabel} ---\n${body}`;
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();

  return {
    text: combined,
    pagesProcessed: cleaned.length,
    removedHeaders,
  };
}

function splitMeaningfulLines(text: string): { first: string; last: string } {
  const lines = (text || "")
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0 && line.length <= 240);
  const first = lines[0] || "";
  const last = lines[lines.length - 1] || "";
  return { first, last };
}
