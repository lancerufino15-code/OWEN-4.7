import type { ExecutionPlan, FileContextRecord } from "./types";

type InstructionLayers = {
  base: string;
  continuity: string;
  retrieval: string;
  strategy: string;
  responseMode: string;
  continuation: string;
  outputConstraints: string;
};

function buildRetrievalLayer(plan: ExecutionPlan, fileContexts: FileContextRecord[]): string {
  if (plan.retrieval.mode === "web_search") {
    return [
      "Use web search results to verify factual claims.",
      "Only cite sources returned by the provider.",
      "Do not print raw URLs in the answer body.",
      "Do not invent URLs, inline citation markup, or a manual references section.",
    ].join("\n");
  }
  if (fileContexts.length) {
    return [
      "Attached files are primary evidence for this answer.",
      "Prefer direct support from the provided file context before general knowledge.",
      "Preserve page markers when quoting them.",
    ].join("\n");
  }
  return "";
}

function buildContinuityLayer(plan: ExecutionPlan): string {
  const summary = plan.compactedTranscript.summary || plan.conversationState?.rollingSummary || "";
  if (!summary) return "";
  return `Conversation summary:\n${summary}`;
}

function buildContinuationLayer(plan: ExecutionPlan): string {
  const lines: string[] = [];
  if (plan.compactedTranscript.triggered && plan.compactedTranscript.resumeInstruction) {
    lines.push(plan.compactedTranscript.resumeInstruction);
  }
  if (plan.continuationText) {
    lines.push("Continue from the existing partial answer without repeating earlier text.");
    lines.push("If the existing answer already ends with a short tailoring follow-up, return no additional content.");
  }
  return lines.join("\n");
}

function buildResponseModeLayer(plan: ExecutionPlan): string {
  if (plan.resolvedResponseMode === "instant") {
    return "Keep the response concise and direct.";
  }
  return "Use structured sections when helpful, but start with the direct answer.";
}

function buildOutputConstraintsLayer(): string {
  return [
    "Output constraints:",
    "- When tabular information is requested, do not use markdown tables.",
    "- Never use pipe-delimited rows like | a | b |.",
    "- Prefer short titled sections or labeled bullets instead of markdown presentation syntax.",
    "- Convert tabular information into structured labeled sections instead.",
    "- Each row should become a clearly separated block.",
    "- Use bullet points for attributes to preserve readability and hierarchy.",
    "- Never output a standalone label without its content.",
    "- Do not append a trailing Sources or References section in the answer text.",
    "- The runtime owns response.sources; do not restate that section manually.",
    "- Do not print raw URLs in the answer body.",
    "- If you end with a short follow-up that asks the user for more context, stop immediately after that block.",
    "- Do not continue into extra sections, appendices, or a second pass after that follow-up.",
  ].join("\n");
}

export function buildInstructionLayers(plan: ExecutionPlan, strategyInstructions: string, fileContexts: FileContextRecord[] = []): InstructionLayers {
  return {
    base: plan.baseSystemPrompt,
    continuity: buildContinuityLayer(plan),
    retrieval: buildRetrievalLayer(plan, fileContexts),
    strategy: strategyInstructions,
    responseMode: buildResponseModeLayer(plan),
    continuation: buildContinuationLayer(plan),
    outputConstraints: buildOutputConstraintsLayer(),
  };
}

export function renderInstructionLayers(layers: InstructionLayers): string {
  return [
    layers.base,
    layers.continuity,
    layers.retrieval,
    layers.strategy,
    layers.responseMode,
    layers.continuation,
    layers.outputConstraints,
  ]
    .filter(Boolean)
    .join("\n\n");
}
