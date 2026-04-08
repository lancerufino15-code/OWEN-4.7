import { ankiPipelineStages } from "../pipelines/anki";
import { quizPipelineStages } from "../pipelines/quiz";
import { studyGuidePipelineStages } from "../pipelines/study-guide";

export type PipelineDomain = "study-guide" | "quiz" | "anki";

export interface PipelineStageDef {
  id: string;
  label: string;
  contract: string;
  validators?: string[];
}

export interface PipelineDef {
  id: string;
  domain: PipelineDomain;
  stages: PipelineStageDef[];
  inputContract: string;
  outputContract: string;
  validators: string[];
}

export const PIPELINE_REGISTRY: PipelineDef[] = [
  {
    id: "study-guide.machine",
    domain: "study-guide",
    inputContract: "lecture text -> normalized machine TXT / Step A JSON",
    outputContract: "published or downloadable study-guide HTML",
    validators: ["validateStepB", "validateSynthesis"],
    stages: studyGuidePipelineStages,
  },
  {
    id: "quiz.library",
    domain: "quiz",
    inputContract: "library lecture context + exclusions",
    outputContract: "stored or streamed quiz batch JSON",
    validators: ["inspectQuizPipelineOutput"],
    stages: quizPipelineStages,
  },
  {
    id: "anki.generate",
    domain: "anki",
    inputContract: "lecture text + slides + optional images",
    outputContract: "downloadable/publishable Anki card set",
    validators: ["lintAnkiNotes", "computeAnkiCoverageStats"],
    stages: ankiPipelineStages,
  },
];

export function getPipelineRegistry(): PipelineDef[] {
  return PIPELINE_REGISTRY;
}
