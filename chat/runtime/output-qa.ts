import {
  applyDeterministicAudit,
} from "../../../universal_answer_orchestrator";
import type { AnswerSegment, CitationSource, ResolvedResponseMode } from "../types";
import type { RenderHints } from "../../../universal_answer_orchestrator";

export interface QaResult {
  answerText: string;
  answerSegments: AnswerSegment[];
  sources: CitationSource[];
  renderHints: RenderHints;
  issues: string[];
}

function normalizeLeadingAnswer(text: string): string {
  const trimmed = (text || "").trim();
  if (!trimmed) return "(empty response)";
  return trimmed;
}

export function applyOutputQa(opts: {
  answerText: string;
  answerSegments: AnswerSegment[];
  sources: CitationSource[];
  resolvedResponseMode: ResolvedResponseMode;
  longAnswerChars: number;
  typewriterSpeedMs?: number;
  markdownSafe?: boolean;
  renderStats?: {
    charCount?: number;
    sourceCount?: number;
  };
}): QaResult {
  const audited = applyDeterministicAudit(
    normalizeLeadingAnswer(opts.answerText),
    opts.answerSegments,
    opts.sources,
  );
  const charCount = Number.isFinite(opts.renderStats?.charCount)
    ? Math.max(0, Number(opts.renderStats?.charCount))
    : audited.answerText.trim().length;
  const sourceCount = Number.isFinite(opts.renderStats?.sourceCount)
    ? Math.max(0, Number(opts.renderStats?.sourceCount))
    : audited.sources.length;
  const renderHints: RenderHints = {
    renderMode: charCount > opts.longAnswerChars ? "typewriter" : "instant",
    showSources: sourceCount > 0,
    typewriterSpeedMs: opts.typewriterSpeedMs,
    format: opts.markdownSafe ? "markdown_safe" : undefined,
    stopReason: audited.stopReason,
  };

  return {
    answerText: audited.answerText,
    answerSegments: audited.answerSegments,
    sources: audited.sources,
    renderHints,
    issues: audited.issues,
  };
}
