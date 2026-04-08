import type {
  ChatResponseSegment,
  ChatResponseStopReason,
  ChatResponseV2,
  SectionDescriptor,
  SourceRef,
} from "../response_contract";
import type { ResponsePlan } from "../../../universal_answer_orchestrator";

export class StopGeneration extends Error {
  readonly stopReason: ChatResponseStopReason;

  constructor(stopReason: ChatResponseStopReason) {
    super(stopReason);
    this.stopReason = stopReason;
  }
}

export type SegmentSessionState = {
  maxSections: number;
  maxSegments: number;
  maxRowsPerTable: number;
  maxListItems: number;
  maxParagraphChars: number;
  maxCodeLines: number;
  maxCodeChars: number;
  emittedSections: Set<string>;
  emittedSegmentIds: Set<string>;
  emittedSegmentCount: number;
  sourceIds: Set<string>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing ${key}`);
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`Expected ${key} array`);
  const items = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  if (!items.length) throw new Error(`Expected non-empty ${key}`);
  return items;
}

function optionalSourceIds(record: Record<string, unknown>, state: SegmentSessionState): string[] | undefined {
  if (!Array.isArray(record.sourceIds)) return undefined;
  const sourceIds = record.sourceIds
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  if (!sourceIds.length) return undefined;
  const unique = Array.from(new Set(sourceIds));
  unique.forEach((sourceId) => {
    if (!state.sourceIds.has(sourceId)) throw new Error(`Unknown sourceId: ${sourceId}`);
  });
  return unique;
}

function parseTableRows(record: Record<string, unknown>): string[][] {
  const rows = record.rows;
  if (!Array.isArray(rows)) throw new Error("Expected rows array");
  return rows.map((row) => {
    if (!Array.isArray(row)) throw new Error("Expected table row array");
    return row.map((cell) => (typeof cell === "string" ? cell.trim() : String(cell ?? "")));
  });
}

export function createSegmentSessionState(plan: ResponsePlan, sources: SourceRef[]): SegmentSessionState {
  return {
    maxSections: plan.maxSections,
    maxSegments: plan.maxSegments,
    maxRowsPerTable: plan.maxTableRows,
    maxListItems: plan.maxListItems,
    maxParagraphChars: plan.maxParagraphChars,
    maxCodeLines: plan.maxCodeLines,
    maxCodeChars: plan.maxCodeChars,
    emittedSections: new Set(plan.sectionPlan.map((section) => section.id)),
    emittedSegmentIds: new Set<string>(),
    emittedSegmentCount: 0,
    sourceIds: new Set(sources.map((source) => source.id)),
  };
}

export function validateSegment(raw: unknown, state: SegmentSessionState): ChatResponseSegment {
  const record = asRecord(raw);
  if (!record) throw new Error("Segment payload must be an object");
  const type = requiredString(record, "type") as ChatResponseSegment["type"];
  const id = requiredString(record, "id");
  const sectionId = requiredString(record, "sectionId");
  const sourceIds = optionalSourceIds(record, state);

  switch (type) {
    case "header":
      return { id, sectionId, type, text: requiredString(record, "text"), sourceIds };
    case "paragraph":
      return { id, sectionId, type, text: requiredString(record, "text"), sourceIds };
    case "list": {
      const style = requiredString(record, "style");
      if (style !== "bullet" && style !== "ordered") throw new Error("Invalid list style");
      return { id, sectionId, type, style, items: stringArray(record, "items"), sourceIds };
    }
    case "table":
      return {
        id,
        sectionId,
        type,
        caption: optionalString(record, "caption"),
        columns: stringArray(record, "columns"),
        rows: parseTableRows(record),
        sourceIds,
      };
    case "code":
      return {
        id,
        sectionId,
        type,
        language: optionalString(record, "language"),
        code: requiredString(record, "code"),
        sourceIds,
      };
    default:
      throw new Error(`Unknown segment type: ${type}`);
  }
}

export function enforcePlanBoundaries(segment: ChatResponseSegment, state: SegmentSessionState): void {
  if (!state.emittedSections.has(segment.sectionId)) {
    throw new Error(`Unknown sectionId: ${segment.sectionId}`);
  }
  if (state.emittedSegmentIds.has(segment.id)) {
    throw new Error(`Duplicate segment id: ${segment.id}`);
  }
  if (state.emittedSegmentCount >= state.maxSegments) {
    throw new StopGeneration("max_segments");
  }
  if (segment.type === "paragraph" || segment.type === "header") {
    const text = segment.text.trim();
    if (!text) throw new Error("Empty text segment");
    if (text.length > state.maxParagraphChars) throw new Error("Paragraph too long");
  }
  if (segment.type === "list") {
    if (!segment.items.length || segment.items.length > state.maxListItems) {
      throw new Error("Too many list items");
    }
  }
  if (segment.type === "table") {
    if (!segment.columns.length) throw new Error("Table must define columns");
    if (segment.rows.length > state.maxRowsPerTable) throw new Error("Too many table rows");
    segment.rows.forEach((row) => {
      if (row.length !== segment.columns.length) throw new Error("Table row width mismatch");
    });
  }
  if (segment.type === "code") {
    const lineCount = segment.code.split(/\r?\n/).length;
    if (lineCount > state.maxCodeLines) throw new Error("Too many code lines");
    if (segment.code.length > state.maxCodeChars) throw new Error("Code block too long");
  }
  state.emittedSegmentIds.add(segment.id);
  state.emittedSegmentCount += 1;
}

export function validateCompletion(raw: unknown): { stopReason: ChatResponseStopReason; truncated: boolean } {
  const record = asRecord(raw);
  if (!record) throw new Error("Completion payload must be an object");
  const stopReason = requiredString(record, "stopReason") as ChatResponseStopReason;
  if (!["complete", "max_sections", "max_segments", "max_tokens", "insufficient_evidence", "user_input_required"].includes(stopReason)) {
    throw new Error(`Invalid stopReason: ${stopReason}`);
  }
  if (typeof record.truncated !== "boolean") throw new Error("Missing truncated flag");
  return {
    stopReason,
    truncated: record.truncated,
  };
}

export function finalizeResponseV2(params: {
  sections: SectionDescriptor[];
  segments: ChatResponseSegment[];
  sources: SourceRef[];
  stopReason: ChatResponseStopReason;
  truncated: boolean;
}): ChatResponseV2 {
  return {
    version: 2,
    sections: params.sections,
    segments: params.segments,
    sources: params.sources,
    stopReason: params.stopReason,
    truncated: params.truncated,
  };
}
