import type { PipelineStageDef } from "../../registry/pipelines";

export const ankiPipelineStages: PipelineStageDef[] = [
  { id: "anki.extract", label: "Content extraction", contract: "lecture uploads -> transcript / slide ledger" },
  { id: "anki.prompt", label: "Prompt assembly", contract: "content blocks -> Anki generation prompt" },
  { id: "anki.parse", label: "Parse / lint", contract: "structured output -> linted notes", validators: ["lintAnkiNotes"] },
  { id: "anki.coverage", label: "Coverage merge", contract: "linted notes -> coverage-complete notes", validators: ["computeAnkiCoverageStats"] },
  { id: "anki.publish", label: "Publish / download", contract: "final notes -> R2 / publish response" },
];
