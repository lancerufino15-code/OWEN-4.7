import type { PipelineStageDef } from "../../registry/pipelines";

export const studyGuidePipelineStages: PipelineStageDef[] = [
  { id: "study-guide.ingest", label: "Ingestion / normalization", contract: "raw lecture bytes -> machine TXT" },
  { id: "study-guide.step-a", label: "Step A extraction", contract: "machine TXT -> Step A extract JSON" },
  { id: "study-guide.step-b", label: "Step B synthesis", contract: "Step A -> study-guide JSON", validators: ["validateStepB"] },
  { id: "study-guide.repair", label: "Validation / repair", contract: "invalid Step B -> repaired Step B JSON", validators: ["validateStepB", "validateSynthesis"] },
  { id: "study-guide.render", label: "HTML render", contract: "Step B JSON -> HTML" },
];
