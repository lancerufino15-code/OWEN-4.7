export const ALIGNMENT_ROW_RE = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)?\|?\s*$/;

export function splitTableRow(line: string): string[] {
  const trimmed = (line || "").trim();
  if (!trimmed || !trimmed.includes("|")) return [];
  const normalized = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = normalized.split("|").map((cell) => cell.trim());
  if (cells.length < 2) return [];
  if (!cells.some((cell) => cell.length > 0)) return [];
  return cells;
}

export function looksLikeTableRow(line: string): boolean {
  if (!line || /```|~~~/.test(line)) return false;
  return splitTableRow(line).length >= 2;
}

export function isTableAlignmentRow(line: string): boolean {
  return ALIGNMENT_ROW_RE.test(line || "");
}

export function collectMarkdownTable(lines: string[], startIndex: number): {
  columns: string[];
  rows: string[][];
  nextIndex: number;
} | null {
  const headerLine = lines[startIndex] || "";
  const alignmentLine = lines[startIndex + 1] || "";
  if (!looksLikeTableRow(headerLine) || !isTableAlignmentRow(alignmentLine)) return null;

  const columns = splitTableRow(headerLine);
  if (!columns.length) return null;

  const rows: string[][] = [];
  let cursor = startIndex + 2;
  while (cursor < lines.length) {
    const rowLine = lines[cursor] || "";
    if (!looksLikeTableRow(rowLine) || isTableAlignmentRow(rowLine)) break;
    const row = splitTableRow(rowLine);
    if (!row.length || row.length !== columns.length) return null;
    rows.push(row);
    cursor += 1;
  }

  return {
    columns,
    rows,
    nextIndex: cursor,
  };
}
