export type SourceRef = {
  id: string;
  url: string;
  title: string;
  domain?: string;
  snippet?: string;
};

export type SectionDescriptor = {
  id: string;
  title: string;
  order: number;
};

type SegmentBase = {
  id: string;
  sectionId: string;
  sourceIds?: string[];
};

export type HeaderSegment = SegmentBase & {
  type: "header";
  text: string;
};

export type ParagraphSegment = SegmentBase & {
  type: "paragraph";
  text: string;
};

export type ListSegment = SegmentBase & {
  type: "list";
  style: "bullet" | "ordered";
  items: string[];
};

export type TableSegment = SegmentBase & {
  type: "table";
  caption?: string;
  columns: string[];
  rows: string[][];
};

export type CodeSegment = SegmentBase & {
  type: "code";
  language?: string;
  code: string;
};

export type ChatResponseSegment =
  | HeaderSegment
  | ParagraphSegment
  | ListSegment
  | TableSegment
  | CodeSegment;

export type ChatResponseStopReason =
  | "complete"
  | "max_sections"
  | "max_segments"
  | "max_tokens"
  | "insufficient_evidence"
  | "user_input_required";

export type ChatResponseV2 = {
  version: 2;
  sections: SectionDescriptor[];
  segments: ChatResponseSegment[];
  sources: SourceRef[];
  stopReason: ChatResponseStopReason;
  truncated: boolean;
};

export function projectSegmentText(segment: ChatResponseSegment): string {
  switch (segment.type) {
    case "header":
      return segment.text.trim();
    case "paragraph":
      return segment.text.trim();
    case "list":
      return segment.items
        .map((item, index) => `${segment.style === "ordered" ? `${index + 1}.` : "-"} ${item}`.trim())
        .join("\n")
        .trim();
    case "table": {
      const lines = segment.rows.map((row) =>
        segment.columns
          .map((column, index) => `${column}: ${row[index] ?? ""}`.trim())
          .join(" | "),
      );
      const caption = segment.caption?.trim();
      return [caption, ...lines].filter(Boolean).join("\n").trim();
    }
    case "code":
      return segment.code.trim();
    default:
      return "";
  }
}

export function buildResponseV2PlainText(response: Pick<ChatResponseV2, "sections" | "segments">): string {
  const lines: string[] = [];
  const sectionById = new Map(response.sections.map((section) => [section.id, section]));
  let currentSectionId = "";

  response.segments.forEach((segment) => {
    if (segment.sectionId !== currentSectionId) {
      currentSectionId = segment.sectionId;
      const section = sectionById.get(segment.sectionId);
      if (section?.title) {
        if (lines.length) lines.push("");
        lines.push(section.title.trim());
      }
    }
    const text = projectSegmentText(segment);
    if (!text) return;
    if (lines.length) lines.push("");
    lines.push(text);
  });

  return lines.join("\n").trim();
}
