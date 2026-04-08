import { isTableAlignmentRow, looksLikeTableRow } from "./markdown-table";
import type { StreamBufferFlushResult } from "./stream-buffer";
import { isStandaloneLabelLine, tryZipTrailingLabels } from "./derived-response-v2";

export const SEMANTIC_STREAM_PENDING_CHAR_LIMIT = 1024;

export interface SemanticStreamBlock {
  text: string;
  rawOffsetStart: number;
  rawOffsetEnd: number;
}

function trimFlushText(flush: StreamBufferFlushResult | undefined): string {
  return (flush?.text || "").trim();
}

function isBlankFlush(flush: StreamBufferFlushResult | undefined): boolean {
  return !trimFlushText(flush);
}

function isTableStart(flushes: StreamBufferFlushResult[], startIndex: number): boolean {
  const header = trimFlushText(flushes[startIndex]);
  const alignment = trimFlushText(flushes[startIndex + 1]);
  return Boolean(header) && looksLikeTableRow(header) && isTableAlignmentRow(alignment);
}

export class SemanticStreamBuffer {
  private pending: StreamBufferFlushResult[] = [];

  push(flushes: StreamBufferFlushResult[]): SemanticStreamBlock[] {
    const blocks: SemanticStreamBlock[] = [];
    flushes.forEach((flush) => {
      if (!flush?.text) return;
      this.pending.push(flush);
      blocks.push(...this.drainReadyBlocks());
    });
    return blocks;
  }

  flushFinal(): SemanticStreamBlock[] {
    const blocks = this.drainReadyBlocks();
    this.trimLeadingBlankFlushes();
    if (!this.pending.length) return blocks;
    blocks.push(this.consume(this.pending.length));
    return blocks;
  }

  getPendingLength(): number {
    return this.pending.reduce((total, flush) => total + (flush.text || "").length, 0);
  }

  private drainReadyBlocks(): SemanticStreamBlock[] {
    const blocks: SemanticStreamBlock[] = [];
    while (true) {
      this.trimLeadingBlankFlushes();
      const readyCount = this.findReadyFlushCount();
      if (!readyCount) break;
      blocks.push(this.consume(readyCount));
    }
    return blocks;
  }

  private trimLeadingBlankFlushes() {
    while (this.pending.length && isBlankFlush(this.pending[0])) {
      this.pending.shift();
    }
  }

  private findReadyFlushCount(): number {
    if (!this.pending.length) return 0;

    const first = this.pending[0];
    if (!first) return 0;
    if (first.blockType === "code" || first.blockType === "heading") {
      return 1;
    }

    const tableCount = this.findReadyTableCount();
    if (tableCount > 0) return tableCount;

    const detachedLabelCount = this.findReadyDetachedLabelCount();
    if (detachedLabelCount > 0) return detachedLabelCount;

    const listCount = this.findReadyListCount();
    if (listCount > 0) return listCount;

    return this.findReadyParagraphCount();
  }

  private findReadyTableCount(): number {
    if (isTableStart(this.pending, 0)) {
      return this.findReadyTableCountFromStart(0);
    }

    const first = this.pending[0];
    if (!first) return 0;
    const firstText = trimFlushText(first);
    if (!firstText || first.blockType === "heading" || first.blockType === "list_item" || first.blockType === "code") {
      return 0;
    }
    if (isTableStart(this.pending, 1)) {
      return this.findReadyTableCountFromStart(1);
    }
    return 0;
  }

  private findReadyTableCountFromStart(startIndex: number): number {
    if (!isTableStart(this.pending, startIndex)) return 0;

    let cursor = startIndex + 2;
    let rowCount = 0;
    while (cursor < this.pending.length) {
      const text = trimFlushText(this.pending[cursor]);
      if (!text) break;
      if (!looksLikeTableRow(text) || isTableAlignmentRow(text)) break;
      rowCount += 1;
      cursor += 1;
    }

    if (!rowCount) return 0;
    if (cursor >= this.pending.length) return 0;
    return cursor;
  }

  private findReadyDetachedLabelCount(): number {
    if (this.pending[0]?.blockType !== "list_item") return 0;

    let limit = 0;
    while (limit < this.pending.length) {
      const flush = this.pending[limit];
      if (!flush) break;
      const text = trimFlushText(flush);
      if (!text) break;
      if (limit > 0 && (flush.blockType === "heading" || flush.blockType === "code")) break;
      if (limit > 0 && isTableStart(this.pending, limit)) break;
      limit += 1;
    }

    let candidate = 0;
    for (let end = 4; end <= limit; end += 1) {
      const lines = this.pending.slice(0, end).map((flush) => trimFlushText(flush));
      if (lines.some((line) => !line)) continue;
      if (tryZipTrailingLabels(lines, { requireExactPairs: true })?.length) {
        candidate = end;
      }
    }
    return candidate;
  }

  private findReadyListCount(): number {
    if (this.pending[0]?.blockType !== "list_item") return 0;

    let cursor = 0;
    while (cursor < this.pending.length && this.pending[cursor]?.blockType === "list_item" && !isBlankFlush(this.pending[cursor])) {
      cursor += 1;
    }

    if (cursor >= this.pending.length) return 0;
    const next = this.pending[cursor];
    if (!next) return 0;
    if (isBlankFlush(next)) return cursor;
    if (isStandaloneLabelLine(next.text)) return 0;
    return cursor;
  }

  private findReadyParagraphCount(): number {
    const first = this.pending[0];
    if (!first) return 0;
    if (first.blockType !== "paragraph" && first.blockType !== "other") return 0;

    const firstText = trimFlushText(first);
    if (!firstText || isStandaloneLabelLine(firstText)) return 0;
    if (looksLikeTableRow(firstText) || isTableAlignmentRow(firstText)) return 0;
    if (this.pending.length > 1 && looksLikeTableRow(trimFlushText(this.pending[1]))) {
      return 0;
    }
    return first.isBlockBoundary ? 1 : 0;
  }

  private consume(count: number): SemanticStreamBlock {
    const flushes = this.pending.splice(0, count);
    return {
      text: flushes.map((flush) => flush.text).join(""),
      rawOffsetStart: flushes[0]?.rawOffsetStart ?? 0,
      rawOffsetEnd: flushes[flushes.length - 1]?.rawOffsetEnd ?? 0,
    };
  }
}
