import type { PipelineStageDef } from "../../registry/pipelines";

export const quizPipelineStages: PipelineStageDef[] = [
  { id: "quiz.context", label: "Context selection", contract: "lecture text -> quiz context window" },
  { id: "quiz.prompt", label: "Prompt assembly", contract: "context -> prompt payload" },
  { id: "quiz.generate", label: "Generation", contract: "prompt payload -> quiz JSON" },
  { id: "quiz.inspect", label: "Validation / inspection", contract: "quiz JSON -> inspected quiz batch", validators: ["inspectQuizPipelineOutput"] },
  { id: "quiz.save", label: "Save / interrupt handling", contract: "quiz batch -> persisted qbank / continuation token" },
];
