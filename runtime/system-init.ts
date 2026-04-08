import type { Env } from "../types";
import { resolveConfiguredModels } from "../registry/models";
import { getPipelineRegistry } from "../registry/pipelines";
import { getPromptRegistry } from "../registry/prompts";
import { getRouteManifest } from "../routes/manifest";

export interface RuntimeSystemInitSummary {
  requiredBindings: string[];
  configuredModels: ReturnType<typeof resolveConfiguredModels>;
  routeCountByDomain: Record<string, number>;
  promptCountByDomain: Record<string, number>;
  pipelineCountByDomain: Record<string, number>;
}

const REQUIRED_BINDINGS = [
  "ASSETS",
  "PRESENCE_ROOM",
  "OWEN_BUCKET",
  "OWEN_INGEST",
  "OWEN_UPLOADS",
  "OWEN_ANALYTICS",
  "OPENAI_API_KEY",
  "OPENAI_API_BASE",
  "DEFAULT_TEXT_MODEL",
];

function countByDomain<T extends { domain: string }>(entries: T[]): Record<string, number> {
  return entries.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.domain] = (acc[entry.domain] || 0) + 1;
    return acc;
  }, {});
}

export function buildRuntimeSystemInitSummary(env: Env): RuntimeSystemInitSummary {
  return {
    requiredBindings: REQUIRED_BINDINGS,
    configuredModels: resolveConfiguredModels(env),
    routeCountByDomain: countByDomain(getRouteManifest()),
    promptCountByDomain: countByDomain(getPromptRegistry()),
    pipelineCountByDomain: countByDomain(getPipelineRegistry()),
  };
}
