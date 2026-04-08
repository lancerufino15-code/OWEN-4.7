import { getAgentRegistry } from "../registry/agents";
import { getModelRegistry } from "../registry/models";
import { getPipelineRegistry } from "../registry/pipelines";
import { getPromptRegistry } from "../registry/prompts";
import { getRouteManifest } from "../routes/manifest";

export interface RuntimeExecutionRegistry {
  routes: ReturnType<typeof getRouteManifest>;
  prompts: ReturnType<typeof getPromptRegistry>;
  pipelines: ReturnType<typeof getPipelineRegistry>;
  agents: ReturnType<typeof getAgentRegistry>;
  models: ReturnType<typeof getModelRegistry>;
}

export function getExecutionRegistry(): RuntimeExecutionRegistry {
  return {
    routes: getRouteManifest(),
    prompts: getPromptRegistry(),
    pipelines: getPipelineRegistry(),
    agents: getAgentRegistry(),
    models: getModelRegistry(),
  };
}
