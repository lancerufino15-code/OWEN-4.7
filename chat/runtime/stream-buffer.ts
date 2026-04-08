import type { StreamBlockType } from "./types";

export interface StreamBufferFlushResult {
  text: string;
  blockType: StreamBlockType;
  isStable: boolean;
  isBlockBoundary: boolean;
  rawOffsetStart: number;
  rawOffsetEnd: number;
}

export interface StreamBufferFormatState {
  blockType: StreamBlockType;
  inCodeFence: boolean;
  rawOffset: number;
}

function normalizeIncomingText(text: string): string {
  return String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function trimTrailingNewline(line: string): string {
  return line.replace(/\n$/, "");
}

function isFenceLine(line: string): boolean {
  return /^```/.test(line.trim());
}

function isHeadingLine(line: string): boolean {
  return /^#{1,6}\s+\S/.test(line.trim());
}

function isListLine(line: string): boolean {
  return /^(?:[-*•]\s+\S|\d+[.)]\s+\S)/.test(line.trim());
}

function hasDanglingBlockPrefix(text: string): boolean {
  const lastLine = text.split("\n").pop() || "";
  const trimmed = lastLine.trim();
  if (!trimmed) return false;
  if (/^#{1,6}\s*$/.test(trimmed)) return true;
  if (/^[-*•+]\s*$/.test(trimmed)) return true;
  if (/^\d+[.)]\s*$/.test(trimmed)) return true;
  return false;
}

function hasBalancedInlineMarkdown(text: string): boolean {
  const sanitized = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\\`/g, "")
    .replace(/\\\*/g, "")
    .replace(/\\_/g, "");
  const singleBackticks = (sanitized.match(/(^|[^`])`([^`]|$)/g) || []).length;
  const doubleAsterisks = (sanitized.match(/\*\*/g) || []).length;
  const doubleUnderscores = (sanitized.match(/__/g) || []).length;
  return singleBackticks % 2 === 0 && doubleAsterisks % 2 === 0 && doubleUnderscores % 2 === 0;
}

function classifyBlock(text: string): StreamBlockType {
  const trimmed = text.trim();
  if (!trimmed) return "other";
  if (/^```/.test(trimmed) || /```/.test(trimmed)) return "code";
  if (isHeadingLine(trimmed)) return "heading";
  if (isListLine(trimmed)) return "list_item";
  return "paragraph";
}

function isSafeLine(line: string): boolean {
  const trimmed = trimTrailingNewline(line);
  if (!trimmed.trim()) return true;
  if (isFenceLine(trimmed)) return false;
  if (hasDanglingBlockPrefix(trimmed)) return false;
  return hasBalancedInlineMarkdown(trimmed);
}

function findSentenceBoundary(text: string): number {
  const matches = text.matchAll(/[.!?…]+(?:["')\]]+)?(?:\s+|$)/g);
  let boundary = 0;
  for (const match of matches) {
    const end = (match.index ?? 0) + match[0].length;
    const candidate = text.slice(0, end);
    if (!candidate.trim()) continue;
    if (hasDanglingBlockPrefix(candidate)) continue;
    if (!hasBalancedInlineMarkdown(candidate)) continue;
    boundary = end;
  }
  return boundary;
}

function findWordBoundary(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  if (hasDanglingBlockPrefix(text)) return 0;
  if (!hasBalancedInlineMarkdown(text)) return 0;
  if (/\s$/.test(text) || /[.,;:!?)\]]$/.test(text)) return text.length;
  const whitespaceIndex = text.search(/\s+\S*$/);
  if (whitespaceIndex <= 0) return 0;
  return whitespaceIndex + 1;
}

function findClosingFenceBoundary(text: string): number {
  let consumed = text.indexOf("\n") + 1;
  if (consumed === 0) return 0;
  while (consumed <= text.length) {
    const newlineIndex = text.indexOf("\n", consumed);
    if (newlineIndex === -1) {
      const tail = text.slice(consumed);
      if (isFenceLine(tail)) return text.length;
      return 0;
    }
    const lineEnd = newlineIndex + 1;
    const line = text.slice(consumed, lineEnd);
    if (isFenceLine(trimTrailingNewline(line))) return lineEnd;
    consumed = lineEnd;
  }
  return 0;
}

export class StreamBuffer {
  private pending = "";
  private rawOffset = 0;

  pushDelta(text: string, _now = Date.now()): StreamBufferFlushResult[] {
    const normalized = normalizeIncomingText(text);
    if (!normalized) return [];
    this.pending += normalized;
    return this.drain("push");
  }

  flushPending(_now = Date.now()): StreamBufferFlushResult[] {
    return this.drain("timer");
  }

  flushFinal(): StreamBufferFlushResult[] {
    if (!this.pending) return [];
    return [this.consume(this.pending.length, classifyBlock(this.pending))];
  }

  getFormatState(): StreamBufferFormatState {
    const pending = this.pending;
    const firstLine = pending.split("\n", 1)[0] || "";
    const inCodeFence = pending ? pending.split("```").length % 2 === 0 : false;
    return {
      blockType: inCodeFence ? "code" : classifyBlock(firstLine),
      inCodeFence,
      rawOffset: this.rawOffset,
    };
  }

  private drain(mode: "push" | "timer"): StreamBufferFlushResult[] {
    const results: StreamBufferFlushResult[] = [];
    while (true) {
      const next = this.findNextFlushBoundary(mode);
      if (!next) break;
      results.push(this.consume(next.index, next.blockType, next.isBlockBoundary));
    }
    return results;
  }

  private findNextFlushBoundary(mode: "push" | "timer"): { index: number; blockType: StreamBlockType; isBlockBoundary: boolean } | null {
    if (!this.pending) return null;

    const newlineIndex = this.pending.indexOf("\n");
    if (newlineIndex !== -1) {
      const line = this.pending.slice(0, newlineIndex + 1);
      const trimmedLine = trimTrailingNewline(line);
      if (isFenceLine(trimmedLine)) {
        const boundary = findClosingFenceBoundary(this.pending);
        if (boundary > 0) {
          return { index: boundary, blockType: "code", isBlockBoundary: true };
        }
        return null;
      }
      if (isSafeLine(line)) {
        return { index: newlineIndex + 1, blockType: classifyBlock(trimmedLine), isBlockBoundary: true };
      }
      return null;
    }

    const sentenceBoundary = findSentenceBoundary(this.pending);
    if (sentenceBoundary > 0) {
      return { index: sentenceBoundary, blockType: "paragraph", isBlockBoundary: true };
    }
    if (mode !== "timer") return null;

    const wordBoundary = findWordBoundary(this.pending);
    if (wordBoundary > 0) {
      return { index: wordBoundary, blockType: "paragraph", isBlockBoundary: false };
    }
    return null;
  }

  private consume(index: number, blockType: StreamBlockType, isBlockBoundary = true): StreamBufferFlushResult {
    const text = this.pending.slice(0, index);
    const rawOffsetStart = this.rawOffset;
    const rawOffsetEnd = rawOffsetStart + text.length;
    this.pending = this.pending.slice(index);
    this.rawOffset = rawOffsetEnd;
    return {
      text,
      blockType,
      isStable: true,
      isBlockBoundary,
      rawOffsetStart,
      rawOffsetEnd,
    };
  }
}
